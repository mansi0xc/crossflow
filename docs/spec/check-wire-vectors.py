#!/usr/bin/env python3
"""T02 independent stdlib encoding fixture generator/checker; not an on-chain validator."""
import copy
import hashlib
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MAX_AMOUNT = 10**12
MAX_PRICE = 10**12


def fail(message):
    raise ValueError(message)


def uint(value, width):
    if not isinstance(value, str) or not re.fullmatch(r"0|[1-9][0-9]*", value):
        fail("noncanonical integer")
    number = int(value)
    if number >= 1 << (8 * width):
        fail("integer width overflow")
    return number.to_bytes(width, "little")


def key(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
        fail("noncanonical bytes32")
    return bytes.fromhex(value)


def exact(obj, fields):
    if not isinstance(obj, dict) or set(obj) != set(fields.split()):
        fail("unknown or missing fields")


def bounded(value, low, high):
    uint(value, 8)
    if not low <= int(value) <= high:
        fail("out of admitted range")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encode_policy(p):
    exact(p, "genesis program_id config_address configuration_version oracle_mode cash_index assets route_kind route_program pool pool_authority route_vaults max_route_legs max_age_seconds max_future_skew_seconds max_confidence_bps max_reference_move_bps max_value_loss_bps max_cross_deviation_bps max_external_deviation_bps max_intent_lifetime_seconds fixture_publisher protocol_fee_bps")
    if len(p["assets"]) != 3 or len(p["route_vaults"]) != 3:
        fail("wrong cardinality")
    if p["oracle_mode"] != "0" or p["protocol_fee_bps"] != "0":
        fail("unimplemented mode or fee")
    bounded(p["configuration_version"], 1, 2**32-1)
    bounded(p["cash_index"], 0, 2)
    for name, low, high in [("max_age_seconds",1,60),("max_future_skew_seconds",0,2),("max_confidence_bps",0,100),("max_reference_move_bps",0,500),("max_value_loss_bps",0,200),("max_cross_deviation_bps",0,100),("max_external_deviation_bps",0,200),("max_intent_lifetime_seconds",1,900)]:
        bounded(p[name],low,high)
    if int(p["fixture_publisher"],16) == 0:
        fail("zero fixture publisher")
    keys = [key(a["mint"]) for a in p["assets"]]
    if keys != sorted(keys) or len(set(keys)) != 3:
        fail("noncanonical assets")
    out = b"CFLCFG01" + b"".join(key(p[f]) for f in ["genesis","program_id","config_address"])
    out += uint(p["configuration_version"],4) + uint(p["oracle_mode"],1) + uint(p["cash_index"],1) + b"\x03"
    for a in p["assets"]:
        exact(a,"mint token_program decimals feed_id")
        bounded(a["decimals"],0,9)
        if a["token_program"] != TOKEN_PROGRAM:
            fail("unsupported token program")
        out += key(a["mint"]) + key(a["token_program"]) + uint(a["decimals"],1) + key(a["feed_id"])
    if p["route_kind"] not in ["0","1"]:
        fail("unknown route kind")
    route_addresses = [p[f] for f in ["route_program","pool","pool_authority"]] + p["route_vaults"]
    if p["route_kind"] == "0":
        if p["max_route_legs"] != "0" or any(v != "00"*32 for v in route_addresses):
            fail("disabled route has authority")
    elif p["max_route_legs"] != "2" or any(v == "00"*32 for v in route_addresses):
        fail("incomplete route policy")
    out += uint(p["route_kind"],1) + b"".join(key(v) for v in route_addresses) + uint(p["max_route_legs"],1)
    out += uint(p["max_age_seconds"],4) + uint(p["max_future_skew_seconds"],4)
    out += b"".join(uint(p[f],2) for f in ["max_confidence_bps","max_reference_move_bps","max_value_loss_bps","max_cross_deviation_bps","max_external_deviation_bps"])
    out += uint(p["max_intent_lifetime_seconds"],4) + key(p["fixture_publisher"]) + uint(p["protocol_fee_bps"],2)
    return out


def encode_mandate(m,p):
    exact(m,"schema_version genesis program_id config_address policy_hash owner nonce expiry_unix_seconds optimization_commitment assets")
    policy_hash = digest(encode_policy(p))
    if m["schema_version"] != "1" or m["policy_hash"] != policy_hash:
        fail("version or policy mismatch")
    for f in ["genesis","program_id","config_address"]:
        if m[f] != p[f]:
            fail("deployment domain mismatch")
    if m["optimization_commitment"] == "00"*32 or len(m["assets"]) != 3:
        fail("invalid commitment or asset count")
    out = b"CFLINT01" + uint(m["schema_version"],1)
    out += b"".join(key(m[f]) for f in ["genesis","program_id","config_address","policy_hash","owner"])
    out += uint(m["nonce"],8) + uint(m["expiry_unix_seconds"],8) + key(m["optimization_commitment"]) + b"\x03"
    body = uint(m["schema_version"],1) + key(m["policy_hash"]) + uint(m["nonce"],8) + uint(m["expiry_unix_seconds"],8) + key(m["optimization_commitment"])
    recipients = set()
    for index,a in enumerate(m["assets"]):
        exact(a,"mint token_program decimals recipient_ata funding min_output max_output funding_reference_price")
        for f in ["mint","token_program","decimals"]:
            if a[f] != p["assets"][index][f]:
                fail("asset identity mismatch")
        for f in ["funding","min_output","max_output"]:
            bounded(a[f],0,MAX_AMOUNT)
        bounded(a["funding_reference_price"],1,MAX_PRICE)
        if int(a["min_output"]) > int(a["max_output"]):
            fail("inverted bounds")
        recipient = key(a["recipient_ata"])
        if recipient in recipients:
            fail("duplicate recipient")
        recipients.add(recipient)
        out += key(a["mint"]) + key(a["token_program"]) + uint(a["decimals"],1) + recipient
        amounts = b"".join(uint(a[f],8) for f in ["funding","min_output","max_output","funding_reference_price"])
        out += amounts
        body += amounts
    if sum(int(a["funding"]) for a in m["assets"]) == 0:
        fail("zero funded slice")
    assert len(out) == 605 and len(body) == 177
    return out,body



def decode_mandate(raw,p):
    if len(raw) != 605:
        fail("wrong canonical byte length")
    if raw[:8] != b"CFLINT01":
        fail("wrong canonical domain")
    at=8
    def take(size):
        nonlocal at
        chunk=raw[at:at+size];at+=size
        return chunk
    m={"schema_version":str(int.from_bytes(take(1),"little"))}
    for f in ["genesis","program_id","config_address","policy_hash","owner"]:
        m[f]=take(32).hex()
    m["nonce"]=str(int.from_bytes(take(8),"little"))
    m["expiry_unix_seconds"]=str(int.from_bytes(take(8),"little"))
    m["optimization_commitment"]=take(32).hex()
    if take(1) != b"\x03":
        fail("wrong encoded asset count")
    m["assets"]=[]
    for _ in range(3):
        a={"mint":take(32).hex(),"token_program":take(32).hex(),"decimals":str(int.from_bytes(take(1),"little")),"recipient_ata":take(32).hex()}
        for f in ["funding","min_output","max_output","funding_reference_price"]:
            a[f]=str(int.from_bytes(take(8),"little"))
        m["assets"].append(a)
    assert at==605
    encoded,_=encode_mandate(m,p)
    if encoded != raw: fail("noncanonical reencoding")
    return m


def b58decode(value):
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    n = 0
    for c in value:
        n = n*58 + alphabet.index(c)
    return (b"\0"*(len(value)-len(value.lstrip("1"))) + n.to_bytes((n.bit_length()+7)//8,"big")).hex()


TOKEN_PROGRAM = b58decode("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
OWNER = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"


def fixture():
    p = dict(genesis=b58decode("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"),program_id="11"*32,config_address="22"*32,configuration_version="1",oracle_mode="0",cash_index="0",assets=[dict(mint=f"{i:02x}"*32,token_program=TOKEN_PROGRAM,decimals="6",feed_id=f"{i+16:02x}"*32) for i in [49,50,51]],route_kind="0",route_program="00"*32,pool="00"*32,pool_authority="00"*32,route_vaults=["00"*32]*3,max_route_legs="0",max_age_seconds="60",max_future_skew_seconds="2",max_confidence_bps="100",max_reference_move_bps="500",max_value_loss_bps="200",max_cross_deviation_bps="100",max_external_deviation_bps="200",max_intent_lifetime_seconds="900",fixture_publisher="55"*32,protocol_fee_bps="0")
    m = {f:p[f] for f in ["genesis","program_id","config_address"]}
    m.update(schema_version="1",policy_hash=digest(encode_policy(p)),owner=OWNER,nonce="0",expiry_unix_seconds="1800630900",optimization_commitment=digest(b"crossflow-t02-example-economic-manifest-v1"),assets=[])
    for index,a in enumerate(p["assets"]):
        item = {f:a[f] for f in ["mint","token_program","decimals"]}
        item.update(recipient_ata=f"{96+index:02x}"*32,funding=["1000000000","5000000","2000000"][index],min_output=["200000000","0","0"][index],max_output=["2000000000","15000000","10000000"][index],funding_reference_price=["1000000","100000000","150000000"][index])
        m["assets"].append(item)
    return p,m


def vector(name,m,p):
    raw,body=encode_mandate(m,p)
    return dict(id=name,mandate=m,canonical_hex=raw.hex(),canonical_sha256=digest(raw),canonical_length=str(len(raw)),funding_body_hex=body.hex(),funding_body_sha256=digest(body),funding_body_length=str(len(body)))


def allocation(q,weights,owners):
    if q == 0:
        if any(weights): fail("weights on zero pool")
        return [0]*len(weights)
    t=sum(weights)
    if t == 0: fail("unallocated positive pool")
    c=[q*w//t for w in weights]
    rem=[q*w%t for w in weights]
    order=sorted(range(len(weights)),key=lambda i:(-rem[i],owners[i]))
    for i in order[:q-sum(c)]: c[i]+=1
    return c



def checked_u128(value):
    if not 0 <= value < 2**128:
        fail("u128 overflow")
    return value


def value(amount,price,decimals):
    return checked_u128(checked_u128(amount*price)*10**(9-decimals))


def price_pass(q,k,p,stock_decimals,cash_decimals,bps):
    if q<=0 or k<=0: return False
    stock=value(q,p,stock_decimals)
    cash=value(k,10**6,cash_decimals)
    return checked_u128(stock*(10000-bps)) <= checked_u128(cash*10000) <= checked_u128(stock*(10000+bps))


def price_vectors():
    cases=[
        ("cross-lower-equality",10**6,9900000,100,6,6,True),
        ("cross-lower-one-cash-unit-outside",10**6,9899999,100,6,6,False),
        ("cross-upper-equality",10**6,10100000,100,6,6,True),
        ("cross-upper-one-cash-unit-outside",10**6,10100001,100,6,6,False),
        ("cross-upper-one-stock-unit-outside",999999,10100000,100,6,6,False),
        ("cross-lower-one-stock-unit-outside",1000001,9900000,100,6,6,False),
        ("cross-strict-exact",10**6,10000000,0,6,6,True),
        ("cross-strict-one-cash-unit-high",10**6,10000001,0,6,6,False),
        ("cross-strict-one-cash-unit-low",10**6,9999999,0,6,6,False),
        ("mixed-decimals-upper-equality",10**9,10100000,100,9,6,True),
        ("mixed-decimals-one-stock-unit-outside",10**9-1,10100000,100,9,6,False),
        ("external-lower-equality",10**6,9800000,200,6,6,True),
        ("external-lower-one-cash-unit-outside",10**6,9799999,200,6,6,False),
        ("external-upper-equality",10**6,10200000,200,6,6,True),
        ("external-upper-one-cash-unit-outside",10**6,10200001,200,6,6,False),
        ("ten-dollar-share-eleven-dollar-cross",10**6,11000000,100,6,6,False),
    ]
    result=[]
    for name,q,k,bps,sd,cd,expected in cases:
        actual=price_pass(q,k,10**7,sd,cd,bps)
        assert actual==expected,name
        result.append(dict(id=name,stock_quantity=str(q),cash_amount=str(k),stock_price="10000000",stock_decimals=str(sd),cash_decimals=str(cd),deviation_bps=str(bps),expected_accept=expected))
    return result


def flow_model(funding,crosses,legs):
    # A small readable specification reference, not a runtime or proof.
    n=len(funding);prices=[10**6,10**7,2*10**7]
    debit=[[0]*3 for _ in range(n)];credit=[[0]*3 for _ in range(n)]
    premium_paid=[0]*n;shortfalls=[0]*n;external=[0]*3
    stock_sells=[[False]*3 for _ in range(n)];stock_buys=[[False]*3 for _ in range(n)]
    cross_order=[];leg_order=[];allocations=[]
    if not 1<=n<=3 or len(crosses)>6 or len(legs)>2: fail("flow cardinality")
    for record in crosses:
        exact(record,"stock seller buyer quantity cash")
        a,s,b,q,k=[int(record[f]) for f in ["stock","seller","buyer","quantity","cash"]]
        if a not in [1,2] or not 0<=s<n or not 0<=b<n or s==b: fail("cross identities")
        if not 0<q<=MAX_AMOUNT or not 0<k<=MAX_AMOUNT: fail("cross amounts")
        cross_order.append((a,s,b))
        if not price_pass(q,k,prices[a],6,6,100): fail("cross price band")
        debit[s][a]+=q;credit[b][a]+=q;debit[b][0]+=k;credit[s][0]+=k
        stock_sells[s][a]=True;stock_buys[b][a]=True
        premium=value(k,prices[0],6)-value(q,prices[a],6)
        premium_paid[b]+=premium;premium_paid[s]-=premium
    if cross_order!=sorted(set(cross_order)): fail("cross ordering or duplicates")
    for leg in legs:
        exact(leg,"stock direction inputs observed_output minimum_output")
        a=int(leg["stock"]);direction=leg["direction"];inputs=list(map(int,leg["inputs"]))
        y=int(leg["observed_output"]);minimum=int(leg["minimum_output"])
        if a not in [1,2] or direction not in ["sell","buy"] or len(inputs)!=n: fail("residual identities")
        if any(not 0<=x<=MAX_AMOUNT for x in inputs) or not 0<sum(inputs)<=3*MAX_AMOUNT: fail("residual input")
        if not 0<minimum<=y<=3*MAX_AMOUNT: fail("residual output")
        leg_order.append(a)
        source,target=(a,0) if direction=="sell" else (0,a)
        outputs=allocation(y,inputs,list(range(n)))
        X=sum(inputs)
        aq,ak=(X,y) if direction=="sell" else (y,X)
        if not price_pass(aq,ak,prices[a],6,6,200): fail("aggregate external price band")
        for i,(x,out) in enumerate(zip(inputs,outputs)):
            if x:
                q,k=(x,out) if direction=="sell" else (out,x)
                if not price_pass(q,k,prices[a],6,6,200): fail("participant external price band")
                (stock_sells if direction=="sell" else stock_buys)[i][a]=True
            elif out: fail("nonparticipant credit")
            debit[i][source]+=x;credit[i][target]+=out
            shortfalls[i]+=value(x,prices[source],6)-value(out,prices[target],6)
        external[source]-=X;external[target]+=y
        allocations.append(outputs)
    if leg_order!=sorted(set(leg_order)): fail("residual ordering or duplicates")
    for i in range(n):
        for a in [1,2]:
            if stock_sells[i][a] and stock_buys[i][a]: fail("owner stock direction conflict")
    outputs=[]
    for i in range(n):
        out=[]
        for a in range(3):
            if not 0<=debit[i][a]<=funding[i][a]<=MAX_AMOUNT: fail("unfunded debit")
            o=funding[i][a]-debit[i][a]+credit[i][a]
            if not 0<=o<=MAX_AMOUNT or credit[i][a]>MAX_AMOUNT: fail("output cap")
            out.append(o)
        vf=sum(value(funding[i][a],prices[a],6) for a in range(3))
        vo=sum(value(out[a],prices[a],6) for a in range(3))
        if vo*10000<vf*9800: fail("whole-slice loss")
        assert vf-vo==premium_paid[i]+shortfalls[i]
        outputs.append(out)
    for a in range(3):
        assert sum(credit[i][a]-debit[i][a] for i in range(n))==external[a]
        assert sum(outputs[i][a]-funding[i][a] for i in range(n))==external[a]
    def matrix_str(mat): return [[str(x) for x in row] for row in mat]
    return dict(debits=matrix_str(debit),credits=matrix_str(credit),outputs=matrix_str(outputs),external_net=list(map(str,external)),residual_output_allocations=matrix_str(allocations),owner_internal_premium_paid=list(map(str,premium_paid)),owner_external_shortfall=list(map(str,shortfalls)))


def flow_vectors():
    funding=[[1000*10**6,2*10**6,0],[1000*10**6,0,2*10**6],[1000*10**6,0,0]]
    crosses=[dict(stock="1",seller="0",buyer="1",quantity="1000000",cash="10000000"),dict(stock="2",seller="1",buyer="2",quantity="1000000",cash="20000000")]
    legs=[dict(stock="1",direction="sell",inputs=["1000000","0","0"],observed_output="9900000",minimum_output="9800000"),dict(stock="2",direction="buy",inputs=["0","0","20100000"],observed_output="1000000",minimum_output="1000000")]
    cases=[("all-internal-no-route",funding,crosses,[]), ("one-stock-zero-residual",funding,crosses,legs[:1]), ("two-residual-legs",funding,crosses,legs), ("shared-residual-pro-rata",[[1000*10**6,0,0]]*3,[],[dict(stock="1",direction="buy",inputs=["10000000","20000000","0"],observed_output="2970000",minimum_output="2950000")])]
    result=[]
    for name,f,c,l in cases:
        expected=flow_model(f,c,l)
        result.append(dict(id=name,funding=[[str(x) for x in row] for row in f],crosses=c,residuals=l,expected=expected))
    assert result[2]["expected"]["outputs"]==[["1019900000","0","0"],["1010000000","1000000","1000000"],["959900000","0","2000000"]]
    assert result[3]["expected"]["residual_output_allocations"]==[["990000","1980000","0"]]
    # Arbitrary output weights no longer form a valid record at all.
    bad=copy.deepcopy(legs[0]);bad["weights"]=["0","1","0"]
    try: flow_model(funding,crosses,[bad])
    except ValueError as e: assert str(e)=="unknown or missing fields"
    else: raise AssertionError("arbitrary weights accepted")
    zero=copy.deepcopy(legs[0]);zero["inputs"]=["0","0","0"]
    try: flow_model(funding,crosses,[zero])
    except ValueError as e: assert str(e)=="residual input"
    else: raise AssertionError("zero residual placeholder accepted")
    return result


def counterexample():
    funding=[[1000*10**6,10**6,0],[1000*10**6,0,0]]
    bad=[dict(stock="1",seller="0",buyer="1",quantity="1000000",cash="11000000")]
    before=1000*10**6;after=(989+10)*10**6
    whole_pass=after*10000>=before*9800
    assert whole_pass
    try: flow_model(funding,bad,[])
    except ValueError as e: assert str(e)=="cross price band"
    else: raise AssertionError("cross cash subsidy accepted")
    return dict(stock_price="10000000",stock_quantity="1000000",cash_amount="11000000",buyer_initial_cash="1000000000",buyer_final_cash="989000000",buyer_final_reference_value="999000000",buyer_whole_slice_loss_bps="10",whole_slice_guard_accepts=True,cross_guard_accepts=False,expected_error="cross price band")


def build():
    p,m=fixture()
    second=copy.deepcopy(m)
    second["nonce"]="9007199254740993" # intentionally beyond JS safe Number
    second["assets"][2]["funding"]="0"
    positives=[vector("ordinary-three-assets",m,p),vector("nonce-above-js-safe-integer",second,p)]
    raw=bytes.fromhex(positives[0]["canonical_hex"])
    offsets={"domain":0,"schema_version":8,"genesis":9,"program_id":41,"config_address":73,"policy_hash":105,"owner":137,"nonce":169,"expiry":177,"optimization_commitment":185,"asset_count":217}
    for i in range(3):
        base=218+129*i
        for field,offset in [("mint",0),("token_program",32),("decimals",64),("recipient",65),("funding",97),("min_output",105),("max_output",113),("funding_reference_price",121)]:
            offsets[f"asset_{i}_{field}"]=base+offset
    mutations=[]
    for field,offset in offsets.items():
        altered=bytearray(raw);altered[offset]^=1
        mutations.append(dict(id=f"mutated-{field}",byte_offset=str(offset),xor_hex="01",mutated_sha256=digest(altered),expected="reject against stored original mandate hash; malformed fields also reject parsing/admission"))
    invalid=[]
    def add(name,change):
        bad=copy.deepcopy(m);change(bad)
        try: encode_mandate(bad,p)
        except ValueError as e: invalid.append(dict(id=name,mandate=bad,expected_error=str(e)))
        else: raise AssertionError(name+" unexpectedly accepted")
    add("json-number",lambda b:b.update(nonce=0))
    add("leading-zero",lambda b:b.update(nonce="00"))
    add("negative",lambda b:b.update(nonce="-1"))
    add("exponent",lambda b:b.update(nonce="1e3"))
    add("u64-overflow",lambda b:b.update(nonce=str(2**64)))
    add("alternate-network",lambda b:b.update(genesis="99"*32))
    add("unknown-field",lambda b:b.update(approved=True))
    add("wrong-policy",lambda b:b.update(policy_hash="ff"*32))
    add("duplicate-mint",lambda b:b["assets"][1].update(mint=b["assets"][0]["mint"]))
    add("duplicate-recipient",lambda b:b["assets"][1].update(recipient_ata=b["assets"][0]["recipient_ata"]))
    add("inverted-bounds",lambda b:b["assets"][0].update(min_output="3000000000"))
    add("amount-cap",lambda b:b["assets"][0].update(funding=str(MAX_AMOUNT+1)))
    add("zero-price",lambda b:b["assets"][0].update(funding_reference_price="0"))
    add("reordered-assets",lambda b:b["assets"].reverse())
    add("truncated-asset-array",lambda b:b["assets"].pop())
    malformed=[]
    wrong_count=bytearray(raw);wrong_count[217]=2
    for name,bad in [("trailing-byte",raw+b"\x00"),("truncated-byte",raw[:-1]),("wrong-domain",b"X"+raw[1:]),("wrong-encoded-count",bytes(wrong_count))]:
        try: decode_mandate(bad,p)
        except ValueError as e: malformed.append(dict(id=name,canonical_hex=bad.hex(),expected_error=str(e)))
        else: raise AssertionError(name+" unexpectedly accepted")
    return dict(spec_version="1",price_guard_vectors=price_vectors(),flow_vectors=flow_vectors(),subsidy_counterexample=counterexample(),invalid_byte_encodings=malformed,scope="Encoding fixtures only. Program/config/mint/recipient public identities are synthetic; recipients here are not asserted to be ATAs. T04 must additionally verify real PDA/ATA derivations, runtime lifecycle, clock, asset admission and capacity. No transaction may be built from these fixtures.",policy=p,policy_hex=encode_policy(p).hex(),policy_sha256=digest(encode_policy(p)),positive=positives,one_field_byte_mutations=mutations,invalid_inputs=invalid,allocation_vectors=[dict(q="10",weights=["1","1","1"],owner_sort_keys=["a","b","c"],expected=["4","3","3"]),dict(q="5",weights=["1","2","0"],owner_sort_keys=["a","b","c"],expected=["2","3","0"])])


def main():
    path=HERE/"wire-vectors.json"
    actual=build()
    if sys.argv[1:] == ["--write"]:
        path.write_text(json.dumps(actual,indent=2)+"\n")
    elif sys.argv[1:]:
        raise SystemExit("usage: check-wire-vectors.py [--write]")
    stored=json.loads(path.read_text())
    assert stored==actual,"checked-in vectors differ from regenerated fixtures"
    p,m=fixture()
    # Equivalent mapping insertion order MUST produce the same bytes.
    assert encode_mandate(dict(reversed(list(m.items()))),p)==encode_mandate(m,p)
    for v in stored["positive"]:
        raw,body=encode_mandate(v["mandate"],p)
        assert digest(raw)==v["canonical_sha256"] and digest(body)==v["funding_body_sha256"]
        assert decode_mandate(raw,p)==v["mandate"]
    original=stored["positive"][0]["canonical_sha256"]
    assert all(v["mutated_sha256"]!=original for v in stored["one_field_byte_mutations"])
    for v in stored["allocation_vectors"]:
        q=int(v["q"]);weights=list(map(int,v["weights"]));owners=v["owner_sort_keys"]
        assert list(map(str,allocation(q,weights,owners)))==v["expected"]
        rev=allocation(q,weights[::-1],owners[::-1])[::-1]
        assert rev==allocation(q,weights,owners)
    assert 3*MAX_AMOUNT*MAX_PRICE*10**9*10200<2**128
    # Boundary arithmetic independent of future implementation.
    assert (60<=60) and not (61<=60)
    assert 100*10000<=10000*100 and not 101*10000<=10000*100
    assert abs(10500-10000)*10000<=10000*500
    assert not abs(10501-10000)*10000<=10000*500
    assert 9800*10000>=10000*(10000-200)
    assert not 9799*10000>=10000*(10000-200)
    print(json.dumps(dict(status="PASS",positive_vectors=len(stored["positive"]),one_field_mutations=len(stored["one_field_byte_mutations"]),invalid_input_vectors=len(stored["invalid_inputs"]),allocation_vectors=len(stored["allocation_vectors"]),invalid_byte_encodings=len(stored["invalid_byte_encodings"]),price_guard_vectors=len(stored["price_guard_vectors"]),flow_vectors=len(stored["flow_vectors"]),subsidy_counterexample_rejected=True,policy_bytes=len(encode_policy(p)),canonical_bytes=605,funding_body_bytes=177,limits="encoding/reference arithmetic only; cross-language, real PDA/ATA and runtime tests pending T04+"),indent=2))


if __name__ == "__main__":
    main()
