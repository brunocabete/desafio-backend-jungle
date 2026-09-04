import { Module } from '@nestjs/common';
import { sqsEnv } from '../common/config/sqs.js';
import { WageringModule } from '../wagering/wagering.module.js';
import { WagerSqsConsumerService } from './wager-sqs.consumer.js';
import { AwsWagerSqsGateway, WAGER_SQS_GATEWAY } from './wager-sqs.gateway.js';

@Module({
  imports: [WageringModule],
  providers: [
    {
      provide: WAGER_SQS_GATEWAY,
      useFactory: () => new AwsWagerSqsGateway(sqsEnv()),
    },
    WagerSqsConsumerService,
  ],
})
export class SqsModule {}
