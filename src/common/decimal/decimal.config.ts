import { Decimal } from 'decimal.js';

export const DECIMAL_PRECISION = 20;
export const DECIMAL_ROUNDING = Decimal.ROUND_HALF_UP;

export const DECIMAL_OPTIONS = {
  precision: DECIMAL_PRECISION,
  rounding: DECIMAL_ROUNDING,
} as const satisfies Decimal.Config;

export function applyDecimalConfig(): void {
  Decimal.set({ ...DECIMAL_OPTIONS, defaults: true });
}
