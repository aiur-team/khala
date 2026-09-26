import { describe, expect, it, vi } from 'vitest';
import { fakeModeApplication } from '../composition/fixtures/listening-mode.js';
import { ListeningModeOperation } from '../composition/listening-mode.js';
import {
  LISTENING_MODE_TOOL_NAME, executeListeningModeTool, listeningModeToolDefinition,
} from './listening-mode-tool.js';

function operation(application = fakeModeApplication().application) {
  return new ListeningModeOperation({ application, newCommandId: () => 'command-1' });
}

describe('khala_listening_mode tool', () => {
  it('declares a closed get/set schema with conflict and delivery-honesty guidance', () => {
    const definition = listeningModeToolDefinition();

    expect(definition).toMatchObject({
      name: LISTENING_MODE_TOOL_NAME,
      inputSchema: {
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: { enum: ['get', 'set'] },
          requested: { enum: ['steer', 'sync', 'async'] },
          expectedVersion: { type: 'integer', minimum: 0 },
          ackBatchToken: { type: 'string' },
        },
      },
    });
    expect(Object.keys(definition.inputSchema.properties).sort())
      .toEqual(['ackBatchToken', 'action', 'expectedVersion', 'requested']);
    expect(definition.description).toMatch(/held by this agent.*get.*again.*never retry automatically/i);
    expect(definition.description).toMatch(/Neither proves.*delivered.*idle/);
  });

  it('returns get and applied set as successful structured results', async () => {
    const mode = operation();
    const view = await executeListeningModeTool({ action: 'get' }, mode);
    const applied = await executeListeningModeTool({ action: 'set', requested: 'async', expectedVersion: 4 }, mode);

    expect(view).toMatchObject({ structuredContent: { kind: 'view', version: 4 } });
    expect(view).not.toHaveProperty('isError');
    expect(applied).toEqual({
      content: [{ type: 'text', text: JSON.stringify(applied?.structuredContent) }],
      structuredContent: { kind: 'applied', requested: 'async', effective: 'async', effectiveReason: null, version: 5 },
    });
  });

  it('marks conflict and refusal as isError while keeping their typed payloads', async () => {
    const fake = fakeModeApplication();
    const conflict = await executeListeningModeTool(
      { action: 'set', requested: 'async', expectedVersion: 3 }, operation(fake.application),
    );
    const refused = await executeListeningModeTool({ action: 'get' }, new ListeningModeOperation({ application: null }));

    expect(conflict).toMatchObject({
      isError: true, structuredContent: { kind: 'conflict', reason: 'stale_version', current: { version: 4 } },
    });
    expect(refused).toMatchObject({ isError: true, structuredContent: { kind: 'refused', reason: 'unavailable' } });
    expect(fake.application.set).toHaveBeenCalledOnce();
  });

  it('returns null for every malformed or target-shaped call before inspecting or mutating', async () => {
    const mode = { get: vi.fn(), set: vi.fn() };
    for (const args of [
      {}, { action: 'delete' }, { action: 'get', requested: 'sync' }, { action: 'get', bindingId: 'binding-2' },
      { action: 'set' }, { action: 'set', requested: 'sync' }, { action: 'set', expectedVersion: 1 },
      { action: 'set', requested: 'sync', expectedVersion: 1, bindingId: 'binding-2' },
      { action: 'set', requested: 'sync', expectedVersion: 1, expectedBindingGeneration: 0 },
      { action: 'set', requested: 'sync', expectedVersion: 1, route: 'codex-sync', evidenceRevision: 'rev-1' },
      { action: 'set', requested: 'sync', expectedVersion: 1, kind: 'grant_experimental_route' },
    ]) {
      await expect(executeListeningModeTool(args, mode)).resolves.toBeNull();
    }
    expect(mode.get).not.toHaveBeenCalled();
    expect(mode.set).not.toHaveBeenCalled();
  });
});
