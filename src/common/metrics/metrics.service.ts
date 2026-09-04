import { Injectable } from '@nestjs/common';
import {
  metricKey,
  PROMETHEUS_BUCKETS_MS,
  renderMetricLines,
  type LabelSet,
} from './prometheus.js';

export const METRIC_NAMES = {
  walletReconciliationTotal: 'wallet_reconciliation_total',
  walletReconciliationDivergent: 'wallet_reconciliation_divergences',
  wagerTransactionsTotal: 'wager_transactions_total',
  wagerDuplicates: 'wager_duplicates_total',
  outboxPublishRetries: 'outbox_publish_retries_total',
  sqsTransientRetries: 'sqs_transient_retries_total',
  messagesMovedToDlq: 'messages_moved_to_dlq_total',
  dbLockConflicts: 'db_lock_conflicts_total',
  outboxPending: 'outbox_pending',
  outboxLagSeconds: 'outbox_lag_seconds',
  wagerProcessDurationMs: 'wager_process_duration_ms',
} as const;

interface HistogramState {
  count: number;
  sum: number;
  byBucket: Map<number, number>;
}

@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, HistogramState>();

  increment(name: string, by = 1, labels?: LabelSet): number {
    const key = metricKey(name, labels);
    const next = (this.counters.get(key) ?? 0) + by;
    this.counters.set(key, next);
    return next;
  }

  get(name: string, labels?: LabelSet): number {
    return this.counters.get(metricKey(name, labels)) ?? 0;
  }

  setGauge(name: string, value: number, labels?: LabelSet): void {
    this.gauges.set(metricKey(name, labels), value);
  }

  observeHistogram(name: string, value: number): void {
    const state = this.histograms.get(name) ?? {
      count: 0,
      sum: 0,
      byBucket: new Map<number, number>(),
    };
    state.count += 1;
    state.sum += value;
    for (const bucket of PROMETHEUS_BUCKETS_MS) {
      if (value <= bucket) {
        state.byBucket.set(bucket, (state.byBucket.get(bucket) ?? 0) + 1);
      }
    }
    this.histograms.set(name, state);
  }

  /** Legacy: unlabeled counters only (used by reconciliation metrics). */
  snapshot(): Readonly<Record<string, number>> {
    return Object.fromEntries(
      [...this.counters].filter(([key]) => !key.includes('{')),
    );
  }

  renderPrometheus(): string {
    return renderMetricLines(
      [...this.counters].map(([key, value]) => this.toSeries(key, value)),
      [...this.gauges].map(([key, value]) => this.toSeries(key, value)),
      [...this.histograms].map(([name, state]) => ({
        name,
        labels: {},
        count: state.count,
        sum: state.sum,
        byBucket: state.byBucket,
      })),
    );
  }

  private toSeries(
    key: string,
    value: number,
  ): { name: string; labels: LabelSet; value: number } {
    const brace = key.indexOf('{');
    if (brace === -1) {
      return { name: key, labels: {}, value };
    }
    const name = key.slice(0, brace);
    const inner = key.slice(brace + 1, -1);
    const labels: Record<string, string> = {};
    for (const part of inner.split(',')) {
      const eq = part.indexOf('=');
      labels[part.slice(0, eq)] = part.slice(eq + 1).replace(/^"|"$/g, '');
    }
    return { name, labels, value };
  }
}
