import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import {
  InvalidWagerPayloadError,
  WagerIdempotencyConflictError,
  WagerTransactionService,
} from '../wagering/wager-transaction.service.js';
import {
  InvalidSqsMessageError,
  parseWagerQueueMessage,
  WAGER_CONSUMER_NAME,
} from './sqs-message.js';
import {
  type SqsReceivedMessage,
  type WagerSqsGateway,
  WAGER_SQS_GATEWAY,
} from './wager-sqs.gateway.js';
import {
  METRIC_NAMES,
  MetricsService,
} from '../common/metrics/metrics.service.js';
import { runWithCorrelationId } from '../common/correlation/correlation-id.context.js';

export const SQS_MAX_RECEIVE_COUNT = 5;
export const SQS_DEFAULT_POLL_MS = 1_000;
export const SQS_DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

export type ConsumeAction = 'ack' | 'dlq' | 'retry';

export function isPermanentWagerError(error: unknown): boolean {
  return (
    error instanceof InvalidSqsMessageError ||
    error instanceof InvalidWagerPayloadError ||
    error instanceof WagerIdempotencyConflictError
  );
}

export function consumeActionForFailure(
  error: unknown,
  receiveCount: number,
): ConsumeAction {
  if (isPermanentWagerError(error)) {
    return 'dlq';
  }
  return receiveCount >= SQS_MAX_RECEIVE_COUNT ? 'dlq' : 'retry';
}

@Injectable()
export class WagerSqsConsumerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(WagerSqsConsumerService.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private stopping = false;
  private tickPromise: Promise<void> | undefined;

  constructor(
    private readonly wagerService: WagerTransactionService,
    @Inject(WAGER_SQS_GATEWAY) private readonly gateway: WagerSqsGateway,
    private readonly metrics?: MetricsService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.WAGER_SQS_CONSUMER_ENABLED !== 'true') {
      return;
    }
    const interval = this.pollIntervalMs();
    if (interval <= 0) {
      return;
    }
    this.timer = setInterval(() => {
      this.onTimer();
    }, interval);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.close();
  }

  async close(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const inFlight = this.tickPromise;
    if (!inFlight) {
      return;
    }
    const graceMs = this.shutdownTimeoutMs();
    const drained = await withTimeout(inFlight, graceMs);
    if (!drained) {
      this.logger.warn(
        `sqs consumer shutdown exceeded the ${graceMs}ms grace period; unacked in-flight messages will be redelivered after the visibility timeout`,
      );
    }
  }

  async pollOnce(): Promise<number> {
    const messages = await this.gateway.receive();
    for (const message of messages) {
      await this.handleMessage(message);
    }
    return messages.length;
  }

  async handleMessage(message: SqsReceivedMessage): Promise<ConsumeAction> {
    let parsed;
    try {
      parsed = parseWagerQueueMessage(message.body);
    } catch (error) {
      const action = consumeActionForFailure(error, message.receiveCount);
      await this.routeFailure(message, error, action);
      return action;
    }

    try {
      await runWithCorrelationId(parsed.messageId, async () => {
        const settled = await this.wagerService.submit(parsed.data, {
          consumerName: WAGER_CONSUMER_NAME,
          messageId: parsed.messageId,
          payloadHash: parsed.payloadHash,
        });
        await this.gateway.ack(message.receiptHandle);
        this.logger.log(
          {
            event: 'wager.message.settled',
            messageId: parsed.messageId,
            transactionId: settled.transactionId,
            walletId: parsed.data.walletId,
            providerId: parsed.data.providerId,
            status: settled.status,
            idempotentReplay: settled.idempotentReplay,
          },
          WagerSqsConsumerService.name,
        );
        return settled;
      });
      return 'ack';
    } catch (error) {
      const action = consumeActionForFailure(error, message.receiveCount);
      await this.routeFailure(message, error, action);
      return action;
    }
  }

  private pollIntervalMs(): number {
    const value = Number(process.env.WAGER_SQS_POLL_MS);
    return Number.isFinite(value) ? value : SQS_DEFAULT_POLL_MS;
  }

  private shutdownTimeoutMs(): number {
    const value = Number(process.env.WAGER_SQS_SHUTDOWN_TIMEOUT_MS);
    return Number.isFinite(value) && value > 0
      ? value
      : SQS_DEFAULT_SHUTDOWN_TIMEOUT_MS;
  }

  private onTimer(): void {
    if (this.running || this.stopping) {
      return;
    }
    this.running = true;
    const cycle = this.runCycle();
    this.tickPromise = cycle;
    void cycle.finally(() => {
      this.running = false;
      this.tickPromise = undefined;
    });
  }

  private async runCycle(): Promise<void> {
    try {
      const handled = await this.pollOnce();
      if (handled > 0) {
        this.logger.log(`sqs consumer processed ${handled} message(s)`);
      }
    } catch (error) {
      this.logger.error(
        `sqs consumer failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async routeFailure(
    message: SqsReceivedMessage,
    error: unknown,
    action: ConsumeAction,
  ): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    if (action === 'dlq') {
      this.metrics?.increment(METRIC_NAMES.messagesMovedToDlq);
      await this.gateway.moveToDlq({
        receiptHandle: message.receiptHandle,
        systemMessageId: message.systemMessageId,
        body: message.body,
        groupId: `dlq-${message.systemMessageId || 'unknown'}`,
      });
      this.logger.warn(
        `permanent failure for SQS message '${message.systemMessageId}': ${reason}`,
      );
      return;
    }
    this.metrics?.increment(METRIC_NAMES.sqsTransientRetries);
    this.logger.warn(
      `transient failure for SQS message '${message.systemMessageId}' (receive ${message.receiveCount}): ${reason} — waiting for redelivery`,
    );
  }
}

async function withTimeout(
  promise: Promise<void>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
