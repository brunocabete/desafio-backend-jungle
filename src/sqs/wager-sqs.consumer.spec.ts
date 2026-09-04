import {
  WagerIdempotencyConflictError,
  WagerTransactionNotFoundError,
  WagerTransactionService,
  type WagerSubmitView,
} from '../wagering/wager-transaction.service.js';
import { WagerTransactionStatus } from '../domain/wager-transaction/wager-transaction.js';
import {
  WAGER_CONSUMER_NAME,
  WAGER_TRANSACTION_EVENT_TYPE,
} from './sqs-message.js';
import {
  consumeActionForFailure,
  SQS_MAX_RECEIVE_COUNT,
  WagerSqsConsumerService,
  type ConsumeAction,
} from './wager-sqs.consumer.js';
import {
  METRIC_NAMES,
  MetricsService,
} from '../common/metrics/metrics.service.js';
import type {
  MoveToDlqInput,
  SqsReceivedMessage,
  WagerSqsGateway,
} from './wager-sqs.gateway.js';

function body(messageId: string, kind = 'BET', amount = '25.00'): string {
  return JSON.stringify({
    messageId,
    type: WAGER_TRANSACTION_EVENT_TYPE,
    occurredAt: '2026-09-04T15:00:00.000Z',
    data: {
      providerId: 'provider-a',
      externalTransactionId: `ext-${messageId}`,
      idempotencyKey: `provider-a:ext-${messageId}`,
      playerId: 'player-1',
      walletId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind,
      money: { amount, currency: 'BRL' },
    },
  });
}

function received(
  overrides: Partial<SqsReceivedMessage> = {},
): SqsReceivedMessage {
  return {
    receiptHandle: 'receipt-1',
    systemMessageId: 'sys-1',
    receiveCount: 1,
    body: body('msg-1'),
    ...overrides,
  };
}

class FakeGateway implements WagerSqsGateway {
  acked: string[] = [];
  dlqed: MoveToDlqInput[] = [];
  receivedMessages: SqsReceivedMessage[] = [];

  async receive(): Promise<SqsReceivedMessage[]> {
    return this.receivedMessages.splice(0);
  }

  async ack(receiptHandle: string): Promise<void> {
    this.acked.push(receiptHandle);
  }

  async moveToDlq(input: MoveToDlqInput): Promise<void> {
    this.dlqed.push(input);
  }
}

function processedView(): WagerSubmitView {
  return {
    transactionId: 'tx-1',
    status: WagerTransactionStatus.Processed,
    balance: { amount: '75.00', currency: 'BRL' },
    idempotentReplay: false,
  };
}

describe('WagerSqsConsumerService.handleMessage', () => {
  function subject(
    submit: WagerTransactionService['submit'],
    metrics?: MetricsService,
  ): {
    consumer: WagerSqsConsumerService;
    gateway: FakeGateway;
    submitCalls: Parameters<WagerTransactionService['submit']>[];
  } {
    const gateway = new FakeGateway();
    const submitCalls: Parameters<WagerTransactionService['submit']>[] = [];
    const fakeService = {
      submit: async (
        request: unknown,
        inbox?: Parameters<WagerTransactionService['submit']>[1],
      ) => {
        submitCalls.push([request, inbox]);
        return submit(request, inbox);
      },
    } as unknown as WagerTransactionService;
    const consumer = new WagerSqsConsumerService(fakeService, gateway, metrics);
    return { consumer, gateway, submitCalls };
  }

  it('acks after a successful settlement and passes the inbox context', async () => {
    const { consumer, gateway, submitCalls } = subject(async () =>
      processedView(),
    );
    const message = received();

    const action = await consumer.handleMessage(message);

    expect(action).toBe('ack');
    expect(gateway.acked).toEqual(['receipt-1']);
    expect(submitCalls).toHaveLength(1);
    const [, inbox] = submitCalls[0];
    expect(inbox).toMatchObject({
      consumerName: WAGER_CONSUMER_NAME,
      messageId: 'msg-1',
    });
    expect(inbox?.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('acks a business REJECTED view (terminal result, not an error)', async () => {
    const { consumer, gateway } = subject(async () => ({
      transactionId: 'tx-2',
      status: WagerTransactionStatus.Rejected,
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '10.00', currency: 'BRL' },
      idempotentReplay: false,
    }));

    const action = await consumer.handleMessage(received());

    expect(action).toBe('ack');
    expect(gateway.acked).toHaveLength(1);
    expect(gateway.dlqed).toHaveLength(0);
  });

  it('moves a permanently invalid message to the DLQ without calling the use case', async () => {
    const { consumer, gateway, submitCalls } = subject(async () =>
      processedView(),
    );
    const message = received({ body: body('msg-1', 'CASHBACK') });

    const action = await consumer.handleMessage(message);

    expect(action).toBe('dlq');
    expect(gateway.dlqed).toHaveLength(1);
    expect(gateway.dlqed[0].receiptHandle).toBe('receipt-1');
    expect(gateway.dlqed[0].groupId).toMatch(/^dlq-/);
    expect(submitCalls).toHaveLength(0);
  });

  it('moves an idempotency conflict to the DLQ', async () => {
    const { consumer, gateway } = subject(async () => {
      throw new WagerIdempotencyConflictError('provider-a:key');
    });

    const action = await consumer.handleMessage(received());

    expect(action).toBe('dlq');
    expect(gateway.dlqed).toHaveLength(1);
    expect(gateway.acked).toHaveLength(0);
  });

  it('leaves a transient failure unacked for redelivery', async () => {
    const { consumer, gateway } = subject(async () => {
      throw new WagerTransactionNotFoundError('wallet not found');
    });

    const action = await consumer.handleMessage(received());

    expect(action).toBe('retry');
    expect(gateway.acked).toHaveLength(0);
    expect(gateway.dlqed).toHaveLength(0);
  });

  it('moves a repeatedly failing transient message to the DLQ at the receive limit', async () => {
    const { consumer, gateway } = subject(async () => {
      throw new WagerTransactionNotFoundError('wallet not found');
    });

    const action = await consumer.handleMessage(
      received({ receiveCount: SQS_MAX_RECEIVE_COUNT }),
    );

    expect(action).toBe('dlq');
    expect(gateway.dlqed).toHaveLength(1);
    expect(gateway.acked).toHaveLength(0);
  });

  it('counts transient retries and DLQ moves on the metrics service', async () => {
    const metrics = new MetricsService();
    const retrySubject = subject(async () => {
      throw new WagerTransactionNotFoundError('wallet not found');
    }, metrics);
    await retrySubject.consumer.handleMessage(received());
    expect(metrics.get(METRIC_NAMES.sqsTransientRetries)).toBe(1);
    expect(metrics.get(METRIC_NAMES.messagesMovedToDlq)).toBe(0);

    const dlqSubject = subject(async () => {
      throw new WagerTransactionNotFoundError('wallet not found');
    }, metrics);
    await dlqSubject.consumer.handleMessage(
      received({ receiveCount: SQS_MAX_RECEIVE_COUNT }),
    );
    expect(metrics.get(METRIC_NAMES.messagesMovedToDlq)).toBe(1);
    expect(metrics.get(METRIC_NAMES.sqsTransientRetries)).toBe(1);
  });
});

describe('consumeActionForFailure', () => {
  it('classifies permanent errors as dlq regardless of receive count', () => {
    expect(
      consumeActionForFailure(new WagerIdempotencyConflictError('k'), 1),
    ).toBe('dlq' satisfies ConsumeAction);
  });

  it('classifies infra failures as retry until the receive limit', () => {
    expect(consumeActionForFailure(new Error('connection refused'), 1)).toBe(
      'retry',
    );
    expect(consumeActionForFailure(new Error('connection refused'), 4)).toBe(
      'retry',
    );
    expect(consumeActionForFailure(new Error('connection refused'), 5)).toBe(
      'dlq',
    );
  });
});

class ControlledGateway implements WagerSqsGateway {
  receiveCalls = 0;
  acked: string[] = [];
  private pendingReleases: Array<(messages: SqsReceivedMessage[]) => void> = [];
  private receiveStartedResolve: (() => void) | undefined;

  receiveStarted(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.receiveStartedResolve = resolve;
    });
  }

  async receive(): Promise<SqsReceivedMessage[]> {
    this.receiveCalls += 1;
    this.receiveStartedResolve?.();
    this.receiveStartedResolve = undefined;
    return new Promise<SqsReceivedMessage[]>((resolve) => {
      this.pendingReleases.push(resolve);
    });
  }

  release(messages: SqsReceivedMessage[]): void {
    const release = this.pendingReleases.shift();
    release?.(messages);
  }

  async ack(receiptHandle: string): Promise<void> {
    this.acked.push(receiptHandle);
  }

  async moveToDlq(): Promise<void> {
    throw new Error('not expected');
  }
}

describe('WagerSqsConsumerService graceful shutdown', () => {
  let previousEnabled: string | undefined;
  let previousPoll: string | undefined;
  let previousTimeout: string | undefined;

  beforeEach(() => {
    previousEnabled = process.env.WAGER_SQS_CONSUMER_ENABLED;
    previousPoll = process.env.WAGER_SQS_POLL_MS;
    previousTimeout = process.env.WAGER_SQS_SHUTDOWN_TIMEOUT_MS;
  });

  afterEach(() => {
    if (previousEnabled === undefined) {
      delete process.env.WAGER_SQS_CONSUMER_ENABLED;
    } else {
      process.env.WAGER_SQS_CONSUMER_ENABLED = previousEnabled;
    }
    if (previousPoll === undefined) {
      delete process.env.WAGER_SQS_POLL_MS;
    } else {
      process.env.WAGER_SQS_POLL_MS = previousPoll;
    }
    if (previousTimeout === undefined) {
      delete process.env.WAGER_SQS_SHUTDOWN_TIMEOUT_MS;
    } else {
      process.env.WAGER_SQS_SHUTDOWN_TIMEOUT_MS = previousTimeout;
    }
  });

  function build(): {
    consumer: WagerSqsConsumerService;
    gateway: ControlledGateway;
  } {
    const gateway = new ControlledGateway();
    const fakeService = {
      submit: async () => processedView(),
    } as unknown as WagerTransactionService;
    return {
      consumer: new WagerSqsConsumerService(fakeService, gateway),
      gateway,
    };
  }

  it('finishes the in-flight message and stops polling on shutdown', async () => {
    process.env.WAGER_SQS_CONSUMER_ENABLED = 'true';
    process.env.WAGER_SQS_POLL_MS = '5';
    process.env.WAGER_SQS_SHUTDOWN_TIMEOUT_MS = '2000';
    const { consumer, gateway } = build();
    const started = gateway.receiveStarted();
    consumer.onApplicationBootstrap();

    await started;
    let closed = false;
    const closing = consumer.onApplicationShutdown().then(() => {
      closed = true;
    });
    await sleep(20);
    expect(closed).toBe(false);

    gateway.release([received()]);
    await closing;
    expect(closed).toBe(true);
    expect(gateway.acked).toEqual(['receipt-1']);

    await sleep(20);
    expect(gateway.receiveCalls).toBe(1);
  });

  it('does not start polling when the consumer is disabled', async () => {
    process.env.WAGER_SQS_CONSUMER_ENABLED = 'false';
    process.env.WAGER_SQS_POLL_MS = '5';
    const { consumer, gateway } = build();
    consumer.onApplicationBootstrap();
    await sleep(20);
    expect(gateway.receiveCalls).toBe(0);
    await consumer.onApplicationShutdown();
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
