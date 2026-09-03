import { Money, type MoneyProps } from '../money/money.js';
import {
  LedgerDirection,
  invertLedgerDirection,
} from '../ledger/wallet-ledger-entry.js';
import {
  isFailureCode,
  type FailureCode as FailureCodeType,
} from '../failure-code.js';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCodeType;
  processedAt?: Date;
}

export class InvalidWagerTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWagerTransactionError';
  }
}

export class MissingReferenceError extends InvalidWagerTransactionError {
  constructor(kind: WagerTransactionKind) {
    super(`transaction kind ${kind} requires referenceExternalTransactionId`);
    this.name = 'MissingReferenceError';
  }
}

export class InvalidTransactionStateError extends InvalidWagerTransactionError {
  constructor(
    transactionId: string,
    current: WagerTransactionStatus,
    action: string,
  ) {
    super(
      `transaction '${transactionId}' in state ${current} cannot ${action}`,
    );
    this.name = 'InvalidTransactionStateError';
  }
}

type TransitionAction = 'process' | 'await reference' | 'reject' | 'fail';

const ALLOWED_TRANSITIONS: Record<
  TransitionAction,
  readonly WagerTransactionStatus[]
> = {
  process: [
    WagerTransactionStatus.Pending,
    WagerTransactionStatus.PendingReference,
  ],
  'await reference': [WagerTransactionStatus.Pending],
  reject: [
    WagerTransactionStatus.Pending,
    WagerTransactionStatus.PendingReference,
  ],
  fail: [
    WagerTransactionStatus.Pending,
    WagerTransactionStatus.PendingReference,
  ],
};

const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCodeType,
    private _processedAt?: Date,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.idempotencyKey.trim().length === 0) {
      throw new InvalidWagerTransactionError(
        'idempotencyKey is required and cannot be empty',
      );
    }
    if (props.payloadHash.trim().length === 0) {
      throw new InvalidWagerTransactionError(
        'payloadHash is required and cannot be empty',
      );
    }
    if (WagerTransaction.requiresReference(props.kind)) {
      if (!props.referenceExternalTransactionId) {
        throw new MissingReferenceError(props.kind);
      }
    } else if (props.kind === WagerTransactionKind.Opening) {
      if (props.referenceExternalTransactionId) {
        throw new InvalidWagerTransactionError(
          `OPENING transactions cannot carry a reference`,
        );
      }
    }
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      Money.from(state.money),
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCodeType | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertCanTransition('process');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._failureCode = undefined;
    this._processedAt = at;
  }

  markPendingReference(): void {
    this.assertCanTransition('await reference');
    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCodeType): void {
    this.assertCode(code);
    this.assertCanTransition('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
  }

  fail(code: FailureCodeType): void {
    this.assertCode(code);
    this.assertCanTransition('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return WagerTransaction.requiresReference(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        if (!reference) {
          throw new InvalidWagerTransactionError(
            `ROLLBACK '${this.id}' needs the referenced transaction to derive its ledger direction`,
          );
        }
        return invertLedgerDirection(reference.ledgerDirectionFor());
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError(
          `LOSS '${this.id}' does not move balance and has no ledger direction`,
        );
    }
  }

  private assertCanTransition(action: TransitionAction): void {
    const allowed = ALLOWED_TRANSITIONS[action];
    if (!allowed.includes(this._status)) {
      throw new InvalidTransactionStateError(this.id, this._status, action);
    }
  }

  private assertCode(code: FailureCodeType): void {
    if (!isFailureCode(code)) {
      throw new InvalidWagerTransactionError(
        `'${String(code)}' is not a registered FailureCode`,
      );
    }
  }

  private static requiresReference(kind: WagerTransactionKind): boolean {
    return (
      kind === WagerTransactionKind.Refund ||
      kind === WagerTransactionKind.Rollback
    );
  }
}
