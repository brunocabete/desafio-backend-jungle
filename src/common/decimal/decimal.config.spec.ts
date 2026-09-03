import { Decimal } from 'decimal.js';
import {
  DECIMAL_OPTIONS,
  DECIMAL_PRECISION,
  DECIMAL_ROUNDING,
  applyDecimalConfig,
} from './decimal.config.js';
import { DecimalConfigModule } from './decimal-config.module.js';

describe('decimal.js configuration', () => {
  it('declares an explicit rounding mode instead of relying on the library default', () => {
    expect(DECIMAL_ROUNDING).toBe(Decimal.ROUND_HALF_UP);
    expect(DECIMAL_OPTIONS.rounding).toBe(4);
    expect(DECIMAL_OPTIONS.precision).toBe(20);
  });

  it('applies the configured rounding mode and precision to the Decimal constructor', () => {
    Decimal.set({ rounding: Decimal.ROUND_UP, precision: 5 });
    expect(Decimal.rounding).toBe(Decimal.ROUND_UP);

    applyDecimalConfig();

    expect(Decimal.rounding).toBe(DECIMAL_ROUNDING);
    expect(Decimal.rounding).toBe(Decimal.ROUND_HALF_UP);
    expect(Decimal.precision).toBe(DECIMAL_PRECISION);
    expect(Decimal.precision).toBe(20);
  });

  it('keeps rounding deterministic on toFixed through the explicit half-up mode', () => {
    applyDecimalConfig();
    const x = new Decimal('1.005').toFixed(2);
    expect(x).toBe('1.01');
  });
});

describe('DecimalConfigModule', () => {
  it('applies the decimal.js config when the module initializes', () => {
    Decimal.set({ rounding: Decimal.ROUND_DOWN, precision: 3 });

    const module = new DecimalConfigModule();
    module.onModuleInit();

    expect(Decimal.rounding).toBe(Decimal.ROUND_HALF_UP);
    expect(Decimal.precision).toBe(DECIMAL_PRECISION);
  });
});
