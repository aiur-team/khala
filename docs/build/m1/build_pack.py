#!/usr/bin/env python3
"""Generate and validate the M1 Build Order pack from roster.md.

Usage: python3 build_pack.py <out_dir>
Writes <out_dir>/build-order.json, copies tickets/*.md to <out_dir>/tickets/,
and prints a wave table, critical path and lane earliest-start report.
Exits non-zero on any validation error.
"""
import json, os, re, shutil, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROSTER = os.path.join(HERE, 'roster.md')
TICKETS = os.path.join(HERE, 'tickets')

def ids(cell):
    return ['KM-' + n for n in re.findall(r'\b(\d{3})\b', cell)]

rows = []
for line in open(ROSTER):
    if not line.startswith('| KM-'):
        continue
    c = [x.strip() for x in line.strip().strip('|').split('|')]
    rows.append({'id': c[0], 'title': re.sub(r'`', '', c[1]), 'lane': c[2], 'complexity': int(c[3]),
                 'depends_on': ids(c[4]), 'serializes_with': ids(c[5])})

errors = []
by = {r['id']: r for r in rows}
if len(by) != len(rows):
    errors.append('duplicate ids')
for r in rows:
    for d in r['depends_on'] + r['serializes_with']:
        if d not in by:
            errors.append(f"{r['id']}: unknown ref {d}")
    if not os.path.exists(os.path.join(TICKETS, r['id'] + '.md')):
        errors.append(f"{r['id']}: missing ticket doc")
    if not 1 <= r['complexity'] <= 5:
        errors.append(f"{r['id']}: bad complexity")

# Level the hard-dependency graph (longest path from roots); detect cycles.
level, state = {}, {}
def lvl(i):
    if state.get(i) == 1:
        errors.append(f'cycle at {i}'); return 1
    if i in level: return level[i]
    state[i] = 1
    level[i] = 1 + max([lvl(d) for d in by[i]['depends_on'] if d in by] or [0])
    state[i] = 2
    return level[i]
for r in rows: lvl(r['id'])
for r in rows: r['phase'] = level[r['id']]
for r in rows:
    for d in r['depends_on']:
        if d in by and level[d] >= r['phase']:
            errors.append(f"{r['id']}: phase not after {d}")

waves = {}
for r in rows: waves.setdefault(r['phase'], []).append(r['id'])
print('WAVES')
for p in sorted(waves):
    same_ser = sorted({tuple(sorted((a, b))) for a in waves[p] for b in by[a]['serializes_with'] if b in waves[p]})
    print(f"  phase {p}: {len(waves[p])} tickets {' '.join(sorted(waves[p]))}" + (f"  | same-wave ser: {same_ser}" if same_ser else ''))

# Critical path by complexity weight.
memo = {}
def cp(i):
    if i in memo: return memo[i]
    best = max([cp(d) for d in by[i]['depends_on']] or [(0, [])], key=lambda x: x[0])
    memo[i] = (best[0] + by[i]['complexity'], best[1] + [i]); return memo[i]
crit = max((cp(r['id']) for r in rows), key=lambda x: x[0])
print('CRITICAL PATH', crit[0], ' -> '.join(crit[1]))
fanout = sorted(rows, key=lambda r: -sum(1 for x in rows if r['id'] in x['depends_on']))[:6]
print('SPINE (top fan-out)', ', '.join(f"{r['id']}({sum(1 for x in rows if r['id'] in x['depends_on'])})" for r in fanout))
print('LANE EARLIEST START')
for lane in sorted({r['lane'] for r in rows}):
    print(f"  {lane}: phase {min(r['phase'] for r in rows if r['lane']==lane)}")

if errors:
    print('ERRORS'); [print('  ' + e) for e in errors]; sys.exit(1)

if len(sys.argv) > 1:
    out = sys.argv[1]
    os.makedirs(os.path.join(out, 'tickets'), exist_ok=True)
    pack = {
        'schema_version': 1,
        'build_order_id': 'aiur-team/khala:m1-external-chat',
        'title': 'Khala M1 external chat',
        'subtitle': f'{len(rows)} tickets; thin external chat path, local then production',
        'repository': 'aiur-team/khala',
        'root_number': None,
        'plan_version': 2,
        'icon': 'chat-bubble-left-right',
        'workstreams': [{'id': l, 'title': l.capitalize()} for l in ['platform', 'app', 'agent', 'acceptance', 'events', 'design']],
        'tickets': [{'id': r['id'], 'title': r['title'], 'lane': r['lane'], 'phase': r['phase'], 'complexity': r['complexity'],
                     'depends_on': r['depends_on'], 'doc': f"tickets/{r['id']}.md", 'ticket': None} for r in rows],
    }
    json.dump(pack, open(os.path.join(out, 'build-order.json'), 'w'), indent=2)
    for r in rows:
        shutil.copy(os.path.join(TICKETS, r['id'] + '.md'), os.path.join(out, 'tickets', r['id'] + '.md'))
    print('WROTE', out)
print('OK', len(rows), 'tickets')
