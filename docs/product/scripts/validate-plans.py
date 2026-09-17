#!/usr/bin/env python3
"""Validate Khala planning artifacts; does not validate runtime or app behavior."""
from collections import Counter
from pathlib import Path
import json
import re
import sys

ROOT = Path(__file__).resolve().parents[3]
PRODUCT = ROOT / 'docs/product'
graph = json.loads((PRODUCT / 'ticket-graph.proposal.json').read_text())
tickets = {t['id']: t for t in graph['tickets']}
errors = []
plans = {}
for path in (ROOT / 'docs/plans').glob('*.md'):
    match = re.search(r'kha-(\d+)', path.name)
    if not match:
        continue
    ticket = 'KHA-' + match[1]
    if ticket in plans:
        errors.append(f'{ticket}: duplicate canonical plans')
    plans[ticket] = path
    text = path.read_text()
    for marker in ['artifact_contract: ce-unified-plan/v1', 'product_contract_source: ce-brainstorm', '## Goal Capsule', '## Product Contract']:
        if marker not in text:
            errors.append(f'{ticket}: missing {marker}')
    readiness = re.search(r'^artifact_readiness: (.+)$', text, re.M)
    if not readiness or readiness[1] not in ['requirements-only', 'implementation-ready']:
        errors.append(f'{ticket}: invalid readiness')
    if readiness and readiness[1] == 'implementation-ready':
        for section in ['Planning Contract', 'Implementation Units', 'Verification Contract', 'Definition of Done']:
            if not re.search(r'^## ' + section + r'\s*$', text, re.M):
                errors.append(f'{ticket}: missing canonical {section} heading')
        units = re.findall(r'^### (U\d+)\.', text, re.M)
        if not units or len(units) != len(set(units)):
            errors.append(f'{ticket}: missing or duplicate stable U IDs')
    if re.search(r'^status:', text, re.M):
        errors.append(f'{ticket}: plan must not store live status')

if set(plans) != set(tickets):
    errors.append(f'Plan membership mismatch: missing={sorted(set(tickets)-set(plans))}, extra={sorted(set(plans)-set(tickets))}')

membership = Counter(t for epic in graph['epics'] for t in epic['contains'])
if set(membership) != set(tickets) or any(n != 1 for n in membership.values()):
    errors.append('Every leaf must belong to exactly one epic')
for ticket, t in tickets.items():
    if t.get('plan') and (PRODUCT / t['plan']).resolve() != plans.get(ticket):
        errors.append(f'{ticket}: graph points to wrong canonical plan')
    if ticket in plans:
        actual = re.search(r'^artifact_readiness: (.+)$', plans[ticket].read_text(), re.M)
        if actual and t.get('plan_readiness') != actual[1]:
            errors.append(f'{ticket}: stale graph readiness')
    for dep in t['depends_on']:
        if dep not in tickets:
            errors.append(f'{ticket}: unresolved dependency {dep}')
        elif tickets[dep]['phase'] >= t['phase']:
            errors.append(f'{ticket}: dependency {dep} violates computed phase')
    for other in t['serializes_with']:
        if other not in tickets or ticket not in tickets[other]['serializes_with']:
            errors.append(f'{ticket}: asymmetric conflict {other}')

for path in (ROOT / 'docs').rglob('*.md'):
    if 'recovered' in path.parts:
        continue
    for target in re.findall(r'\]\(([^)]+)\)', path.read_text()):
        if '://' in target or target.startswith('#'):
            continue
        target = target.split('#', 1)[0]
        if target and not (path.parent / target).exists():
            errors.append(f'{path.relative_to(ROOT)}: unresolved link {target}')

for err in errors:
    print('ERROR:', err)
counts = Counter(re.search(r'^artifact_readiness: (.+)$', p.read_text(), re.M)[1] for p in plans.values() if re.search(r'^artifact_readiness: (.+)$', p.read_text(), re.M))
print(json.dumps({'plans': len(plans), 'epics': len(graph['epics']), 'readiness': counts, 'errors': len(errors)}, indent=2))
sys.exit(bool(errors))
