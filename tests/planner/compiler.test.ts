import { describe, expect, test } from 'vitest';
import { compileProposal, reconstructSettlement, type ProposalAccount } from '../../packages/planner/src/proposal.js';

/**
 * The compiler turns a proposal into the settlement the program executes. The claim under test is
 * the one the whole product rests on: *the recommended portfolio becomes the correct trade*. Stock
 * quantities and input-token quantities are different numbers, and a purchase must convert through
 * the committed price ratio rather than copy its stock quantity into the cash input.
 */
const OWNER_A = '11'.repeat(32);
const OWNER_B = '22'.repeat(32);
const OWNER_C = '33'.repeat(32);

function account(id: string, owner: string, external: Record<string, string>, internal: Record<string, string> = {}): ProposalAccount {
  return {
    id, owner,
    initial_raw: { STOCK_A: '0', STOCK_B: '0', CASH: '0' },
    final_raw: { STOCK_A: '0', STOCK_B: '0', CASH: '0' },
    trades_raw: { STOCK_A: '0', STOCK_B: '0', CASH: '0' },
    internal_raw: { STOCK_A: internal.STOCK_A ?? '0', STOCK_B: internal.STOCK_B ?? '0' },
    external_raw: { STOCK_A: external.STOCK_A ?? '0', STOCK_B: external.STOCK_B ?? '0' },
  };
}

describe('compiler residual legs use the input asset, not the stock quantity', () => {
  test('a purchase converts the stock quantity into an exact cash input', () => {
    // The reviewed reproduction: buying 100 units of a 10-cash stock must place 1,000 cash, not 100.
    const compiled = compileProposal({
      accounts: [
        account('buyer', OWNER_A, { STOCK_A: '100' }),
        account('bystander', OWNER_B, {}),
      ],
      prices: { STOCK_A: '10', STOCK_B: '20', CASH: '1' },
    });
    expect(compiled.residuals).toHaveLength(1);
    const leg = compiled.residuals[0];
    expect(leg.direction).toBe('1'); // buy the stock with cash
    // The cash input is the converted quantity, so the owner places 1,000 cash for 100 units.
    expect(leg.input_allocations).toEqual(['1000', '0']);
    // The minimum stock output is the reference quantity less the committed 200 bps band.
    expect(leg.minimum_output).toBe('98');
    expect(compiled.unrepresented).toEqual([]);
  });

  test('a sale keeps the input in stock units and prices the cash output', () => {
    const compiled = compileProposal({
      accounts: [
        account('seller', OWNER_A, { STOCK_A: '-100' }),
        account('bystander', OWNER_B, {}),
      ],
      prices: { STOCK_A: '10', STOCK_B: '20', CASH: '1' },
    });
    const leg = compiled.residuals[0];
    expect(leg.direction).toBe('0'); // sell the stock for cash
    expect(leg.input_allocations).toEqual(['100', '0']);
    expect(leg.minimum_output).toBe('980'); // 100 * 10, less 200 bps
  });

  test('each stock converts at its own reference price in the same settlement', () => {
    const compiled = compileProposal({
      accounts: [
        account('mixed', OWNER_A, { STOCK_A: '100', STOCK_B: '-40' }),
        account('bystander', OWNER_B, {}),
      ],
      prices: { STOCK_A: '10', STOCK_B: '20', CASH: '1' },
    });
    expect(compiled.residuals).toHaveLength(2);
    const buy = compiled.residuals.find(leg => leg.direction === '1')!;
    const sell = compiled.residuals.find(leg => leg.direction === '0')!;
    expect(compiled.index_order[Number(buy.stock_index)]).toBe('STOCK_A');
    expect(buy.input_allocations).toEqual(['1000', '0']); // 100 * 10
    expect(buy.minimum_output).toBe('98');
    expect(compiled.index_order[Number(sell.stock_index)]).toBe('STOCK_B');
    expect(sell.input_allocations).toEqual(['40', '0']);
    expect(sell.minimum_output).toBe('784'); // 40 * 20, less 200 bps
  });

  test('a non-unit cash denomination still converts exactly', () => {
    const compiled = compileProposal({
      accounts: [
        account('buyer', OWNER_A, { STOCK_A: '100' }),
        account('bystander', OWNER_B, {}),
      ],
      prices: { STOCK_A: '10', STOCK_B: '20', CASH: '2' },
    });
    const leg = compiled.residuals[0];
    // 100 units * 10 micro-USD per unit / 2 micro-USD per cash unit = 500 cash.
    expect(leg.input_allocations).toEqual(['500', '0']);
    expect(leg.minimum_output).toBe('98'); // 500 * 2 / 10, less 200 bps
  });

  test('a purchase with no exact cash value is refused rather than rounded', () => {
    const compiled = compileProposal({
      accounts: [
        account('buyer', OWNER_A, { STOCK_A: '1' }),
        account('bystander', OWNER_B, {}),
      ],
      prices: { STOCK_A: '3', STOCK_B: '4', CASH: '2' },
    });
    // 1 unit * 3 / 2 has no exact cash value, so the leg is dropped and recorded.
    expect(compiled.residuals).toHaveLength(0);
    expect(compiled.unrepresented).toEqual([
      expect.objectContaining({ asset: 'STOCK_A', quantity_raw: '1' }),
    ]);
    expect(compiled.unrepresented[0].reason).toMatch(/no exact cash value/);
  });

  test('the buggy copy of the stock quantity into the cash input is gone', () => {
    const compiled = compileProposal({
      accounts: [
        account('buyer', OWNER_A, { STOCK_A: '100' }),
        account('bystander', OWNER_B, {}),
      ],
      prices: { STOCK_A: '10', STOCK_B: '20', CASH: '1' },
    });
    const leg = compiled.residuals[0];
    // The old defect would have compiled a ~10-unit purchase placing 100 cash with a floor of 9.
    expect(leg.input_allocations[0]).not.toBe('100');
    expect(leg.minimum_output).not.toBe('9');
  });
});

describe('compiler crosses still price the cash leg exactly', () => {
  test('a matched cross prices the cash leg at the reference price', () => {
    const compiled = compileProposal({
      accounts: [
        account('seller', OWNER_A, {}, { STOCK_A: '-100' }),
        account('buyer', OWNER_B, {}, { STOCK_A: '100' }),
      ],
      prices: { STOCK_A: '10', STOCK_B: '20', CASH: '1' },
    });
    expect(compiled.crosses).toHaveLength(1);
    expect(compiled.crosses[0]).toMatchObject({ stock_quantity: '100', cash_amount: '1000', seller_index: '0', buyer_index: '1' });
    expect(compiled.residuals).toHaveLength(0);
  });

  test('an inexact cross leaves the remainder to the residual rather than rounding it', () => {
    const compiled = compileProposal({
      accounts: [
        account('seller', OWNER_A, {}, { STOCK_A: '-7' }),
        account('buyer', OWNER_B, {}, { STOCK_A: '7' }),
      ],
      prices: { STOCK_A: '3', STOCK_B: '4', CASH: '2' },
    });
    // Only 6 of the 7 units have an exact cash leg (6 * 3 / 2 = 9); the last unit is recorded,
    // never rounded away.
    expect(compiled.crosses[0]).toMatchObject({ stock_quantity: '6', cash_amount: '9' });
    const dropped = compiled.unrepresented.filter(entry => entry.asset === 'STOCK_A');
    expect(dropped.map(entry => entry.reason)).toContain('the remainder has no exact cash leg and was left to the residual');
    expect(dropped.reduce((sum, entry) => sum + BigInt(entry.quantity_raw), 0n)).toBe(3n);
  });

  test('a one-sided internal quantity is reported, never crossed against nothing', () => {
    const compiled = compileProposal({
      accounts: [
        account('seller', OWNER_A, {}, { STOCK_A: '-5' }),
        account('bystander', OWNER_B, {}),
      ],
      prices: { STOCK_A: '10', STOCK_B: '20', CASH: '1' },
    });
    expect(compiled.crosses).toHaveLength(0);
    expect(compiled.unrepresented.some(entry => entry.asset === 'STOCK_A')).toBe(true);
  });
});

describe('the compiled settlement reconstructs each owner’s change', () => {
  test('a cross plus a purchase reconstruct debits and credits per owner', () => {
    const compiled = compileProposal({
      accounts: [
        account('seller', OWNER_A, { STOCK_A: '-100' }, { STOCK_A: '-50' }),
        account('buyer', OWNER_B, {}, { STOCK_A: '50' }),
      ],
      prices: { STOCK_A: '10', STOCK_B: '20', CASH: '1' },
    });
    // One cross of 50 and one sale residual of 100.
    expect(compiled.crosses).toHaveLength(1);
    expect(compiled.residuals).toHaveLength(1);
    const changes = reconstructSettlement(compiled, [OWNER_A, OWNER_B]);
    expect(changes[0].owner).toBe(OWNER_A);
    // The seller gives 50 across the cross and 100 into the residual; it receives 500 cash across
    // the cross and at least 980 from the sale.
    expect(changes[0].stock_change.STOCK_A).toBe('-150');
    expect(changes[0].cash_change).toBe('1480');
    expect(changes[1].stock_change.STOCK_A).toBe('50');
    expect(changes[1].cash_change).toBe('-500');
    expect(changes[0].quote_dependent).toBe(true);
  });

  test('a cross-only settlement reconstructs exactly and is not quote-dependent', () => {
    const compiled = compileProposal({
      accounts: [
        account('seller', OWNER_A, {}, { STOCK_A: '-40' }),
        account('buyer', OWNER_B, {}, { STOCK_A: '40' }),
      ],
      prices: { STOCK_A: '10', STOCK_B: '20', CASH: '1' },
    });
    const changes = reconstructSettlement(compiled, [OWNER_A, OWNER_B]);
    expect(changes[0].quote_dependent).toBe(false);
    expect(changes[0].stock_change.STOCK_A).toBe('-40');
    expect(changes[0].cash_change).toBe('400');
    expect(changes[1].stock_change.STOCK_A).toBe('40');
    expect(changes[1].cash_change).toBe('-400');
  });

  test('a purchase residual credits stock to the buyer and debits its cash', () => {
    const compiled = compileProposal({
      accounts: [
        account('buyer', OWNER_A, { STOCK_A: '100' }),
        account('bystander', OWNER_B, {}),
      ],
      prices: { STOCK_A: '10', STOCK_B: '20', CASH: '1' },
    });
    const changes = reconstructSettlement(compiled, [OWNER_A, OWNER_B]);
    // The credited stock is the committed minimum (98), the quoted bound, not the modelled 100.
    expect(changes[0].stock_change.STOCK_A).toBe('98');
    expect(changes[0].cash_change).toBe('-1000');
    expect(changes[1].stock_change.STOCK_A).toBe('0');
    expect(changes[1].cash_change).toBe('0');
  });
});
