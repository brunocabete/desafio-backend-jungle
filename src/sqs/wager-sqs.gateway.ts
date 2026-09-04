import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { Logger } from '@nestjs/common';
import { createSqsClient, type SqsEnv } from '../common/config/sqs.js';

const DEFAULT_QUEUE = 'wager-transactions.fifo';
const DEFAULT_DLQ = 'wager-transactions-dlq.fifo';
const MAX_MESSAGES = 10;
const WAIT_TIME_SECONDS = 10;
const VISIBILITY_TIMEOUT_SECONDS = 60;

export interface SqsReceivedMessage {
  receiptHandle: string;
  systemMessageId: string;
  receiveCount: number;
  body: string;
}

export interface MoveToDlqInput {
  receiptHandle: string;
  systemMessageId: string;
  body: string;
  groupId: string;
}

export interface WagerSqsGateway {
  receive(): Promise<SqsReceivedMessage[]>;
  ack(receiptHandle: string): Promise<void>;
  moveToDlq(input: MoveToDlqInput): Promise<void>;
}

export const WAGER_SQS_GATEWAY = Symbol('WagerSqsGateway');

export class AwsWagerSqsGateway implements WagerSqsGateway {
  private readonly logger = new Logger(AwsWagerSqsGateway.name);
  private readonly client: SQSClient;
  private readonly queueName: string;
  private readonly dlqName: string;
  private queueUrl: string | undefined;
  private dlqUrl: string | undefined;

  constructor(env: SqsEnv) {
    this.client = createSqsClient(env);
    this.queueName = env.queue ?? DEFAULT_QUEUE;
    this.dlqName = env.dlqQueue ?? DEFAULT_DLQ;
  }

  async receive(): Promise<SqsReceivedMessage[]> {
    const queueUrl = await this.resolveQueueUrl();
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: MAX_MESSAGES,
        WaitTimeSeconds: WAIT_TIME_SECONDS,
        VisibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );
    if (!result.Messages) {
      return [];
    }
    return result.Messages.map((message) => ({
      receiptHandle: message.ReceiptHandle ?? '',
      systemMessageId: message.MessageId ?? '',
      receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? 1),
      body: message.Body ?? '',
    }));
  }

  async ack(receiptHandle: string): Promise<void> {
    const queueUrl = await this.resolveQueueUrl();
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  async moveToDlq(input: MoveToDlqInput): Promise<void> {
    const dlqUrl = await this.resolveDlqUrl();
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: dlqUrl,
        MessageBody: input.body,
        MessageGroupId: input.groupId,
        MessageDeduplicationId: input.systemMessageId || undefined,
      }),
    );
    await this.ack(input.receiptHandle);
    this.logger.warn(
      `moved SQS message '${input.systemMessageId}' to DLQ (${this.dlqName})`,
    );
  }

  private async resolveQueueUrl(): Promise<string> {
    if (!this.queueUrl) {
      this.queueUrl = await this.lookup(this.queueName);
    }
    return this.queueUrl;
  }

  private async resolveDlqUrl(): Promise<string> {
    if (!this.dlqUrl) {
      this.dlqUrl = await this.lookup(this.dlqName);
    }
    return this.dlqUrl;
  }

  private async lookup(name: string): Promise<string> {
    const result = await this.client.send(
      new GetQueueUrlCommand({ QueueName: name }),
    );
    if (!result.QueueUrl) {
      throw new Error(`could not resolve SQS queue url for '${name}'`);
    }
    return result.QueueUrl;
  }
}
