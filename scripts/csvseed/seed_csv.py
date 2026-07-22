#!/usr/bin/env python3
# CSV venue importer (name,address,city,state,notes) — ME/NJ/NY batch.
# Per the import spec: Mapbox forward geocoding on address+city+state, insert
# with added_manually=true on EVERY row so the batch is distinguishable.
# (created_by=curator + sources=['Matchbook Traveler'] carry provenance too —
# user manual-adds also set added_manually, so ownership is the hard signal.)
#
# Hardening from previous seed runs:
#  * T1 = Search Box POI first (rooftop coords + mapbox_id for tier-1 dedup),
#    STREET NUMBER MUST MATCH (multi-location names grab the wrong branch:
#    "12 oz. Studios Tattoos" appears twice in this very file).
#  * T2 = v6 forward geocode of "address, city, state".
#  * STATE GUARD on both tiers: the landing's region_code must equal the CSV
#    state — the cross-state analog of the DC bbox guard.
#  * Dedup vs the live DB by mapbox_id and normalized-name-within-~400m.
#  * CSV notes land in venues.note (the venue sheet renders it).
import csv, json, subprocess, sys, time, unicodedata, re, uuid, os

ENV = {}
for line in open(os.path.expanduser('~/phillumeni/.env')):
    if '=' in line:
        k, v = line.strip().split('=', 1)
        ENV[k] = v
URL = ENV['VITE_SUPABASE_URL']; AK = ENV['VITE_SUPABASE_ANON_KEY']; MB = ENV['VITE_MAPBOX_TOKEN']
STATE_NAMES = {'ME': 'Maine', 'NJ': 'New Jersey', 'NY': 'New York'}

def curl(args):
    r = subprocess.run(['curl', '-s'] + args, capture_output=True, text=True, timeout=30)
    return r.stdout

def api(path, tok, method='GET', body=None, prefer=None):
    a = ['-X', method, f'{URL}{path}', '-H', f'apikey: {AK}', '-H', f'Authorization: Bearer {tok}', '-H', 'Content-Type: application/json']
    if prefer: a += ['-H', f'Prefer: {prefer}']
    if body is not None: a += ['-d', json.dumps(body)]
    out = curl(a)
    try: return json.loads(out) if out.strip() else None
    except json.JSONDecodeError: return {'_raw': out}

def norm(s):
    s = unicodedata.normalize('NFD', s.lower())
    s = ''.join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r'[^a-z0-9 ]', '', s)
    s = re.sub(r'^the ', '', s).strip()
    return re.sub(r'\s+', ' ', s)

def street_num(addr):
    m = re.match(r'\s*(\d+)', addr)
    return m.group(1) if m else None

def region_of(props):
    ctx = (props or {}).get('context', {}) or {}
    reg = ctx.get('region', {}) or {}
    return (reg.get('region_code') or '').upper()

TYPE_RULES = [
    (r'cannabis|dispensar', ('Dispensary', '🌿', '#16281A')), (r'cigar|tobacco|smoke|vape', ('Smoke Shop', '💨', '#241C14')),
    (r'tattoo', ('Tattoo', '🖋️', '#1C1C22')), (r'candle', ('Candle Shop', '🕯️', '#2A2015')),
    (r'coffee|cafe|bakery', ('Cafe', '☕', '#2A2015')), (r'oyster|clam|chowder|seafood|fish', ('Seafood', '🦪', '#12222B')),
    (r'beer|brew|tap ?room|tavern|barcade|pub', ('Bar', '🍺', '#241E10')), (r'pizza', ('Pizza', '🍕', '#301B10')),
    (r'wine|vineyard|liquor', ('Wine & Spirits', '🍷', '#2B1520')), (r'steak', ('Steakhouse', '🥩', '#2B1414')),
    (r'hotel|inn\b|maidstone', ('Hotel', '🛎️', '#1E2430')), (r'floral|flower', ('Shop', '💐', '#22261A')),
]
def type_for(name, notes):
    hay = (name + ' ' + (notes or '')).lower()
    for pat, t in TYPE_RULES:
        if re.search(pat, hay): return t
    return ('Restaurant', '🔥', '#281808')

tok = api('/auth/v1/token?grant_type=password', '', 'POST', {'email': 'curator@phillumeni.app', 'password': 'Curator-Seed-2026'})
TOK = tok.get('access_token') if isinstance(tok, dict) else None
if not TOK: sys.exit(f'curator login failed: {tok}')
CURATOR = json.loads(curl([f'{URL}/auth/v1/user', '-H', f'apikey: {AK}', '-H', f'Authorization: Bearer {TOK}']))['id']

existing = api('/rest/v1/venues?select=id,name,lat,lng,mapbox_id&limit=3000', TOK)
ex_ids = {v['mapbox_id'] for v in existing if v.get('mapbox_id')}
def db_twin(name, lng, lat):
    n = norm(name)
    for v in existing:
        if norm(v['name']) == n and abs(float(v['lat']) - lat) < 0.004 and abs(float(v['lng']) - lng) < 0.005:
            return v
    return None

rows_out, report = [], []
session = str(uuid.uuid4())
CSVPATH = os.path.join(os.path.dirname(__file__), 'venues-me-nj-ny.csv')

for rec in csv.DictReader(open(CSVPATH)):
    name, addr, city, st = rec['name'].strip(), rec['address'].strip(), rec['city'].strip(), rec['state'].strip().upper()
    notes = (rec.get('notes') or '').strip() or None
    if not name: continue
    want_num = street_num(addr)
    got = None  # (lng, lat, mbid, via)

    # T1: POI — proximity biased by geocoding the city first would cost a call;
    # instead pass the full query and trust name+number+state checks.
    q1 = f'{name} {city} {STATE_NAMES.get(st, st)}'.replace(' ', '%20').replace("'", '%27')
    sug = json.loads(curl([f'https://api.mapbox.com/search/searchbox/v1/suggest?q={q1}&country=US&types=poi&limit=5&session_token={session}&access_token={MB}']) or '{}')
    for s in (sug.get('suggestions') or []):
        sname, saddr = s.get('name', ''), (s.get('full_address') or s.get('place_formatted') or '')
        if norm(name) not in norm(sname) and norm(sname) not in norm(name): continue
        if want_num and want_num not in saddr: continue
        ret = json.loads(curl([f'https://api.mapbox.com/search/searchbox/v1/retrieve/{s["mapbox_id"]}?session_token={session}&access_token={MB}']) or '{}')
        feat = (ret.get('features') or [None])[0]
        if not feat: continue
        if region_of(feat.get('properties')) != st: continue  # state guard
        lng, lat = feat['geometry']['coordinates'][:2]
        got = (lng, lat, s['mapbox_id'], 'poi')
        break

    # T2: forward geocode address+city+state (the spec'd path)
    if not got:
        q2 = f'{addr}, {city}, {st}'.replace(' ', '%20').replace("'", '%27')
        geo = json.loads(curl([f'https://api.mapbox.com/search/geocode/v6/forward?q={q2}&country=US&limit=1&access_token={MB}']) or '{}')
        feat = (geo.get('features') or [None])[0]
        if feat and region_of(feat.get('properties')) == st:
            lng, lat = feat['geometry']['coordinates'][:2]
            got = (lng, lat, None, 'addr')

    if not got:
        report.append(f'SKIP (no in-state geocode): {name} — {addr}, {city} {st}')
        continue
    lng, lat, mbid, via = got
    if mbid and mbid in ex_ids:
        report.append(f'SKIP (mapbox_id dupe): {name}')
        continue
    tw = db_twin(name, lng, lat)
    if tw:
        report.append(f'SKIP (db twin #{tw["id"]}): {name}')
        continue

    typ, emoji, bg = type_for(name, notes)
    row = {
        'name': name, 'address': addr, 'neighborhood': None, 'city': city,
        'lat': lat, 'lng': lng, 'type': typ, 'emoji': emoji, 'bg_color': bg,
        'sources': ['Matchbook Traveler'], 'created_by': CURATOR, 'verified': False,
        'added_manually': True,  # per import spec: every row in this batch
    }
    if mbid: row['mapbox_id'] = mbid
    if notes: row['note'] = notes
    rows_out.append(row)
    report.append(f'{via:4s}: {name} ({city}, {st})' + (f' — note: {notes[:40]}' if notes else ''))
    time.sleep(0.12)

def insert(rows):
    # Per-row, not bulk: one duplicate mapbox_id in an atomic batch used to kill
    # every row in it. On a mapbox_id collision, strip the id and keep the row —
    # the geocoded coords are still right, only the tier-1 dedup key is lost.
    n = 0
    for r in rows:
        res = api('/rest/v1/venues', TOK, 'POST', r, prefer='return=representation')
        if isinstance(res, list):
            n += 1
            continue
        if isinstance(res, dict) and res.get('code') == '23505' and 'mapbox_id' in r:
            r2 = {k: v for k, v in r.items() if k != 'mapbox_id'}
            res = api('/rest/v1/venues', TOK, 'POST', r2, prefer='return=representation')
            if isinstance(res, list):
                n += 1
                report.append(f'RETRY ok (mapbox_id collision stripped): {r["name"]}')
                continue
        report.append(f'INSERT FAIL: {r["name"]} — {json.dumps(res)[:120]}')
    return n

n = insert(rows_out)
print('\n'.join(report))
poi = sum(1 for r in rows_out if 'mapbox_id' in r)
print(f'\n=== inserted {n} of {len(rows_out)} prepared ({poi} POI-matched w/ mapbox_id, {len(rows_out)-poi} address-geocoded) ===')
