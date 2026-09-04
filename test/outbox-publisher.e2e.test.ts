import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';
import { OutboxMessageEntity } from '../src/db/entities/outbox-message.entity.js';
import { WagerTransactionStatus } from '../src/domain/wager-transaction/wager-transaction.js';
import { WalletService } from '../src/wallets/wallet.service.js';
import { WagerTransactionService } from '../src/wagering/wager-transaction.service.js';
import { MetricsService } from '../src/common/metrics/metrics.service.js';
import { sqsEnv, createSqsClient } from '../src/common/config/sqs.js';
import { OutboxPublisherService } from '../src/outbox/outbox-publisher.service.js';
import {
  SqsOutboxPublisherGateway,
  type OutboxPublisherGateway,
} from '../src/outbox/outbox-publisher.gateway.js';
import { ormOptionsFor, dropDatabaseIfExists } from './test-db.js';
import { testDatabaseName } from './test-names.js';

const TEST_DB = testDatabaseName('desafio_jungle_outboxpub_test');
const EVENTS_QUEUE = 'wager-events.fifo';

class FailingGateway implements OutboxPublisherGateway {
  async publish(): Promise<void> {
    throw new Error('sqs unavailable (test)');
  }
}

interface OutboxRow {
  id: string;
  aggregateId: string;
  attempts: number;
  nextAttemptAt: Date | null;
  publishedAt: Date | null;
}

describe('transactional outbox publisher (e2e, real Postgres + Ministack)', () => {
  let orm: MikroORM;
  let walletService: WalletService;
  let wagerService: WagerTransactionService;
  let publisher: OutboxPublisherService;
  let client: SQSClient;
  let eventsUrl: string;
  let provider: string;
  let previousDbName: string | undefined;
  let previousAws: Record<string, string | undefined>;

  beforeAll(async () => {
    previousDbName = process.env.POSTGRES_DB;
    previousAws = {
      AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL,
      AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION,
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      AWS_SQS_QUEUE: process.env.AWS_SQS_QUEUE,
      AWS_SQS_EVENTS_QUEUE: process.env.AWS_SQS_EVENTS_QUEUE,
    };
    process.env.POSTGRES_DB = TEST_DB;
    process.env.AWS_ENDPOINT_URL = 'http://localhost:4566';
    process.env.AWS_DEFAULT_REGION = 'us-east-1';
    process.env.AWS_ACCESS_KEY_ID = 'test';
    process.env.AWS_SECRET_ACCESS_KEY = 'test';
    process.env.AWS_SQS_QUEUE = 'wager-transactions.fifo';
    process.env.AWS_SQS_EVENTS_QUEUE = EVENTS_QUEUE;

    await dropDatabaseIfExists(TEST_DB);
    orm = await MikroORM.init(ormOptionsFor(TEST_DB));
    await orm.migrator.up();

    walletService = new WalletService(orm, new MetricsService());
    wagerService = new WagerTransactionService(orm);
    publisher = new OutboxPublisherService(
      orm,
      new SqsOutboxPublisherGateway(sqsEnv()),
    );

    client = createSqsClient(sqsEnv());
    const result = await client.send(
      new GetQueueUrlCommand({ QueueName: EVENTS_QUEUE }),
    );
    if (!result.QueueUrl) {
      throw new Error(`no queue url for ${EVENTS_QUEUE}`);
    }
    eventsUrl = result.QueueUrl;
    await drainEvents();
    provider = `provider-${randomUUID().slice(0, 8)}`;
  }, 60_000);

  afterAll(async () => {
    if (client) {
      await drainEvents();
      client.destroy();
    }
    if (orm) {
      await orm.close(true);
    }
    await dropDatabaseIfExists(TEST_DB);
    if (previousDbName === undefined) {
      delete process.env.POSTGRES_DB;
    } else {
      process.env.POSTGRES_DB = previousDbName;
    }
    for (const [key, value] of Object.entries(previousAws)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }, 60_000);

  async function drainEvents(): Promise<Array<Record<string, unknown>>> {
    const envelopes: Array<Record<string, unknown>> = [];
    for (;;) {
      const result = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: eventsUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
        }),
      );
      if (!result.Messages || result.Messages.length === 0) {
        return envelopes;
      }
      for (const message of result.Messages) {
        if (message.Body) {
          envelopes.push(JSON.parse(message.Body));
        }
        if (message.ReceiptHandle) {
          await client.send(
            new DeleteMessageCommand({
              QueueUrl: eventsUrl,
              ReceiptHandle: message.ReceiptHandle,
            }),
          );
        }
      }
    }
  }

  async function pendingRows(): Promise<OutboxRow[]> {
    const rows = await orm.em.fork().find(OutboxMessageEntity, {
      publishedAt: null,
    });
    return rows as unknown as OutboxRow[];
  }

  async function seedOutboxRows(): Promise<number> {
    const wallet = await walletService.create({
      playerId: randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const base = {
      providerId: provider,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      money: { amount: '5.00', currency: 'BRL' },
    } as const;
    const loss = await wagerService.submit({
      ...base,
      externalTransactionId: randomUUID(),
      idempotencyKey: `${provider}:${randomUUID()}`,
      kind: 'LOSS',
    });
    const bet = await wagerService.submit({
      ...base,
      externalTransactionId: randomUUID(),
      idempotencyKey: `${provider}:${randomUUID()}`,
      kind: 'BET',
    });
    expect(loss.status).toBe(WagerTransactionStatus.Processed);
    expect(bet.status).toBe(WagerTransactionStatus.Processed);
    return (await pendingRows()).length;
  }

  async function forceAllDue(): Promise<void> {
    const em = orm.em.fork();
    const ids = (await pendingRows()).map((row) => row.id);
    const entities = await em.find(OutboxMessageEntity, { id: { $in: ids } });
    for (const entity of entities) {
      entity.nextAttemptAt = null;
    }
    await em.flush();
  }

  async function rowsById(ids: string[]): Promise<OutboxRow[]> {
    return (await orm.em
      .fork()
      .find(OutboxMessageEntity, {
        id: { $in: ids },
      })) as unknown as OutboxRow[];
  }

  it('publishes every pending event once and is idempotent on the next run', async () => {
    const pending = await seedOutboxRows();
    expect(pending).toBeGreaterThan(0);

    const stats = await publisher.publishDue();
    expect(stats).toEqual({
      due: pending,
      published: pending,
      skipped: 0,
      failed: 0,
    });
    expect(await pendingRows()).toHaveLength(0);

    const envelopes = await drainEvents();
    const eventIds = envelopes.map((envelope) => envelope.eventId);
    expect(eventIds).toHaveLength(pending);
    expect(new Set(eventIds).size).toBe(pending);
    for (const envelope of envelopes) {
      expect(typeof envelope.eventType).toBe('string');
      expect(envelope.version).toBe(1);
      expect(typeof envelope.aggregateId).toBe('string');
    }

    const again = await publisher.publishDue();
    expect(again.published).toBe(0);
    expect(await drainEvents()).toHaveLength(0);
  });

  it('reschedules a failed publish with backoff and recovers on the next run', async () => {
    await drainEvents();
    const pending = await seedOutboxRows();
    expect(pending).toBeGreaterThan(0);
    const ids = (await pendingRows()).map((row) => row.id);

    const failing = new OutboxPublisherService(orm, new FailingGateway());
    const failed = await failing.publishDue();
    expect(failed).toEqual({
      due: pending,
      published: 0,
      skipped: 0,
      failed: pending,
    });
    expect(await drainEvents()).toHaveLength(0);

    for (const row of await rowsById(ids)) {
      expect(row.attempts).toBe(1);
      expect(row.publishedAt).toBeNull();
      expect(row.nextAttemptAt).not.toBeNull();
    }

    await forceAllDue();
    const stats = await publisher.publishDue();
    expect(stats.published).toBe(pending);

    const envelopes = await drainEvents();
    expect(new Set(envelopes.map((envelope) => envelope.eventId)).size).toBe(
      pending,
    );
    for (const row of await rowsById(ids)) {
      expect(row.publishedAt).not.toBeNull();
      expect(row.attempts).toBe(2);
    }
  });

  it('keeps two concurrent publishers from duplicating events', async () => {
    await drainEvents();
    const pending = await seedOutboxRows();
    expect(pending).toBeGreaterThan(0);
    const ids = (await pendingRows()).map((row) => row.id);

    const second = new OutboxPublisherService(
      orm,
      new SqsOutboxPublisherGateway(sqsEnv()),
    );
    const [a, b] = await Promise.all([
      publisher.publishDue(),
      second.publishDue(),
    ]);
    expect(a.published + b.published).toBe(pending);
    expect(await pendingRows()).toHaveLength(0);

    const envelopes = await drainEvents();
    const eventIds = envelopes.map((envelope) => envelope.eventId);
    expect(new Set(eventIds).size).toBe(pending);

    for (const row of await rowsById(ids)) {
      expect(row.publishedAt).not.toBeNull();
      expect(row.attempts).toBe(1);
    }
  });
});
