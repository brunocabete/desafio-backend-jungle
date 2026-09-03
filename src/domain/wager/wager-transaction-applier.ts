import { randomUUID } from 'node:crypto';
import { FailureCode } from '../failure-code.js';
import { Wallet } from '../wallet/wallet.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../ledger/wallet-ledger-entry.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../wager-transaction/wager-transaction.js';

export type WagerApplyResult =
  | { kind: 'processed'; entry?: WalletLedgerEntry }
  | { kind: 'rejected'; failureCode: FailureCode }
  | { kind: 'pendingReference' };

export interface ApplyWagerTransactionProps {
  wallet: Wallet;
  transaction: WagerTransaction;
  reference?: WagerTransaction;
  referenceAlreadyReversed?: boolean;
  now?: Date;
}

const ROLLBACK_REFERENCEABLE_KINDS = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Refund,
];

export function applyWagerTransaction(
  props: ApplyWagerTransactionProps,
): WagerApplyResult {
  const { wallet, transaction, now = new Date() } = props;

  if (transaction.status !== WagerTransactionStatus.Pending) {
    throw new Error(
      `transaction '${transaction.id}' must be PENDING to be applied, found ${transaction.status}`,
    );
  }
  if (wallet.id !== transaction.walletId) {
    throw new Error(
      `wallet '${wallet.id}' does not belong to transaction '${transaction.id}'`,
    );
  }
  if (transaction.kind === WagerTransactionKind.Opening) {
    return reject(transaction, FailureCode.OPENING_NOT_ALLOWED);
  }
  if (transaction.money.currency !== wallet.currency) {
    return reject(transaction, FailureCode.CURRENCY_MISMATCH);
  }

  if (transaction.requiresReference()) {
    return applyReversal(
      wallet,
      transaction,
      props.reference,
      props.referenceAlreadyReversed ?? false,
      now,
    );
  }

  if (transaction.kind === WagerTransactionKind.Loss) {
    transaction.markProcessed(undefined, now);
    return { kind: 'processed' };
  }

  return applyMovement(
    wallet,
    transaction,
    transaction.ledgerDirectionFor(),
    now,
  );
}

function applyReversal(
  wallet: Wallet,
  transaction: WagerTransaction,
  reference: WagerTransaction | undefined,
  referenceAlreadyReversed: boolean,
  now: Date,
): WagerApplyResult {
  if (
    !reference ||
    reference.status === WagerTransactionStatus.Pending ||
    reference.status === WagerTransactionStatus.PendingReference
  ) {
    transaction.markPendingReference();
    return { kind: 'pendingReference' };
  }
  if (reference.status !== WagerTransactionStatus.Processed) {
    return reject(transaction, FailureCode.REFERENCE_NOT_PROCESSED);
  }
  if (!sharesScope(transaction, reference)) {
    return reject(transaction, FailureCode.REFERENCE_SCOPE_MISMATCH);
  }
  if (referenceAlreadyReversed) {
    return reject(transaction, FailureCode.REFERENCE_ALREADY_REVERSED);
  }
  if (
    transaction.kind === WagerTransactionKind.Refund &&
    reference.kind !== WagerTransactionKind.Bet
  ) {
    return reject(transaction, FailureCode.REFUND_OF_NON_BET);
  }
  if (
    transaction.kind === WagerTransactionKind.Rollback &&
    !ROLLBACK_REFERENCEABLE_KINDS.includes(reference.kind)
  ) {
    return reject(transaction, FailureCode.UNSUPPORTED_REVERSAL_REFERENCE);
  }
  if (!transaction.money.equals(reference.money)) {
    return reject(transaction, FailureCode.REFERENCE_AMOUNT_MISMATCH);
  }
  return applyMovement(
    wallet,
    transaction,
    transaction.ledgerDirectionFor(reference),
    now,
    reference.id,
  );
}

function applyMovement(
  wallet: Wallet,
  transaction: WagerTransaction,
  direction: LedgerDirection,
  now: Date,
  referenceTransactionId?: string,
): WagerApplyResult {
  if (
    direction === LedgerDirection.Debit &&
    wallet.balance.isLessThan(transaction.money)
  ) {
    const code =
      transaction.kind === WagerTransactionKind.Rollback
        ? FailureCode.REVERSAL_WOULD_OVERDRAW
        : FailureCode.INSUFFICIENT_FUNDS;
    return reject(transaction, code);
  }

  const change = {
    entryId: randomUUID(),
    transactionId: transaction.id,
    money: transaction.money,
  };
  const entry =
    direction === LedgerDirection.Debit
      ? wallet.debit(change)
      : wallet.credit(change);

  transaction.markProcessed(referenceTransactionId, now);
  return { kind: 'processed', entry };
}

function sharesScope(
  transaction: WagerTransaction,
  reference: WagerTransaction,
): boolean {
  return (
    transaction.providerId === reference.providerId &&
    transaction.playerId === reference.playerId &&
    transaction.walletId === reference.walletId &&
    transaction.roundId === reference.roundId &&
    transaction.money.currency === reference.money.currency
  );
}

function reject(
  transaction: WagerTransaction,
  code: FailureCode,
): WagerApplyResult {
  transaction.reject(code);
  return { kind: 'rejected', failureCode: code };
}
