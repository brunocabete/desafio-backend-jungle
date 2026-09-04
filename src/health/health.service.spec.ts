import { sqsEnv, summarizeReadiness } from './health.service.js';

describe('summarizeReadiness', () => {
  it('reports ok when database and sqs are up', () => {
    expect(
      summarizeReadiness({
        database: { up: true },
        sqs: { up: true },
      }),
    ).toEqual({
      status: 'ok',
      checks: { database: 'up', sqs: 'up' },
      errors: {},
    });
  });

  it('reports error when a dependency is down and includes its message', () => {
    expect(
      summarizeReadiness({
        database: { up: false, message: 'connection refused' },
        sqs: { up: true },
      }),
    ).toEqual({
      status: 'error',
      checks: { database: 'down', sqs: 'up' },
      errors: { database: 'connection refused' },
    });
  });

  it('keeps error details for every down dependency', () => {
    expect(
      summarizeReadiness({
        database: { up: false, message: 'db down' },
        sqs: { up: false, message: 'queue not configured' },
      }),
    ).toEqual({
      status: 'error',
      checks: { database: 'down', sqs: 'down' },
      errors: { database: 'db down', sqs: 'queue not configured' },
    });
  });
});

describe('sqsEnv', () => {
  it('parses the configured endpoint, region, credentials and queue', () => {
    expect(
      sqsEnv({
        AWS_ENDPOINT_URL: 'http://localhost:4566',
        AWS_DEFAULT_REGION: 'us-east-1',
        AWS_ACCESS_KEY_ID: 'test',
        AWS_SECRET_ACCESS_KEY: 'test',
        AWS_SQS_QUEUE: 'wager-transactions.fifo',
      }),
    ).toEqual({
      region: 'us-east-1',
      accessKeyId: 'test',
      secretAccessKey: 'test',
      endpoint: 'http://localhost:4566',
      queue: 'wager-transactions.fifo',
    });
  });

  it('defaults region and tolerates missing aws env', () => {
    expect(sqsEnv({})).toEqual({
      region: 'us-east-1',
      accessKeyId: undefined,
      secretAccessKey: undefined,
      endpoint: undefined,
      queue: undefined,
    });
  });
});
