export const FailureCode = {
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  UNSUPPORTED_TRANSACTION_KIND: 'UNSUPPORTED_TRANSACTION_KIND',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',
  WALLET_NOT_FOUND: 'WALLET_NOT_FOUND',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  REVERSAL_WOULD_OVERDRAW: 'REVERSAL_WOULD_OVERDRAW',
  REFERENCE_NOT_FOUND: 'REFERENCE_NOT_FOUND',
  REFERENCE_NOT_PROCESSED: 'REFERENCE_NOT_PROCESSED',
  UNRESOLVED_REFERENCE: 'UNRESOLVED_REFERENCE',
  REFERENCE_SCOPE_MISMATCH: 'REFERENCE_SCOPE_MISMATCH',
  REFERENCE_ALREADY_REVERSED: 'REFERENCE_ALREADY_REVERSED',
  REFUND_OF_NON_BET: 'REFUND_OF_NON_BET',
  UNSUPPORTED_REVERSAL_REFERENCE: 'UNSUPPORTED_REVERSAL_REFERENCE',
  REFERENCE_AMOUNT_MISMATCH: 'REFERENCE_AMOUNT_MISMATCH',
  OPENING_NOT_ALLOWED: 'OPENING_NOT_ALLOWED',
  STORAGE_FAILURE: 'STORAGE_FAILURE',
} as const;

export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];

export const FAILURE_CODE_DESCRIPTIONS: Record<FailureCode, string> = {
  INVALID_PAYLOAD:
    'request payload is malformed or fails schema/format validation',
  IDEMPOTENCY_CONFLICT:
    'same idempotency key was submitted with a different payload',
  UNSUPPORTED_TRANSACTION_KIND:
    'transaction kind is not accepted for this channel',
  INVALID_AMOUNT:
    'amount does not conform to the money contract (2 decimals, non-negative)',
  CURRENCY_MISMATCH: 'operation currency differs from the wallet currency',
  WALLET_NOT_FOUND: 'wallet does not exist',
  INSUFFICIENT_FUNDS: 'wallet balance is not enough to settle the debit',
  REVERSAL_WOULD_OVERDRAW:
    'reversing the referenced transaction would drive the balance negative',
  REFERENCE_NOT_FOUND: 'referenced transaction was not found',
  REFERENCE_NOT_PROCESSED:
    'referenced transaction exists but is in a terminal non-PROCESSED state',
  UNRESOLVED_REFERENCE:
    'referenced transaction never arrived within the retry/TTL window',
  REFERENCE_SCOPE_MISMATCH:
    'referenced transaction does not share provider, player, wallet, currency or round',
  REFERENCE_ALREADY_REVERSED:
    'referenced transaction was already reversed by the same operation type',
  REFUND_OF_NON_BET: 'REFUND can only reference a BET',
  UNSUPPORTED_REVERSAL_REFERENCE:
    'ROLLBACK can only reference a BET, WIN or REFUND',
  REFERENCE_AMOUNT_MISMATCH:
    'reversal amount differs from the referenced transaction amount',
  OPENING_NOT_ALLOWED:
    'OPENING transactions are internal and cannot be submitted',
  STORAGE_FAILURE: 'permanent storage failure while persisting the transaction',
};

export function isFailureCode(value: unknown): value is FailureCode {
  return typeof value === 'string' && value in FailureCode;
}
