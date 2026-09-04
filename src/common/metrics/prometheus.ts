export type LabelSet = Readonly<Record<string, string>>;

export const PROMETHEUS_BUCKETS_MS = [
  5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000,
] as const;

export interface PromSeries {
  name: string;
  labels: LabelSet;
  value: number;
}

export interface PromHistogram {
  name: string;
  labels: LabelSet;
  count: number;
  sum: number;
  /** bucket upper bound (ms) -> cumulative count (value <= bound). */
  byBucket: ReadonlyMap<number, number>;
}

export function formatLabels(labels: LabelSet | undefined): string {
  if (!labels || Object.keys(labels).length === 0) {
    return '';
  }
  const entries = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}="${escapeLabelValue(value)}"`);
  return `{${entries.join(',')}}`;
}

function escapeLabelValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

export function metricKey(name: string, labels?: LabelSet): string {
  return `${name}${formatLabels(labels)}`;
}

export function renderMetricLines(
  counters: PromSeries[],
  gauges: PromSeries[],
  histograms: PromHistogram[],
): string {
  const lines: string[] = [];

  const groups = new Map<
    string,
    { type: 'counter' | 'gauge'; series: PromSeries[] }
  >();
  const push = (type: 'counter' | 'gauge', series: PromSeries[]) => {
    for (const item of series) {
      const group = groups.get(item.name) ?? { type, series: [] };
      group.series.push(item);
      groups.set(item.name, group);
    }
  };
  push('gauge', gauges);
  push('counter', counters);

  for (const name of [...groups.keys()].sort()) {
    const { type, series } = groups.get(name)!;
    lines.push(`# TYPE ${name} ${type}`);
    for (const item of series.sort((a, b) =>
      formatLabels(a.labels).localeCompare(formatLabels(b.labels)),
    )) {
      lines.push(`${item.name}${formatLabels(item.labels)} ${item.value}`);
    }
  }

  for (const histogram of [...histograms].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const labels = formatLabels(histogram.labels);
    lines.push(`# TYPE ${histogram.name} histogram`);
    for (const bucket of PROMETHEUS_BUCKETS_MS) {
      const count = histogram.byBucket.get(bucket) ?? 0;
      lines.push(
        `${histogram.name}_bucket${bucketLabel(labels, bucket)} ${count}`,
      );
    }
    lines.push(
      `${histogram.name}_bucket${bucketLabel(labels, '+Inf')} ${histogram.count}`,
    );
    lines.push(`${histogram.name}_sum${labels} ${histogram.sum}`);
    lines.push(`${histogram.name}_count${labels} ${histogram.count}`);
  }

  return `${lines.join('\n')}\n`;
}

function bucketLabel(base: string, le: number | '+Inf'): string {
  const value = le === '+Inf' ? '+Inf' : String(le);
  if (base.length === 0) {
    return `{le="${value}"}`;
  }
  return `${base.slice(0, -1)},le="${value}"}`;
}
