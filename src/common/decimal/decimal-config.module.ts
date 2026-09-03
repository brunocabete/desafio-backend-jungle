import { Module, OnModuleInit } from '@nestjs/common';
import { applyDecimalConfig } from './decimal.config.js';

@Module({})
export class DecimalConfigModule implements OnModuleInit {
  onModuleInit(): void {
    applyDecimalConfig();
  }
}
