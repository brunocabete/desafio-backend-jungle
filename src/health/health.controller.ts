import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { HealthService, type ReadinessReport } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('live')
  live(): { status: string } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReadinessReport> {
    const report = await this.healthService.readiness();
    res.status(report.status === 'ok' ? 200 : 503);
    return report;
  }
}
