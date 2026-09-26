// Declarative run profiles and the per-mode plan derived from each role's route.
// A mode runs only where both routes make it effective under the policy owner's
// own rule; anything else is recorded as skipped and never substituted.

import { decodeHarnessCapabilities } from '../../packages/contracts/src/delivery/harness';
import { LISTENING_MODES, type ListeningMode } from '../../packages/contracts/src/delivery/listening-mode';
import { initialListeningModeControl, listeningModeView } from '../../packages/policy/src/listening-mode/store';
import { ACCEPTANCE_REPOSITORY, type ModePlan, type Profile, type ProfileRole, type RoleName } from './types';

const MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const IDENTIFIER = /^[a-z0-9][a-z0-9._:/@-]{0,127}$/i;

function fail(field: string, why: string): never {
  throw new Error(`profile ${field}: ${why}`);
}

function exactKeys(value: unknown, field: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(field, 'must be an object');
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).filter(key => !keys.includes(key));
  const missing = keys.filter(key => !(key in record));
  if (extra.length > 0 || missing.length > 0) fail(field, `keys must be exactly ${keys.join(', ')}`);
  return record;
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) fail(field, 'must be a short identifier');
  return value;
}

function decodeRole(value: unknown, field: string, expected: RoleName): ProfileRole {
  const record = exactKeys(value, field, ['role', 'harness', 'provider', 'model', 'labels', 'capabilities']);
  if (record.role !== expected) fail(`${field}.role`, `must be ${expected}`);
  const harness = identifier(record.harness, `${field}.harness`);
  if (!Array.isArray(record.labels) || record.labels.length === 0) fail(`${field}.labels`, 'must name the harness/model labels');
  const labels = record.labels.map((label, index) => identifier(label, `${field}.labels[${index}]`));
  const capabilities = decodeHarnessCapabilities(record.capabilities);
  if (!capabilities.ok) fail(`${field}.capabilities`, `${capabilities.code} at ${capabilities.field}`);
  if (capabilities.value.harness !== harness) fail(`${field}.capabilities.harness`, `must be ${harness}`);
  return {
    role: expected,
    harness,
    provider: identifier(record.provider, `${field}.provider`),
    model: identifier(record.model, `${field}.model`),
    labels,
    capabilities: capabilities.value,
  };
}

/** Strict: unknown keys, another repository, or an unbounded timeout refuse the profile. */
export function decodeProfile(input: unknown): Profile {
  const record = exactKeys(input, 'profile', ['name', 'repository', 'dispatchLabel', 'khalaPackage', 'timeoutMs', 'roles']);
  if (record.repository !== ACCEPTANCE_REPOSITORY) fail('repository', `must be ${ACCEPTANCE_REPOSITORY}`);
  const timeoutMs = record.timeoutMs;
  if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    fail('timeoutMs', `must be a positive integer of at most ${MAX_TIMEOUT_MS}`);
  }
  const khalaPackage = record.khalaPackage;
  if (typeof khalaPackage !== 'string' || !/^@aiur\/khala@\d+\.\d+\.\d+(?:-[0-9a-z.]+)?$/i.test(khalaPackage)) {
    fail('khalaPackage', 'must pin an exact @aiur/khala version');
  }
  if (!Array.isArray(record.roles) || record.roles.length !== 2) fail('roles', 'must hold exactly roles a and b');
  return {
    name: identifier(record.name, 'name'),
    repository: ACCEPTANCE_REPOSITORY,
    dispatchLabel: identifier(record.dispatchLabel, 'dispatchLabel'),
    khalaPackage,
    timeoutMs,
    roles: [decodeRole(record.roles[0], 'roles[0]', 'a'), decodeRole(record.roles[1], 'roles[1]', 'b')],
  };
}

function effective(role: ProfileRole, mode: ListeningMode): string | null {
  const control = { ...initialListeningModeControl({ bindingId: 'binding_plan' as never, generation: 0 }, role.capabilities), requested: mode };
  const view = listeningModeView(control, role.capabilities);
  return view.effective === mode ? null : `${role.role} (${role.harness}): ${view.effectiveReason ?? 'not effective'}`;
}

/** Every mode both exact routes advertise as effective, in contract order. */
export function planModes(profile: Profile): ModePlan {
  const runnable: ListeningMode[] = [];
  const skipped: { mode: ListeningMode; reason: string }[] = [];
  for (const mode of LISTENING_MODES) {
    const reasons = profile.roles.map(role => effective(role, mode)).filter((reason): reason is string => reason !== null);
    if (reasons.length === 0) runnable.push(mode);
    else skipped.push({ mode, reason: reasons.join('; ') });
  }
  return { runnable, skipped };
}
