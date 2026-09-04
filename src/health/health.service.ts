import { GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/core';
import { Injectable, Logger } from '@nestjs/common';
import { createSqsClient, sqsEnv } from '../common/config/sqs.js';

export { sqsEnv };

const SQS_PROBE_TIMEOUT_MS = 3_000;

export type ComponentState = 'up' | 'down';

export interface ComponentHealth {
  up: boolean;
  message?: string;
}

export interface ReadinessReport {
  status: 'ok' | 'error';
  checks: {
    database: ComponentState;
    sqs: ComponentState;
  };
  errors: Partial<Record<'database' | 'sqs', string>>;
}

export function summarizeReadiness(health: {
  database: ComponentHealth;
  sqs: ComponentHealth;
}): ReadinessReport {
  const checks = {
    database: health.database.up ? ('up' as const) : ('down' as const),
    sqs: health.sqs.up ? ('up' as const) : ('down' as const),
  };
  const errors: ReadinessReport['errors'] = {};
  if (!health.database.up && health.database.message) {
    errors.database = health.database.message;
  }
  if (!health.sqs.up && health.sqs.message) {
    errors.sqs = health.sqs.message;
  }
  return {
    status: health.database.up && health.sqs.up ? 'ok' : 'error',
    checks,
    errors,
  };
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(private readonly orm: MikroORM) {}

  async readiness(): Promise<ReadinessReport> {
    const [database, sqs] = await Promise.all([
      this.checkDatabase(),
      this.checkSqs(),
    ]);
    return summarizeReadiness({ database, sqs });
  }

  private async checkDatabase(): Promise<ComponentHealth> {
    try {
      await this.orm.em.getConnection().execute('select 1', [], 'get');
      return { up: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`readiness: postgres is down: ${message}`);
      return { up: false, message };
    }
  }

  private async checkSqs(): Promise<ComponentHealth> {
    const env = sqsEnv();
    if (!env.queue) {
      return { up: false, message: 'AWS_SQS_QUEUE is not configured' };
    }
    const client = createSqsClient(env);
    try {
      await withTimeout(
        client.send(new GetQueueUrlCommand({ QueueName: env.queue })),
        SQS_PROBE_TIMEOUT_MS,
      );
      return { up: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`readiness: sqs is down: ${message}`);
      return { up: false, message };
    } finally {
      client.destroy();
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`probe timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
