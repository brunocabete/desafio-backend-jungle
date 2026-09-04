import {
  CurrencyMismatchError,
  Money,
  type MoneyProps,
} from '../money/money.js';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export function invertLedgerDirection(
  direction: LedgerDirection,
): LedgerDirection {
  return direction === LedgerDirection.Debit
    ? LedgerDirection.Credit
    : LedgerDirection.Debit;
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: Date;
}

export class InvalidLedgerEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLedgerEntryError';
  }
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    private readonly _createdAt: Date,
  ) {}

  get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    WalletLedgerEntry.assertSameCurrency(
      props.balanceBefore,
      props.balanceAfter,
      props.money,
    );
    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      new Date(props.createdAt.getTime()),
    );
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        `ledger entry '${props.id}' is not balanced: ${props.direction} of ` +
          `${props.money.toJSON().amount} from ${props.balanceBefore.toJSON().amount} ` +
          `does not equal ${props.balanceAfter.toJSON().amount}`,
      );
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      Money.from(state.money),
      Money.from(state.balanceBefore),
      Money.from(state.balanceAfter),
      new Date(state.createdAt.getTime()),
    );
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Debit
        ? this.balanceBefore.subtract(this.money)
        : this.balanceBefore.add(this.money);
    return expected.equals(this.balanceAfter);
  }

  private static assertSameCurrency(...moneys: Money[]): void {
    const reference = moneys[0].currency;
    for (const money of moneys) {
      if (money.currency !== reference) {
        throw new CurrencyMismatchError(reference, money.currency);
      }
    }
  }
}
