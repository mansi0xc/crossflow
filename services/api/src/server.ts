import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { Connection, PublicKey } from '@solana/web3.js';
import { prepareBatch, readSnapshot, summariseIntent, type CoordinatorOptions } from './batch-coordinator.js';
import { listFundedIntents } from './intent-index.js';
import { DEFAULT_RUNNER_LIMITS, assertNoFloats, runNumericalEngine } from './optimizer-runner.js';
import { validateWriteDestination } from '../../../scripts/network-guard.mjs';

/**
 * Bounded local service. It holds no user key, exposes no arbitrary command surface, and every
 * response is JSON derived from chain state or the frozen model.
 */
export interface ServiceConfig {
  rpcUrl: string;
  manifestPath: string;
  port: number;
  /** Requests per client per window. */
  rateLimit: number;
  rateWindowMs: number;
  maxBodyBytes: number;
  maxOwners: number;
  chainTimeoutMs: number;
  maxConcurrent: number;
}

export const DEFAULT_SERVICE_CONFIG: ServiceConfig = {
  rpcUrl: 'http://127.0.0.1:8899',
  manifestPath: 'verification/evidence/T16-local-manifest.json',
  port: 8787,
  rateLimit: 30,
  rateWindowMs: 60_000,
  maxBodyBytes: 65_536,
  maxOwners: 3,
  chainTimeoutMs: 15_000,
  maxConcurrent: 2,
};

interface Bucket { count: number; resetAt: number }

function isBase58Key(value: string): boolean {
  try { new PublicKey(value); return true; } catch { return false; }
}

export function createService(config: ServiceConfig = DEFAULT_SERVICE_CONFIG) {
  const manifest = JSON.parse(readFileSync(config.manifestPath, 'utf8'));
  const programId = new PublicKey(manifest.program_id);
  // The guard runs before the connection is even created, so a misconfigured cluster cannot serve.
  validateWriteDestination(config.rpcUrl, manifest.genesis, manifest.cluster === 'devnet' ? 'devnet' : 'local');
  const connection = new Connection(config.rpcUrl, 'confirmed');
  const coordinator: CoordinatorOptions = { connection, programId, manifest, timeoutMs: config.chainTimeoutMs, maxOwners: config.maxOwners };
  const buckets = new Map<string, Bucket>();
  let inFlight = 0;

  const rateLimited = (client: string) => {
    const now = Date.now();
    const bucket = buckets.get(client);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(client, { count: 1, resetAt: now + config.rateWindowMs });
      return false;
    }
    bucket.count += 1;
    return bucket.count > config.rateLimit;
  };

  // The UI is served from a different local origin, so only the local dev origins are allowed.
  const ALLOWED_ORIGINS = new Set(['http://127.0.0.1:5173', 'http://localhost:5173']);
  const corsHeaders = (origin: string | undefined) =>
    origin && ALLOWED_ORIGINS.has(origin)
      ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS', vary: 'origin' }
      : {};

  const send = (response: ServerResponse, code: number, payload: unknown) => {
    const body = JSON.stringify(payload, null, 2);
    response.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store', ...corsHeaders(response.req.headers.origin as string | undefined) });
    response.end(body);
  };

  const readBody = (request: IncomingMessage): Promise<string> =>
    new Promise((resolvePromise, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > config.maxBodyBytes) { reject(new Error('request body exceeds the cap')); request.destroy(); return; }
        chunks.push(chunk);
      });
      request.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
      request.on('error', reject);
    });

  const server = createServer(async (request, response) => {
    const client = request.socket.remoteAddress ?? 'unknown';
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'OPTIONS') {
      response.writeHead(204, corsHeaders(request.headers.origin as string | undefined));
      return response.end();
    }
    if (rateLimited(client)) return send(response, 429, { status: 'REJECTED', reason: 'rate limit exceeded' });
    const now = Date.now();
    if (buckets.size > 1024) for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
    if (inFlight >= config.maxConcurrent) {
      // Applies to reads as well: a burst of chain-reading GETs must not evict legitimate work.
      return send(response, 503, { status: 'REJECTED', reason: 'service is at its concurrency limit' });
    }
    inFlight += 1;
    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        return send(response, 200, { status: 'OK', cluster: manifest.cluster, genesis: manifest.genesis,
          programId: programId.toBase58(), config: manifest.config_address, routeEnabled: manifest.policy.route_kind === '1' });
      }
      if (request.method === 'GET' && url.pathname === '/deployment') {
        // Only public identity: no RPC credential, no key, nothing that lets a client sign.
        return send(response, 200, {
          status: 'OK',
          cluster: manifest.cluster,
          genesis: manifest.genesis,
          programId: programId.toBase58(),
          config: manifest.config_address,
          deploymentId: manifest.deployment_id,
          policyHash: manifest.initial_policy_hash,
          routeEnabled: manifest.policy.route_kind === '1',
          route: manifest.policy.route_kind === '1'
            ? { program: Buffer.from(manifest.policy.route_program, 'hex').toString('hex'), pool: manifest.policy.pool }
            : null,
          oracleMode: Number(manifest.policy.oracle_mode),
          oracleLabel: 'TEST PRICES; synthetic fixture oracle; no equity price claim',
          protocolFeeBps: manifest.policy.protocol_fee_bps,
          maxIntentLifetimeSeconds: manifest.policy.max_intent_lifetime_seconds,
          assets: manifest.policy.assets.map((asset: { mint: string; token_program: string; decimals: string }, i: number) => ({
            index: i, mint: Buffer.from(asset.mint, 'hex').toString('hex'),
            tokenProgram: Buffer.from(asset.token_program, 'hex').toString('hex'), decimals: Number(asset.decimals),
            testAsset: true,
          })),
          policy: manifest.policy,
        });
      }
      if (request.method === 'GET' && url.pathname === '/intents') {
        const intents = await listFundedIntents({ connection, programId, configAddress: new PublicKey(manifest.config_address), timeoutMs: config.chainTimeoutMs });
        return send(response, 200, { status: 'OK', observedAt: new Date().toISOString(), intents: intents.map(summariseIntent) });
      }
      if (request.method === 'GET' && url.pathname === '/price') {
        const snapshot = await readSnapshot(coordinator, new Date().toISOString());
        return send(response, 200, { status: 'OK', label: 'TEST PRICES; synthetic fixture oracle; no equity price claim',
          address: snapshot.address, sequence: snapshot.sequence, marketClosed: snapshot.marketClosed,
          assets: snapshot.assets.map((asset, i) => ({ index: i, price: asset.price, confidence: asset.confidence,
            feedId: asset.feedId, publishedAt: asset.publishedAt })) });
      }
      if (request.method === 'POST' && url.pathname === '/plans') {
        const body = await readBody(request);
        let parsed: { scenario_id?: unknown; grid_step?: unknown; scenario?: unknown };
        try { parsed = JSON.parse(body); } catch { return send(response, 400, { status: 'REJECTED', reason: 'body is not JSON' }); }
        const result = await runNumericalEngine(parsed, DEFAULT_RUNNER_LIMITS);
        if (result.status !== 'OK') return send(response, 400, { status: result.status, reason: result.reason, durationMs: result.durationMs });
        try { assertNoFloats(result.payload); }
        catch (error) { return send(response, 500, { status: 'REJECTED', reason: `engine produced a non-exact number: ${String(error)}` }); }
        return send(response, 200, result.payload);
      }
      if (request.method === 'POST' && url.pathname === '/batches/prepare') {
        const body = await readBody(request);
        let parsed: { plan?: unknown; operator?: unknown; lookupTable?: unknown; technical_probe?: unknown };
        try { parsed = JSON.parse(body); } catch { return send(response, 400, { status: 'REJECTED', reason: 'body is not JSON' }); }
        if (typeof parsed.operator !== 'string' || !isBase58Key(parsed.operator)) {
          return send(response, 400, { status: 'REJECTED', reason: 'operator must be a base58 public key' });
        }
        if (parsed.lookupTable !== undefined && (typeof parsed.lookupTable !== 'string' || !isBase58Key(parsed.lookupTable))) {
          return send(response, 400, { status: 'REJECTED', reason: 'lookupTable must be a base58 public key' });
        }
        const result = await prepareBatch(coordinator, parsed as never);
        return send(response, result.status === 'PREPARED' ? 200 : 400, result);
      }
      return send(response, 404, { status: 'REJECTED', reason: 'unknown route' });
    } catch (error) {
      return send(response, 500, { status: 'REJECTED', reason: String(error instanceof Error ? error.message : error) });
    } finally {
      inFlight -= 1;
    }
  });

  return { server, config, connection, programId, manifest };
}

if (process.argv[1] && process.argv[1].endsWith('server.ts')) {
  const { server, config } = createService({ ...DEFAULT_SERVICE_CONFIG, port: Number(process.env.CROSSFLOW_PORT ?? DEFAULT_SERVICE_CONFIG.port) });
  server.listen(config.port, '127.0.0.1', () => {
    console.log(JSON.stringify({ status: 'LISTENING', url: `http://127.0.0.1:${config.port}`, manifest: config.manifestPath }));
  });
}
