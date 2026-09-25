/**
 * Compile an optimizer proposal into the settlement the program can actually execute.
 *
 * This is the missing link the central product claim depends on: the optimizer produces *targets*,
 * the program executes *crosses and residual legs*, and until now nothing translated one into the
 * other — the demo simply invented a trade. Everything here is derived from the proposal's own
 * per-account numbers; nothing is chosen by the caller.
 *
 * The ledger already separates each account's intended change into the part matched against other
 * participants (`internal_raw`) and the part that must go to a venue (`external_raw`). The compiler
 * turns the first into crosses and the second into residual legs, and refuses rather than rounding
 * when a quantity cannot be represented exactly.
 */

export interface ProposalAccount {
  id: string;
  /** Owner public key as 32-byte hex, which is the order the program requires. */
  owner: string;
  initial_raw: Record<string, number | string>;
  final_raw: Record<string, number | string>;
  trades_raw: Record<string, number | string>;
  internal_raw: Record<string, number | string>;
  external_raw: Record<string, number | string>;
}

export interface CompileInput {
  /** In the order the engine emitted them; the compiler sorts by owner bytes. */
  accounts: ProposalAccount[];
  /** Micro-USD per raw unit, per asset id. */
  prices: Record<string, string>;
  /** The residual legs the engine expects to route externally, in the same units. */
  external_orders?: { asset: string; signed_quantity_raw: number | string }[];
}

export interface CompiledCross {
  stock_index: string;
  seller_index: string;
  buyer_index: string;
  stock_quantity: string;
  cash_amount: string;
}

export interface CompiledResidual {
  stock_index: string;
  direction: string;
  minimum_output: string;
  input_allocations: string[];
}

export interface CompiledSettlement {
  crosses: CompiledCross[];
  residuals: CompiledResidual[];
  /** Asset ids in the index order the settlement uses: cash first, then the two stocks. */
  index_order: string[];
  /** What the compiler could not represent, stated rather than silently dropped. */
  unrepresented: { asset: string; quantity_raw: string; reason: string }[];
  explanation: string[];
}

const STOCK_A = 'STOCK_A';
const STOCK_B = 'STOCK_B';
const CASH = 'CASH';

function asBigInt(value: number | string, name: string): bigint {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new TypeError(`${name} must be an integer raw amount`);
    return BigInt(value);
  }
  if (!/^-?(0|[1-9][0-9]*)$/.test(value)) throw new TypeError(`${name} must be an integer string`);
  return BigInt(value);
}

/**
 * Index order matters: the program takes a cash index and stock indexes, and the caller must know
 * which is which. Cash is index 0 by the frozen convention.
 */
export function indexOrder(assetIds: string[]): string[] {
  const sorted = [...assetIds].sort();
  if (!sorted.includes(CASH) || sorted.length !== 3) throw new TypeError('the settlement needs cash and exactly two stocks');
  return [CASH, ...sorted.filter(id => id !== CASH)];
}

/**
 * A cross needs an exact cash leg. The frozen convention prices each asset in micro-USD per raw
 * unit, so a quantity is exactly representable when `qty * p_stock` divides by `p_cash`.
 */
function cashFor(quantity: bigint, stockPrice: bigint, cashPrice: bigint): bigint | null {
  const numerator = quantity * stockPrice;
  if (cashPrice === 0n) throw new RangeError('cash price cannot be zero');
  if (numerator % cashPrice !== 0n) return null;
  return numerator / cashPrice;
}

/** Largest quantity at or below `quantity` whose cash leg is exact, or 0 when none is. */
function largestExact(quantity: bigint, stockPrice: bigint, cashPrice: bigint): bigint {
  if (cashFor(quantity, stockPrice, cashPrice) !== null) return quantity;
  const scale = stockPrice === 0n ? 1n : cashPrice / gcd(cashPrice, stockPrice);
  const step = scale > 1n ? scale : 1n;
  return (quantity / step) * step;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y) { const t = x % y; x = y; y = t; }
  return x;
}

export function compileProposal(input: unknown): CompiledSettlement {
  const record = input as CompileInput;
  if (!Array.isArray(record?.accounts) || record.accounts.length < 2 || record.accounts.length > 3) {
    throw new RangeError('a settlement covers two or three accounts');
  }
  const prices: Record<string, bigint> = {};
  for (const [id, value] of Object.entries(record.prices ?? {})) prices[id] = asBigInt(value, `price ${id}`);
  for (const id of [STOCK_A, STOCK_B, CASH]) {
    if (prices[id] === undefined || prices[id] <= 0n) throw new TypeError(`price for ${id} is required and positive`);
  }
  const order = indexOrder(Object.keys(prices));
  if (order[0] !== CASH) throw new TypeError('cash must be index zero');

  // The program requires ascending owner bytes, and the indices in the cross refer to that order.
  const accounts = [...record.accounts].sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));
  for (let index = 1; index < accounts.length; index++) {
    if (accounts[index - 1].owner === accounts[index].owner) throw new TypeError('accounts must have unique owners');
  }
  const indexOf = new Map(accounts.map((account, index) => [account.id, index]));

  const crosses: CompiledCross[] = [];
  const residuals: CompiledResidual[] = [];
  const unrepresented: CompiledSettlement['unrepresented'] = [];
  const explanation: string[] = [];

  for (const stock of [STOCK_A, STOCK_B]) {
    const stockIndex = order.indexOf(stock);
    const stockPrice = prices[stock];
    const cashPrice = prices[CASH];

    // The internal half of every account's intended change, as signed raw units.
    const internal = accounts.map(account => asBigInt(account.internal_raw?.[stock] ?? 0, `${account.id}.internal_raw.${stock}`));
    const remaining = internal.map(value => value < 0n ? -value : 0n); // what each seller still owes
    const wanted = internal.map(value => value > 0n ? value : 0n); // what each buyer still wants

    const sellers = remaining.map((value, index) => ({ index, value })).filter(entry => entry.value > 0n);
    const buyers = wanted.map((value, index) => ({ index, value })).filter(entry => entry.value > 0n);
    if (sellers.length === 0 || buyers.length === 0) {
      const totalInternal = internal.reduce((sum, value) => sum + value, 0n);
      if (totalInternal !== 0n) {
        unrepresented.push({ asset: stock, quantity_raw: totalInternal.toString(),
          reason: 'the proposal crosses this asset but only one side is represented' });
      }
      continue;
    }

    let sellerCursor = 0;
    let buyerCursor = 0;
    while (sellerCursor < sellers.length && buyerCursor < buyers.length) {
      const seller = sellers[sellerCursor];
      const buyer = buyers[buyerCursor];
      const quantity = seller.value < buyer.value ? seller.value : buyer.value;
      const exact = largestExact(quantity, stockPrice, cashPrice);
      if (exact === 0n) {
        unrepresented.push({ asset: stock, quantity_raw: quantity.toString(),
          reason: `no exact cash leg at ${stockPrice} micro-USD per raw unit against ${cashPrice}` });
        break;
      }
      const cash = cashFor(exact, stockPrice, cashPrice)!;
      if (crosses.length >= 6) {
        unrepresented.push({ asset: stock, quantity_raw: exact.toString(), reason: 'the protocol allows at most six crosses' });
        break;
      }
      crosses.push({ stock_index: String(stockIndex), seller_index: String(seller.index),
        buyer_index: String(buyer.index), stock_quantity: exact.toString(), cash_amount: cash.toString() });
      seller.value -= exact;
      buyer.value -= exact;
      if (exact < quantity) {
        unrepresented.push({ asset: stock, quantity_raw: (quantity - exact).toString(),
          reason: 'the remainder has no exact cash leg and was left to the residual' });
      }
      if (seller.value === 0n) sellerCursor += 1;
      if (buyer.value === 0n) buyerCursor += 1;
    }
    const leftOver = sellers.reduce((sum, entry) => sum + entry.value, 0n);
    if (leftOver > 0n) {
      unrepresented.push({ asset: stock, quantity_raw: leftOver.toString(), reason: 'unmatched sell quantity' });
    }
  }

  // The external half becomes the residual leg. The engine tells us the net; each contributing
  // account supplies its own share, which is the only weight the program accepts.
  for (const stock of [STOCK_A, STOCK_B]) {
    const stockIndex = order.indexOf(stock);
    const contributions = accounts.map(account => asBigInt(account.external_raw?.[stock] ?? 0, `${account.id}.external_raw.${stock}`));
    const net = contributions.reduce((sum, value) => sum + value, 0n);
    if (net === 0n) {
      if (contributions.some(value => value !== 0n)) {
        unrepresented.push({ asset: stock, quantity_raw: '0', reason: 'external quantities cancel and cannot be routed as one leg' });
      }
      continue;
    }
    if (residuals.length >= 2) {
      unrepresented.push({ asset: stock, quantity_raw: net.toString(), reason: 'the protocol allows at most two residual legs' });
      continue;
    }
    const direction = net > 0n ? 1 : 0; // 0 sells the stock, 1 buys it
    // Every contribution shares the sign of the net, so the input side is well defined.
    if (contributions.some(value => value !== 0n && (value > 0n) !== (net > 0n))) {
      unrepresented.push({ asset: stock, quantity_raw: net.toString(), reason: 'contributions do not share the net direction' });
      continue;
    }
    const inputs = contributions.map(value => (value < 0n ? -value : value).toString());
    const totalInput = contributions.reduce((sum, value) => sum + (value < 0n ? -value : value), 0n);
    if (totalInput !== (net < 0n ? -net : net)) {
      unrepresented.push({ asset: stock, quantity_raw: net.toString(), reason: 'contributions do not sum to the net quantity' });
      continue;
    }
    // The minimum output is what the reference price implies, less a disclosed tolerance: the
    // venue must not be allowed to deliver less than the participants' own accounting assumed
    // minus the committed external band.
    const outputPrice = direction === 0 ? prices[CASH] : prices[stock];
    const inputPrice = direction === 0 ? prices[stock] : prices[CASH];
    const expectedOutput = (totalInput * inputPrice) / outputPrice;
    const minimum = (expectedOutput * 9_800n) / 10_000n; // 200 bps, the committed external band
    if (minimum <= 0n) {
      unrepresented.push({ asset: stock, quantity_raw: net.toString(), reason: 'the implied minimum output is zero' });
      continue;
    }
    residuals.push({ stock_index: String(stockIndex), direction: String(direction),
      minimum_output: minimum.toString(), input_allocations: inputs });
  }

  const internalTotal = accounts.reduce((sum, account) => sum
    + asBigInt(account.internal_raw?.[STOCK_A] ?? 0, 'internal') + asBigInt(account.internal_raw?.[STOCK_B] ?? 0, 'internal'), 0n);
  explanation.push(`compiled ${crosses.length} internal cross(es) and ${residuals.length} residual leg(s) from the proposal's own per-account split`);
  explanation.push('cash legs use the engine reference price exactly, so the settleable trade reproduces the accounting the engine priced');
  explanation.push(`minimum residual outputs are set at the committed 200 bps external band below the reference value`);
  if (internalTotal !== 0n) explanation.push('warning: internal quantities do not sum to zero, which the compiler records as unrepresented');

  return { crosses, residuals, index_order: order, unrepresented, explanation };
}
