import { hash } from 'canonical-json/hash';
import type { MoneyProps } from '../money/money.js';
import type { WagerTransaction } from '../wager-transaction/wager-transaction.js';

export type IdempotencyDecision = 'PROCESS' | 'REPLAY' | 'CONFLICT';

export interface WagerTransactionRequest {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export function wagerPayloadHash(request: WagerTransactionRequest): string {
  const business: Record<string, unknown> = {
    providerId: request.providerId,
    externalTransactionId: request.externalTransactionId,
    playerId: request.playerId,
    walletId: request.walletId,
    roundId: request.roundId,
    gameId: request.gameId,
    kind: request.kind,
    money: { amount: request.money.amount, currency: request.money.currency },
  };
  if (request.referenceExternalTransactionId !== undefined) {
    business.referenceExternalTransactionId =
      request.referenceExternalTransactionId;
  }
  return hash(business);
}

export function classifyIdempotency(
  existing: WagerTransaction | undefined,
  payloadHash: string,
): IdempotencyDecision {
  if (!existing) {
    return 'PROCESS';
  }
  return existing.matchesPayload(payloadHash) ? 'REPLAY' : 'CONFLICT';
}
