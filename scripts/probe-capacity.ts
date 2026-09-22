import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

const LIMIT = 1232;
const PROGRAM_ID = new PublicKey('CW1jtAmpZWWwu3HyTACiW6W7Bwh6efcPHiha3noXbRkh');

function pub(name: string): PublicKey {
  return new PublicKey(createHash('sha256').update(`crossflow-capacity-v1:${name}`).digest());
}

function meta(name: string, writable = false) {
  return { pubkey: pub(name), isSigner: false, isWritable: writable };
}

const operator = pub('operator');
const recentBlockhash = pub('recent-blockhash').toBase58();
const token = pub('spl-token-program');
const ata = pub('associated-token-program');
const system = pub('system-program');
const config = meta('config');
const snapshot = meta('fixture-snapshot');
const batch = meta('batch-authority', true);
const mints = Array.from({ length: 3 }, (_, i) => meta(`mint-${i}`));
const batchVaults = Array.from({ length: 3 }, (_, i) => meta(`batch-vault-${i}`, true));
const ownerStates = Array.from({ length: 3 }, (_, i) => meta(`owner-state-${i}`, true));
const intents = Array.from({ length: 3 }, (_, i) => meta(`intent-${i}`, true));
const intentVaults = Array.from({ length: 9 }, (_, i) => meta(`intent-vault-${i}`, true));
const recipients = Array.from({ length: 9 }, (_, i) => meta(`recipient-${i}`, true));
const route = [meta('controlled-route-program'), meta('pool'), meta('pool-authority'),
  ...Array.from({ length: 3 }, (_, i) => meta(`route-vault-${i}`, true))];
const feedAccounts = [meta('oracle-verifier-program'), meta('feed-A'), meta('feed-B')];

function instruction(keys: ReturnType<typeof meta>[], bodyLength: number): TransactionInstruction {
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data: Buffer.alloc(8 + bodyLength) });
}

function build(keys: ReturnType<typeof meta>[], bodyLength: number, lookup?: AddressLookupTableAccount, extra?: TransactionInstruction[], payer = operator) {
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }), ...(extra ?? []), instruction(keys, bodyLength)];
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash, instructions })
    .compileToV0Message(lookup ? [lookup] : []);
  const tx = new VersionedTransaction(message);
  let serializedBytes: number | null;
  let serializationFailure: string | null = null;
  try {
    serializedBytes = tx.serialize().length;
  } catch (error) {
    if (!(error instanceof RangeError) || !String(error.message).includes('encoding overruns')) throw error;
    serializedBytes = null;
    serializationFailure = 'Solana serializer exceeded its fixed packet buffer';
  }
  return {
    serializedBytes,
    serializationFailure,
    packetLimitBytes: LIMIT,
    fits: serializedBytes !== null && serializedBytes <= LIMIT,
    staticAccountKeys: message.staticAccountKeys.length,
    loadedWritable: message.addressTableLookups.reduce((n, entry) => n + entry.writableIndexes.length, 0),
    loadedReadonly: message.addressTableLookups.reduce((n, entry) => n + entry.readonlyIndexes.length, 0),
    signatures: tx.signatures.length,
    instructionCount: instructions.length,
  };
}

const fundingOwner = pub('owner-0');
const fundingKeys = [{ pubkey: fundingOwner, isSigner: true, isWritable: true }, config, snapshot, ownerStates[0], intents[0],
  ...mints, ...intentVaults.slice(0, 3), ...recipients.slice(0, 3),
  { pubkey: token, isSigner: false, isWritable: false },
  { pubkey: ata, isSigner: false, isWritable: false },
  { pubkey: system, isSigner: false, isWritable: false }];

const settlementKeys = [config, snapshot, batch, ...mints, ...batchVaults, ...ownerStates, ...intents,
  ...intentVaults, ...recipients, ...route,
  { pubkey: token, isSigner: false, isWritable: false },
  { pubkey: ata, isSigner: false, isWritable: false },
  { pubkey: system, isSigner: false, isWritable: false }];

const allAddresses = [...fundingKeys, ...settlementKeys, ...feedAccounts]
  .map((entry) => entry.pubkey)
  .filter((value, index, arr) => arr.findIndex((other) => other.equals(value)) === index)
  .filter((value) => !value.equals(operator) && !value.equals(PROGRAM_ID));

const lookup = new AddressLookupTableAccount({
  key: pub('mock-lookup-table'),
  state: { deactivationSlot: 18446744073709551615n, lastExtendedSlot: 0,
    lastExtendedSlotStartIndex: 0, authority: operator, addresses: allAddresses },
});

const pythReserve = new TransactionInstruction({
  programId: pub('pyth-reserved-verifier'),
  keys: feedAccounts,
  data: Buffer.alloc(512), // Placeholder only; actual signed payload is T15-gated.
});

const paddingArg = process.argv.find((item) => item.startsWith('--mandatory-padding='));
const mandatoryPadding = paddingArg ? Number(paddingArg.split('=')[1]) : 0;
if (!Number.isSafeInteger(mandatoryPadding) || mandatoryPadding < 0 || mandatoryPadding > 4096) throw new Error('invalid mandatory padding');
const paddedInstruction = mandatoryPadding > 0 ? [new TransactionInstruction({
  programId: PROGRAM_ID, keys: [], data: Buffer.alloc(mandatoryPadding),
})] : [];

const report = {
  label: 'SYNTHETIC_UNSIGNED_SERIALIZATION_ONLY',
  programId: PROGRAM_ID.toBase58(),
  canonicalBodyLengths: { funding: 177, settlementMaximum: 194 },
  assumptions: ['Three owners, two stocks plus cash, two venue legs',
    'All lookup addresses and data accounts are synthetic; no lookup table exists on devnet yet',
    'One operator signature; all wallet funding transactions are separate',
    'Fixture mode has preloaded price account; 512-byte Pyth reserve is illustrative, not a measured payload',
    'Compute units are requested, not measured; actual runtime and route checks remain open'],
  fundingWithLookup: build(fundingKeys, 177, lookup, undefined, fundingOwner),
  fundingWithoutLookup: build(fundingKeys, 177, undefined, undefined, fundingOwner),
  settlementWithLookup: build(settlementKeys, 194, lookup, paddedInstruction),
  settlementWithoutLookup: build(settlementKeys, 194),
  settlementWithIllustrativePythReserve: build([...settlementKeys, ...feedAccounts], 194, lookup, [pythReserve]),
  lookupAddressCount: allAddresses.length,
  mandatoryPaddingBytes: mandatoryPadding,
  actualComputeUnits: null,
  actualRuntimeTransaction: false,
};

if (!report.fundingWithLookup.fits || !report.settlementWithLookup.fits) {
  console.error(JSON.stringify(report, null, 2));
  throw new Error('Mandatory three-owner fixture envelope exceeds packet limit; amend capacity before money-path implementation');
}
if (process.argv.includes('--write')) {
  writeFileSync('/private/tmp/crossflow-t04-capacity.json', JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report, null, 2));
