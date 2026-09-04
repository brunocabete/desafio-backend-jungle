import {
  formatLabels,
  metricKey,
  PROMETHEUS_BUCKETS_MS,
  renderMetricLines,
} from './prometheus.js';

describe('prometheus formatters', () => {
  it('formats no labels as empty and sorts labeled keys', () => {
    expect(formatLabels(undefined)).toBe('');
    expect(formatLabels({})).toBe('');
    expect(formatLabels({ status: 'PROCESSED' })).toBe('{status="PROCESSED"}');
    expect(formatLabels({ b: '2', a: '1' })).toBe('{a="1",b="2"}');
    expect(formatLabels({ kind: 'a"b\nc' })).toBe('{kind="a\\"b\\nc"}');
    expect(metricKey('wager_transactions_total', { status: 'BET' })).toBe(
      'wager_transactions_total{status="BET"}',
    );
  });

  it('renders counters, gauges and histograms in exposition format', () => {
    const buckets = new Map<number, number>([
      [5, 1],
      [10, 1],
    ]);
    const text = renderMetricLines(
      [
        {
          name: 'wager_transactions_total',
          labels: { status: 'PROCESSED' },
          value: 3,
        },
      ],
      [{ name: 'outbox_pending', labels: {}, value: 2 }],
      [
        {
          name: 'wager_process_duration_ms',
          labels: {},
          count: 1,
          sum: 4,
          byBucket: buckets,
        },
      ],
    );

    expect(text).toContain('# TYPE wager_transactions_total counter');
    expect(text).toContain('wager_transactions_total{status="PROCESSED"} 3');
    expect(text).toContain('# TYPE outbox_pending gauge');
    expect(text).toContain('outbox_pending 2');
    expect(text).toContain('# TYPE wager_process_duration_ms histogram');
    expect(text).toContain('wager_process_duration_ms_bucket{le="5"} 1');
    expect(text).toContain(`wager_process_duration_ms_bucket{le="10"} 1`);
    expect(text).toContain(
      `wager_process_duration_ms_bucket{le="${PROMETHEUS_BUCKETS_MS.at(-1)}"} 0`,
    );
    expect(text).toContain('wager_process_duration_ms_bucket{le="+Inf"} 1');
    expect(text).toContain('wager_process_duration_ms_sum 4');
    expect(text).toContain('wager_process_duration_ms_count 1');
  });
});
