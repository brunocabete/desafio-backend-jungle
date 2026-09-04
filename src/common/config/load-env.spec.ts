import { applyEnv, parseEnvContent } from './load-env.js';

describe('parseEnvContent', () => {
  it('parses key/value pairs ignoring comments and blank lines', () => {
    const entries = parseEnvContent(
      [
        '# comment',
        'POSTGRES_DB=myapp',
        '',
        'AWS_ENDPOINT_URL=http://localhost:4566',
        'EMPTY=',
        'QUOTED="with spaces"',
      ].join('\n'),
    );
    expect(entries).toEqual([
      { key: 'POSTGRES_DB', value: 'myapp' },
      { key: 'AWS_ENDPOINT_URL', value: 'http://localhost:4566' },
      { key: 'EMPTY', value: '' },
      { key: 'QUOTED', value: 'with spaces' },
    ]);
  });

  it('skips lines without a key/value shape', () => {
    expect(parseEnvContent('not an assignment\n=novalue\nA=B=C\n')).toEqual([
      { key: 'A', value: 'B=C' },
    ]);
  });
});

describe('applyEnv', () => {
  it('sets missing variables without overriding existing ones', () => {
    const target: Record<string, string | undefined> = {
      EXISTING: 'keep-me',
    };
    applyEnv(
      [
        { key: 'EXISTING', value: 'override-me' },
        { key: 'NEW', value: 'added' },
      ],
      target,
    );
    expect(target).toEqual({ EXISTING: 'keep-me', NEW: 'added' });
  });
});
