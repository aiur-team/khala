// App-specific identity and hook metadata around the shared capability owner.
// Candidate boundaries identify integration seams; they never imply support.

import {
  type Decoded, decodeWith, fail, identifier, literal, nullable, object, version,
} from './decode';
import { type HarnessCapabilities, decodeHarnessCapabilities } from './harness';
import { LISTENING_MODES } from './listening-mode';

export const APP_HARNESSES = ['cursor', 'claude', 'codex'] as const;
export const APP_HARNESS_SHAPES = [
  'local_chat', 'desktop_extension', 'remote_connector', 'browser', 'cloud_task',
] as const;

const STEER_APP_HOOK_BOUNDARIES = ['postToolUse', 'PostToolUse'] as const;
const SYNC_APP_HOOK_BOUNDARIES = ['stop', 'Stop'] as const;
const ASYNC_APP_HOOK_BOUNDARIES = ['khala_read'] as const;
export const APP_HOOK_BOUNDARIES = [
  ...STEER_APP_HOOK_BOUNDARIES,
  ...SYNC_APP_HOOK_BOUNDARIES,
  ...ASYNC_APP_HOOK_BOUNDARIES,
] as const;

export type AppHarness = (typeof APP_HARNESSES)[number];
export type AppHarnessShape = (typeof APP_HARNESS_SHAPES)[number];
export type AppHookBoundary = (typeof APP_HOOK_BOUNDARIES)[number];

export type AppHarnessIdentity = Readonly<{
  v: 1;
  app: AppHarness;
  shape: AppHarnessShape;
  appVersion: string;
  accountTier: string;
  administratorPolicyScope: string;
}>;

export type AppHarnessBoundaries = Readonly<{
  steer: (typeof STEER_APP_HOOK_BOUNDARIES)[number] | null;
  sync: (typeof SYNC_APP_HOOK_BOUNDARIES)[number] | null;
  async: (typeof ASYNC_APP_HOOK_BOUNDARIES)[number] | null;
}>;

export type AppHarnessRecord = AppHarnessIdentity & Readonly<{
  boundaries: AppHarnessBoundaries;
  capabilities: HarnessCapabilities;
}>;

function readBoundaries(input: unknown, field: string): AppHarnessBoundaries {
  const r = object(input, field, LISTENING_MODES);
  return {
    steer: nullable(
      r.field('steer'),
      value => literal(value, r.at('steer'), STEER_APP_HOOK_BOUNDARIES),
    ),
    sync: nullable(
      r.field('sync'),
      value => literal(value, r.at('sync'), SYNC_APP_HOOK_BOUNDARIES),
    ),
    async: nullable(
      r.field('async'),
      value => literal(value, r.at('async'), ASYNC_APP_HOOK_BOUNDARIES),
    ),
  };
}

function readWireV3Capabilities(input: unknown, field: string): HarnessCapabilities {
  const raw = input as { v?: unknown } | null;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || raw.v !== 3) {
    fail(`${field}.v`, 'invalid_version');
  }

  const decoded = decodeHarnessCapabilities(input);
  if (!decoded.ok) fail(decoded.field.length === 0 ? field : `${field}.${decoded.field}`, decoded.code);
  return decoded.value;
}

export function decodeAppHarnessRecord(input: unknown): Decoded<AppHarnessRecord> {
  return decodeWith(() => {
    const r = object(input, '', [
      'v', 'app', 'shape', 'appVersion', 'accountTier', 'administratorPolicyScope', 'boundaries', 'capabilities',
    ]);
    const app = literal(r.field('app'), r.at('app'), APP_HARNESSES);
    const appVersion = identifier(r.field('appVersion'), r.at('appVersion'));
    const capabilities = readWireV3Capabilities(r.field('capabilities'), r.at('capabilities'));
    if (capabilities.harness !== app) fail(`${r.at('capabilities')}.harness`, 'invalid_field');
    if (capabilities.version !== appVersion) fail(`${r.at('capabilities')}.version`, 'invalid_field');

    return {
      v: version(r.field('v'), r.at('v')),
      app,
      shape: literal(r.field('shape'), r.at('shape'), APP_HARNESS_SHAPES),
      appVersion,
      accountTier: identifier(r.field('accountTier'), r.at('accountTier')),
      administratorPolicyScope: identifier(
        r.field('administratorPolicyScope'),
        r.at('administratorPolicyScope'),
      ),
      boundaries: readBoundaries(r.field('boundaries'), r.at('boundaries')),
      capabilities,
    };
  });
}

export function sameAppHarnessIdentity(a: AppHarnessIdentity, b: AppHarnessIdentity): boolean {
  return a.v === b.v
    && a.app === b.app
    && a.shape === b.shape
    && a.appVersion === b.appVersion
    && a.accountTier === b.accountTier
    && a.administratorPolicyScope === b.administratorPolicyScope;
}
