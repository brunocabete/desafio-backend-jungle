import {
  CurrencyMismatchError,
  Money,
  type MoneyProps,
} from '../money/money.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../ledger/wallet-ledger-entry.js';

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: MoneyProps;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletBalanceChangeProps {
  entryId: string;
  transactionId: string;
  money: Money;
}

export class InsufficientFundsError extends Error {
  constructor(walletId: string, requested: Money, balance: Money) {
    super(
      `wallet '${walletId}' has balance ${balance.toJSON().amount} ${balance.currency} ` +
        `but ${requested.toJSON().amount} ${requested.currency} was requested`,
    );
    this.name = 'InsufficientFundsError';
  }
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): Wallet {
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      new Date(),
      new Date(),
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      Money.from(state.balance),
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(props: WalletBalanceChangeProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    const balanceAfter = this._balance.subtract(props.money);
    if (balanceAfter.isNegative()) {
      throw new InsufficientFundsError(this.id, props.money, this._balance);
    }
    return this.applyChange(
      props.entryId,
      props.transactionId,
      LedgerDirection.Debit,
      props.money,
      balanceAfter,
    );
  }

  credit(props: WalletBalanceChangeProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    const balanceAfter = this._balance.add(props.money);
    return this.applyChange(
      props.entryId,
      props.transactionId,
      LedgerDirection.Credit,
      props.money,
      balanceAfter,
    );
  }

  private applyChange(
    entryId: string,
    transactionId: string,
    direction: LedgerDirection,
    money: Money,
    balanceAfter: Money,
  ): WalletLedgerEntry {
    const now = new Date();
    const entry = WalletLedgerEntry.create({
      id: entryId,
      walletId: this.id,
      transactionId,
      direction,
      money,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: now,
    });
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = now;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
