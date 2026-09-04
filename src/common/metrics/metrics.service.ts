import { Injectable } from '@nestjs/common';

export const METRIC_NAMES = {
  walletReconciliationTotal: 'wallet_reconciliation_total',
  walletReconciliationDivergent: 'wallet_reconciliation_divergences',
} as const;

export type MetricName = (typeof METRIC_NAMES)[keyof typeof METRIC_NAMES];

@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, number>();

  increment(name: MetricName, by = 1): number {
    const next = (this.counters.get(name) ?? 0) + by;
    this.counters.set(name, next);
    return next;
  }

  get(name: MetricName): number {
    return this.counters.get(name) ?? 0;
  }

  snapshot(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.counters);
  }
}
