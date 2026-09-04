import { SQSClient, type SQSClientConfig } from '@aws-sdk/client-sqs';

export interface SqsEnv {
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  endpoint?: string;
  queue?: string;
  dlqQueue?: string;
  eventsQueue?: string;
}

export function sqsEnv(env: NodeJS.ProcessEnv = process.env): SqsEnv {
  return {
    region: env.AWS_DEFAULT_REGION ?? 'us-east-1',
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    endpoint: env.AWS_ENDPOINT_URL || undefined,
    queue: env.AWS_SQS_QUEUE,
    dlqQueue: env.AWS_SQS_DLQ_QUEUE,
    eventsQueue: env.AWS_SQS_EVENTS_QUEUE,
  };
}

export function createSqsClient(env: SqsEnv): SQSClient {
  const config: SQSClientConfig = {
    region: env.region,
  };
  if (env.accessKeyId && env.secretAccessKey) {
    config.credentials = {
      accessKeyId: env.accessKeyId,
      secretAccessKey: env.secretAccessKey,
    };
  }
  if (env.endpoint) {
    config.endpoint = env.endpoint;
  }
  return new SQSClient(config);
}
