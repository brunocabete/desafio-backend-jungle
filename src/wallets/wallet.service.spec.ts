import {
  buildReconciliationView,
  InvalidCreateWalletError,
  parseCreateWallet,
} from './wallet.service.js';

describe('parseCreateWallet', () => {
  it('normalizes playerId and parses a valid initialBalance', () => {
    const parsed = parseCreateWallet({
      playerId: '  player-1  ',
      initialBalance: { amount: '1000.00', currency: 'BRL' },
    });
    expect(parsed.playerId).toBe('player-1');
    expect(parsed.initialBalance.toJSON()).toEqual({
      amount: '1000.00',
      currency: 'BRL',
    });
  });

  it('defaults currency to BRL when omitted', () => {
    const parsed = parseCreateWallet({
      playerId: 'player-1',
      initialBalance: { amount: '25.00' },
    });
    expect(parsed.initialBalance.toJSON().currency).toBe('BRL');
  });

  it('defaults to a zero BRL wallet when initialBalance is omitted', () => {
    const parsed = parseCreateWallet({ playerId: 'player-1' });
    expect(parsed.initialBalance.toJSON()).toEqual({
      amount: '0.00',
      currency: 'BRL',
    });
  });

  const invalidCases = [
    { name: 'rejects a missing playerId', input: { playerId: '' } },
    {
      name: 'rejects a playerId longer than 64 characters',
      input: { playerId: 'x'.repeat(65) },
    },
    {
      name: 'rejects a negative initialBalance',
      input: {
        playerId: 'p',
        initialBalance: { amount: '-5.00', currency: 'BRL' },
      },
    },
    {
      name: 'rejects an initialBalance with more than 2 decimal places',
      input: {
        playerId: 'p',
        initialBalance: { amount: '1.234', currency: 'BRL' },
      },
    },
    {
      name: 'rejects a lowercase currency',
      input: {
        playerId: 'p',
        initialBalance: { amount: '1.00', currency: 'brl' },
      },
    },
    {
      name: 'rejects a non-string amount',
      input: {
        playerId: 'p',
        initialBalance: { amount: 100, currency: 'BRL' },
      },
    },
    {
      name: 'rejects an empty currency',
      input: {
        playerId: 'p',
        initialBalance: { amount: '10.00', currency: '' },
      },
    },
  ] as const;

  for (const { name, input } of invalidCases) {
    it(name, () => {
      expect(() => parseCreateWallet(input)).toThrow(InvalidCreateWalletError);
    });
  }
});

describe('buildReconciliationView', () => {
  const base = {
    walletId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    currency: 'BRL',
  };

  it('reports a wallet consistent when stored equals the reconstructed ledger', () => {
    const view = buildReconciliationView({
      ...base,
      storedBalance: { amount: '975.00', currency: 'BRL' },
      calculatedBalance: { amount: '975.00', currency: 'BRL' },
      checkedEntries: 42,
    });
    expect(view).toEqual({
      walletId: base.walletId,
      storedBalance: { amount: '975.00', currency: 'BRL' },
      calculatedBalance: { amount: '975.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 42,
    });
  });

  it('signals a positive difference when stored exceeds the ledger', () => {
    const view = buildReconciliationView({
      ...base,
      storedBalance: { amount: '100.00', currency: 'BRL' },
      calculatedBalance: { amount: '80.00', currency: 'BRL' },
      checkedEntries: 5,
    });
    expect(view).toMatchObject({
      difference: { amount: '20.00', currency: 'BRL' },
      consistent: false,
      checkedEntries: 5,
    });
  });

  it('signals a negative difference when the ledger exceeds stored', () => {
    const view = buildReconciliationView({
      ...base,
      storedBalance: { amount: '100.00', currency: 'BRL' },
      calculatedBalance: { amount: '125.00', currency: 'BRL' },
      checkedEntries: 5,
    });
    expect(view).toMatchObject({
      difference: { amount: '-25.00', currency: 'BRL' },
      consistent: false,
    });
  });

  it('treats a zero-balance wallet with no entries as consistent', () => {
    const view = buildReconciliationView({
      ...base,
      storedBalance: { amount: '0.00', currency: 'BRL' },
      calculatedBalance: { amount: '0', currency: 'BRL' },
      checkedEntries: 0,
    });
    expect(view).toMatchObject({
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 0,
    });
  });
});
