import { randomUUID } from 'node:crypto';

export function testDatabaseName(prefix: string): string {
  return `${prefix}_${process.pid}_${randomUUID().slice(0, 8)}`;
}
