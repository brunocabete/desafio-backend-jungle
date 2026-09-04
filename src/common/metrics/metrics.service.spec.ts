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
});
