import hashlib,json,re,subprocess
from fractions import Fraction as F
from pathlib import Path
root=Path('/Users/mansitibrewal/chronicles/crossflow')
v=json.loads((root/'docs/spec/wire-vectors.json').read_text())
# Independent exact rational executable price; no author checker import.
def band(q,k,p,sd,cd,bps):
    if q<=0 or k<=0:return False
    actual=F(k*10**sd*10**6,q*10**cd)
    return F(p*(10000-bps),10000)<=actual<=F(p*(10000+bps),10000)
for c in v['price_guard_vectors']:
    answer=band(*(int(c[k]) for k in ('stock_quantity','cash_amount','stock_price','stock_decimals','cash_decimals','deviation_bps')))
    assert answer is c['expected_accept'],c['id']
# $10/$11 attack separately: whole-slice rule passes but per-cross rule rejects.
assert F(999,1000)>=F(9800,10000)
assert band(10**6,11*10**6,10**7,6,6,100) is False
for limit in (100,200):
    lower=10**7*(10000-limit)//10000;upper=10**7*(10000+limit)//10000
    assert band(10**6,lower,10**7,6,6,limit)
    assert band(10**6,upper,10**7,6,6,limit)
    assert not band(10**6,lower-1,10**7,6,6,limit)
    assert not band(10**6,upper+1,10**7,6,6,limit)
# Aggregate exact price does not mask one-unit rounding damage to a contributor.
assert band(1,10,10**7,6,6,200)
assert not band(1,5,10**7,6,6,200)
assert not band(0,5,10**7,6,6,200)

for case in v['flow_vectors']:
    funding=[[int(x) for x in row] for row in case['funding']];n=len(funding)
    D=[[0]*3 for _ in range(n)];C=[[0]*3 for _ in range(n)];external=[0]*3
    premium=[0]*n;shortfall=[0]*n;allocations=[]
    price=[10**6,10**7,2*10**7]
    val=lambda a,amount:amount*price[a]*1000
    for cross in case['crosses']:
        a,s,b,q,k=[int(cross[f]) for f in ('stock','seller','buyer','quantity','cash')]
        assert band(q,k,price[a],6,6,100)
        for owner,asset,quantity in [(s,a,q),(b,0,k)]:D[owner][asset]+=quantity
        for owner,asset,quantity in [(b,a,q),(s,0,k)]:C[owner][asset]+=quantity
        paid=val(0,k)-val(a,q);premium[b]+=paid;premium[s]-=paid
    for leg in case['residuals']:
        a=int(leg['stock']);amounts=list(map(int,leg['inputs']));X=sum(amounts);Y=int(leg['observed_output'])
        ratios=[F(Y*x,X) for x in amounts];out=[int(x) for x in ratios]
        remaining=Y-sum(out)
        # Only positive input participants qualify; explicit tie index is canonical owner order.
        order=sorted([i for i,x in enumerate(amounts) if x],key=lambda i:(-(ratios[i]-out[i]),i))
        for i in order[:remaining]:out[i]+=1
        assert sum(out)==Y
        source,target=(a,0) if leg['direction']=='sell' else (0,a)
        for i,(x,y) in enumerate(zip(amounts,out)):
            D[i][source]+=x;C[i][target]+=y
            shortfall[i]+=val(source,x)-val(target,y)
            if x:
                q,k=(x,y) if source==a else (y,x)
                assert band(q,k,price[a],6,6,200)
            else:assert y==0
        external[source]-=X;external[target]+=Y;allocations.append(out)
    O=[[funding[i][a]-D[i][a]+C[i][a] for a in range(3)] for i in range(n)]
    for i in range(n):
        assert all(0<=D[i][a]<=funding[i][a] for a in range(3))
        loss=sum(val(a,funding[i][a]-O[i][a]) for a in range(3))
        assert loss==premium[i]+shortfall[i]
    for a in range(3):
        assert sum(C[i][a]-D[i][a] for i in range(n))==external[a]
        assert sum(O[i][a]-funding[i][a] for i in range(n))==external[a]
    expected=case['expected']
    for field,calculated in [('debits',D),('credits',C),('outputs',O),('residual_output_allocations',allocations)]:
        assert calculated==[[int(x) for x in row] for row in expected[field]],(case['id'],field)
    for field,calculated in [('external_net',external),('owner_internal_premium_paid',premium),('owner_external_shortfall',shortfall)]:
        assert calculated==list(map(int,expected[field])),(case['id'],field)

# Reconstruct the revised policy commitment independently from its field table.
p=v['policy'];pk=lambda k:bytes.fromhex(k);u=lambda x,n:int(x).to_bytes(n,'little')
b=b'CFLCFG01'+b''.join(pk(p[k]) for k in ('genesis','program_id','config_address'))
b+=u(p['configuration_version'],4)+u(p['oracle_mode'],1)+u(p['cash_index'],1)+u(len(p['assets']),1)
for a in p['assets']:b+=pk(a['mint'])+pk(a['token_program'])+u(a['decimals'],1)+pk(a['feed_id'])
b+=u(p['route_kind'],1)+b''.join(pk(p[k]) for k in ('route_program','pool','pool_authority'))+b''.join(pk(x) for x in p['route_vaults'])+u(p['max_route_legs'],1)
b+=u(p['max_age_seconds'],4)+u(p['max_future_skew_seconds'],4)
for k in ('max_confidence_bps','max_reference_move_bps','max_value_loss_bps','max_cross_deviation_bps','max_external_deviation_bps'):b+=u(p[k],2)
b+=u(p['max_intent_lifetime_seconds'],4)+pk(p['fixture_publisher'])+u(p['protocol_fee_bps'],2)
assert len(b)==652 and b.hex()==v['policy_hex'] and hashlib.sha256(b).hexdigest()==v['policy_sha256']
assert 3*10**12*10**12*10**9*10200<2**128
# Verify authoritative task cards are acyclic and revised displayed levels are correct.
text=(root/'.planning/TASKS.md').read_text();cards=re.split(r'^### (T\d+) — ',text,flags=re.M)
deps={}
for i in range(1,len(cards),2):
    tid=cards[i];body=cards[i+1];line=re.search(r'\*\*Phase / dependencies / owner / effort:\*\* (.+)',body).group(1)
    deps[tid]=re.findall(r'T\d+',line.split('/')[1])
levels={}
def level(t,stack=()):
    assert t not in stack,'cycle'
    if t not in levels:levels[t]=max((level(d,stack+(t,))+1 for d in deps[t]),default=0)
    return levels[t]
for t in deps:level(t)
assert set(deps['T05'])=={'T04','T14'}
assert {'T02','T04'}<=set(deps['T14'])
assert deps['T15']==['T14'] and set(deps['T16'])=={'T09','T10'}
rows=re.findall(r'^\| (\d+) \| (T\d+[^|]*) \|',text,flags=re.M)
for number,tasks in rows:
    for t in re.findall(r'T\d+',tasks):assert levels[t]==int(number),(t,number,levels[t])
# Hash five frozen sources and confirm commit identity without changing repository.
hashes={}
for pth in sorted((root/'docs/spec').iterdir()):
    if pth.is_file():
        raw=pth.read_bytes();committed=subprocess.check_output(['git','show','191f090:'+str(pth.relative_to(root))],cwd=root)
        assert raw==committed
        hashes[str(pth.relative_to(root))]=hashlib.sha256(raw).hexdigest()
print(json.dumps({'status':'PASS','independent_price_vectors':len(v['price_guard_vectors']),'independent_flow_vectors':len(v['flow_vectors']),'extra_counterexample_and_boundary_probes':'PASS','policy_bytes':len(b),'dependency_tasks':len(deps),'acyclic_and_waves_match':True,'source_commit':'191f090','source_sha256':hashes},indent=2))
