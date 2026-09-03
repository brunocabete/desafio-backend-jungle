import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { WagerTransactionService } from './wager-transaction.service.js';

const DEFAULT_POLL_INTERVAL_MS = 2_000;

@Injectable()
export class PendingReferenceScheduler
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(PendingReferenceScheduler.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    private readonly wagerTransactionService: WagerTransactionService,
  ) {}

  onApplicationBootstrap(): void {
    const pollMs = Number(process.env.WAGER_PENDING_WORKER_POLL_MS);
    const interval = Number.isFinite(pollMs)
      ? pollMs
      : DEFAULT_POLL_INTERVAL_MS;
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
    }
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const handled =
        await this.wagerTransactionService.reprocessPendingReferences();
      if (handled > 0) {
        this.logger.log(
          `pending reference worker reprocessed ${handled} transaction(s)`,
        );
      }
    } catch (error) {
      this.logger.error(
        `pending reference worker failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
