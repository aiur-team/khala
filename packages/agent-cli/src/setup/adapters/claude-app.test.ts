import { describe, expect, it } from 'vitest';
import { decodeSetupResult, type SetupEnvironment, type SetupProbe } from '../types.js';
import { CLAUDE_APP_UNPROVEN_CODE, claudeAppSetupAdapter } from './claude-app.js';

const home = '/home/person';
const text = (value: string) => new TextEncoder().encode(value);

function environment(files: Readonly<Record<string, string>>, directories: Readonly<Record<string, readonly string[]>>) {
  const reads: string[] = [];
  const probe: SetupProbe = {
    resolveExecutable: async () => { throw new Error('a desktop app is not on PATH'); },
    runVersion: async () => { throw new Error('no command may run'); },
    readFile: async target => { reads.push(target); return target in files ? text(files[target]!) : null; },
    listDirectory: async target => directories[target] ?? null,
  };
  const env: SetupEnvironment = {
    home, xdgConfigHome: `${home}/.config`, xdgDataHome: `${home}/.local/share`, xdgStateHome: `${home}/.local/state`, probe,
  };
  return { env, reads };
}

const plist = (version: string) => `<?xml version="1.0"?><plist><dict>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
</dict></plist>`;

describe('claudeAppSetupAdapter', () => {
  it('reports an absent app without planning anything', async () => {
    const { env } = environment({}, {});
    const detection = await claudeAppSetupAdapter.detect(env);
    expect(detection).toEqual({ executable: null, version: null, supported: false });
    const observation = await claudeAppSetupAdapter.inspect(env, detection);
    expect(observation.components).toEqual([{ component: 'mcp_entry', state: 'absent' }]);
    expect(observation.route).toBe('unavailable');
    expect(observation.diagnostics).toEqual([expect.objectContaining({ code: CLAUDE_APP_UNPROVEN_CODE, severity: 'info' })]);
    expect(claudeAppSetupAdapter.plan({ desired: 'present', observation })).toEqual([]);
  });

  it('detects the macOS bundle version but never marks it supported', async () => {
    const { env } = environment(
      { '/Applications/Claude.app/Contents/Info.plist': plist('0.14.10') },
      { '/Applications/Claude.app': ['Contents'] },
    );
    const detection = await claudeAppSetupAdapter.detect(env);
    expect(detection).toEqual({ executable: '/Applications/Claude.app', version: '0.14.10', supported: false });
    const observation = await claudeAppSetupAdapter.inspect(env, detection);
    expect(observation.components).toEqual([{ component: 'mcp_entry', state: 'unsupported' }]);
    expect(observation.route).toBe('unavailable');
    // Every Claude app shape is named on its own; none borrows another's evidence.
    expect(observation.diagnostics.map(diagnostic => diagnostic.message.match(/\((\w+)\)/)?.[1])).toEqual([
      'desktop_extension', 'remote_connector', 'browser',
    ]);
    for (const diagnostic of observation.diagnostics) {
      expect(diagnostic).toMatchObject({ code: CLAUDE_APP_UNPROVEN_CODE, severity: 'warning', harness: 'claude-app' });
      expect(diagnostic.message).toMatch(/unknown because no exact-version proof exists/);
    }
    expect(claudeAppSetupAdapter.plan({ desired: 'present', observation })).toEqual([]);
    expect(claudeAppSetupAdapter.plan({ desired: 'absent', observation })).toEqual([]);
  });

  it('reads a single Windows install version and leaves side-by-side installs unknown', async () => {
    const root = `${home}/AppData/Local/AnthropicClaude`;
    const single = environment({}, { [root]: ['app-0.14.10', 'Update.exe'] });
    expect(await claudeAppSetupAdapter.detect(single.env)).toEqual({ executable: root, version: '0.14.10', supported: false });
    const ambiguous = environment({}, { [root]: ['app-0.14.9', 'app-0.14.10'] });
    expect(await claudeAppSetupAdapter.detect(ambiguous.env)).toEqual({ executable: root, version: null, supported: false });
  });

  it('keeps an unparseable bundle version unknown', async () => {
    const { env } = environment(
      { [`${home}/Applications/Claude.app/Contents/Info.plist`]: 'bplist00\u0000' },
      { [`${home}/Applications/Claude.app`]: ['Contents'] },
    );
    expect(await claudeAppSetupAdapter.detect(env)).toMatchObject({ version: null, supported: false });
  });

  it('carries the claude-app harness through the frozen result schema', async () => {
    const { env } = environment({}, { '/Applications/Claude.app': [] });
    const detection = await claudeAppSetupAdapter.detect(env);
    const observation = await claudeAppSetupAdapter.inspect(env, detection);
    const result = {
      v: 1, command: 'status', ok: true, changed: false, state: 'unsupported', planDigest: null,
      confirmation: { required: false, confirmed: false },
      harnesses: [{
        harness: 'claude-app',
        executable: { present: true, path: detection.executable },
        version: { detected: detection.version, supported: detection.supported },
        components: observation.components,
        route: observation.route,
      }],
      operations: [],
      diagnostics: observation.diagnostics,
    };
    expect(decodeSetupResult(result)).toEqual(result);
  });
});
