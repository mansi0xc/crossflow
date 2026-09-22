import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BorshInstructionCoder } from '@anchor-lang/core';
import { PublicKey, TransactionInstruction, Transaction } from '@solana/web3.js';

const idl = JSON.parse(await readFile(new URL('../t00_probe/target/idl/t00_probe.json', import.meta.url), 'utf8'));
const coder = new BorshInstructionCoder(idl);
const initialize = idl.instructions.find(instruction => instruction.name === 'initialize');
assert.ok(initialize, 'compiled IDL must contain initialize');
const data = coder.encode('initialize', {});
assert.deepEqual([...data], initialize.discriminator, 'client encoding must match compiled Rust IDL');
const id = new PublicKey(idl.address);
const instruction = new TransactionInstruction({ programId: id, keys: [], data });
const transaction = new Transaction({ feePayer: id, recentBlockhash: '11111111111111111111111111111111' }).add(instruction);
const bytes = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
assert.ok(bytes.length > 0 && bytes.length <= 1232);
console.log(JSON.stringify({ status: 'PASS', check: 'Pinned JS SDK imports, compiled-IDL instruction encoding and unsigned serialization', networkRequests: 0, submittedTransactions: 0, bytes: bytes.length }));
