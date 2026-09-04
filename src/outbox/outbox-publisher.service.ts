import { Inject, Injectable, Logger } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import { OutboxMessageEntity } from '../db/entities/outbox-message.entity.js';
import {
  OUTBOX_RETRY_BASE_DELAY_MS,
  OUTBOX_RETRY_MAX_DELAY_MS,
} from '../domain/outbox/outbox-message.js';
import {
  OUTBOX_PUBLISHER,
  type OutboxPublisherGateway,
} from './outbox-publisher.gateway.js';

export const OUTBOX_DEFAULT_BATCH = 100;
export const OUTBOX_DEFAULT_POLL_MS = 1_000;
export const OUTBOX_CLAIM_LEASE_MS = 30_000;

export function outboxRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(
    OUTBOX_RETRY_BASE_DELAY_MS * 2 ** exponent,
    OUTBOX_RETRY_MAX_DELAY_MS,
  );
}

interface OutboxRow {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | null;
  publishedAt: Date | null;
}

type PublishOutcome = 'published' | 'skipped' | 'failed';

export interface OutboxPublishStats {
  due: number;
  published: number;
  skipped: number;
  failed: number;
}

@Injectable()
export class OutboxPublisherService {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    private readonly orm: MikroORM,
    @Inject(OUTBOX_PUBLISHER) private readonly gateway: OutboxPublisherGateway,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.WAGER_OUTBOX_PUBLISHER_ENABLED !== 'true') {
      return;
    }
    const pollMs = Number(process.env.WAGER_OUTBOX_POLL_MS);
    const interval = Number.isFinite(pollMs) ? pollMs : OUTBOX_DEFAULT_POLL_MS;
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

  async publishDue(
    now = new Date(),
    limit = OUTBOX_DEFAULT_BATCH,
  ): Promise<OutboxPublishStats> {
    const em = this.orm.em.fork();
    const due = (await em.find(
      OutboxMessageEntity,
      {
        publishedAt: null,
        $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
      },
      {
        orderBy: { occurredAt: 'ASC', id: 'ASC' },
        limit,
      },
    )) as unknown as OutboxRow[];

    const stats: OutboxPublishStats = {
      due: due.length,
      published: 0,
      skipped: 0,
      failed: 0,
    };
    for (const row of due) {
      const outcome = await this.publishOne(row, now);
      stats[outcome] += 1;
    }
    return stats;
  }

  private async publishOne(row: OutboxRow, now: Date): Promise<PublishOutcome> {
    const claimedAttempts = await this.claim(row.id, now);
    if (claimedAttempts === null) {
      return 'skipped';
    }
    try {
      await this.gateway.publish(row.payload, row.aggregateId);
    } catch (error) {
      await this.scheduleRetry(row.id, claimedAttempts, now);
      this.logger.warn(
        `outbox publish failed for '${row.id}' (attempt ${claimedAttempts}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 'failed';
    }
    const finalized = await this.markPublished(
      row.id,
      claimedAttempts,
      new Date(),
    );
    return finalized ? 'published' : 'skipped';
  }

  /**
   * Atomic claim (compare-and-set): increments attempts and leases the row in a
   * single guarded UPDATE. Concurrent publishers racing on the same row get
   * zero affected rows and skip — no double claim, no lost update.
   */
  private async claim(rowId: string, now: Date): Promise<number | null> {
    const em = this.orm.em.fork();
    const lease = new Date(now.getTime() + OUTBOX_CLAIM_LEASE_MS);
    const result = (await em
      .getConnection()
      .execute(
        `update "outbox_message" set "attempts" = "attempts" + 1, "next_attempt_at" = ? where "id" = ? and "published_at" is null and ("next_attempt_at" is null or "next_attempt_at" <= ?) returning "attempts"`,
        [lease, rowId, now],
        'get',
      )) as unknown as { attempts: number } | undefined;
    return result ? Number(result.attempts) : null;
  }

  /** Failure path: schedules the exponential backoff for the owning attempt. */
  private async scheduleRetry(
    rowId: string,
    claimedAttempts: number,
    now: Date,
  ): Promise<void> {
    const em = this.orm.em.fork();
    const retryAt = new Date(
      now.getTime() + outboxRetryDelayMs(claimedAttempts),
    );
    await em
      .getConnection()
      .execute(
        `update "outbox_message" set "next_attempt_at" = ? where "id" = ? and "published_at" is null and "attempts" = ?`,
        [retryAt, rowId, claimedAttempts],
        'run',
      );
  }

  /**
   * Success path: marks published, but only if this attempt still owns the row
   * (attempts guard). A stale publisher that lost a race never overwrites.
   */
  private async markPublished(
    rowId: string,
    claimedAttempts: number,
    at: Date,
  ): Promise<boolean> {
    const em = this.orm.em.fork();
    const result = (await em
      .getConnection()
      .execute(
        `update "outbox_message" set "published_at" = ?, "next_attempt_at" = null where "id" = ? and "published_at" is null and "attempts" = ? returning "id"`,
        [at, rowId, claimedAttempts],
        'get',
      )) as unknown as { id: string } | undefined;
    return result !== undefined;
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const stats = await this.publishDue();
      if (stats.published > 0) {
        this.logger.log(
          `outbox publisher: published ${stats.published}/${stats.due} event(s)`,
        );
      } else if (stats.failed > 0) {
        this.logger.warn(
          `outbox publisher: ${stats.failed} event(s) failed and were rescheduled`,
        );
      }
    } catch (error) {
      this.logger.error(
        `outbox publisher failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
