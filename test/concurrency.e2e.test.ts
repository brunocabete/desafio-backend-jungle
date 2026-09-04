import { MikroORM } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';
import { WalletEntity } from '../src/db/entities/wallet.entity.js';
import { WagerTransactionEntity } from '../src/db/entities/wager-transaction.entity.js';
import { WalletLedgerEntryEntity } from '../src/db/entities/wallet-ledger-entry.entity.js';
import {
  WagerTransactionStatus,
  WagerTransactionKind,
} from '../src/domain/wager-transaction/wager-transaction.js';
import { WalletService } from '../src/wallets/wallet.service.js';
import { WagerTransactionService } from '../src/wagering/wager-transaction.service.js';
import { MetricsService } from '../src/common/metrics/metrics.service.js';
import { ormOptionsFor, dropDatabaseIfExists } from './test-db.js';
import { testDatabaseName } from './test-names.js';

const TEST_DB = testDatabaseName('desafio_jungle_concurrency_test');

interface Wallet {
  id: string;
  playerId: string;
}

describe('concurrency hardening (e2e, real Postgres, real parallelism)', () => {
  let orm: MikroORM;
  let walletService: WalletService;
  let wagerService: WagerTransactionService;
  let provider: string;

  beforeAll(async () => {
    await dropDatabaseIfExists(TEST_DB);
    orm = await MikroORM.init(ormOptionsFor(TEST_DB));
    await orm.migrator.up();
    walletService = new WalletService(orm, new MetricsService());
    wagerService = new WagerTransactionService(orm);
    provider = `provider-${randomUUID().slice(0, 8)}`;
  }, 120_000);

  afterAll(async () => {
    if (orm) {
      await orm.close(true);
    }
    await dropDatabaseIfExists(TEST_DB);
  }, 120_000);

  async function createWallet(balance = '100.00'): Promise<Wallet> {
    const wallet = await walletService.create({
      playerId: randomUUID(),
      initialBalance: { amount: balance, currency: 'BRL' },
    });
    return { id: wallet.id, playerId: wallet.playerId };
  }

  async function submitWager(
    wallet: Wallet,
    overrides: {
      amount?: string;
      kind?: WagerTransactionKind;
      reference?: string;
    } = {},
  ) {
    const ext = `${overrides.kind ?? 'BET'}-${randomUUID().slice(0, 12)}`;
    return wagerService.submit({
      providerId: provider,
      externalTransactionId: ext,
      idempotencyKey: `${provider}:${ext}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: overrides.kind ?? WagerTransactionKind.Bet,
      money: { amount: overrides.amount ?? '25.00', currency: 'BRL' },
      ...(overrides.reference
        ? { referenceExternalTransactionId: overrides.reference }
        : {}),
    });
  }

  async function walletRow(walletId: string) {
    const row = await orm.em.fork().findOne(WalletEntity, { id: walletId });
    return row as unknown as { balanceAmount: string; version: number };
  }

  async function debitCount(walletId: string): Promise<number> {
    return orm.em.fork().count(WalletLedgerEntryEntity, {
      walletId,
      direction: 'DEBIT',
    });
  }

  async function creditCount(
    walletId: string,
    amount: string,
  ): Promise<number> {
    return orm.em.fork().count(WalletLedgerEntryEntity, {
      walletId,
      direction: 'CREDIT',
      moneyAmount: amount,
    });
  }

  it('mandatory §8 scenario: two concurrent 80.00 bets on a 100.00 wallet', async () => {
    const wallet = await createWallet('100.00');

    const [first, second] = await Promise.all([
      submitWager(wallet, { amount: '80.00' }),
      submitWager(wallet, { amount: '80.00' }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
    ]);
    const winner =
      first.status === WagerTransactionStatus.Processed ? first : second;
    const loser =
      first.status === WagerTransactionStatus.Rejected ? first : second;
    expect(winner.balance).toEqual({ amount: '20.00', currency: 'BRL' });
    expect(loser.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(loser.balance).toEqual({ amount: '20.00', currency: 'BRL' });

    expect(await debitCount(wallet.id)).toBe(1);
    expect(await walletRow(wallet.id)).toMatchObject({
      balanceAmount: '20.00',
      version: 2,
    });
  });

  it('submits the same wager 50 times in parallel with a single debit', async () => {
    const wallet = await createWallet('100.00');
    const ext = `same-${randomUUID().slice(0, 10)}`;
    const key = `${provider}:${ext}`;

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        wagerService.submit({
          providerId: provider,
          externalTransactionId: ext,
          idempotencyKey: key,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'round-1',
          gameId: 'fortune-chimp',
          kind: WagerTransactionKind.Bet,
          money: { amount: '10.00', currency: 'BRL' },
        }),
      ),
    );

    expect(results).toHaveLength(50);
    for (const result of results) {
      expect(result.status).toBe(WagerTransactionStatus.Processed);
    }
    const fresh = results.filter((result) => !result.idempotentReplay);
    expect(fresh).toHaveLength(1);

    expect(
      await orm.em.fork().count(WagerTransactionEntity, {
        providerId: provider,
        walletId: wallet.id,
        externalTransactionId: ext,
      }),
    ).toBe(1);
    expect(await debitCount(wallet.id)).toBe(1);
    expect(await walletRow(wallet.id)).toMatchObject({
      balanceAmount: '90.00',
    });
  });

  it('settles distinct wallets in parallel without cross-talk', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 12 }, () => createWallet('100.00')),
    );

    const results = await Promise.all(
      wallets.map((wallet) => submitWager(wallet, { amount: '20.00' })),
    );

    for (const result of results) {
      expect(result.status).toBe(WagerTransactionStatus.Processed);
    }
    for (const wallet of wallets) {
      expect(await debitCount(wallet.id)).toBe(1);
      expect(await walletRow(wallet.id)).toMatchObject({
        balanceAmount: '80.00',
        version: 2,
      });
    }
  });

  it('allows only one of two concurrent REFUNDs of the same BET', async () => {
    const wallet = await createWallet('100.00');
    const betExt = `bet-${randomUUID().slice(0, 12)}`;
    const bet = await wagerService.submit({
      providerId: provider,
      externalTransactionId: betExt,
      idempotencyKey: `${provider}:bet-${betExt}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
    });
    expect(bet.status).toBe(WagerTransactionStatus.Processed);

    const [first, second] = await Promise.all([
      submitWager(wallet, {
        kind: WagerTransactionKind.Refund,
        reference: betExt,
      }),
      submitWager(wallet, {
        kind: WagerTransactionKind.Refund,
        reference: betExt,
      }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
    ]);
    const rejected =
      first.status === WagerTransactionStatus.Rejected ? first : second;
    expect(rejected.failureCode).toBe('REFERENCE_ALREADY_REVERSED');

    expect(await creditCount(wallet.id, '25.00')).toBe(1);
    expect(await debitCount(wallet.id)).toBe(1);
    expect(await walletRow(wallet.id)).toMatchObject({
      balanceAmount: '100.00',
      version: 3,
    });
  });
});
