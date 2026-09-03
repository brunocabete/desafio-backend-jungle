import { Decimal } from 'decimal.js';

export const MONEY_SCALE = 2;
export const DEFAULT_CURRENCY = 'BRL';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const AMOUNT_PATTERN = /^\d+(?:\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export abstract class MoneyError extends Error {
  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends MoneyError {
  constructor(message: string) {
    super(message);
  }
}

export class CurrencyMismatchError extends MoneyError {
  constructor(currencyA: string, currencyB: string) {
    super(
      `currency mismatch: cannot operate '${currencyA}' with '${currencyB}'`,
    );
  }
}

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    return new Money(
      Money.parseAmount(props.amount),
      Money.parseCurrency(props.currency),
    );
  }

  static zero(currency: string): Money {
    return new Money(new Decimal(0), Money.parseCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(MONEY_SCALE), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(MONEY_SCALE)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static parseAmount(amount: unknown): Decimal {
    if (typeof amount !== 'string' || amount.length === 0) {
      throw new InvalidMoneyError(
        `amount must be a non-empty decimal string, received ${Money.describe(amount)}`,
      );
    }
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        `invalid amount '${amount}': expected a non-negative decimal string with at most ${MONEY_SCALE} decimal places`,
      );
    }
    return new Decimal(amount);
  }

  private static parseCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(
        `invalid currency ${Money.describe(currency)}: expected an ISO-4217 code (e.g. BRL)`,
      );
    }
    return currency;
  }

  private static describe(value: unknown): string {
    return typeof value === 'string' ? `'${value}'` : String(value);
  }
}
