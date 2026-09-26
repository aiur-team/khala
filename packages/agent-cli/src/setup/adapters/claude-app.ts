// Claude Desktop setup adapter (E09 `claude-app-channel-adapter`). No Claude app
// route has exact-version evidence yet (`claude-app-channel-proof`), so no route is
// selectable: the adapter reports the app, marks its entry unsupported, says why,
// and plans no writes. Remove stays manifest-driven, so it undoes only what an
// earlier setup recorded.
import path from 'node:path';
import type {
  HarnessDetection, HarnessObservation, SetupAdapter, SetupDiagnostic, SetupEnvironment, SetupOperation,
} from '../types.js';

export const CLAUDE_APP_UNPROVEN_CODE = 'claude_app_delivery_unproven';

const IDLE = 'Idle agents receive messages only at their next turn.';

/** Each Claude app shape has its own evidence; none is proven, so each is named separately. */
const UNPROVEN_SHAPES = [
  ['desktop_extension', 'Claude Desktop local extension'],
  ['remote_connector', 'Claude Desktop remote connector'],
  ['browser', 'claude.ai in a browser'],
] as const;

/** Install locations: macOS system and per-user bundles, then the Windows per-user install. */
function candidates(home: string): readonly Readonly<{ path: string; kind: 'bundle' | 'windows' }>[] {
  return [
    { path: '/Applications/Claude.app', kind: 'bundle' },
    { path: path.join(home, 'Applications', 'Claude.app'), kind: 'bundle' },
    { path: path.join(home, 'AppData', 'Local', 'AnthropicClaude'), kind: 'windows' },
  ];
}

const BUNDLE_VERSION = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]{1,64})<\/string>/;
const WINDOWS_VERSION = /^app-(\d+(?:\.\d+){1,3})$/;

async function detectedVersion(environment: SetupEnvironment, found: string, kind: 'bundle' | 'windows'): Promise<string | null> {
  if (kind === 'bundle') {
    const plist = await environment.probe.readFile(path.join(found, 'Contents', 'Info.plist'));
    if (plist === null) return null;
    // A binary plist is not parsed; the version then stays unknown.
    return BUNDLE_VERSION.exec(new TextDecoder().decode(plist))?.[1]?.trim() || null;
  }
  const versions = ((await environment.probe.listDirectory(found)) ?? [])
    .flatMap(name => WINDOWS_VERSION.exec(name)?.[1] ?? []);
  // Several side-by-side installs leave the running one ambiguous.
  return versions.length === 1 ? versions[0]! : null;
}

function unproven(detected: boolean): readonly SetupDiagnostic[] {
  if (!detected) {
    return [{
      code: CLAUDE_APP_UNPROVEN_CODE,
      severity: 'info',
      harness: 'claude-app',
      message: `Claude Desktop was not found. Delivery into claude.ai or a remote connector is unproven, so setup installs nothing for them. ${IDLE}`,
    }];
  }
  return UNPROVEN_SHAPES.map(([shape, label]) => ({
    code: CLAUDE_APP_UNPROVEN_CODE,
    severity: 'warning',
    harness: 'claude-app',
    component: 'mcp_entry',
    message: `${label} (${shape}): every listening mode is unknown because no exact-version proof exists, `
      + `so setup installs nothing. ${IDLE}`,
  }));
}

export const claudeAppSetupAdapter: SetupAdapter = {
  harness: 'claude-app',

  async detect(environment): Promise<HarnessDetection> {
    for (const candidate of candidates(environment.home)) {
      if (await environment.probe.listDirectory(candidate.path) === null) continue;
      return {
        executable: candidate.path,
        version: await detectedVersion(environment, candidate.path, candidate.kind),
        // A version alone never matches a proof: the account tier and administrator
        // policy cannot be inspected locally, and no tuple is proven anyway. This
        // adapter is report-only and plans nothing, so the planner must not list it
        // in `unsupportedHarnesses`; that would refuse setup for every other harness.
        supported: false,
      };
    }
    return { executable: null, version: null, supported: false };
  },

  async inspect(_environment, detection): Promise<HarnessObservation> {
    const detected = detection.executable !== null;
    return {
      detection,
      components: [{ component: 'mcp_entry', state: detected ? 'unsupported' : 'absent' }],
      route: 'unavailable',
      diagnostics: unproven(detected),
    };
  },

  // No route is selectable, so presence needs no writes. Absence needs none either:
  // setup never wrote Claude app config, and the executor removes manifest entries.
  plan(): readonly SetupOperation[] {
    return [];
  },
};
