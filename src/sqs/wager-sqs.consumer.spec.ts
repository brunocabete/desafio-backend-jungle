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
  function subject(submit: WagerTransactionService['submit']): {
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
    const consumer = new WagerSqsConsumerService(fakeService, gateway);
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
