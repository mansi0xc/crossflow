import json, hashlib, struct, pathlib, importlib.util, copy
P=pathlib.Path('/private/tmp/crossflow-t02-stage/docs/spec')
v=json.loads((P/'wire-vectors.json').read_text())
# Independently implement wire order directly from normative table, without generator import.
def hx(x): return bytes.fromhex(x)
def u(x,n): return int(x).to_bytes(n,'little')
p=v['policy']; policy=b'CFLCFG01'+b''.join(hx(p[k]) for k in ['genesis','program_id','config_address'])+u(p['configuration_version'],4)+u(p['oracle_mode'],1)+u(p['cash_index'],1)+b'\x03'
for a in p['assets']: policy+=hx(a['mint'])+hx(a['token_program'])+u(a['decimals'],1)+hx(a['feed_id'])
policy+=u(p['route_kind'],1)+b''.join(hx(p[k]) for k in ['route_program','pool','pool_authority'])+b''.join(hx(x) for x in p['route_vaults'])+u(p['max_route_legs'],1)
for k,n in [('max_age_seconds',4),('max_future_skew_seconds',4),('max_confidence_bps',2),('max_reference_move_bps',2),('max_value_loss_bps',2),('max_intent_lifetime_seconds',4)]: policy+=u(p[k],n)
policy+=hx(p['fixture_publisher'])+u(p['protocol_fee_bps'],2)
assert policy.hex()==v['policy_hex'] and hashlib.sha256(policy).hexdigest()==v['policy_sha256']
for z in v['positive']:
 m=z['mandate']; raw=b'CFLINT01'+u(m['schema_version'],1)+b''.join(hx(m[k]) for k in ['genesis','program_id','config_address','policy_hash','owner'])+u(m['nonce'],8)+u(m['expiry_unix_seconds'],8)+hx(m['optimization_commitment'])+b'\x03'
 body=u(m['schema_version'],1)+hx(m['policy_hash'])+u(m['nonce'],8)+u(m['expiry_unix_seconds'],8)+hx(m['optimization_commitment'])
 for a in m['assets']:
  nums=b''.join(u(a[k],8) for k in ['funding','min_output','max_output','funding_reference_price'])
  raw+=hx(a['mint'])+hx(a['token_program'])+u(a['decimals'],1)+hx(a['recipient_ata'])+nums; body+=nums
 assert raw.hex()==z['canonical_hex'] and len(raw)==605 and len(body)==177
 assert hashlib.sha256(raw).hexdigest()==z['canonical_sha256'] and body.hex()==z['funding_body_hex']
for mu in v['one_field_byte_mutations']:
 b=bytearray.fromhex(v['positive'][0]['canonical_hex']); b[int(mu['byte_offset'])]^=int(mu['xor_hex'],16)
 assert hashlib.sha256(b).hexdigest()==mu['mutated_sha256']
print('Independent policy/mandate/funding preimages and 35 mutations PASS')
# Probe supplied strict-input checker using independent cases.
spec=importlib.util.spec_from_file_location('wire',P/'check-wire-vectors.py');w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)
for bad in [True, 1.0, ' 1', '+1', '01', '1.0', '1e1', str(2**64)]:
 m=copy.deepcopy(v['positive'][0]['mandate']);m['nonce']=bad
 try:w.encode_mandate(m,p)
 except ValueError:pass
 else:raise AssertionError(('unsafe nonce accepted',bad))
for Q in range(0,21):
 for wa in range(5):
  for wb in range(5):
   for wc in range(5):
    weights=[wa,wb,wc];T=sum(weights)
    if not T or not Q:continue
    out=w.allocation(Q,weights,['a','b','c']); assert sum(out)==Q and all(x>=0 for x in out)
    assert all(out[i]==0 for i in range(3) if weights[i]==0)
    assert out==w.allocation(Q,weights[::-1],['c','b','a'])[::-1]
print('Independent numeric-input probes and 2480 small allocation/conservation/permutation cases PASS')
D=pathlib.Path('/private/tmp/crossflow-t01-stage');s=json.loads((D/'research/economics/scenarios.json').read_text());m=json.loads((D/'research/economics/split-manifest.json').read_text())
canon=lambda x:json.dumps(x,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
assert hashlib.sha256(canon(s)).hexdigest()==m['suite_sha256']
assert set(m['train_ids']).isdisjoint(m['holdout_ids'])
assert set(m['train_ids'])|set(m['holdout_ids'])=={x['id'] for x in s['scenarios']}
refs=0
for x in s['scenarios']:
 assert hashlib.sha256(canon(x)).hexdigest()==m['scenario_sha256'][x['id']]
 prices={a['id']:a['price_micro_usd_per_raw'] for a in x['assets']}
 for a in x['accounts']:
  refs+=1; f=a['initial_raw'];o=a['reference']['final_raw'];charge=a['reference']['cost_debit_micro_usd']
  assert sum(f[k]*prices[k] for k in f)-sum(o[k]*prices[k] for k in o)==charge
print('Independent split/hashes and all',refs,'reference cash/value conservation checks PASS; optimizer_runs=0')
# Structural integration counterexamples, not performance evaluation.
x=next(x for x in s['scenarios'] if x['id']=='tiny-01');a=x['accounts'][0];prices={z['id']:z['price_micro_usd_per_raw'] for z in x['assets']};vf=sum(a['initial_raw'][k]*prices[k] for k in a['initial_raw']);vo=sum(a['reference']['final_raw'][k]*prices[k] for k in a['reference']['final_raw'])
print('T01 tiny-01/a reference VF',vf,'VO',vo,'loss_bps',(vf-vo)*10000//vf,'T02 200bps pass',vo*10000>=vf*9800)
print('Cross-price counterexample: buyer $1000 cash -> $989 cash + 1 share at $10 reference; seller $1000 cash +1 share -> $1011 cash. Buyer value loss=0.1%, seller gains; both pass 2% value guard although internal cross price is 10% above reference. Broad raw bounds can permit both outputs.')
files=list(D.glob('research/economics/*'))+[D/'scripts/check-scenarios.py',D/'tests/economics/test_scenarios.py']+list(P.glob('*'))
hashes={str(z):hashlib.sha256(z.read_bytes()).hexdigest() for z in files if z.is_file()}
pathlib.Path('/private/tmp/crossflow-foundation-source-hashes.json').write_text(json.dumps(hashes,indent=2)+'\n')
print('Source hashes saved:',len(hashes))
