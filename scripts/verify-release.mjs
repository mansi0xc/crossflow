#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * Verify the release manifest against the working tree.
 *
 * A manifest that does not describe the tree it is committed next to is worse than no manifest, so
 * this fails on a missing file, a changed hash or a stale commit rather than warning.
 */
const MANIFEST_PATH = 'docs/release-manifest.json';
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const freeze = process.argv.includes('--freeze');
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const errors = [];

const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
// `--freeze` rewrites the manifest to describe the current tree; the plain run only ever verifies.
if (freeze) {
  const treeNow = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
  manifest.source.commit = head;
  manifest.source.tree = treeNow;
  for (const path of Object.keys(manifest.artifacts)) {
    if (existsSync(path)) manifest.artifacts[path] = sha256(path);
  }
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'FROZEN', commit: head, tree: treeNow,
    artifacts: Object.keys(manifest.artifacts).length }, null, 2));
  process.exit(0);
}
if (manifest.source.commit !== head) errors.push(`manifest commit ${manifest.source.commit} != HEAD ${head}`);
const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
if (manifest.source.tree !== tree) errors.push(`manifest tree ${manifest.source.tree} != HEAD tree ${tree}`);

// Do not trim the whole output: the leading status space of the first line is meaningful.
const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
// Two kinds of transient state are excluded here rather than allowlisted, so neither can be used to
// smuggle an unreviewed change into the tree:
//   * `.commandcode/` — agent tooling state (settings, learned preferences), which changes as the
//     tool is used and describes nothing about the artifact under test;
//   * `artifacts/` — the generated per-task evidence log, rewritten by every `verify:task` run. The
//     artifacts that actually ship are named in `manifest.artifacts` and are hash-checked below, so
//     excluding this directory does not weaken the release hashing.
const tracked = dirty.split('\n').filter(line => line.trim().length > 0)
  .filter(line => !line.startsWith('??')).map(line => line.slice(3).trim())
  .filter(path => !path.startsWith('.commandcode/') && !path.startsWith('artifacts/'));
const ignored = new Set(manifest.source.uncommittedAllowlist ?? []);

// The allowlist exists for the release paperwork a freeze rewrites in place — never for the code
// under test. A source, dependency or evidence file in the allowlist would let the very change
// being released go unverified, so each entry is checked rather than trusted. (An earlier manifest
// allowlisted services/api/src/server.ts and the lockfile, which made the PASS a formality.)
const PROTECTED = [
  /^services\//, /^packages\//, /^apps\//, /^programs\//, /^scripts\//, /^tests\//, /^research\//,
  /^verification\//, /^artifacts\//, /^target\//,
  /^package\.json$/, /^pnpm-lock\.yaml$/, /^Anchor\.toml$/, /^Cargo\.(toml|lock)$/, /^tsconfig\.json$/,
];
for (const path of ignored) {
  if (PROTECTED.some(pattern => pattern.test(path))) {
    errors.push(`allowlist entry ${path} is code or evidence and must be committed, not allowlisted`);
  }
}

const unexpected = tracked.filter(path => !ignored.has(path));
if (unexpected.length) errors.push(`uncommitted tracked changes: ${unexpected.join(', ')}`);

for (const [path, expected] of Object.entries(manifest.artifacts)) {
  if (!existsSync(path)) { errors.push(`missing artifact ${path}`); continue; }
  const actual = sha256(path);
  if (actual !== expected) errors.push(`artifact ${path} changed: ${actual} != ${expected}`);
}

for (const entry of manifest.checks) {
  if (entry.status !== 'PASS') errors.push(`check ${entry.name} is ${entry.status}`);
  for (const path of entry.evidence ?? []) {
    if (!existsSync(path)) errors.push(`check ${entry.name} cites missing evidence ${path}`);
  }
}

for (const limit of manifest.disclosures ?? []) {
  if (typeof limit !== 'string' || limit.length < 10) errors.push('disclosure entries must be explicit sentences');
}

if (errors.length) {
  console.error(errors.join('\n'));
  // A submission must not ship a manifest that describes a different tree, so this still fails —
  // but say what to do about it rather than leaving a reader to guess.
  if (errors.some(entry => entry.startsWith('manifest commit') || entry.startsWith('manifest tree') || entry.startsWith('artifact '))) {
    console.error('\nThe release manifest is frozen to a specific commit. If this is a legitimate new ' +
      'candidate, re-freeze it as the last step before submission:\n' +
      '  node scripts/verify-release.mjs --freeze\n' +
      'and commit the updated docs/release-manifest.json.');
  }
  process.exit(1);
}
console.log(JSON.stringify({ status: 'PASS', commit: head, artifacts: Object.keys(manifest.artifacts).length,
  checks: manifest.checks.length, disclosures: manifest.disclosures.length,
  uncommittedAllowlist: [...ignored].length }, null, 2));
