export const DEFAULT_PERCENTAGE_PRECISION = 2;

export function normalizePercentagePrecision(value: unknown): number {
  if (value === -1) return -1;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100) return value;
  return DEFAULT_PERCENTAGE_PRECISION;
}

export function formatPercentage(value: number, precision: number = DEFAULT_PERCENTAGE_PRECISION): string {
  const normalized = normalizePercentagePrecision(precision);
  return normalized === -1 ? String(value) : value.toFixed(normalized);
}
