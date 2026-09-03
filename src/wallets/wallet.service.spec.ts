import {
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

  it.each([
    [{ playerId: '' }, 'missing playerId'],
    [{ playerId: 'x'.repeat(65) }, 'playerId too long'],
    [
      { playerId: 'p', initialBalance: { amount: '-5.00', currency: 'BRL' } },
      'negative amount',
    ],
    [
      { playerId: 'p', initialBalance: { amount: '1.234', currency: 'BRL' } },
      'more than 2 decimal places',
    ],
    [
      { playerId: 'p', initialBalance: { amount: '1.00', currency: 'brl' } },
      'lowercase currency',
    ],
    [
      { playerId: 'p', initialBalance: { amount: 100, currency: 'BRL' } },
      'non-string amount',
    ],
    [
      { playerId: 'p', initialBalance: { amount: '10.00', currency: '' } },
      'empty currency',
    ],
  ])('rejects %s', (input, _label) => {
    expect(() => parseCreateWallet(input)).toThrow(InvalidCreateWalletError);
  });
});
