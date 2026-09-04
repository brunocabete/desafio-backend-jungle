import { MikroORM } from '@mikro-orm/core';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { testDatabaseName } from './test-names.js';

const TEST_DB = testDatabaseName('desafio_jungle_health_test');

describe('health endpoints (e2e)', () => {
  let app: INestApplication;
  let previousDbName: string | undefined;

  beforeAll(async () => {
    previousDbName = process.env.POSTGRES_DB;
    process.env.POSTGRES_DB = TEST_DB;
    const helpers = await import('./test-db.js');
    const { AppModule } = await import('./../src/app.module.js');

    await helpers.dropDatabaseIfExists(TEST_DB);
    const migrator = await MikroORM.init(helpers.ormOptionsFor(TEST_DB));
    await migrator.migrator.up();
    await migrator.close(true);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  }, 60_000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    const helpers = await import('./test-db.js');
    await helpers.dropDatabaseIfExists(TEST_DB);
    if (previousDbName === undefined) {
      delete process.env.POSTGRES_DB;
    } else {
      process.env.POSTGRES_DB = previousDbName;
    }
  }, 60_000);

  it('reports liveness with 200 while the process is up', async () => {
    const response = await request(app.getHttpServer())
      .get('/health/live')
      .expect(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(response.headers['x-correlation-id']).toBeDefined();
  });

  it('reports readiness 200 when Postgres and SQS are reachable', async () => {
    const response = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200);
    expect(response.body).toMatchObject({
      status: 'ok',
      checks: { database: 'up', sqs: 'up' },
    });
  });

  it('reports readiness 503 listing the dependency when SQS is unavailable', async () => {
    const previousQueue = process.env.AWS_SQS_QUEUE;
    delete process.env.AWS_SQS_QUEUE;
    try {
      const response = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(503);
      expect(response.body).toMatchObject({
        status: 'error',
        checks: { database: 'up', sqs: 'down' },
      });
      expect(response.body.errors.sqs).toBeTruthy();
    } finally {
      if (previousQueue === undefined) {
        delete process.env.AWS_SQS_QUEUE;
      } else {
        process.env.AWS_SQS_QUEUE = previousQueue;
      }
    }
  });
});
