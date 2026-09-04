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

export const SQS_MAX_RECEIVE_COUNT = 5;

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

  constructor(
    private readonly wagerService: WagerTransactionService,
    @Inject(WAGER_SQS_GATEWAY) private readonly gateway: WagerSqsGateway,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.WAGER_SQS_CONSUMER_ENABLED !== 'true') {
      return;
    }
    const pollMs = Number(process.env.WAGER_SQS_POLL_MS);
    const interval = Number.isFinite(pollMs) ? pollMs : 1_000;
    if (interval <= 0) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, interval);
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
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
      const view = await this.wagerService.submit(parsed.data, {
        consumerName: WAGER_CONSUMER_NAME,
        messageId: parsed.messageId,
        payloadHash: parsed.payloadHash,
      });
      await this.gateway.ack(message.receiptHandle);
      this.logger.log(
        `wager message '${parsed.messageId}' settled with status ${view.status} (transaction ${view.transactionId})`,
      );
      return 'ack';
    } catch (error) {
      const action = consumeActionForFailure(error, message.receiveCount);
      await this.routeFailure(message, error, action);
      return action;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const handled = await this.pollOnce();
      if (handled > 0) {
        this.logger.log(`sqs consumer processed ${handled} message(s)`);
      }
    } catch (error) {
      this.logger.error(
        `sqs consumer failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  private async routeFailure(
    message: SqsReceivedMessage,
    error: unknown,
    action: ConsumeAction,
  ): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    if (action === 'dlq') {
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
    this.logger.warn(
      `transient failure for SQS message '${message.systemMessageId}' (receive ${message.receiveCount}): ${reason} — waiting for redelivery`,
    );
  }
}
