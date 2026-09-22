import test from 'node:test';
import assert from 'node:assert/strict';
import { withLocalIdentity, isAuthorityRejection } from './safety.mjs';
const local = '4NvEmQ5DwAduuJb5KiTAQLi1hvFcxNXPTPRkM3KYaUG6';
const program = 'F9fpzkGLA7e58XHN5pE42g4mfoZiCzyu3Qtw3KkXJTT4';
for (const expected of [undefined, '', 'not-a-genesis', '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY']) {
  test(`invalid/public expected identity ${String(expected)} cannot read or write`, async () => {
    let reads = 0; let writes = 0;
    await assert.rejects(withLocalIdentity(expected, async () => { reads++; return local; }, async () => { writes++; }));
    assert.equal(reads, 0); assert.equal(writes, 0);
  });
}
test('mismatched local identity cannot reach funding/sign/send', async () => {
  let writes = 0;
  await assert.rejects(withLocalIdentity(local, async () => 'wrong', async () => { writes++; }), /LOCAL_GENESIS_MISMATCH/);
  assert.equal(writes, 0);
});
test('matching owned local identity permits the operation', async () => {
  let writes = 0;
  await withLocalIdentity(local, async () => local, async () => { writes++; });
  assert.equal(writes, 1);
});
test('structured expected program rejection is recognized', () => {
  assert.equal(isAuthorityRejection({ error: { errorCode: { code: 'Unauthorized', number: 6000 } }, logs: [`Program ${program} failed: custom program error: 0x1770`] }, program), true);
});
test('401, timeout, wrong code and wrong emitting program are not authority proof', () => {
  for (const error of [new Error('HTTP 401 Unauthorized'), new Error('timeout'), { error: { errorCode: { code: 'Unauthorized', number: 6001 } }, logs: [] }, { error: { errorCode: { code: 'Unauthorized', number: 6000 } }, logs: ['Program WRONG failed: custom program error: 0x1770'] }]) {
    assert.equal(isAuthorityRejection(error, program), false);
  }
});
