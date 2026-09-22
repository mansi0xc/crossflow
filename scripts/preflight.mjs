import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEVNET_RPC = 'https://api.devnet.solana.com';
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const TESTNET_GENESIS = '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY';
const LOCAL_RPCS = new Set(['http://127.0.0.1:8899', 'http://localhost:8899']);

// This preflight performs reads only. Future signing/broadcast paths must invoke
// their own reviewed guard; passing this script does not protect unrelated tools.
export function validateConfig(config) {
  if (!config || config.version !== 1) throw new Error('CONFIG_VERSION');
  if (config.newSpendBudget !== 0) throw new Error('SPENDING_NOT_AUTHORIZED');
  if (!Array.isArray(config.services)) throw new Error('SERVICES_REQUIRED');
  for (const service of config.services) {
    if (!service || typeof service.name !== 'string' || service.incrementalCost !== 0 || service.creditCardRequired !== false) {
      throw new Error('PAID_OR_UNVERIFIED_SERVICE');
    }
  }
  if (config.oracleMode !== 'fixture') throw new Error('PYTH_NOT_AUTHORIZED_IN_T00');
  if (config.network === 'devnet') {
    if (config.rpcUrl !== DEVNET_RPC || config.expectedGenesis !== DEVNET_GENESIS) throw new Error('DEVNET_IDENTITY_REQUIRED');
  } else if (config.network === 'localnet') {
    if (!LOCAL_RPCS.has(config.rpcUrl) || typeof config.expectedGenesis !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(config.expectedGenesis)) {
      throw new Error('LOCAL_IDENTITY_REQUIRED');
    }
    if ([DEVNET_GENESIS, MAINNET_GENESIS, TESTNET_GENESIS].includes(config.expectedGenesis)) throw new Error('LOCAL_IDENTITY_REQUIRED');
  } else {
    throw new Error('NETWORK_NOT_ALLOWED');
  }
  return Object.freeze(structuredClone(config));
}

export async function verifyRpc(config, fetchImpl = fetch) {
  const checked = validateConfig(config);
  let id = 0;
  async function call(method) {
    const requestId = ++id;
    const response = await fetchImpl(checked.rpcUrl, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method }),
    });
    if (!response.ok) throw new Error(`RPC_HTTP_${response.status}`);
    const body = await response.json();
    if (body.jsonrpc !== '2.0' || body.id !== requestId || body.error || !Object.hasOwn(body, 'result')) throw new Error('RPC_INVALID_RESPONSE');
    return body.result;
  }
  const genesis = await call('getGenesisHash');
  if (genesis !== checked.expectedGenesis) throw new Error('GENESIS_MISMATCH');
  const health = await call('getHealth');
  if (health !== 'ok') throw new Error('RPC_UNHEALTHY');
  const version = await call('getVersion');
  if (!version || typeof version['solana-core'] !== 'string') throw new Error('RPC_INVALID_VERSION');
  return { genesis, health, version, methods: ['getGenesisHash', 'getHealth', 'getVersion'] };
}

function getVersion(command, args) {
  try {
    return { status: 'PASS', value: execFileSync(command, args, { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
  } catch {
    return { status: 'FAIL', reason: `${command} version check failed; no credentials or raw environment logged` };
  }
}

export async function main(args = process.argv.slice(2)) {
  const valid = new Set(['--write-evidence', '--offline']);
  if (args.some(arg => !valid.has(arg))) throw new Error('UNKNOWN_ARGUMENT');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const raw = await readFile(resolve(root, 'preflight.config.json'), 'utf8');
  const config = validateConfig(JSON.parse(raw));
  const report = {
    task: 'T00', timestamp: new Date().toISOString(), scope: 'Environment and policy preflight only; no transaction is submitted',
    configSha256: createHash('sha256').update(raw).digest('hex'),
    policy: 'PASS', cluster: config.network, spendAuthorized: 0, oracleMode: config.oracleMode,
    tools: {
      node: getVersion('node', ['--version']), pnpm: getVersion('corepack', ['pnpm@10.17.1', '--version']),
      anchor: getVersion('anchor', ['--version']), solana: getVersion('solana', ['--version']),
      cargo: getVersion('cargo', ['--version']), sbf: getVersion('cargo-build-sbf', ['--version']), python: getVersion('python3', ['--version']),
    },
    rpc: { status: 'NOT_RUN', reason: 'offline mode' },
    overall: 'NOT_EVALUATED',
  };
  if (!args.includes('--offline')) {
    try { report.rpc = { status: 'PASS', ...await verifyRpc(config) }; }
    catch (error) { report.rpc = { status: 'FAIL', reason: error.message }; }
  }
  const failed = Object.values(report.tools).some(result => result.status !== 'PASS') || report.rpc.status === 'FAIL';
  report.overall = failed ? 'FAIL' : report.rpc.status === 'NOT_RUN' ? 'PARTIAL_OFFLINE' : 'PASS';
  // This output is one check, not the T00 acceptance manifest. The compatibility
  // build, negative tests, faucet, wallet and reviewer checks are separate.
  if (args.includes('--write-evidence')) {
    const output = resolve(root, 'artifacts/tasks/T00/working');
    await mkdir(output, { recursive: true });
    await writeFile(resolve(output, 'preflight.json'), JSON.stringify(report, null, 2) + '\n');
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (failed) process.exitCode = 1;
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`Preflight failed: ${error.message}\n`); process.exitCode = 1; });
}
