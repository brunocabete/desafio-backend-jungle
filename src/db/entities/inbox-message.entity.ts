import { defineEntity, p } from '@mikro-orm/postgresql';

export const InboxMessageEntity = defineEntity({
  name: 'InboxMessage',
  tableName: 'inbox_message',
  properties: {
    consumerName: p.string().columnType('varchar(255)').primary(),
    messageId: p.string().columnType('varchar(255)').primary(),
    payloadHash: p.string().columnType('varchar(64)'),
    receivedAt: p.datetime().columnType('timestamptz'),
    processedAt: p.datetime().columnType('timestamptz').nullable(),
  },
});
