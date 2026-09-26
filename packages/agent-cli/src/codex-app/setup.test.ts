import { describe, expect, it } from 'vitest';
import { codexAppRouteEvidence, codexAppSetupEntries } from '../composition/codex-app.js';
import { SETUP_COMMANDS } from '../setup/types.js';
import { type CodexAppRouteEvidence, codexAppSetupContribution } from './setup.js';

const route = (shape: CodexAppRouteEvidence['shape'], mode: CodexAppRouteEvidence['mode'], proven: boolean) =>
  ({ shape, mode, proven, reason: proven ? '' : `Blocked ${shape}.` });

describe('codex app setup entries', () => {
  it.each(SETUP_COMMANDS)('%s installs and removes nothing and says delivery is unproven', command => {
    const entries = codexAppSetupEntries(command);
    expect(entries.components).toEqual([]);
    expect(entries.diagnostics.map(diagnostic => diagnostic.code))
      .toEqual(['codex_app_delivery_unproven', 'codex_app_delivery_unproven']);
    for (const diagnostic of entries.diagnostics) {
      expect(diagnostic).toMatchObject({ severity: 'info', harness: 'codex' });
      expect(diagnostic.message).toContain('delivery is unproven for steer, sync, async');
    }
    expect(entries.diagnostics[0]!.message).toMatch(/^Codex desktop app: /);
    expect(entries.diagnostics[1]!.message).toMatch(/^Codex Cloud task: /);
  });

  it('reads every cell from the committed proof record as unproven', () => {
    expect(codexAppRouteEvidence().filter(cell => cell.proven)).toEqual([]);
    expect(codexAppRouteEvidence()).toHaveLength(6);
  });

  it('asks the Codex adapter only for components a proven desktop cell needs', () => {
    const routes = [route('local_chat', 'sync', true), route('local_chat', 'async', true), route('local_chat', 'steer', false)];
    const entries = codexAppSetupContribution('setup', routes);
    expect(entries.components).toEqual(['hooks', 'mcp_entry']);
    expect(entries.diagnostics.map(diagnostic => diagnostic.message)).toEqual([
      'Codex desktop app: delivery is unproven for steer. Blocked local_chat. Setup installs nothing for it.',
    ]);
  });

  it('never turns a cloud-task proof into a local install', () => {
    const entries = codexAppSetupContribution('setup', [route('cloud_task', 'steer', true), route('cloud_task', 'sync', true)]);
    expect(entries.components).toEqual([]);
    expect(entries.diagnostics).toEqual([expect.objectContaining({ code: 'codex_app_task_environment', severity: 'warning' })]);
  });
});
