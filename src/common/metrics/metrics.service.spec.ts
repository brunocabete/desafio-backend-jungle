import { METRIC_NAMES, MetricsService } from './metrics.service.js';

describe('MetricsService', () => {
  it('starts every counter at zero', () => {
    const metrics = new MetricsService();
    expect(metrics.get(METRIC_NAMES.walletReconciliationTotal)).toBe(0);
    expect(metrics.get(METRIC_NAMES.walletReconciliationDivergent)).toBe(0);
    expect(metrics.snapshot()).toEqual({});
  });

  it('increments a named counter and returns the new value', () => {
    const metrics = new MetricsService();
    expect(metrics.increment(METRIC_NAMES.walletReconciliationDivergent)).toBe(
      1,
    );
    expect(metrics.increment(METRIC_NAMES.walletReconciliationDivergent)).toBe(
      2,
    );
    expect(metrics.get(METRIC_NAMES.walletReconciliationDivergent)).toBe(2);
  });

  it('supports incrementing by an arbitrary amount', () => {
    const metrics = new MetricsService();
    metrics.increment(METRIC_NAMES.walletReconciliationTotal, 5);
    expect(metrics.get(METRIC_NAMES.walletReconciliationTotal)).toBe(5);
  });

  it('returns a point-in-time snapshot', () => {
    const metrics = new MetricsService();
    metrics.increment(METRIC_NAMES.walletReconciliationTotal, 2);
    metrics.increment(METRIC_NAMES.walletReconciliationDivergent);
    expect(metrics.snapshot()).toEqual({
      [METRIC_NAMES.walletReconciliationTotal]: 2,
      [METRIC_NAMES.walletReconciliationDivergent]: 1,
    });
  });

  it('counts labeled series independently', () => {
    const metrics = new MetricsService();
    metrics.increment(METRIC_NAMES.wagerTransactionsTotal, 1, {
      status: 'PROCESSED',
    });
    metrics.increment(METRIC_NAMES.wagerTransactionsTotal, 2, {
      status: 'REJECTED',
    });
    expect(
      metrics.get(METRIC_NAMES.wagerTransactionsTotal, { status: 'PROCESSED' }),
    ).toBe(1);
    expect(
      metrics.get(METRIC_NAMES.wagerTransactionsTotal, { status: 'REJECTED' }),
    ).toBe(2);
    expect(
      metrics.get(METRIC_NAMES.wagerTransactionsTotal, { status: 'PENDING' }),
    ).toBe(0);
    expect(metrics.snapshot()).toEqual({});
  });

  it('tracks gauges and histograms', () => {
    const metrics = new MetricsService();
    metrics.setGauge(METRIC_NAMES.outboxPending, 7);
    metrics.observeHistogram(METRIC_NAMES.wagerProcessDurationMs, 4);
    metrics.observeHistogram(METRIC_NAMES.wagerProcessDurationMs, 120);

    const text = metrics.renderPrometheus();
    expect(text).toContain('# TYPE outbox_pending gauge');
    expect(text).toContain('outbox_pending 7');
    expect(text).toContain('# TYPE wager_process_duration_ms histogram');
    expect(text).toContain('wager_process_duration_ms_bucket{le="5"} 1');
    expect(text).toContain('wager_process_duration_ms_bucket{le="100"} 1');
    expect(text).toContain('wager_process_duration_ms_bucket{le="250"} 2');
    expect(text).toContain('wager_process_duration_ms_sum 124');
    expect(text).toContain('wager_process_duration_ms_count 2');
  });
});
