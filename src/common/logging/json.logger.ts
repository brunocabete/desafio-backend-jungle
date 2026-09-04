import type { LoggerService } from '@nestjs/common';
import { getCorrelationId } from '../correlation/correlation-id.context.js';

type LogLevel = 'debug' | 'verbose' | 'info' | 'warn' | 'error' | 'fatal';

type StructuredFields = Record<string, unknown>;

interface LogRecord extends StructuredFields {
  ts: string;
  level: LogLevel;
  pid: number;
  ctx?: string;
  correlationId?: string;
  msg: string;
  stack?: string;
}

const RESERVED_FIELDS = new Set([
  'ts',
  'level',
  'pid',
  'ctx',
  'correlationId',
  'msg',
  'stack',
]);

function isStructuredMessage(message: unknown): message is StructuredFields {
  return (
    typeof message === 'object' &&
    message !== null &&
    !Array.isArray(message) &&
    !(message instanceof Error)
  );
}

function describe(message: unknown): {
  msg: string;
  stack?: string;
  fields?: StructuredFields;
} {
  if (message instanceof Error) {
    return { msg: message.message, stack: message.stack };
  }
  if (isStructuredMessage(message)) {
    const fields: StructuredFields = {};
    for (const [key, value] of Object.entries(message)) {
      if (RESERVED_FIELDS.has(key)) {
        continue;
      }
      if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        fields[key] = value;
      }
    }
    const explicit = message.msg;
    const fallback = message.event;
    return {
      msg:
        typeof explicit === 'string'
          ? explicit
          : typeof fallback === 'string'
            ? fallback
            : '',
      fields,
    };
  }
  return { msg: String(message) };
}

export class JsonLogger implements LoggerService {
  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('info', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('verbose', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write('fatal', message, optionalParams);
  }

  private write(
    level: LogLevel,
    message: unknown,
    optionalParams: unknown[],
  ): void {
    const strings = optionalParams.filter(
      (param): param is string => typeof param === 'string',
    );
    const ctx = strings.at(-1);
    const paramStack = strings.find(
      (param) => param !== ctx && param.includes('\n'),
    );

    const described = describe(message);
    const correlationId = getCorrelationId();

    const record: LogRecord = {
      ts: new Date().toISOString(),
      level,
      pid: process.pid,
      msg: described.msg,
      ...(ctx ? { ctx } : {}),
      ...(correlationId ? { correlationId } : {}),
      ...((described.stack ?? paramStack)
        ? { stack: described.stack ?? paramStack }
        : {}),
      ...described.fields,
    };

    const line = JSON.stringify(record);
    if (level === 'error' || level === 'fatal') {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  }
}
