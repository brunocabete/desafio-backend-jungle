import { MikroORM } from '@mikro-orm/core';
import { writeFileSync } from 'node:fs';
import { WagerTransactionService } from '../../src/wagering/wager-transaction.service.js';
import { AwsWagerSqsGateway } from '../../src/sqs/wager-sqs.gateway.js';
import { WagerSqsConsumerService } from '../../src/sqs/wager-sqs.consumer.js';
import {
  parseWagerQueueMessage,
  WAGER_CONSUMER_NAME,
} from '../../src/sqs/sqs-message.js';
import { sqsEnv } from '../../src/common/config/sqs.js';
import { ormOptionsFor } from '../test-db.js';

/**
 * Child-process worker for the crash-recovery e2e matrix (§13 items 3.5/3.8).
 *
 * Spawned by test/crash-recovery.e2e.test.ts. Each process boots its own
 * MikroORM + the real SQS consumer (shared use case + inbox + ack) against a
 * dedicated FIFO queue, i.e. an independent application instance.
 *
 * Modes:
 * - 'poll'  (default): consumes until the queue is drained (a poll returns no
 *   message) and then exits cleanly — used as the restarted instance. Never
 *   killed while blocked on a long-poll, which keeps the emulator FIFO sane.
 * - 'crash': receives a single message, settles it via the shared use case
 *   (commit: wallet/ledger/wager/inbox), writes a checkpoint with the receipt
 *   handle, then hangs — reproducing exactly a process that committed but was
 *   killed BEFORE acking. The parent SIGKILLs it and redelivers the message.
 */

function need(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing env var ${name}`);
  }
  return value;
}

async function run(): Promise<number> {
  const dbName = need('WORKER_DB_NAME');
  const mode = process.env.WORKER_MODE ?? 'poll';
  const orm = await MikroORM.init(ormOptionsFor(dbName));
  const service = new WagerTransactionService(orm);
  const gateway = new AwsWagerSqsGateway(sqsEnv());
  const consumer = new WagerSqsConsumerService(service, gateway);

  try {
    if (mode === 'crash') {
      await crashOnce(orm, service, gateway);
      return 0;
    }
    for (;;) {
      try {
        const handled = await consumer.pollOnce();
        if (handled === 0) {
          return 0;
        }
      } catch (error) {
        process.stderr.write(
          `sqs consumer worker failed: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
        return 1;
      }
    }
  } finally {
    await orm.close(true);
  }
}

async function crashOnce(
  orm: MikroORM,
  service: WagerTransactionService,
  gateway: AwsWagerSqsGateway,
): Promise<void> {
  const checkpoint = need('WORKER_CHECKPOINT');
  const messages = await gateway.receive();
  if (messages.length === 0) {
    writeFileSync(checkpoint, JSON.stringify({ committed: false }));
    return;
  }
  const message = messages[0];
  const parsed = parseWagerQueueMessage(message.body);
  const settled = await service.submit(parsed.data, {
    consumerName: WAGER_CONSUMER_NAME,
    messageId: parsed.messageId,
    payloadHash: parsed.payloadHash,
  });
  writeFileSync(
    checkpoint,
    JSON.stringify({
      committed: true,
      receiptHandle: message.receiptHandle,
      systemMessageId: message.systemMessageId,
      messageId: parsed.messageId,
      status: settled.status,
    }),
  );
  // Commit happened, ack deliberately skipped: hang until the parent SIGKILLs.
  await new Promise<void>(() => setInterval(() => undefined, 1 << 30));
}

void run().then((code) => process.exit(code));
