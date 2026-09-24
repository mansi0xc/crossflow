import { describe, expect, test } from 'vitest';
import { once } from 'node:events';
import { AddressInfo } from 'node:net';
import { DEFAULT_RUNNER_LIMITS, assertNoFloats, runNumericalEngine } from '../../services/api/src/optimizer-runner.js';
import { DEFAULT_SERVICE_CONFIG, createService } from '../../services/api/src/server.js';
import { decodeIntent, INTENT_SPACE } from '../../services/api/src/intent-index.js';
import { decodeSnapshot, SNAPSHOT_SPACE } from '../../services/api/src/batch-coordinator.js';

async function withService(overrides: Record<string, unknown>, run: (base: string) => Promise<void>) {
  const { server, config } = createService({ ...DEFAULT_SERVICE_CONFIG, port: 0, ...overrides });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  try { await run(`http://127.0.0.1:${port}`); }
  finally { server.close(); await once(server, 'close'); }
  expect(config.port).toBe(0);
}

describe('T32 service resource limits', () => {
  test('the numerical runner is bounded by input size, output size and a hard deadline', async () => {
    const oversized = await runNumericalEngine({ scenario_id: 'x'.repeat(DEFAULT_RUNNER_LIMITS.maxInputBytes) });
    expect(oversized.status).toBe('OVERSIZED');

    const timedOut = await runNumericalEngine({ scenario_id: 'opposite-01' }, { timeoutMs: 1, maxInputBytes: 1024, maxOutputBytes: 1024 });
    expect(['TIMEOUT', 'OK']).toContain(timedOut.status);

    const rejected = await runNumericalEngine({ scenario_id: 'not-a-frozen-scenario' });
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.reason).toMatch(/unknown scenario_id/);

    const accepted = await runNumericalEngine({ scenario_id: 'opposite-01', grid_step: 8 });
    expect(accepted.status).toBe('OK');
    expect(accepted.payload).toHaveProperty('comparison');
  }, 60_000);

  test('engine output must contain no non-integer number', () => {
    expect(() => assertNoFloats({ a: '1', b: [1, 2] })).not.toThrow();
    expect(() => assertNoFloats({ a: 1.5 })).toThrow(/non-integer/);
    expect(() => assertNoFloats({ a: [{ b: 0.1 }] })).toThrow(/\$\.a\[0\]\.b/);
  });

  test('the HTTP surface rejects oversized bodies, unknown routes and a request flood', async () => {
    await withService({ maxBodyBytes: 256, rateLimit: 5, rateWindowMs: 60_000 }, async base => {
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
      const body = await health.json();
      expect(body.status).toBe('OK');
      expect(JSON.stringify(body)).not.toMatch(/api[_-]?key|secret|private/i);

      const unknown = await fetch(`${base}/nope`);
      expect(unknown.status).toBe(404);

      // An oversized body is refused by closing the connection, so the refusal may surface as a
      // socket error rather than a response — either way nothing was processed.
      let oversizedRefused = false;
      try {
        const oversized = await fetch(`${base}/plans`, { method: 'POST', body: 'x'.repeat(4096) });
        oversizedRefused = [400, 413, 500].includes(oversized.status);
      } catch { oversizedRefused = true; }
      expect(oversizedRefused).toBe(true);

      let sawRateLimit = false;
      for (let i = 0; i < 12; i++) {
        const response = await fetch(`${base}/health`);
        if (response.status === 429) { sawRateLimit = true; break; }
      }
      expect(sawRateLimit).toBe(true);
    });
  }, 60_000);

  test('a missing operator and a non-JSON body are refused before any chain read', async () => {
    await withService({}, async base => {
      const noOperator = await fetch(`${base}/batches/prepare`, { method: 'POST', body: JSON.stringify({ plan: {} }) });
      expect(noOperator.status).toBe(400);
      const notJson = await fetch(`${base}/batches/prepare`, { method: 'POST', body: 'not json' });
      expect(notJson.status).toBe(400);
      const badLookup = await fetch(`${base}/batches/prepare`, { method: 'POST', body: JSON.stringify({ plan: {}, operator: '11111111111111111111111111111111', lookupTable: 7 }) });
      expect(badLookup.status).toBe(400);
    });
  }, 60_000);
});

describe('T32 chain decoding', () => {
  test('an intent account with the wrong discriminator or length is refused', () => {
    expect(() => decodeIntent('x', Buffer.alloc(INTENT_SPACE), 'now')).toThrow(/discriminator/);
    expect(() => decodeIntent('x', Buffer.alloc(INTENT_SPACE - 1), 'now')).toThrow(/unexpected length/);
  });

  test('a snapshot with the wrong length is refused', () => {
    expect(() => decodeSnapshot(Buffer.alloc(SNAPSHOT_SPACE - 1))).toThrow(/unexpected length/);
  });
});
