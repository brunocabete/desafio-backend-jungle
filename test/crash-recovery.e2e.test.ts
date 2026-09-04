import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WagerTransactionEntity } from '../src/db/entities/wager-transaction.entity.js';
import { WalletLedgerEntryEntity } from '../src/db/entities/wallet-ledger-entry.entity.js';
import { InboxMessageEntity } from '../src/db/entities/inbox-message.entity.js';
import { WalletEntity } from '../src/db/entities/wallet.entity.js';
import { WalletService } from '../src/wallets/wallet.service.js';
import { MetricsService } from '../src/common/metrics/metrics.service.js';
import { createSqsClient, sqsEnv } from '../src/common/config/sqs.js';
import { WAGER_CONSUMER_NAME } from '../src/sqs/sqs-message.js';
import { ormOptionsFor, dropDatabaseIfExists } from './test-db.js';
import { testDatabaseName } from './test-names.js';

const TEST_DB = testDatabaseName('desafio_jungle_crash_test');
const WORKER = resolve('test/processes/sqs-consumer-worker.ts');
const WORKER_TIMEOUT_MS = 30_000;
const WAIT_TIMEOUT_MS = 60_000;
const BET_AMOUNT = '25.00';

interface Wallet {
  id: string;
  playerId: string;
}

interface WorkerHandle {
  pid: number;
  exited: Promise<number | null>;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
}

interface SqsQueues {
  mainName: string;
  dlqName: string;
  mainUrl: string;
  dlqUrl: string;
}

describe('crash recovery (e2e, real processes + Ministack + Postgres)', () => {
  let orm: MikroORM;
  let walletService: WalletService;
  let client: SQSClient;
  let queues: SqsQueues;
  let previousAws: Record<string, string | undefined>;

  beforeAll(async () => {
    previousAws = {
      AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL,
      AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION,
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    };
    process.env.AWS_ENDPOINT_URL = 'http://localhost:4566';
    process.env.AWS_DEFAULT_REGION = 'us-east-1';
    process.env.AWS_ACCESS_KEY_ID = 'test';
    process.env.AWS_SECRET_ACCESS_KEY = 'test';

    await dropDatabaseIfExists(TEST_DB);
    orm = await MikroORM.init(ormOptionsFor(TEST_DB));
    await orm.migrator.up();
    walletService = new WalletService(orm, new MetricsService());

    client = createSqsClient(sqsEnv());
    queues = await createQueuePair(`crash-${randomUUID().slice(0, 8)}`);
  }, 120_000);

  afterAll(async () => {
    if (client) {
      await drainQueue(queues.mainUrl);
      await client.send(new DeleteQueueCommand({ QueueUrl: queues.mainUrl }));
      await client.send(new DeleteQueueCommand({ QueueUrl: queues.dlqUrl }));
      client.destroy();
    }
    if (orm) {
      await orm.close(true);
    }
    await dropDatabaseIfExists(TEST_DB);
    for (const [key, value] of Object.entries(previousAws)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }, 120_000);

  // ---------- SQS helpers ----------

  async function createQueuePair(prefix: string): Promise<SqsQueues> {
    const dlqName = `${prefix}-dlq.fifo`;
    const mainName = `${prefix}.fifo`;
    const dlqUrl = await createFifoQueue(dlqName);
    const dlqArn = await queueArn(dlqUrl);
    const mainUrl = await createFifoQueue(mainName, {
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: dlqArn,
        maxReceiveCount: '5',
      }),
    });
    return { mainName, dlqName, mainUrl, dlqUrl };
  }

  async function createFifoQueue(
    name: string,
    attributes: Record<string, string> = {},
  ): Promise<string> {
    const result = await client.send(
      new CreateQueueCommand({
        QueueName: name,
        Attributes: { FifoQueue: 'true', ...attributes },
      }),
    );
    if (!result.QueueUrl) {
      throw new Error(`no queue url for '${name}'`);
    }
    return result.QueueUrl;
  }

  async function queueArn(url: string): Promise<string> {
    const result = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: url,
        AttributeNames: ['QueueArn'],
      }),
    );
    const arn = result.Attributes?.QueueArn;
    if (!arn) {
      throw new Error(`no arn for queue '${url}'`);
    }
    return arn;
  }

  async function sendWager(
    messageId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await client.send(
      new SendMessageCommand({
        QueueUrl: queues.mainUrl,
        MessageGroupId: `group-${messageId}`,
        MessageDeduplicationId: `dedup-${messageId}-${randomUUID().slice(0, 8)}`,
        MessageBody: JSON.stringify({
          messageId,
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data,
        }),
      }),
    );
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

  // ---------- process helpers ----------

  function spawnWorker(extraEnv: Record<string, string>): WorkerHandle {
    const proc = Bun.spawn({
      cmd: [process.execPath, WORKER],
      cwd: resolve('.'),
      env: {
        ...process.env,
        WORKER_DB_NAME: TEST_DB,
        AWS_SQS_QUEUE: queues.mainName,
        AWS_SQS_DLQ_QUEUE: queues.dlqName,
        ...extraEnv,
      },
      stdout: process.env.WORKER_DEBUG === '1' ? 'inherit' : 'ignore',
      stderr: process.env.WORKER_DEBUG === '1' ? 'inherit' : 'ignore',
    });
    return {
      pid: proc.pid,
      exited: proc.exited,
      kill(signal: 'SIGTERM' | 'SIGKILL') {
        try {
          process.kill(proc.pid, signal);
        } catch {
          // already gone
        }
      },
    };
  }

  async function waitExit(
    worker: WorkerHandle,
    timeoutMs = WORKER_TIMEOUT_MS,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        worker.exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            worker.kill('SIGKILL');
            reject(new Error(`worker ${worker.pid} did not exit in time`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  function tmpFile(prefix: string): string {
    return join(
      tmpdir(),
      `${prefix}-${process.pid}-${randomUUID().slice(0, 8)}.json`,
    );
  }

  async function waitFor(
    describe: string,
    predicate: () => Promise<boolean>,
    timeoutMs = WAIT_TIMEOUT_MS,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await predicate()) {
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${describe}`);
      }
      await Bun.sleep(250);
    }
  }

  // ---------- data helpers ----------

  async function createWallet(balance: string): Promise<Wallet> {
    const wallet = await walletService.create({
      playerId: randomUUID(),
      initialBalance: { amount: balance, currency: 'BRL' },
    });
    return { id: wallet.id, playerId: wallet.playerId };
  }

  function wagerData(
    wallet: Wallet,
    providerId: string,
    externalTransactionId: string,
  ): Record<string, unknown> {
    return {
      providerId,
      externalTransactionId,
      idempotencyKey: `${providerId}:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-crash',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: BET_AMOUNT, currency: 'BRL' },
    };
  }

  async function walletRow(walletId: string) {
    const row = await orm.em.fork().findOne(WalletEntity, { id: walletId });
    return row as unknown as { balanceAmount: string; version: number };
  }

  async function debitCount(walletId: string): Promise<number> {
    return orm.em.fork().count(WalletLedgerEntryEntity, {
      walletId,
      direction: 'DEBIT',
    });
  }

  async function wagerRows(walletId: string, providerId: string) {
    return orm.em.fork().find(WagerTransactionEntity, {
      walletId,
      providerId,
    });
  }

  async function inboxCount(messageIds: string[]): Promise<number> {
    return orm.em.fork().count(InboxMessageEntity, {
      consumerName: WAGER_CONSUMER_NAME,
      messageId: { $in: messageIds },
    });
  }

  async function ledgerTotal(walletId: string): Promise<string> {
    const row = (await orm.em
      .getConnection()
      .execute(
        `select coalesce(sum(case when direction = 'CREDIT' then money_amount else -money_amount end), 0)::text as total from wallet_ledger_entry where wallet_id = ?`,
        [walletId],
        'get',
      )) as { total: string };
    return row.total;
  }

  it('does not duplicate a settled wager whose worker was killed after commit, before ack (§13.5)', async () => {
    await drainQueue(queues.mainUrl);
    const wallet = await createWallet('100.00');
    const provider = `provider-${randomUUID().slice(0, 8)}`;
    const external = `bet-crash-${randomUUID().slice(0, 12)}`;
    const messageId = `msg-${randomUUID().slice(0, 12)}`;
    const data = wagerData(wallet, provider, external);
    await sendWager(messageId, data);

    // Worker #1 receives, commits (wallet + ledger + wager + inbox), then is
    // SIGKILLed before it can ack.
    const checkpoint = tmpFile('crash-checkpoint');
    const doomed = spawnWorker({
      WORKER_MODE: 'crash',
      WORKER_CHECKPOINT: checkpoint,
    });
    await waitFor('crash worker to commit', async () => {
      try {
        return JSON.parse(readFileSync(checkpoint, 'utf8')).committed === true;
      } catch {
        return false;
      }
    });
    doomed.kill('SIGKILL');
    await waitExit(doomed);
    expect((await wagerRows(wallet.id, provider)).length).toBe(1);
    expect(await debitCount(wallet.id)).toBe(1);

    // The broker redelivers (at-least-once): same message id + payload arrives
    // again. A restarted instance must not duplicate the effect.
    await sendWager(messageId, data);
    const restarted = spawnWorker({});
    await waitExit(restarted);
    rmSync(checkpoint, { force: true });

    const rows = await wagerRows(wallet.id, provider);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('PROCESSED');
    expect(await debitCount(wallet.id)).toBe(1);
    expect(await inboxCount([messageId])).toBe(1);
    expect(await walletRow(wallet.id)).toMatchObject({
      balanceAmount: '75.00',
    });
    expect(await ledgerTotal(wallet.id)).toBe('75.00');
    await expect(drainQueue(queues.mainUrl)).resolves.toBe(0);
  }, 120_000);

  it('restarts the service mid-work and proves final consistency (§13.8)', async () => {
    await drainQueue(queues.mainUrl);
    const wallet = await createWallet('1000.00');
    const provider = `provider-${randomUUID().slice(0, 8)}`;

    const messageIds: string[] = [];
    const sendBatch = async (count: number, prefix: string): Promise<void> => {
      for (let i = 0; i < count; i += 1) {
        const external = `${prefix}-${i}`;
        const messageId = `msg-${prefix}-${i}`;
        messageIds.push(messageId);
        await sendWager(messageId, wagerData(wallet, provider, external));
      }
    };

    // First instance settles the first batch, then stops (the service is down
    // while more wagers arrive). Restarting must not lose or duplicate effects.
    await sendBatch(3, `restart-a-${randomUUID().slice(0, 8)}`);
    const first = spawnWorker({});
    await waitExit(first);
    expect((await wagerRows(wallet.id, provider)).length).toBe(3);

    // More wagers arrive while the service is down; a restarted instance must
    // drain everything with no loss and no duplication of the first batch.
    await sendBatch(3, `restart-b-${randomUUID().slice(0, 8)}`);
    const second = spawnWorker({});
    await waitExit(second);

    const rows = await wagerRows(wallet.id, provider);
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.status).toBe('PROCESSED');
    }
    expect(await debitCount(wallet.id)).toBe(6);
    expect(await inboxCount(messageIds)).toBe(6);
    expect(await walletRow(wallet.id)).toMatchObject({
      balanceAmount: '850.00',
      version: 7,
    });
    expect(await ledgerTotal(wallet.id)).toBe('850.00');
    await expect(drainQueue(queues.mainUrl)).resolves.toBe(0);
  }, 120_000);
});
