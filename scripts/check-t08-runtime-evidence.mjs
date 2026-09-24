import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';

const read = path => readFileSync(path);
const json = path => JSON.parse(read(path).toString('utf8'));
const sha = value => createHash('sha256').update(value).digest('hex');
const manifestPath = 'verification/evidence/T08-local-manifest.json';
const fundingPath = 'verification/evidence/T08-local-funding-output.json';
const setupPath = 'verification/evidence/T08-local-setup-output.json';
const recoveryPath = 'verification/evidence/T08-local-closed-vault-output.json';
const manifest = json(manifestPath);
const funding = json(fundingPath);
const setup = json(setupPath);
const recovery = json(recoveryPath);
const required = new Map([
  ['current-nonce-rejected', /Error Code: RecoveryAuthority/],
  ['non-owner-rejected', /Error Code: ConstraintSeeds/],
  ['substituted-vault-rejected', /Error Code: TokenIdentity/],
  ['substituted-recipient-rejected', /Error Code: TokenIdentity/],
  ['wrong-token-program-rejected', /Error Code: InvalidProgramId/],
  ['empty-vault-replay-rejected', /Error Code: TokenIdentity/],
]);
if (manifest.cluster !== 'localnet' || funding.status !== 'LOCAL_FUNDING_PASS' ||
    setup.status !== 'LOCAL_POLICY_REMOVAL_SETUP_PASS' || recovery.status !== 'LOCAL_CLOSED_VAULT_PASS' ||
    funding.genesis !== manifest.genesis || setup.genesis !== manifest.genesis || recovery.genesis !== manifest.genesis ||
    funding.config !== manifest.config_address || setup.config !== manifest.config_address || recovery.config !== manifest.config_address ||
    recovery.program_id !== manifest.program_id || recovery.owner !== manifest.expected_initializer ||
    funding.priceLabel !== 'TEST PRICES; synthetic fixture oracle; no equity price claim') {
  throw new Error('T08 local deployment, identity or test-price evidence mismatch');
}
if (setup.old_mint !== recovery.mint ||
    setup.old_mint !== new PublicKey(Buffer.from(manifest.policy.assets[0].mint, 'hex')).toBase58() ||
    setup.old_mint_removed !== true || setup.old_intent_closed !== true ||
    setup.policy_version !== 2 || setup.next_nonce !== '1' || setup.outstanding_claim_intents !== '0' ||
    recovery.policy_version_at_recovery !== 2 || recovery.configured_mint_at_recovery !== false ||
    recovery.nonce !== '0' || recovery.next_nonce !== '1' || recovery.old_intent !== funding.intent ||
    recovery.final_vault_closed !== true || recovery.old_intent_remains_closed !== true ||
    recovery.owner_nonce_unchanged !== true || recovery.donated_raw !== '1000' ||
    recovery.recovered_raw !== '1000' || BigInt(recovery.recovered_vault_rent_lamports ?? 0) <= 0n) {
  throw new Error('T08 closed-vault, mint-removal, nonce or rent invariant failed');
}
const negatives = new Map((recovery.negativeResults ?? []).map(row => [row.label, row.log]));
if (negatives.size !== required.size) throw new Error('T08 negative case count mismatch');
for (const [label, pattern] of required) {
  const log = negatives.get(label);
  if (!log?.includes(`Program ${manifest.program_id} invoke [1]`) ||
      !log.includes(`Program ${manifest.program_id} failed:`) || !pattern.test(log)) {
    throw new Error(`T08 missing target-program rejection for ${label}`);
  }
}
const signatures = [funding.configSignature, funding.publishSignature, funding.fundingSignature,
  setup.signatures.cancel, ...setup.signatures.withdrawals, setup.signatures.close, setup.signatures.rotation,
  recovery.signatures.createVault, recovery.signatures.donate, recovery.signatures.recover];
if (signatures.length !== 12 || signatures.some(signature => typeof signature !== 'string' ||
    !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature)) || new Set(signatures).size !== signatures.length) {
  throw new Error('T08 unique transaction signatures missing');
}
console.log(JSON.stringify({ status: 'PASS', task: 'T08', cluster: 'localnet', genesis: manifest.genesis,
  config: manifest.config_address, program_id: manifest.program_id, mandatory_negative_cases: required.size,
  transaction_signatures_count: signatures.length, transaction_signatures: signatures,
  old_mint_removed_before_recovery: true, recovered_raw: recovery.recovered_raw,
  recovered_vault_rent_lamports: recovery.recovered_vault_rent_lamports,
  final_nonce: recovery.next_nonce, outstanding_claim_intents: setup.outstanding_claim_intents,
  hashes: { manifest: sha(read(manifestPath)), funding: sha(read(fundingPath)), setup: sha(read(setupPath)),
    recovery: sha(read(recoveryPath)), binary: sha(read('target/deploy/crossflow.so')) },
  limitations: ['Isolated local validator and synthetic test prices only; no devnet or live equity claim.',
    'Captured signatures are historical evidence and require the running ledger for later RPC re-query.'] }, null, 2));
