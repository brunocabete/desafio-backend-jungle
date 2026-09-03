import 'reflect-metadata';
import { defineConfig } from '@mikro-orm/postgresql';

const env = (name: string, fallback: string): string =>
  process.env[name] ?? fallback;

export default defineConfig({
  host: env('DATABASE_HOST', 'localhost'),
  port: Number(env('DATABASE_PORT', '5432')),
  dbName: env('POSTGRES_DB', 'myapp'),
  user: env('POSTGRES_USER', 'myapp'),
  password: env('POSTGRES_PASSWORD', 'secret'),
  entities: [],
  migrations: {
    path: 'dist/migrations',
    pathTs: 'src/migrations',
  },
});
