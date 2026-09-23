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
    if (!['locked-install', 'workspace', 'vitest', 'typecheck', 'json-pass', 'cargo-test', 'anchor-build', 'capacity'].includes(check.kind)) throw new Error(`unknown evidence kind ${check.kind}`);
    if (typeof check.command !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(check.command)) throw new Error('invalid command');
    if (!Array.isArray(check.args) || check.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('invalid command args');
    if (check.args.join(' ').includes('mainnet')) throw new Error('mainnet command rejected');
  }
  for (const rel of manifest.sourceFiles) {
    if (typeof rel !== 'string' || rel.startsWith('/') || rel.split('/').includes('..') || rel.startsWith('artifacts/')) throw new Error('unsafe source selection');
  }
}

export function assertFreshOutput(kind, stdout, stderr, root) {
  const combined = `${stdout}\n${stderr}`;
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
  } else if (kind === 'json-pass') {
    const report = JSON.parse(stdout.trim());
    if (report.status !== 'PASS' || report.positive_vectors < 1 || report.price_guard_vectors < 1 || report.flow_vectors < 1 || report.subsidy_counterexample_rejected !== true) throw new Error('wire vectors missing required positive/adversarial cases');
  } else if (kind === 'cargo-test') {
    if (!/test result: ok\. [1-9]\d* passed; 0 failed; 0 ignored/.test(combined)) throw new Error('Rust test selection absent, failed or ignored');
  } else if (kind === 'anchor-build') {
    if (!/Finished `release` profile/.test(combined) || !existsSync(resolve(root, 'target/deploy/crossflow.so')) || !existsSync(resolve(root, 'target/idl/crossflow.json'))) {
      throw new Error('SBF/IDL build evidence missing');
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
    try { assertFreshOutput(check.kind, stdout, stderr, root); record.passed = true; }
    catch (error) { record.validationError = String(error); break; }
  }
  const passed = checks.length === manifest.checks.length && checks.every((item) => item.passed);
  const evidence = {
    task, status: passed ? 'CHECKS_PASS_REVIEW_PENDING' : 'CHECKS_FAILED', recordedAt: new Date().toISOString(),
    sourceCommit: version('git', ['rev-parse', 'HEAD'], root), sourceTreeSha256: source.sha256, sourceFiles: source.files,
    policyFixtureSha256: hash(readFileSync(resolve(root, 'docs/spec/wire-vectors.json'))),
    environment: 'LOCAL_NO_TRANSACTION', clusterGenesis: null, transactionCount: 0,
    versions: { node: process.version, pnpm: version('corepack', ['pnpm@10.17.1', '--version'], root),
      anchor: version('anchor', ['--version'], root), cargo: version('cargo', ['--version'], root) },
    checks, mandatoryCheckCount: manifest.checks.length, executedCheckCount: checks.length,
    reviewer: null, limits: ['Checks only; independent reviewer and actual runtime/compute capacity remain open'],
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
