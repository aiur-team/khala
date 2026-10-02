#!/usr/bin/env python3
"""Generate and validate the internal-mode Build Order pack from roster.md.

Usage: python3 build_pack.py [<out_dir>]
- Parses roster.md, levels the hard-dependency graph, detects cycles, prints the
  wave table, critical path, spine and lane earliest-start report.
- Checks every ticket doc exists and its header (complexity, model, depends on,
  serializes with) matches the roster.
- Checks every code pointer in contracts.md, the plan and the tickets against the
  researched commit: a `path:line` or `path:a-b` pointer must name an existing
  file with at least that many lines (ERROR otherwise); a bare repo path that does
  not exist is reported as a WARNING unless the ticket declares it as a file to
  create (listed under a "Create" line or in contracts L1).
- With <out_dir>, writes build-order.json and copies tickets.
Exits non-zero on any ERROR.
"""
import json, os, re, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
ROSTER = os.path.join(HERE, 'roster.md')
TICKETS = os.path.join(HERE, 'tickets')
SHA = os.environ.get('KI_SHA', '7672b0e5')
PREFIX = 'KI-'

def ids(cell):
    return [PREFIX + n for n in re.findall(r'\b(\d{3})\b', cell)]

rows = []
for line in open(ROSTER):
    if not line.startswith('| ' + PREFIX):
        continue
    c = [x.strip() for x in line.strip().strip('|').split('|')]
    rows.append({'id': c[0], 'title': re.sub(r'`', '', c[1]), 'lane': c[2], 'model': c[3], 'complexity': int(c[4]),
                 'depends_on': ids(c[5]), 'serializes_with': ids(c[6]),
                 'ticket': int(c[8].lstrip('#')) if len(c) > 8 and c[8].lstrip('#').isdigit() else None})

errors, warnings = [], []
by = {r['id']: r for r in rows}
if len(by) != len(rows):
    errors.append('duplicate ids')
for r in rows:
    for d in r['depends_on'] + r['serializes_with']:
        if d not in by:
            errors.append(f"{r['id']}: unknown ref {d}")
    for s in r['serializes_with']:
        if s in by and r['id'] not in by[s]['serializes_with']:
            errors.append(f"{r['id']}: serializes_with {s} is not symmetric")
    if not 1 <= r['complexity'] <= 5:
        errors.append(f"{r['id']}: bad complexity")
    if r['model'] not in ('codex', 'opus', '—'):
        errors.append(f"{r['id']}: bad model {r['model']}")

# Ticket header consistency.
for r in rows:
    path = os.path.join(TICKETS, r['id'] + '.md')
    if not os.path.exists(path):
        errors.append(f"{r['id']}: missing ticket doc"); continue
    text = open(path).read()
    head = '\n'.join(text.splitlines()[:6])
    if not text.startswith(f"# {r['id']} "):
        errors.append(f"{r['id']}: doc title must start with '# {r['id']} '")
    m = re.search(r'\*\*Complexity:\*\*\s*(\d)', head)
    if not m or int(m.group(1)) != r['complexity']:
        errors.append(f"{r['id']}: header complexity != roster {r['complexity']}")
    m = re.search(r'\*\*Depends on:\*\*([^·\n]*)', head)
    if not m or sorted(ids(m.group(1))) != sorted(r['depends_on']):
        errors.append(f"{r['id']}: header depends_on {m.group(1).strip() if m else None!r} != roster {r['depends_on']}")
    m = re.search(r'\*\*Serializes with:\*\*([^·\n]*)', head)
    if not m or sorted(ids(m.group(1))) != sorted(r['serializes_with']):
        errors.append(f"{r['id']}: header serializes_with {m.group(1).strip() if m else None!r} != roster {r['serializes_with']}")
    m = re.search(r'\*\*Model:\*\*\s*([\w-]+)', head)
    model = {'codex': 'codex', 'claude-opus': 'opus', 'executor': '—'}.get(m.group(1) if m else '', None)
    if model != r['model']:
        errors.append(f"{r['id']}: header model {m.group(1) if m else None!r} != roster {r['model']}")

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

waves = {}
for r in rows: waves.setdefault(r['phase'], []).append(r['id'])
print('WAVES')
for p in sorted(waves):
    same_ser = sorted({tuple(sorted((a, b))) for a in waves[p] for b in by[a]['serializes_with'] if b in waves[p]})
    print(f"  phase {p}: {len(waves[p])} tickets {' '.join(sorted(waves[p]))}" + (f"  | same-wave ser: {same_ser}" if same_ser else ''))
memo = {}
def depth(i):
    if i in memo: return memo[i]
    best = max([depth(d) for d in by[i]['depends_on']] or [(0, [])], key=lambda x: x[0])
    memo[i] = (best[0] + 1, best[1] + [i]); return memo[i]
crit = max((depth(r['id']) for r in rows), key=lambda x: x[0])
print('CRITICAL PATH (waves)', crit[0], ' -> '.join(crit[1]))
fan = lambda r: sum(1 for x in rows if r['id'] in x['depends_on'])
print('SPINE (direct fan-out)', ', '.join(f"{r['id']}({fan(r)})" for r in sorted(rows, key=lambda r: -fan(r))[:6]))
print('LANE EARLIEST START')
for lane in sorted({r['lane'] for r in rows}):
    print(f"  {lane}: phase {min(r['phase'] for r in rows if r['lane'] == lane)}")

# Pointer validation against the researched commit.
def lines_at(path):
    try:
        out = subprocess.run(['git', '-C', REPO, 'show', f'{SHA}:{path}'], capture_output=True, check=True).stdout
        return out.count(b'\n') + (0 if out.endswith(b'\n') or not out else 1)
    except subprocess.CalledProcessError:
        return None
def is_dir_at(path):
    r = subprocess.run(['git', '-C', REPO, 'cat-file', '-t', f'{SHA}:{path.rstrip("/")}'], capture_output=True)
    return r.returncode == 0 and r.stdout.strip() == b'tree'

POINTER = re.compile(r'`((?:apps|packages|docs|scripts|experiments|infra|tests)/[A-Za-z0-9_.@/\-\[\]{},*]+?)(?::(\d+)(?:-(\d+))?(?:,[\d,\- ]+)?)?`')
contracts = open(os.path.join(HERE, 'contracts.md')).read()
declared_new = set(re.findall(r'`((?:apps|packages)/[^`\s]+)`', contracts.split('## L2.')[0]))
sources = [os.path.join(HERE, 'contracts.md'), os.path.join(HERE, 'reconciliation.md'),os.path.join(REPO, 'docs/plans/2026-10-02-001-feat-internal-mode-plan.md')] + \
    [os.path.join(TICKETS, f) for f in sorted(os.listdir(TICKETS)) if f.endswith('.md')]
checked = 0
for src in sources:
    text = open(src).read()
    create_paths = set()
    for line in text.splitlines():
        if re.search(r'\b(Create|create|new file|\(new\))', line):
            create_paths.update(re.findall(r'`((?:apps|packages|docs|scripts|tests)/[^`\s:]+)', line))
    rel = os.path.relpath(src, REPO)
    for m in POINTER.finditer(text):
        path, a, b = m.group(1), m.group(2), m.group(3)
        if any(ch in path for ch in '*{}[]') or path.startswith('docs/build/internal') or path.startswith('docs/plans/2026-10-02'):
            continue
        checked += 1
        n = lines_at(path)
        if n is None:
            if is_dir_at(path):
                continue
            if a:
                errors.append(f"{rel}: pointer {path}:{a} does not exist at {SHA}")
            elif path not in create_paths and path not in declared_new and not any(path.startswith(p.rstrip('*')) for p in declared_new if p.endswith('*')):
                warnings.append(f"{rel}: {path} not at {SHA} (new file?)")
            continue
        hi = int(b or a or 0)
        if hi and hi > n:
            errors.append(f"{rel}: pointer {path}:{a}{'-' + b if b else ''} beyond EOF ({n} lines) at {SHA}")
print(f'POINTERS checked {checked}')

if warnings:
    print('WARNINGS'); [print('  ' + w) for w in sorted(set(warnings))]
if errors:
    print('ERRORS'); [print('  ' + e) for e in errors]; sys.exit(1)

if len(sys.argv) > 1:
    out = sys.argv[1]
    os.makedirs(os.path.join(out, 'tickets'), exist_ok=True)
    pack = {
        'schema_version': 1,
        'build_order_id': 'aiur-team/khala:internal-mode',
        'title': 'Khala internal mode (local channels)',
        'subtitle': f'{len(rows)} tickets; one machine, Claude + Codex + the full web app over a loopback helper',
        'repository': 'aiur-team/khala',
        'root_number': 828,
        'plan_version': 1,
        'icon': 'computer-desktop',
        'workstreams': [{'id': l, 'title': l.capitalize()} for l in ['platform', 'agent', 'helper', 'web', 'acceptance']],
        'tickets': [{'id': r['id'], 'title': r['title'], 'lane': r['lane'], 'phase': r['phase'], 'complexity': r['complexity'],
                     'depends_on': r['depends_on'], 'doc': f"tickets/{r['id']}.md", 'ticket': r['ticket']} for r in rows],
    }
    json.dump(pack, open(os.path.join(out, 'build-order.json'), 'w'), indent=2)
    for r in rows:
        shutil.copy(os.path.join(TICKETS, r['id'] + '.md'), os.path.join(out, 'tickets', r['id'] + '.md'))
    print('WROTE', out)
print('OK', len(rows), 'tickets')
