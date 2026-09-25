import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Submission readiness (T29/T31).
 *
 * A submission is a set of claims pointed at evidence. This check follows every pointer: each
 * evidence path named in the claims ledger must exist, every claim must carry a recognised status,
 * and no submission artefact may contain a secret-like pattern. It fails closed, because a broken
 * evidence link in a submission is worse than no link at all.
 */
const errors = [];
const read = path => readFileSync(path, 'utf8');

const REQUIRED = ['README.md', 'docs/demo-script.md', 'docs/submission-draft.md',
  'docs/claims-ledger.csv', 'docs/THIRD_PARTY_NOTICES.md', 'docs/submission-checklist.md',
  'docs/final-handoff.md'];
for (const path of REQUIRED) if (!existsSync(path)) errors.push(`missing submission artefact ${path}`);

const STATUSES = new Set(['implemented', 'measured', 'narrowed', 'mixed', 'excluded', 'false',
  'not implemented', 'not run', 'planned', 'refused']);

// Every claim's evidence must resolve. Evidence is a `;`-separated list of repo paths or a single
// path; prose is not accepted as evidence.
if (existsSync('docs/claims-ledger.csv')) {
  const ledger = read('docs/claims-ledger.csv');
  const lines = ledger.trim().split('\n');
  const header = lines[0];
  if (!header.startsWith('claim,evidence,status,notes')) errors.push('claims ledger header is not the expected shape');
  let claims = 0;
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    // The columns are quoted and comma-separated; prices in prose contain commas.
    const match = line.match(/^"((?:[^"]|"")*)","((?:[^"]|"")*)","((?:[^"]|"")*)","((?:[^"]|"")*)"$/);
    if (!match) { errors.push(`claims ledger row is malformed: ${line.slice(0, 60)}`); continue; }
    const [, claim, evidence, status] = match;
    claims += 1;
    if (claim.trim().length < 10) errors.push(`claim is too short to be a claim: ${claim}`);
    if (!STATUSES.has(status.trim())) errors.push(`claim has an unrecognised status "${status}"`);
    const pointers = evidence.split(';').map(entry => entry.trim()).filter(Boolean);
    if (pointers.length === 0) errors.push(`claim has no evidence: ${claim.slice(0, 50)}`);
    for (const pointer of pointers) {
      if (pointer.startsWith('-')) continue; // an explicit "no artefact" marker
      if (pointer.includes(' ') && !pointer.includes('/')) { errors.push(`claim cites prose rather than a path: ${pointer}`); continue; }
      if (!existsSync(pointer)) errors.push(`claim cites missing evidence ${pointer}`);
    }
  }
  if (claims < 10) errors.push('claims ledger is too thin to be a submission');
  // The ledger must include the honest entries, not only the flattering ones.
  for (const required of ['excluded', 'not implemented']) {
    if (!lines.some(line => line.includes(`"${required}"`))) errors.push(`claims ledger omits any "${required}" claim`);
  }
}

// The draft must state its limitations and name what is absent.
if (existsSync('docs/submission-draft.md')) {
  const draft = read('docs/submission-draft.md');
  // The substance is what matters: the draft must name what it is missing, report the honest
  // result, and disclose that no audit exists.
  const lower = draft.toLowerCase();
  if (!lower.includes('deliberately absent')) errors.push('submission draft does not name what is deliberately absent');
  if (!lower.includes('honest result')) errors.push('submission draft does not report an honest result');
  if (!lower.includes('audit')) errors.push('submission draft does not disclose the absence of an audit');
  if (draft.length < 1500) errors.push('submission draft is too thin to stand as a submission');
}

// No secret-like pattern in anything a submission could carry.
const SECRET_PATTERNS = [/secretKey/i, /privateKey/i, /seedPhrase/i, /mnemonic/i, /api[_-]?key\s*[:=]/i,
  /BEGIN [A-Z ]*PRIVATE KEY/, /"(?:private|secret)"\s*:\s*\[/i];
for (const path of [...REQUIRED, 'docs/release-manifest.json']) {
  if (!existsSync(path)) continue;
  const text = read(path);
  for (const pattern of SECRET_PATTERNS) if (pattern.test(text)) errors.push(`${path} matches a secret-like pattern: ${pattern}`);
}

/**
 * Every path these documents cite must resolve. They cite paths in backticks rather than markdown
 * links, so both forms are followed; only paths under a known top-level directory are checked, so a
 * bare filename like `batch.rs` or a placeholder like `<TASK>` is not mistaken for a broken link.
 */
const TOP_LEVEL = ['docs', 'packages', 'programs', 'scripts', 'services', 'apps', 'tests',
  'verification', 'research', 'artifacts', 'dist'];
let links = 0;
for (const path of REQUIRED) {
  if (!existsSync(path)) continue;
  const text = read(path);
  const candidates = [
    ...[...text.matchAll(/\]\((\.[^)#]+)(?:#[^)]*)?\)/g)].map(match => resolve(dirname(path), match[1])),
    ...[...text.matchAll(/`([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)`/g)].map(match => match[1])
      .filter(pointer => !pointer.startsWith('/') && !pointer.includes('*') && !pointer.includes('<')
        && pointer.includes('/') && TOP_LEVEL.includes(pointer.split('/')[0])),
  ];
  for (const candidate of candidates) {
    const target = typeof candidate === 'string' && candidate.startsWith('/') ? candidate : resolve(candidate);
    links += 1;
    if (!existsSync(target)) errors.push(`${path} cites a missing path: ${typeof candidate === 'string' ? candidate : match}`);
  }
}
if (links === 0) errors.push('no cross-references found, which suggests the artefacts are not linked together');

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(JSON.stringify({
  status: 'PASS', task: 'T29', artefacts: REQUIRED.length, relativeLinks: links,
  prohibitedStatusesPresent: ['excluded', 'not implemented'],
  note: 'submission readiness only: whether the claims are true is what the per-task checks establish',
}, null, 2));
