import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface EnvEntry {
  key: string;
  value: string;
}

const LINE_PATTERN = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;
const QUOTED = /^(['"])(.*)\1$/s;

export function parseEnvContent(content: string): EnvEntry[] {
  const entries: EnvEntry[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const match = LINE_PATTERN.exec(line);
    if (!match) {
      continue;
    }
    let value = match[2];
    const quoted = QUOTED.exec(value);
    if (quoted) {
      value = quoted[2];
    }
    entries.push({ key: match[1], value });
  }
  return entries;
}

export function applyEnv(
  entries: EnvEntry[],
  target: Record<string, string | undefined> = process.env,
): void {
  for (const entry of entries) {
    if (target[entry.key] === undefined) {
      target[entry.key] = entry.value;
    }
  }
}

/**
 * Loads a `.env` file (dotenv-style) into `process.env` without overriding
 * variables that are already set. Bun auto-loads `.env` for `bun run`, but
 * plain Node/`nest start` does not — calling this at import time makes the
 * app launcher-independent.
 */
export function loadEnvFile(filePath?: string): void {
  const path = filePath ?? resolve(process.cwd(), '.env');
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  applyEnv(parseEnvContent(content));
}

loadEnvFile();
