const BASE = (import.meta.env?.VITE_CROSSFLOW_API as string | undefined) ?? 'http://127.0.0.1:8787';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  let payload: unknown = null;
  try { payload = text ? JSON.parse(text) : null; } catch { throw new Error(`${path} returned a non-JSON response`); }
  if (!response.ok) {
    const reason = (payload as { reason?: string } | null)?.reason ?? `HTTP ${response.status}`;
    throw new Error(reason);
  }
  return payload as T;
}

export interface DeploymentAsset { index: number; mint: string; tokenProgram: string; decimals: number; testAsset: boolean }
export interface Deployment {
  cluster: string; genesis: string; programId: string; config: string; deploymentId: string; policyHash: string;
  /** Which source produced this identity. The chain path is the fallback when the service is down. */
  source?: 'service' | 'chain';
  admin?: string; fundingPaused?: boolean; settlementPaused?: boolean; outstandingClaimIntents?: string;
  routeEnabled: boolean; oracleMode: number; oracleLabel: string; protocolFeeBps: string;
  maxIntentLifetimeSeconds: string; assets: DeploymentAsset[]; policy: Record<string, unknown>;
}
export interface IntentSummary {
  address: string; owner: string; nonce: string; status: string; expiryUnixSeconds: string;
  mandateHash: string; bookedClaims: string[]; initialSurplus: string[]; observedAt: string;
}
export interface PlanResponse {
  status: string; scenario_id: string; scenario_sha256: string;
  proposals: Record<'A' | 'B' | 'C', {
    method: string; status: string; feasible: boolean; reasons: string[];
    totals: Record<string, string | { numerator: number; denominator: number }> | null;
  }>;
  comparison: {
    valid_baselines: boolean; reason?: string;
    netting_gain_micro_usd?: number | { numerator: number; denominator: number } | null;
    cooperative_gain_micro_usd?: number | { numerator: number; denominator: number } | null;
    cooperative_raw_difference_micro_usd?: number | { numerator: number; denominator: number } | null;
    cooperative_trading_benefit_eligible?: boolean; attribution?: string;
  };
}

export const api = {
  deployment: () => request<Deployment>('/deployment'),
  health: () => request<{ status: string; cluster: string; genesis: string; routeEnabled: boolean }>('/health'),
  price: () => request<{ status: string; label: string; sequence: string; marketClosed: boolean; assets: { index: number; price: string }[] }>('/price'),
  intents: () => request<{ status: string; intents: IntentSummary[] }>('/intents'),
  plan: (scenarioId: string, gridStep = 1) => request<PlanResponse>('/plans', { method: 'POST', body: JSON.stringify({ scenario_id: scenarioId, grid_step: gridStep }) }),
  prepare: (body: { plan: unknown; operator: string }) => request<{ status: string; reason?: string; transaction?: string; preview?: Record<string, unknown>; outputs?: string[][] }>('/batches/prepare', { method: 'POST', body: JSON.stringify(body) }),
};

/**
 * Exact rationals arrive as numerator/denominator pairs. They are formatted with BigInt long
 * division: these are display values, but the compare screen exists to compare exactly, and
 * modelled micro-USD totals can exceed 2^53.
 */
export function micro(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string' || typeof value === 'number') return `${value} µUSD`;
  if (typeof value === 'object') {
    const pair = value as { numerator?: unknown; denominator?: unknown };
    if (typeof pair.numerator !== 'number' || typeof pair.denominator !== 'number' || pair.denominator === 0) return '—';
    const numerator = BigInt(pair.numerator);
    const denominator = BigInt(pair.denominator);
    const negative = numerator < 0n;
    const absolute = negative ? -numerator : numerator;
    const whole = absolute / denominator;
    const remainder = absolute % denominator;
    const sign = negative ? '-' : '';
    if (remainder === 0n) return `${sign}${whole} µUSD`;
    const fraction = ((remainder * 1000n) / denominator).toString().padStart(3, '0').replace(/0+$/, '');
    return `${sign}${whole}.${fraction} µUSD`;
  }
  return '—';
}
