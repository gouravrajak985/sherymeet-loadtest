export interface Distribution {
  count: number;
  min: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Nearest-rank percentiles. Returns null rather than zeros when there is no data. */
export function distribution(values: readonly number[]): Distribution | null {
  const v = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  if (v.length === 0) return null;
  const at = (p: number) => v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))]!;
  return {
    count: v.length,
    min: round1(v[0]!),
    avg: round1(v.reduce((a, b) => a + b, 0) / v.length),
    p50: round1(at(50)),
    p95: round1(at(95)),
    p99: round1(at(99)),
    max: round1(v[v.length - 1]!),
  };
}

export function averageOrNull(values: readonly (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null && Number.isFinite(v));
  return present.length ? round1(present.reduce((a, b) => a + b, 0) / present.length) : null;
}

export function percent(part: number, whole: number): number | null {
  return whole > 0 ? round1((part / whole) * 100) : null;
}
