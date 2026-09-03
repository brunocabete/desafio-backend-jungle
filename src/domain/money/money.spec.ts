import {
  CurrencyMismatchError,
  DEFAULT_CURRENCY,
  InvalidMoneyError,
  MONEY_SCALE,
  Money,
  type MoneyProps,
} from './money.js';

const BRL = 'BRL';
const USD = 'USD';

function money(amount: string, currency: string = BRL): Money {
  return Money.from({ amount, currency });
}

describe('Money.from', () => {
  it('accepts a fixed two-decimal amount', () => {
    const m = money('25.00');
    expect(m.toJSON()).toEqual({ amount: '25.00', currency: BRL });
  });

  it('normalizes integer amounts to the 2-decimal scale', () => {
    expect(money('25').toJSON().amount).toBe('25.00');
    expect(money('0').toJSON().amount).toBe('0.00');
  });

  it('normalizes one-decimal amounts to the 2-decimal scale', () => {
    expect(money('25.5').toJSON().amount).toBe('25.50');
    expect(money('0.1').toJSON().amount).toBe('0.10');
  });

  it('keeps the exact currency code', () => {
    expect(money('1.00', USD).currency).toBe(USD);
  });

  it('serializes amount always as a decimal string with 2 decimal places', () => {
    const serialized = money('100').toJSON().amount;
    expect(serialized).toBe('100.00');
    expect(serialized).toMatch(/^\d+\.\d{2}$/);
  });

  it('exposes the fixed scale constant', () => {
    expect(MONEY_SCALE).toBe(2);
    expect(DEFAULT_CURRENCY).toBe(BRL);
  });

  it('rejects NaN, Infinity and scientific notation', () => {
    for (const amount of [
      'NaN',
      'Infinity',
      '-Infinity',
      '1e3',
      '1E3',
      '1e+3',
      '2.5e2',
    ]) {
      expect(() => money(amount), `amount '${amount}'`).toThrow(
        InvalidMoneyError,
      );
    }
  });

  it('rejects empty and whitespace-only amounts', () => {
    for (const amount of ['', '   ', '\t', ' 25.00', '25.00 ', '2 5']) {
      expect(() => money(amount), `amount '${amount}'`).toThrow(
        InvalidMoneyError,
      );
    }
  });

  it('rejects negative amounts in entry contracts', () => {
    for (const amount of ['-25.00', '-0.00', '-25', '-0.5']) {
      expect(() => money(amount), `amount '${amount}'`).toThrow(
        InvalidMoneyError,
      );
    }
  });

  it('rejects more than 2 decimal places without rounding', () => {
    for (const amount of ['25.001', '0.999', '1.005', '10.000']) {
      expect(() => money(amount), `amount '${amount}'`).toThrow(
        InvalidMoneyError,
      );
    }
  });

  it('rejects malformed numeric strings', () => {
    for (const amount of [
      'abc',
      '25,00',
      '25.',
      '.5',
      '1.2.3',
      '0x10',
      '+25.00',
      '--25.00',
    ]) {
      expect(() => money(amount), `amount '${amount}'`).toThrow(
        InvalidMoneyError,
      );
    }
  });

  it('rejects non-string amounts', () => {
    const amounts: unknown[] = [
      null,
      undefined,
      25,
      25.0,
      NaN,
      Infinity,
      {},
      [],
    ];
    for (const amount of amounts) {
      expect(() => money(amount as unknown as string)).toThrow(
        InvalidMoneyError,
      );
    }
  });

  it('rejects invalid currencies', () => {
    const currencies: unknown[] = [
      '',
      '  ',
      'brl',
      'BRL ',
      ' BRL',
      'BR',
      'BRLL',
      'B1L',
      'US$',
      null,
      undefined,
      123,
    ];
    for (const currency of currencies) {
      expect(
        () =>
          Money.from({
            amount: '25.00',
            currency: currency as unknown as string,
          }),
        `currency '${String(currency)}'`,
      ).toThrow(InvalidMoneyError);
    }
  });

  it('supports any ISO-4217-style currency code', () => {
    for (const currency of ['BRL', 'USD', 'EUR', 'JPY', 'XXX']) {
      expect(money('1.00', currency).currency).toBe(currency);
    }
  });
});

describe('Money.zero', () => {
  it('creates a zeroed Money for the given currency', () => {
    const m = Money.zero(BRL);
    expect(m.toJSON()).toEqual({ amount: '0.00', currency: BRL });
    expect(m.isZero()).toBe(true);
  });

  it('rejects an invalid currency', () => {
    expect(() => Money.zero('')).toThrow(InvalidMoneyError);
  });
});

describe('Money arithmetic', () => {
  it('adds without floating point drift', () => {
    expect(money('0.10').add(money('0.20')).toJSON().amount).toBe('0.30');
  });

  it('adds money of the same currency', () => {
    expect(money('25.00').add(money('15.50')).toJSON().amount).toBe('40.50');
  });

  it('subtracts money of the same currency', () => {
    expect(money('25.00').subtract(money('15.50')).toJSON().amount).toBe(
      '9.50',
    );
  });

  it('may yield a negative result from arithmetic', () => {
    const negative = money('5.00').subtract(money('20.00'));
    expect(negative.toJSON().amount).toBe('-15.00');
    expect(negative.isNegative()).toBe(true);
  });

  it('returns new instances and keeps the receiver immutable', () => {
    const original = money('25.00');
    const result = original.add(money('1.00'));
    expect(result).not.toBe(original);
    expect(original.toJSON().amount).toBe('25.00');
    expect(result.toJSON().amount).toBe('26.00');
  });

  it('negates a value', () => {
    expect(money('25.00').negate().toJSON().amount).toBe('-25.00');
    expect(money('25.00').negate().negate().toJSON().amount).toBe('25.00');
  });

  it('keeps the scale fixed after arithmetic', () => {
    for (const m of [
      money('0.10').add(money('0.20')),
      money('25.00').subtract(money('0.05')),
      money('1.00').negate(),
    ]) {
      expect(m.toJSON().amount).toMatch(/^-?\d+\.\d{2}$/);
    }
  });

  it('rejects arithmetic across different currencies', () => {
    const brl = money('25.00', BRL);
    const usd = money('25.00', USD);
    for (const op of [
      () => brl.add(usd),
      () => usd.add(brl),
      () => brl.subtract(usd),
      () => usd.subtract(brl),
    ]) {
      expect(op).toThrow(CurrencyMismatchError);
    }
  });
});

describe('Money predicates and comparisons', () => {
  it('detects zero, positive and negative', () => {
    expect(money('0.00').isZero()).toBe(true);
    expect(money('0.00').isPositive()).toBe(false);
    expect(money('0.00').isNegative()).toBe(false);
    expect(money('5.00').isPositive()).toBe(true);
    expect(money('5.00').isZero()).toBe(false);
    const negative = money('5.00').subtract(money('10.00'));
    expect(negative instanceof Money).toBe(true);
    expect(negative.isNegative()).toBe(true);
    expect(negative.isZero()).toBe(false);
  });

  it('compares with isLessThan', () => {
    expect(money('5.00').isLessThan(money('10.00'))).toBe(true);
    expect(money('10.00').isLessThan(money('5.00'))).toBe(false);
    expect(money('5.00').isLessThan(money('5.00'))).toBe(false);
  });

  it('rejects isLessThan across different currencies', () => {
    expect(() => money('5.00', BRL).isLessThan(money('5.00', USD))).toThrow(
      CurrencyMismatchError,
    );
  });

  it('equals compares amount and currency', () => {
    expect(money('5.00').equals(money('5.00'))).toBe(true);
    expect(money('5').equals(money('5.00'))).toBe(true);
    expect(money('5.00').equals(money('5.01'))).toBe(false);
    expect(money('5.00', BRL).equals(money('5.00', USD))).toBe(false);
  });

  it('equals does not throw for a currency mismatch', () => {
    expect(() => money('5.00', BRL).equals(money('5.00', USD))).not.toThrow();
  });
});

describe('Money serialization', () => {
  it('toJSON returns a MoneyProps-compatible object', () => {
    const m = money('25.00');
    const props: MoneyProps = m.toJSON();
    expect(props).toEqual({ amount: '25.00', currency: BRL });
  });

  it('toString renders amount with scale and currency', () => {
    expect(money('25.00').toString()).toBe('25.00 BRL');
    expect(money('0.00').toString()).toBe('0.00 BRL');
  });

  it('round-trips through JSON', () => {
    const m = money('25.00');
    const roundTripped = Money.from(
      JSON.parse(JSON.stringify(m)) as MoneyProps,
    );
    expect(roundTripped.equals(m)).toBe(true);
  });
});
