import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';

function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }

export function assertManifest(manifest, task) {
  if (!/^T\d\d$/.test(task) || manifest.task !== task) throw new Error('task selector or manifest mismatch');
  if (!Array.isArray(manifest.sourceFiles) || manifest.sourceFiles.length === 0) throw new Error('missing source selection');
  if (!Array.isArray(manifest.checks) || manifest.checks.length === 0) throw new Error('zero mandatory checks');
  const names = new Set();
  for (const check of manifest.checks) {
    if (!check || typeof check.name !== 'string' || !/^[a-z0-9-]+$/.test(check.name) || names.has(check.name)) throw new Error('invalid/duplicate check name');
    names.add(check.name);
    if (!['locked-install', 'workspace', 'vitest', 'typecheck', 'json-pass', 'cargo-test', 'anchor-build', 'capacity', 'local-runtime', 't06-runtime', 't07-runtime', 't08-runtime', 't09-runtime', 't10-runtime', 't16-runtime', 't32-runtime', 't24-runtime', 'release-manifest', 'soak-report', 'playwright', 'python-test'].includes(check.kind)) throw new Error(`unknown evidence kind ${check.kind}`);
    if (typeof check.command !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(check.command)) throw new Error('invalid command');
    if (!Array.isArray(check.args) || check.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('invalid command args');
    if (check.args.join(' ').includes('mainnet')) throw new Error('mainnet command rejected');
  }
  for (const rel of manifest.sourceFiles) {
    if (typeof rel !== 'string' || rel.startsWith('/') || rel.split('/').includes('..') || rel.startsWith('artifacts/')) throw new Error('unsafe source selection');
  }
}

// Test runners colourise their output when they detect a terminal, and the escape sequences
// break the plain-text matchers below. Strip them before interpreting any evidence.
const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g;
export function stripAnsi(value) {
  return String(value).replace(ANSI, '');
}

export function assertFreshOutput(kind, stdout, stderr, root) {
  const combined = stripAnsi(`${stdout}\n${stderr}`);
  if (kind === 'locked-install') {
    if (!/Lockfile is up to date, resolution step is skipped/.test(combined) || !/Done in/.test(combined)) throw new Error('locked install did not verify reproducibility');
  } else if (kind === 'vitest') {
    const files = combined.match(/Test Files\s+(\d+) passed/);
    const tests = combined.match(/Tests\s+(\d+) passed/);
    if (!files || !tests || Number(files[1]) < 1 || Number(tests[1]) < 1 || /\b[1-9]\d*\s+(?:failed|skipped|todo)\b/i.test(combined)) throw new Error('Vitest selection absent, failed or skipped');
  } else if (kind === 'typecheck') {
    if (/\berror TS\d+\b/.test(combined)) throw new Error('TypeScript errors in typecheck output');
  } else if (kind === 'workspace') {
    const node = combined.match(/ℹ pass\s+(\d+)/);
    const vitest = combined.match(/Tests\s+(\d+) passed/);
    if (!node || !vitest || Number(node[1]) < 1 || Number(vitest[1]) < 1 || /ℹ (?:fail|skipped|todo)\s+[1-9]|Tests\s+0 passed|\b(?:skipped|todo)\s*\([1-9]/i.test(combined)) throw new Error('workspace mandatory tests absent, failed or skipped');
  } else if (kind === 'python-test') {
    // `unittest` prints "Ran N tests" then "OK" on success; a skip is a missing check.
    const ran = combined.match(/Ran (\d+) tests?/);
    if (!ran || Number(ran[1]) < 1 || !/^OK$/m.test(combined) || /skipped=\d+/.test(combined)) {
      throw new Error('Python test selection absent, failed or skipped');
    }
  } else if (kind === 'soak-report') {
    const result = JSON.parse(stdout.trim());
    if (result.status !== 'COMPLETE' || !(result.cycles >= 3) || !(result.steps >= 10) ||
        result.chain_errors !== 0 || result.ok < 1 ||
        !(result.refused >= 0) || !(result.max_compute > 0)) {
      throw new Error('soak report is incomplete or reports failures');
    }
  } else if (kind === 'release-manifest') {
    const result = JSON.parse(stdout.trim());
    if (result.status !== 'PASS' || !(result.artifacts >= 1) || !(result.checks >= 1) || !(result.disclosures >= 1) ||
        typeof result.commit !== 'string' || !/^[0-9a-f]{40}$/.test(result.commit)) {
      throw new Error('release manifest does not describe this tree');
    }
  } else if (kind === 't24-runtime') {
    const result = JSON.parse(stdout.trim());
    if (result.status !== 'PASS' || result.task !== 'T24' || result.cluster !== 'devnet' ||
        result.genesis !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' ||
        !(result.compute_units > 0) || !(result.lookup_table_entries >= 30) ||
        result.mandatory_negative_cases < 7 || result.recovery?.funded !== result.recovery?.returned ||
        !(result.recovery?.assets >= 1) ||
        Object.values(result.hashes ?? {}).length < 2 ||
        Object.values(result.hashes ?? {}).some(value => typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))) {
      throw new Error('T24 devnet probe evidence is incomplete');
    }
  } else if (kind === 'json-pass') {
    const report = JSON.parse(stdout.trim());
    if (report.status !== 'PASS' || report.positive_vectors < 1 || report.price_guard_vectors < 1 || report.flow_vectors < 1 || report.subsidy_counterexample_rejected !== true) throw new Error('wire vectors missing required positive/adversarial cases');
  } else if (kind === 'cargo-test') {
    if (!/test result: ok\. [1-9]\d* passed; 0 failed; 0 ignored/.test(combined)) throw new Error('Rust test selection absent, failed or ignored');
  } else if (kind === 'anchor-build') {
    if (!/Finished `release` profile/.test(combined) || !existsSync(resolve(root, 'target/deploy/crossflow.so')) || !existsSync(resolve(root, 'target/idl/crossflow.json'))) {
      throw new Error('SBF/IDL build evidence missing');
    }
  } else if (kind === 'local-runtime') {
    const report = JSON.parse(stdout.trim());
    const required = ['one-raw-unit-reference-mismatch', 'insufficient-source-balance', 'substituted-source-ata', 'substituted-configured-mint', 'wrong-funder-signer', 'duplicate-active-intent-new-nonce', 'duplicate-intent-replay'];
    const expectedLogs = {
      'attacker-first-initializer': /Error Code: Initializer/,
      'duplicate-initialization': /already in use/,
      'one-raw-unit-reference-mismatch': /Error Code: ReferenceMove/,
      'insufficient-source-balance': /Error Code: InsufficientFunds/,
      'substituted-source-ata': /Error Code: (AccountOwnedByWrongProgram|ConstraintAssociated)/,
      'substituted-configured-mint': /Error Code: (ConstraintAssociated|Mint)/,
      'wrong-funder-signer': /Error Code: (ConstraintSeeds|Nonce)/,
      'duplicate-active-intent-new-nonce': /Error Code: Nonce/,
      'duplicate-intent-replay': /already in use/,
    };
    if (report.status !== 'LOCAL_FUNDING_PASS' || report.cluster !== 'localnet' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(report.genesis) ||
        report.attacker_first_initializer_rejected !== true || report.duplicate_initialization_rejected !== true || report.prefunded_system_pda_adopted_safely !== true ||
        report.actual_compute_units <= 0 || report.actual_compute_units > report.requested_compute_units ||
        required.some((name) => !report.rollback_cases?.includes(name)) || Object.keys(report.transaction_signatures ?? {}).length !== 5 ||
        new Set(Object.values(report.transaction_signatures)).size !== 5 || !report.price_label?.startsWith('TEST PRICES')) throw new Error('local runtime evidence incomplete or mislabeled');
    for (const [label, expected] of Object.entries(expectedLogs)) {
      const item = report.negative_results?.find((row) => row.label === label);
      if (!item || !item.log?.includes('Program CW1jtAmpZWWwu3HyTACiW6W7Bwh6efcPHiha3noXbRkh failed:') || !expected.test(item.log)) throw new Error(`local runtime expected program rejection log missing for ${label}`);
    }
    if (report.stored_intent_verified !== true || !/^[0-9a-f]{64}$/.test(report.stored_mandate_hash ?? '')) throw new Error('stored mandate evidence missing');
    for (let i = 0; i < 3; i++) {
      const sourceDelta = BigInt(report.before_raw_balances.source[i]) - BigInt(report.after_raw_balances.source[i]);
      const vaultDelta = BigInt(report.after_raw_balances.vault[i]) - BigInt(report.before_raw_balances.vault[i]);
      if (sourceDelta !== vaultDelta) throw new Error(`local token conservation failed for asset ${i}`);
    }
  } else if (kind === 't06-runtime') {
    const result = JSON.parse(stdout.trim());
    if (result.status !== 'PASS' || result.task !== 'T06' || result.cluster !== 'localnet' ||
        result.mandatory_negative_cases < 15 || result.transaction_signatures !== 13 ||
        result.settlement_rollback_cpis_per_case !== 2 || result.final_nonce !== '2' ||
        result.outstanding_claim_intents !== '0') throw new Error('T06 local settlement/recovery evidence is incomplete');
  } else if (kind === 't07-runtime') {
    const result = JSON.parse(stdout.trim());
    if (result.status !== 'PASS' || result.task !== 'T07' || result.cluster !== 'localnet' ||
        !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(result.genesis) ||
        result.mandatory_negative_cases < 31 || result.transaction_signatures_count < 27 ||
        result.settlement_rollback_cpis_per_case !== 2 || result.final_nonce !== '3' ||
        result.outstanding_claim_intents !== '0' ||
        !/^[0-9a-f]{64}$/.test(result.demo_transcript_sha256 ?? '') ||
        !/^[0-9a-f]{64}$/.test(result.program_binary_sha256 ?? '')) {
      throw new Error('T07 local lifecycle/config evidence is incomplete');
    }
  } else if (kind === 't08-runtime') {
    const result = JSON.parse(stdout.trim());
    if (result.status !== 'PASS' || result.task !== 'T08' || result.cluster !== 'localnet' ||
        !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(result.genesis) ||
        result.mandatory_negative_cases < 6 || result.transaction_signatures_count !== 12 ||
        result.old_mint_removed_before_recovery !== true || result.recovered_raw !== '1000' ||
        result.recovered_vault_rent_lamports <= 0 || result.final_nonce !== '1' ||
        result.outstanding_claim_intents !== '0' ||
        Object.values(result.hashes ?? {}).length !== 5 ||
        Object.values(result.hashes ?? {}).some(value => typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))) {
      throw new Error('T08 local asset/recovery evidence is incomplete');
    }
  } else if (kind === 't09-runtime') {
    const result = JSON.parse(stdout.trim());
    if (result.status !== 'PASS' || result.task !== 'T09' || result.cluster !== 'localnet' ||
        !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(result.genesis) ||
        result.batch_count !== 3 || result.mandatory_negative_cases < 14 ||
        result.transaction_signatures_count < 6 ||
        !(result.compute_units > 0) || result.compute_units > 2000000 ||
        !(result.serialized_settlement_bytes > 0) || result.serialized_settlement_bytes > 1232 ||
        result.lookup_table_entries < 24 ||
        !Array.isArray(result.final_status) || result.final_status.length !== 3 || result.final_status.some(status => status !== 1) ||
        Object.values(result.hashes ?? {}).length !== 5 ||
        Object.values(result.hashes ?? {}).some(value => typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))) {
      throw new Error('T09 local batch settlement evidence is incomplete');
    }
  } else if (kind === 't10-runtime') {
    const result = JSON.parse(stdout.trim());
    if (result.status !== 'PASS' || result.task !== 'T10' || result.cluster !== 'localnet' ||
        !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(result.genesis) ||
        !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(result.pool ?? '') ||
        result.mandatory_negative_cases < 7 || result.transaction_signatures_count < 3 ||
        !(result.compute_units > 0) || result.compute_units > 200000 ||
        BigInt(result.measured_out) !== BigInt(result.quoted_out) ||
        BigInt(result.quoted_out) <= 0n ||
        Object.values(result.hashes ?? {}).length !== 3 ||
        Object.values(result.hashes ?? {}).some(value => typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))) {
      throw new Error('T10 controlled venue execution evidence is incomplete');
    }
  } else if (kind === 't16-runtime') {
    const result = JSON.parse(stdout.trim());
    if (result.status !== 'PASS' || result.task !== 'T16' || result.cluster !== 'localnet' ||
        !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(result.genesis) ||
        result.mandatory_negative_cases < 6 ||
        !(result.compute_units > 0) || result.compute_units > 2000000 ||
        !(result.serialized_settlement_bytes > 0) || result.serialized_settlement_bytes > 1232 ||
        result.lookup_table_entries < 30 ||
        BigInt(result.measured_external_input) <= 0n || BigInt(result.measured_external_output) <= 0n ||
        BigInt(result.external_deviation_bps) > 200n ||
        !Array.isArray(result.pools) || result.pools.length !== 3 ||
        result.route?.vaults_are_pool_atas !== true ||
        Object.values(result.hashes ?? {}).length !== 5 ||
        Object.values(result.hashes ?? {}).some(value => typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))) {
      throw new Error('T16 composed routed settlement evidence is incomplete');
    }
  } else if (kind === 'playwright') {
    const passed = combined.match(/(\d+) passed/);
    if (!passed || Number(passed[1]) < 1 || /(\d+) failed/.test(combined) || /(\d+) flaky/.test(combined)) {
      throw new Error('Playwright selection absent, failed or flaky');
    }
  } else if (kind === 't32-runtime') {
    const result = JSON.parse(stdout.trim());
    if (result.status !== 'PASS' || result.task !== 'T32' || result.cluster !== 'localnet' ||
        !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(result.genesis) ||
        result.funded_intents < 2 || result.settled_intents !== result.funded_intents ||
        !(result.compute_units > 0) || !(result.serialized_bytes > 0) || result.serialized_bytes > 1232 ||
        !(result.lookup_table_entries >= 1) ||
        !Array.isArray(result.steps) || result.steps.length < 8 ||
        !Array.isArray(result.limitations) || result.limitations.length < 2 ||
        Object.values(result.hashes ?? {}).length < 2 ||
        Object.values(result.hashes ?? {}).some(value => typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))) {
      throw new Error('T32 live service end-to-end evidence is incomplete');
    }
  } else if (kind === 'capacity') {
    const start = stdout.indexOf('{');
    if (start < 0) throw new Error('capacity JSON missing');
    const report = JSON.parse(stdout.slice(start));
    if (report.label !== 'SYNTHETIC_UNSIGNED_SERIALIZATION_ONLY' || !report.fundingWithLookup?.fits || !report.settlementWithLookup?.fits || report.actualRuntimeTransaction !== false) throw new Error('mandatory capacity estimate failed or mislabeled');
  } else throw new Error('unknown evidence kind');
}

export function sourceSnapshot(root, paths) {
  const mapping = {};
  for (const rel of paths) {
    const current = readFileSync(resolve(root, rel));
    const committed = execFileSync('git', ['show', `HEAD:${rel}`], { cwd: root, maxBuffer: 20 * 1024 * 1024 });
    if (!current.equals(committed)) throw new Error(`source differs from HEAD: ${rel}`);
    mapping[rel] = hash(current);
  }
  return { files: mapping, sha256: hash(JSON.stringify(mapping)) };
}

function version(command, args, root) {
  try { return execFileSync(command, args, { cwd: root, encoding: 'utf8', timeout: 10000 }).trim(); }
  catch { return 'UNAVAILABLE'; }
}

export function runTask(task, root = process.cwd()) {
  if (!/^T\d\d$/.test(task)) throw new Error('explicit Txx selector required');
  const manifest = readJson(resolve(root, 'verification/tasks', `${task}.json`));
  assertManifest(manifest, task);
  const source = sourceSnapshot(root, manifest.sourceFiles);
  const outDir = resolve(root, 'artifacts/tasks', task, source.sha256);
  mkdirSync(outDir, { recursive: true });
  const checks = [];
  let runtimeEvidence = null;
  let runtimeMode = null;
  for (const check of manifest.checks) {
    const result = spawnSync(check.command, check.args, { cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 20 * 1024 * 1024, shell: false });
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    const log = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`;
    const logName = `${check.name}.log`;
    writeFileSync(resolve(outDir, logName), log);
    const record = { name: check.name, kind: check.kind, command: [check.command, ...check.args], exit: result.status, signal: result.signal,
      output: logName, outputSha256: hash(log), passed: false };
    checks.push(record);
    if (result.error || result.status !== 0) break;
    try {
      assertFreshOutput(check.kind, stdout, stderr, root);
      record.passed = true;
      if (check.kind === 'local-runtime') runtimeEvidence = JSON.parse(stdout.trim());
      else if (check.kind === 't06-runtime') {
        runtimeEvidence = readJson(resolve(root, 'verification/evidence/T06-local-runtime.json'));
        runtimeMode = 'LOCAL_VALIDATOR_TRANSCRIPT';
      }
      else if (check.kind === 't07-runtime') {
        runtimeEvidence = JSON.parse(stdout.trim());
        runtimeMode = 'LOCAL_VALIDATOR_TRANSCRIPT';
      }
      else if (check.kind === 't08-runtime' || check.kind === 't09-runtime' || check.kind === 't10-runtime' || check.kind === 't16-runtime') {
        runtimeEvidence = JSON.parse(stdout.trim());
        runtimeMode = 'LOCAL_VALIDATOR_TRANSCRIPT';
      }
    }
    catch (error) { record.validationError = String(error); break; }
  }
  const passed = checks.length === manifest.checks.length && checks.every((item) => item.passed);
  const evidence = {
    task, status: passed ? 'CHECKS_PASS_REVIEW_PENDING' : 'CHECKS_FAILED', recordedAt: new Date().toISOString(),
    sourceCommit: version('git', ['rev-parse', 'HEAD'], root), sourceTreeSha256: source.sha256, sourceFiles: source.files,
    policyFixtureSha256: hash(readFileSync(resolve(root, 'docs/spec/wire-vectors.json'))),
    environment: runtimeEvidence ? (runtimeMode ?? 'LOCAL_VALIDATOR') : 'LOCAL_NO_TRANSACTION', clusterGenesis: runtimeEvidence?.genesis ?? null,
    transactionCount: runtimeEvidence ? Object.keys(runtimeEvidence.transaction_signatures ?? runtimeEvidence.signatures ?? {}).length : 0,
    versions: { node: process.version, pnpm: version('corepack', ['pnpm@10.17.1', '--version'], root),
      anchor: version('anchor', ['--version'], root), cargo: version('cargo', ['--version'], root) },
    checks, mandatoryCheckCount: manifest.checks.length, executedCheckCount: checks.length,
    reviewer: manifest.reviewer ?? null, limits: runtimeEvidence?.limitations ?? ['Checks only; independent reviewer and actual runtime/compute capacity remain open'],
  };
  writeFileSync(resolve(outDir, 'manifest.json'), JSON.stringify(evidence, null, 2) + '\n');
  writeFileSync(resolve(outDir, 'result.md'), `# ${task} verification\n\nStatus: ${evidence.status}. Executed ${checks.length}/${manifest.checks.length} mandatory checks. Source snapshot: ${source.sha256}.\n`);
  console.log(JSON.stringify({ evidenceDir: outDir, status: evidence.status, checks: checks.map(({ name, passed }) => ({ name, passed })) }, null, 2));
  if (!passed) throw new Error(`${task} verification failed; inspect ${outDir}`);
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const args = process.argv.slice(2);
  if (args[0] === '--') args.shift();
  if (args.length !== 1) throw new Error('exactly one explicit Txx selector required');
  runTask(args[0]);
}
