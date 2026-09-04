import {
  GetQueueUrlCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { createSqsClient, type SqsEnv } from '../common/config/sqs.js';

const DEFAULT_EVENTS_QUEUE = 'wager-events.fifo';

export interface OutboxPublisherGateway {
  publish(envelope: Record<string, unknown>, groupId: string): Promise<void>;
}

export const OUTBOX_PUBLISHER = Symbol('OutboxPublisher');

export class SqsOutboxPublisherGateway implements OutboxPublisherGateway {
  private readonly client: SQSClient;
  private readonly queueName: string;
  private queueUrl: string | undefined;

  constructor(env: SqsEnv) {
    this.client = createSqsClient(env);
    this.queueName = env.eventsQueue ?? DEFAULT_EVENTS_QUEUE;
  }

  async publish(
    envelope: Record<string, unknown>,
    groupId: string,
  ): Promise<void> {
    const queueUrl = await this.resolveQueueUrl();
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(envelope),
        MessageGroupId: groupId,
      }),
    );
  }

  private async resolveQueueUrl(): Promise<string> {
    if (!this.queueUrl) {
      const result = await this.client.send(
        new GetQueueUrlCommand({ QueueName: this.queueName }),
      );
      if (!result.QueueUrl) {
        throw new Error(
          `could not resolve SQS queue url for '${this.queueName}'`,
        );
      }
      this.queueUrl = result.QueueUrl;
    }
    return this.queueUrl;
  }
}
