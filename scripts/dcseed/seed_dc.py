#!/usr/bin/env python3
# DC seeder — matchbooktraveler.com/district-of-columbia (69 venues).
# Pattern per the Manhattan/round-2 seeders, with the hard-won rules baked in:
#   * T1 = Mapbox Search Box POI (suggest+retrieve) and the STREET NUMBER MUST
#     match (score==2) — multi-location names (Matchbox, Barcelona Wine Bar)
#     grab the wrong branch otherwise.
#   * T2 = v6 forward geocode of the street address, added_manually=true.
#   * DC bbox guard on every landing; dedup vs the live DB by mapbox_id and
#     normalized-name-within-400m.
#   * Verified-closed venues insert with status='closed' (grey collector's-item
#     pins — the app's model supports dead spots on purpose).
import json, subprocess, sys, time, unicodedata, re, uuid, os

ENV = {}
for line in open(os.path.expanduser('~/phillumeni/.env')):
    if '=' in line:
        k, v = line.strip().split('=', 1)
        ENV[k] = v
URL = ENV['VITE_SUPABASE_URL']; AK = ENV['VITE_SUPABASE_ANON_KEY']; MB = ENV['VITE_MAPBOX_TOKEN']
BBOX = (-77.12, 38.79, -76.90, 39.00)  # lon_min, lat_min, lon_max, lat_max
PROX = "-77.0369,38.9072"
CITY = "Washington DC"

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

def in_bbox(lng, lat):
    return BBOX[0] <= lng <= BBOX[2] and BBOX[1] <= lat <= BBOX[3]

# ── input: [name, address, neighborhood] + verdict map loaded from files
VENUES = json.load(open(os.path.join(os.path.dirname(__file__), 'venues.json')))
VERDICTS = json.load(open(os.path.join(os.path.dirname(__file__), 'verdicts.json')))
vmap = {v['name']: v for v in VERDICTS}

TYPE_RULES = [
    (r'books', ('Bookstore', '📚', '#2A2118')), (r'hotel|watergate', ('Hotel', '🛎️', '#1E2430')),
    (r'pizza|pizzeria', ('Pizza', '🍕', '#301B10')), (r'oyster|fish|seafood', ('Seafood', '🦪', '#12222B')),
    (r'wine', ('Wine Bar', '🍷', '#2B1520')), (r'coffee|baked', ('Cafe', '☕', '#2A2015')),
    (r'club', ('Club', '🥃', '#231A2B')), (r'taco|cantina|rum|tiki', ('Bar', '🍹', '#0F2A24')),
]
def type_for(name):
    n = name.lower()
    for pat, t in TYPE_RULES:
        if re.search(pat, n): return t
    return ('Bar', '🔥', '#281808')

# ── auth as curator (owns all seeded venues)
tok = api('/auth/v1/token?grant_type=password', '', 'POST', {'email': 'curator@phillumeni.app', 'password': 'Curator-Seed-2026'})
TOK = tok.get('access_token') if isinstance(tok, dict) else None
if not TOK: sys.exit(f'curator login failed: {tok}')
CURATOR = json.loads(curl([f'{URL}/auth/v1/user', '-H', f'apikey: {AK}', '-H', f'Authorization: Bearer {TOK}']))['id']

# ── existing venues for dedup
existing = api('/rest/v1/venues?select=id,name,lat,lng,mapbox_id&limit=2000', TOK)
ex_ids = {v['mapbox_id'] for v in existing if v.get('mapbox_id')}
def db_twin(name, lng, lat):
    n = norm(name)
    for v in existing:
        if norm(v['name']) == n and abs(float(v['lat']) - lat) < 0.004 and abs(float(v['lng']) - lng) < 0.005:
            return v
    return None

session = str(uuid.uuid4())
rows_active, rows_closed, report = [], [], []

for name, addr, hood in VENUES:
    verdict = vmap.get(name, {}).get('verdict', 'unsure')
    note = vmap.get(name, {}).get('note', '')
    want_num = street_num(addr)
    got = None  # (lng, lat, mapbox_id, via)

    # T1: Search Box POI, street number REQUIRED
    sug = json.loads(curl([f'https://api.mapbox.com/search/searchbox/v1/suggest?q={subprocess.list2cmdline([name])[:0]}{name}&proximity={PROX}&types=poi&limit=5&session_token={session}&access_token={MB}'.replace(' ', '%20')]) or '{}')
    for s in (sug.get('suggestions') or []):
        sname, saddr = s.get('name', ''), (s.get('full_address') or s.get('place_formatted') or '')
        if norm(name) not in norm(sname) and norm(sname) not in norm(name): continue
        if want_num and want_num not in saddr: continue
        ret = json.loads(curl([f'https://api.mapbox.com/search/searchbox/v1/retrieve/{s["mapbox_id"]}?session_token={session}&access_token={MB}']) or '{}')
        feat = (ret.get('features') or [None])[0]
        if not feat: continue
        lng, lat = feat['geometry']['coordinates'][:2]
        if in_bbox(lng, lat):
            got = (lng, lat, s['mapbox_id'], 'poi')
            break

    # T2: address geocode
    if not got:
        q = f'{addr}, Washington, DC'.replace(' ', '%20')
        geo = json.loads(curl([f'https://api.mapbox.com/search/geocode/v6/forward?q={q}&proximity={PROX}&limit=1&access_token={MB}']) or '{}')
        feat = (geo.get('features') or [None])[0]
        if feat:
            lng, lat = feat['geometry']['coordinates'][:2]
            if in_bbox(lng, lat):
                got = (lng, lat, None, 'addr')

    if not got:
        report.append(f'SKIP (no geocode): {name}')
        continue
    lng, lat, mbid, via = got
    if mbid and mbid in ex_ids:
        report.append(f'SKIP (mapbox_id dupe): {name}')
        continue
    tw = db_twin(name, lng, lat)
    if tw:
        report.append(f'SKIP (db twin #{tw["id"]}): {name}')
        continue

    typ, emoji, bg = type_for(name)
    row = {
        'name': name, 'address': addr, 'neighborhood': hood, 'city': CITY,
        'lat': lat, 'lng': lng, 'type': typ, 'emoji': emoji, 'bg_color': bg,
        'sources': ['Matchbook Traveler'], 'created_by': CURATOR, 'verified': False,
    }
    if mbid: row['mapbox_id'] = mbid  # tier-1 dedup for future search submits
    if via == 'addr': row['added_manually'] = True
    if verdict == 'closed':
        row['status'] = 'closed'
        row['closed_at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        rows_closed.append(row)
        report.append(f'CLOSED  ({via}): {name} — {note[:70]}')
    else:
        rows_active.append(row)
        tag = 'unsure→active' if verdict == 'unsure' else 'open'
        report.append(f'{tag:14s} ({via}): {name}')
    time.sleep(0.15)

# ── insert (uniform keys per batch: split by key signature)
def insert(rows, label):
    if not rows: return 0
    groups = {}
    for r in rows: groups.setdefault(tuple(sorted(r.keys())), []).append(r)
    n = 0
    for g in groups.values():
        res = api('/rest/v1/venues', TOK, 'POST', g, prefer='return=representation')
        if isinstance(res, list): n += len(res)
        else: report.append(f'INSERT FAIL ({label}): {json.dumps(res)[:140]}')
    return n

na = insert(rows_active, 'active')
nc = insert(rows_closed, 'closed')
print('\n'.join(report))
print(f'\n=== inserted {na} active + {nc} closed of {len(VENUES)} listed ===')
