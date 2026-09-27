// U1: the surface inventory and the canary scanner are themselves tested, so a
// passing boundary suite cannot come from an incomplete inventory or a blind scanner.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSurfaceCapture, findLeaks, leakForms, listFiles, mintCanary, scanTree } from './fixtures';
import {
  DECLARED_UNREGISTERED_TOOLS, PROBES, REPO_ROOT, SURFACE_INVENTORY, auditInventory, discoverSurfaces,
  harnessDependencies, internalServerRoutes, surfacesFor,
} from './inventory';

describe('surface inventory', () => {
  it('lists exactly the surfaces the built code registers', async () => {
    const { ids } = await discoverSurfaces();
    expect(auditInventory(ids, SURFACE_INVENTORY)).toEqual({ unlisted: [], stale: [] });
  });

  it('fails the audit for a registered surface nobody inventoried', async () => {
    const { ids } = await discoverSurfaces();
    const audit = auditInventory([...ids, 'mcp-tool:khala_search_history'], SURFACE_INVENTORY);
    expect(audit.unlisted).toEqual(['mcp-tool:khala_search_history']);
  });

  it('fails the audit for an inventoried surface that is no longer registered', async () => {
    const { ids } = await discoverSurfaces();
    const audit = auditInventory(ids.filter(id => id !== 'mcp-tool:khala_read'), SURFACE_INVENTORY);
    expect(audit.stale).toEqual(['mcp-tool:khala_read']);
  });

  it('fails discovery when the internal server mounts a route from outside its known sources', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'apps/internal/src/server/channel-server.ts'), 'utf8');
    expect(internalServerRoutes(source)).toContain('POST /api/v1/channels/:channelId/stop');
    const extended = source.replace('if (options.stop) routes.push(STOP_ROUTE);', '$&\n  routes.push(HISTORY_ROUTE);');
    expect(extended).not.toBe(source);
    expect(() => internalServerRoutes(extended)).toThrow(/unaccounted route: routes\.push\(HISTORY_ROUTE\)/);
  });

  it('gives every probe at least one surface and every uncovered surface a reason', () => {
    for (const probe of PROBES) expect(surfacesFor(probe), probe).not.toEqual([]);
    for (const [id, coverage] of Object.entries(SURFACE_INVENTORY)) {
      if (coverage.kind !== 'probe') expect(coverage.reason.length, id).toBeGreaterThan(20);
    }
  });

  it('accounts for every tool the frozen Claude plugin contract declares', async () => {
    const { ids, declaredPluginTools } = await discoverSurfaces();
    const served = new Set(ids.filter(id => id.includes('tool:')).map(id => id.split(':')[1]));
    const unserved = declaredPluginTools.filter(name => !served.has(name));
    expect(unserved.sort()).toEqual(Object.keys(DECLARED_UNREGISTERED_TOOLS).sort());
  });

  it('keeps harness adapters off connector storage: their only workspace dependency is contracts', () => {
    expect(harnessDependencies()).toEqual(['@khala/contracts']);
  });
});

describe('canary scanner', () => {
  it('mints distinct random canaries with content-free labels', () => {
    const a = mintCanary('pending');
    const b = mintCanary('pending');
    expect(a.core).toMatch(/^[0-9a-f]{32}$/);
    expect(a.core).not.toBe(b.core);
    expect(a.text).toContain(a.core);
    expect(() => mintCanary('Secret Body')).toThrow();
  });

  it('detects a deliberate leak in every recognised encoding at every alignment', () => {
    const canary = mintCanary('pending');
    const body = Buffer.from(`{"body":"${canary.text}"}`, 'utf8');
    const variants: Record<string, Buffer[]> = {
      utf8: [body],
      utf16le: [Buffer.from(body.toString('utf8'), 'utf16le')],
      hex: [Buffer.from(body.toString('hex'))],
      'hex-upper': [Buffer.from(body.toString('hex').toUpperCase())],
      base64: [0, 1, 2].map(pad => Buffer.from(Buffer.concat([Buffer.alloc(pad, 7), body]).toString('base64'))),
      base64url: [0, 1, 2].map(pad => Buffer.from(Buffer.concat([Buffer.alloc(pad, 7), body]).toString('base64url'))),
    };
    for (const [encoding, haystacks] of Object.entries(variants)) {
      for (const haystack of haystacks) {
        const framed = Buffer.concat([Buffer.from('prefix '), haystack, Buffer.from(' suffix')]);
        expect(findLeaks(framed, [canary], 'probe').map(leak => leak.encoding), encoding).toHaveLength(1);
      }
    }
    expect(leakForms(canary).length).toBeGreaterThanOrEqual(10);
  });

  it('does not report a different canary', () => {
    const pending = mintCanary('pending');
    const approved = mintCanary('approved');
    const text = `released: ${approved.text} ${Buffer.from(approved.text).toString('base64')}`;
    expect(findLeaks(text, [pending], 'probe')).toEqual([]);
    expect(findLeaks(text, [approved], 'probe')).toHaveLength(1);
  });

  it('finds a canary inside a SQLite database and names the file, not the content', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const canary = mintCanary('pending');
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'kha138-scan-'));
    try {
      const db = new DatabaseSync(path.join(root, 'store.sqlite'));
      db.exec('CREATE TABLE t (body TEXT)');
      db.prepare('INSERT INTO t VALUES (?)').run(canary.text);
      db.close();
      const leaks = scanTree(root, [canary]);
      expect(leaks.map(leak => leak.where)).toContain('store.sqlite');
      expect(JSON.stringify(leaks)).not.toContain(canary.core);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports which captured surfaces carried a canary', () => {
    const approved = mintCanary('approved');
    const capture = createSurfaceCapture();
    capture.add('cli:read', `body ${approved.text}`);
    capture.add('cli:status', '{"ok":true}');
    expect(capture.carrying(approved)).toEqual(['cli:read']);
    expect(capture.surfaces()).toEqual(['cli:read', 'cli:status']);
  });
});

describe('suite artifacts', () => {
  it('store no raw credential, private key or canary text', () => {
    const owned = [
      ...listFiles(path.join(REPO_ROOT, 'tests/e2e/security')),
      path.join(REPO_ROOT, 'docs/evidence/security-acceptance.md'),
    ].filter(file => fs.existsSync(file));
    for (const file of owned) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
      expect(text, file).not.toMatch(/Bearer [A-Za-z0-9_-]{43}\b/);
      expect(text, file).not.toMatch(/khala-canary-[a-z-]+-[0-9a-f]{32}/);
      expect(text, file).not.toMatch(/\b(?:ghp|gho|sk|xox[bp])[-_][A-Za-z0-9]{20,}/);
    }
  });
});
