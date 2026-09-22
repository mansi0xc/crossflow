import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { AnchorProvider, Program, Wallet } from '@anchor-lang/core';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { withLocalIdentity, isAuthorityRejection } from './safety.mjs';

// Isolated disposable probe only; no mainnet or user-wallet key is used.
const endpoint = 'http://127.0.0.1:18899';
const connection = new Connection(endpoint, 'confirmed');
await withLocalIdentity(process.env.CROSSFLOW_T00_LOCAL_GENESIS, () => connection.getGenesisHash(), async (genesis) => {
const payer = Keypair.generate();
const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: 'confirmed' });
const idl = JSON.parse(await readFile(new URL('../t00_probe/target/idl/t00_probe.json', import.meta.url), 'utf8'));
const program = new Program(idl, provider);
const [counter] = PublicKey.findProgramAddressSync([Buffer.from('counter')], program.programId);
const airdrop = await connection.requestAirdrop(payer.publicKey, 1_000_000_000);
await connection.confirmTransaction(airdrop, 'confirmed');
const initialize = await program.methods.initialize().accounts({ payer: payer.publicKey, counter, systemProgram: SystemProgram.programId }).rpc();
const before = await program.account.counter.fetch(counter);
assert.equal(before.count.toString(), '0');
const increment = await program.methods.increment().accounts({ counter, authority: payer.publicKey }).rpc();
const after = await program.account.counter.fetch(counter);
assert.equal(after.count.toString(), '1');
assert.equal(after.authority.toBase58(), payer.publicKey.toBase58());
const attacker = Keypair.generate();
let rejection = false;
let rejectionEvidence;
try { await program.methods.increment().accounts({ counter, authority: attacker.publicKey }).signers([attacker]).rpc(); }
catch (error) { rejection = isAuthorityRejection(error, program.programId.toBase58()); rejectionEvidence = { code: error.error?.errorCode, logs: error.logs }; }
assert.ok(rejection, 'wrong authority must reject for the account-authority constraint');
assert.equal((await program.account.counter.fetch(counter)).count.toString(), '1');
const report = { status: 'PASS', scope: 'Disposable Anchor counter on isolated LOCAL validator, not CrossFlow', endpoint, genesis, programId: program.programId.toBase58(), initialize, increment, before: '0', after: '1', wrongAuthorityRejected: rejection, rejectionEvidence };
await writeFile(new URL('../local-runtime.json', import.meta.url), JSON.stringify(report, null, 2)+'\n');
console.log(JSON.stringify(report));

});
