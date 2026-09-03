import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { NestMiddleware } from '@nestjs/common';
import {
  CORRELATION_ID_HEADER,
  runWithCorrelationId,
} from './correlation-id.context.js';

export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const header = req.headers[CORRELATION_ID_HEADER.toLowerCase()];
    const incoming = Array.isArray(header) ? header[0] : header;
    const correlationId = incoming ? incoming : randomUUID();

    res.setHeader(CORRELATION_ID_HEADER, correlationId);
    runWithCorrelationId(correlationId, () => next());
  }
}
