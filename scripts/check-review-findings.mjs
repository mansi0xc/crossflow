import { existsSync, readFileSync } from 'node:fs';

/**
 * Money-path review findings (T22).
 *
 * A review is only useful if a reader can tell what is still open. This refuses a review record
 * that has any unresolved finding, a "fixed" finding with no stated fix, a severity outside the
 * agreed scale, or no statement of what the review does *not* establish.
 */
const errors = [];
const findings = JSON.parse(readFileSync('docs/reviews/findings.json', 'utf8'));

if (findings.schema_version !== 1) errors.push('findings schema_version must be 1');
if (typeof findings.scope !== 'string' || findings.scope.length < 20) errors.push('findings must state their scope');
if (!Array.isArray(findings.reviews) || findings.reviews.length < 2) errors.push('a money-path review covers more than one surface');
if (!Array.isArray(findings.not_established) || findings.not_established.length < 3) {
  errors.push('a review must state what it does not establish');
}

const SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
const STATUSES = new Set(['fixed', 'accepted', 'open', 'mitigated']);
let total = 0;
let resolved = 0;
let serious = 0;

for (const review of findings.reviews ?? []) {
  for (const field of ['id', 'record', 'verdict', 'reviewer']) {
    if (typeof review[field] !== 'string' || review[field].length === 0) errors.push(`review ${review.id ?? '?'} is missing ${field}`);
  }
  if (!existsSync(review.record)) errors.push(`review ${review.id} cites a missing record: ${review.record}`);
  if (!Array.isArray(review.findings) || review.findings.length === 0) errors.push(`review ${review.id} has no findings, which is not credible`);
  for (const finding of review.findings ?? []) {
    total += 1;
    if (typeof finding.summary !== 'string' || finding.summary.length < 20) errors.push(`${review.id}/${finding.id} has no usable summary`);
    if (!SEVERITIES.has(finding.severity)) errors.push(`${review.id}/${finding.id} has an unknown severity "${finding.severity}"`);
    if (!STATUSES.has(finding.status)) errors.push(`${review.id}/${finding.id} has an unknown status "${finding.status}"`);
    if (finding.severity === 'high' || finding.severity === 'critical') serious += 1;
    if (finding.status === 'fixed' || finding.status === 'accepted') resolved += 1;
    if (finding.status === 'fixed') {
      if (typeof finding.fix !== 'string' || finding.fix.length < 10) errors.push(`${review.id}/${finding.id} is marked fixed with no stated fix`);
    }
    if (finding.status === 'open' && (finding.severity === 'critical' || finding.severity === 'high')) {
      errors.push(`${review.id}/${finding.id} is an open ${finding.severity} finding, which blocks the gate`);
    }
  }
}

if (!Array.isArray(findings.open_findings)) errors.push('open_findings must be an array, even when empty');
if ((findings.open_findings ?? []).length > 0) errors.push(`open findings remain: ${findings.open_findings.join(', ')}`);
if (total < 10) errors.push('a money-path review that found fewer than ten findings across three surfaces is not credible');
if (resolved < total) errors.push('every finding must be either fixed or explicitly accepted');

// A review that found nothing serious is either lucky or not a review. This record must contain at
// least one high or critical finding, or a review whose verdict required rework.
const reworked = (findings.reviews ?? []).some(review => /rework/i.test(String(review.verdict)));
if (serious === 0 && !reworked) errors.push('no serious finding and no rework recorded: the review is not credible');

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(JSON.stringify({
  status: 'PASS', task: 'T22', scope: findings.scope,
  reviews: findings.reviews.length, findings: total, resolved, serious,
  open_findings: findings.open_findings.length,
  not_established: findings.not_established.length,
  note: 'a scoped engineering review, not an external audit certificate',
}, null, 2));
