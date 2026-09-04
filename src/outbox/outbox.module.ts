import { Module } from '@nestjs/common';
import { sqsEnv } from '../common/config/sqs.js';
import {
  OUTBOX_PUBLISHER,
  SqsOutboxPublisherGateway,
} from './outbox-publisher.gateway.js';
import { OutboxPublisherService } from './outbox-publisher.service.js';

@Module({
  providers: [
    {
      provide: OUTBOX_PUBLISHER,
      useFactory: () => new SqsOutboxPublisherGateway(sqsEnv()),
    },
    OutboxPublisherService,
  ],
})
export class OutboxModule {}
