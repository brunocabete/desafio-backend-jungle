import { defineEntity, p } from '@mikro-orm/postgresql';

export const OutboxMessageEntity = defineEntity({
  name: 'OutboxMessage',
  tableName: 'outbox_message',
  properties: {
    id: p.uuid().primary(),
    aggregateId: p.string().columnType('varchar(64)'),
    eventType: p.string().columnType('varchar(64)'),
    payload: p.json(),
    occurredAt: p.datetime().columnType('timestamptz'),
    attempts: p.integer(),
    nextAttemptAt: p.datetime().columnType('timestamptz').nullable(),
    publishedAt: p.datetime().columnType('timestamptz').nullable(),
  },
});
