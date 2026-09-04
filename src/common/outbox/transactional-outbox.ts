import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/core';
import { getCorrelationId } from '../correlation/correlation-id.context.js';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
  type EventContext,
  type IntegrationEvent,
} from '../../domain/integration-event/integration-event.js';
import { OutboxMessage } from '../../domain/outbox/outbox-message.js';
import {
  WagerTransactionStatus,
  type WagerTransaction,
} from '../../domain/wager-transaction/wager-transaction.js';
import type { Wallet } from '../../domain/wallet/wallet.js';
import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry.js';
import { OutboxMessageEntity } from '../../db/entities/outbox-message.entity.js';

export function currentEventContext(occurredAt?: Date): EventContext {
  return {
    correlationId: getCorrelationId() ?? randomUUID(),
    occurredAt,
  };
}

export interface SettlementEventsInput {
  /** transação já transicionada por apply (terminal ou PENDING_REFERENCE). */
  transaction: WagerTransaction;
  /** estado em que a transação estava antes de ser aplicada. */
  beforeStatus: WagerTransactionStatus;
  /** wallet já atualizada quando o saldo mudou. */
  wallet: Wallet;
  /** entry de ledger gerada na liquidação (só transações que movem saldo). */
  entry?: WalletLedgerEntry;
  ctx: EventContext;
}

export function settlementEvents(
  input: SettlementEventsInput,
): IntegrationEvent<unknown>[] {
  const { transaction, beforeStatus, wallet, entry, ctx } = input;
  const events: IntegrationEvent<unknown>[] = [];

  switch (transaction.status) {
    case WagerTransactionStatus.Processed:
      events.push(
        WagerTransactionProcessed.from(
          transaction,
          entry ? entry.balanceAfter.toJSON() : undefined,
          ctx,
        ),
      );
      if (entry) {
        events.push(WalletBalanceChanged.from(wallet, entry, ctx));
      }
      break;
    case WagerTransactionStatus.Rejected:
      events.push(WagerTransactionRejected.from(transaction, ctx));
      break;
    case WagerTransactionStatus.PendingReference:
      if (beforeStatus === WagerTransactionStatus.Pending) {
        events.push(WagerTransactionPendingReference.from(transaction, ctx));
      }
      break;
    default:
      break;
  }

  return events;
}

export function persistOutboxEvents(
  em: EntityManager,
  events: IntegrationEvent<unknown>[],
): void {
  for (const event of events) {
    const message = OutboxMessage.enqueue(event);
    em.create(OutboxMessageEntity, {
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      payload: message.payload,
      occurredAt: message.occurredAt,
      attempts: message.attempts,
      nextAttemptAt: null,
      publishedAt: null,
    });
  }
}
