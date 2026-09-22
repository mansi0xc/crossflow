import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function assertPinnedWorkspace(root) {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  if (pkg.private !== true || pkg.packageManager !== 'pnpm@10.17.1') throw new Error('workspace package manager must be pinned');
  for (const group of ['dependencies', 'devDependencies']) {
    for (const [name, version] of Object.entries(pkg[group] ?? {})) {
      if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`unpinned ${name}`);
    }
  }
  if (!existsSync(resolve(root, 'pnpm-lock.yaml'))) throw new Error('missing lockfile');
  if (!existsSync(resolve(root, 'Cargo.lock'))) throw new Error('missing Cargo.lock');
  const anchor = readFileSync(resolve(root, 'Anchor.toml'), 'utf8');
  if (!/^cluster\s*=\s*"localnet"\s*$/m.test(anchor)) throw new Error('Anchor must default to localnet');
  const example = readFileSync(resolve(root, '.env.example'), 'utf8');
  if (!/^CROSSFLOW_CLUSTER=localnet$/m.test(example) || !/^CROSSFLOW_RPC_URL=http:\/\/127\.0\.0\.1:8899$/m.test(example) || /mainnet|testnet|(?:private|secret|api[_-]?key)\s*=/i.test(example)) {
    throw new Error('sample environment must be local-only and secrets-free');
  }
  const rust = readFileSync(resolve(root, 'Cargo.toml'), 'utf8');
  if (!/^overflow-checks\s*=\s*true\s*$/m.test(rust)) throw new Error('Rust release overflow checks must be enabled');
}

export function assertNoTrackedSecrets(root) {
  const tracked = execFileSync('git', ['ls-files', '-c', '-o', '--exclude-standard', '-z'], { cwd: root }).toString('utf8').split('\0').filter(Boolean);
  const forbiddenNames = /(^|\/)(?:[^/]*[-_])?(?:id|keypair|secret|seed)(?:[-_.][^/]*)?\.(json|pem|key|txt)$/i;
  const patterns = [/-----BEGIN (?:RSA |EC |OPENSSH |ED25519 )?PRIVATE KEY-----/, /\b(?:api_key|private_key|secret_key)\s*[:=]\s*["'][A-Za-z0-9+\/_=-]{20,}["']/i];
  for (const rel of tracked) {
    if (forbiddenNames.test(rel)) throw new Error(`tracked signing/secret filename: ${rel}`);
    if (!/\.(?:ts|tsx|js|mjs|rs|json|toml|md|yaml|yml|env)$/.test(rel)) continue;
    const full = resolve(root, rel);
    if (!existsSync(full)) continue;
    const body = readFileSync(full, 'utf8');
    if (patterns.some((re) => re.test(body))) throw new Error(`possible tracked secret in ${rel}`);
  }
}

export function assertNoMainnetWriteTarget(value) {
  if (typeof value !== 'string' || !value) throw new Error('explicit RPC URL required');
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported RPC protocol');
  if (parsed.hostname === 'api.mainnet-beta.solana.com' || parsed.hostname.includes('mainnet')) throw new Error('mainnet write target forbidden');
  if (parsed.hostname === 'api.testnet.solana.com' || parsed.hostname.includes('testnet')) throw new Error('testnet write target forbidden');
  if (parsed.hostname !== 'api.devnet.solana.com' && !['127.0.0.1', 'localhost'].includes(parsed.hostname)) throw new Error('unreviewed RPC hostname');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.cwd());
  assertPinnedWorkspace(root);
  assertNoTrackedSecrets(root);
  assertNoMainnetWriteTarget('http://127.0.0.1:8899');
  console.log('Workspace pinning, local default, tracked secret names, and RPC destination checks passed.');
}
