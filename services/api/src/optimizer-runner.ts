import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Run the bounded numerical engine.
 *
 * The executable and the script path are fixed constants; the caller can only supply JSON on
 * stdin. Nothing from the request reaches a shell, and the process is killed on a hard deadline
 * with a byte cap on its output.
 */
// Resolved from this module, not the working directory, so the service cannot be pointed at
// another script by where it happens to be launched from.
export const RUNNER = {
  executable: 'python3',
  script: fileURLToPath(new URL('../../optimizer/run_plan.py', import.meta.url)),
} as const;

export interface RunnerLimits {
  timeoutMs: number;
  maxOutputBytes: number;
  maxInputBytes: number;
}

export const DEFAULT_RUNNER_LIMITS: RunnerLimits = { timeoutMs: 20_000, maxOutputBytes: 1_048_576, maxInputBytes: 65_536 };

export interface RunnerResult {
  status: 'OK' | 'REJECTED' | 'TIMEOUT' | 'OVERSIZED' | 'FAILED';
  reason?: string;
  payload?: unknown;
  durationMs: number;
}

export function runNumericalEngine(request: unknown, limits: RunnerLimits = DEFAULT_RUNNER_LIMITS): Promise<RunnerResult> {
  const body = JSON.stringify(request);
  if (Buffer.byteLength(body, 'utf8') > limits.maxInputBytes) {
    return Promise.resolve({ status: 'OVERSIZED', reason: 'request exceeds the runner input cap', durationMs: 0 });
  }
  const started = Date.now();
  return new Promise<RunnerResult>(resolvePromise => {
    const child = spawn(RUNNER.executable, [RUNNER.script], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let oversize = false;
    let settled = false;
    const finish = (result: RunnerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed) child.kill('SIGKILL');
      resolvePromise({ ...result, durationMs: Date.now() - started });
    };
    const timer = setTimeout(() => finish({ status: 'TIMEOUT', reason: `engine exceeded ${limits.timeoutMs}ms`, durationMs: limits.timeoutMs }), limits.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (oversize) return;
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length > limits.maxOutputBytes) {
        oversize = true;
        finish({ status: 'OVERSIZED', reason: 'engine output exceeded the cap', durationMs: 0 });
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 8_192) stderr = Buffer.concat([stderr, chunk]); });
    child.on('error', error => finish({ status: 'FAILED', reason: `engine could not start: ${error.message}`, durationMs: 0 }));
    child.on('close', (code: number | null) => {
      if (oversize) return;
      let parsed: unknown;
      try { parsed = JSON.parse(stdout.toString('utf8')); }
      catch { return finish({ status: 'FAILED', reason: `engine returned unparseable output (exit ${code})`, durationMs: 0 }); }
      const record = parsed as { status?: string; reason?: string };
      if (record?.status === 'OK') return finish({ status: 'OK', payload: parsed, durationMs: 0 });
      finish({ status: 'REJECTED', reason: record?.reason ?? `engine rejected the request (exit ${code})`, durationMs: 0 });
    });
    child.stdin.on('error', () => { /* the child may exit before the write completes */ });
    child.stdin.end(body);
  });
}

/** A float anywhere in the engine output is a contract violation: amounts must be exact. */
export function assertNoFloats(value: unknown, path = '$'): void {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new TypeError(`non-integer number at ${path}`);
    return;
  }
  if (Array.isArray(value)) { value.forEach((entry, i) => assertNoFloats(entry, `${path}[${i}]`)); return; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) assertNoFloats(v, `${path}.${k}`);
  }
}
