import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';
import { WagerTransactionEntity } from '../src/db/entities/wager-transaction.entity.js';
import { WalletLedgerEntryEntity } from '../src/db/entities/wallet-ledger-entry.entity.js';
import { InboxMessageEntity } from '../src/db/entities/inbox-message.entity.js';
import { WalletEntity } from '../src/db/entities/wallet.entity.js';
import { WalletService } from '../src/wallets/wallet.service.js';
import { WagerTransactionService } from '../src/wagering/wager-transaction.service.js';
import { MetricsService } from '../src/common/metrics/metrics.service.js';
import { sqsEnv, createSqsClient } from '../src/common/config/sqs.js';
import { WagerSqsConsumerService } from '../src/sqs/wager-sqs.consumer.js';
import { AwsWagerSqsGateway } from '../src/sqs/wager-sqs.gateway.js';
import { WAGER_CONSUMER_NAME } from '../src/sqs/sqs-message.js';
import { ormOptionsFor, dropDatabaseIfExists } from './test-db.js';
import { testDatabaseName } from './test-names.js';

const TEST_DB = testDatabaseName('desafio_jungle_sqs_test');
const MAIN_QUEUE = 'wager-transactions.fifo';
const DLQ_QUEUE = 'wager-transactions-dlq.fifo';

describe('SQS consumer (e2e, real Ministack + Postgres)', () => {
  let orm: MikroORM;
  let walletService: WalletService;
  let consumer: WagerSqsConsumerService;
  let client: SQSClient;
  let mainUrl: string;
  let dlqUrl: string;
  let provider: string;
  let previousAws: Record<string, string | undefined>;
  let previousDbName: string | undefined;

  beforeAll(async () => {
    previousDbName = process.env.POSTGRES_DB;
    previousAws = {
      AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL,
      AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION,
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      AWS_SQS_QUEUE: process.env.AWS_SQS_QUEUE,
      AWS_SQS_DLQ_QUEUE: process.env.AWS_SQS_DLQ_QUEUE,
    };
    process.env.POSTGRES_DB = TEST_DB;
    process.env.AWS_ENDPOINT_URL = 'http://localhost:4566';
    process.env.AWS_DEFAULT_REGION = 'us-east-1';
    process.env.AWS_ACCESS_KEY_ID = 'test';
    process.env.AWS_SECRET_ACCESS_KEY = 'test';
    process.env.AWS_SQS_QUEUE = MAIN_QUEUE;
    process.env.AWS_SQS_DLQ_QUEUE = DLQ_QUEUE;

    await dropDatabaseIfExists(TEST_DB);
    orm = await MikroORM.init(ormOptionsFor(TEST_DB));
    await orm.migrator.up();

    const walletServiceInstance = new WalletService(orm, new MetricsService());
    walletService = walletServiceInstance;
    const wagerService = new WagerTransactionService(orm);
    consumer = new WagerSqsConsumerService(
      wagerService,
      new AwsWagerSqsGateway(sqsEnv()),
    );

    client = createSqsClient(sqsEnv());
    mainUrl = await queueUrl(MAIN_QUEUE);
    dlqUrl = await queueUrl(DLQ_QUEUE);
    await drainQueue(mainUrl);
    await drainQueue(dlqUrl);
    provider = `provider-${randomUUID().slice(0, 8)}`;
  }, 60_000);

  afterAll(async () => {
    if (client) {
      await drainQueue(mainUrl);
      await drainQueue(dlqUrl);
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

  async function queueUrl(name: string): Promise<string> {
    const result = await client.send(
      new GetQueueUrlCommand({ QueueName: name }),
    );
    if (!result.QueueUrl) {
      throw new Error(`no queue url for ${name}`);
    }
    return result.QueueUrl;
  }

  async function drainQueue(url: string): Promise<number> {
    let drained = 0;
    for (;;) {
      const result = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: url,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
        }),
      );
      if (!result.Messages || result.Messages.length === 0) {
        return drained;
      }
      for (const message of result.Messages) {
        if (message.ReceiptHandle) {
          await client.send(
            new DeleteMessageCommand({
              QueueUrl: url,
              ReceiptHandle: message.ReceiptHandle,
            }),
          );
        }
      }
      drained += result.Messages.length;
    }
  }

  async function sendWager(
    messageId: string,
    data: Record<string, unknown>,
    dedupId?: string,
  ): Promise<void> {
    await client.send(
      new SendMessageCommand({
        QueueUrl: mainUrl,
        MessageGroupId: String(data.providerId),
        MessageDeduplicationId: dedupId,
        MessageBody: JSON.stringify({
          messageId,
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data,
        }),
      }),
    );
  }

  async function createWallet(
    balance = '100.00',
  ): Promise<{ id: string; playerId: string }> {
    const wallet = await walletService.create({
      playerId: randomUUID(),
      initialBalance: { amount: balance, currency: 'BRL' },
    });
    return { id: wallet.id, playerId: wallet.playerId };
  }

  function wagerData(
    wallet: { id: string; playerId: string },
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      providerId: provider,
      externalTransactionId: `ext-${randomUUID().slice(0, 12)}`,
      idempotencyKey: `${provider}:${randomUUID().slice(0, 12)}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      ...overrides,
    };
  }

  async function wagerRows(walletId: string) {
    return orm.em
      .fork()
      .find(WagerTransactionEntity, { walletId, providerId: provider });
  }

  async function inboxCount(messageId: string): Promise<number> {
    return orm.em.fork().count(InboxMessageEntity, {
      consumerName: WAGER_CONSUMER_NAME,
      messageId,
    });
  }

  it('settles a queued BET, acks it and records the inbox row', async () => {
    const wallet = await createWallet('100.00');
    const messageId = `msg-${randomUUID().slice(0, 8)}`;
    await sendWager(messageId, wagerData(wallet));

    const handled = await consumer.pollOnce();
    expect(handled).toBe(1);

    const rows = await wagerRows(wallet.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('PROCESSED');
    expect(await inboxCount(messageId)).toBe(1);
    const ledgerCount = await orm.em.fork().count(WalletLedgerEntryEntity, {
      walletId: wallet.id,
      direction: 'DEBIT',
    });
    expect(ledgerCount).toBe(1);
    const walletRow = await orm.em.fork().findOne(WalletEntity, {
      id: wallet.id,
    });
    expect(walletRow?.balanceAmount).toBe('75.00');

    const next = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: mainUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 0,
      }),
    );
    expect(next.Messages).toBeUndefined();
  });

  it('does not double-debit when the same inbox message is redelivered', async () => {
    const wallet = await createWallet('100.00');
    const messageId = `msg-${randomUUID().slice(0, 8)}`;
    const data = wagerData(wallet);
    await sendWager(messageId, data, `dedup-1-${messageId}`);
    await consumer.pollOnce();
    expect(await inboxCount(messageId)).toBe(1);

    await sendWager(messageId, data, `dedup-2-${messageId}`);
    const handled = await consumer.pollOnce();
    expect(handled).toBe(1);

    const ledgerCount = await orm.em.fork().count(WalletLedgerEntryEntity, {
      walletId: wallet.id,
      direction: 'DEBIT',
    });
    expect(ledgerCount).toBe(1);
    expect(await inboxCount(messageId)).toBe(1);
    const walletRow = await orm.em.fork().findOne(WalletEntity, {
      id: wallet.id,
    });
    expect(walletRow?.balanceAmount).toBe('75.00');
  });

  it('acks a PENDING_REFERENCE submission and resolves it once the BET arrives', async () => {
    const wallet = await createWallet('100.00');
    const missingBet = `bet-late-${randomUUID().slice(0, 8)}`;
    const refundId = `msg-refund-${randomUUID().slice(0, 8)}`;
    await sendWager(
      refundId,
      wagerData(wallet, {
        kind: 'REFUND',
        referenceExternalTransactionId: missingBet,
      }),
    );

    expect(await consumer.pollOnce()).toBe(1);
    let rows = await wagerRows(wallet.id);
    expect(rows[0].status).toBe('PENDING_REFERENCE');
    expect(await inboxCount(refundId)).toBe(1);

    const betId = `msg-bet-${randomUUID().slice(0, 8)}`;
    await sendWager(
      betId,
      wagerData(wallet, { externalTransactionId: missingBet }),
    );
    expect(await consumer.pollOnce()).toBe(1);

    rows = await wagerRows(wallet.id);
    expect(rows).toHaveLength(2);
    const refundRow = rows.find((row) => row.kind === 'REFUND');
    expect(refundRow?.status).toBe('PROCESSED');
  });

  it('moves a permanently invalid message to the DLQ', async () => {
    const wallet = await createWallet('100.00');
    const messageId = `msg-bad-${randomUUID().slice(0, 8)}`;
    await sendWager(messageId, wagerData(wallet, { kind: 'CASHBACK' }));

    expect(await consumer.pollOnce()).toBe(1);
    expect(await inboxCount(messageId)).toBe(0);

    const result = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: dlqUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 0,
      }),
    );
    const bodies = (result.Messages ?? [])
      .map((message) => message.Body ?? '')
      .filter((body) => body.includes(messageId));
    expect(bodies).toHaveLength(1);
    for (const message of result.Messages ?? []) {
      if (message.ReceiptHandle) {
        await client.send(
          new DeleteMessageCommand({
            QueueUrl: dlqUrl,
            ReceiptHandle: message.ReceiptHandle,
          }),
        );
      }
    }
  });
});
