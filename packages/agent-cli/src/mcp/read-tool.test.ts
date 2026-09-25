import { describe, expect, it, vi } from 'vitest';
import type { BindingId } from '@khala/contracts/delivery/index';
import { CliError } from '../cli/errors.js';
import type { InboxBatch } from '../cli/inbox.js';
import { mcpPayloadBudget } from './result-postprocessor.js';
import { executeReadTool, readToolDefinition, type ReadOperationPort } from './read-tool.js';

const BATCH = { token: 'batch-token', items: [] } as unknown as InboxBatch;

describe('khala_read tool', () => {
  it('publishes a closed schema with shared acknowledgement and trust guidance', () => {
    const definition = readToolDefinition();
    expect(definition).toMatchObject({
      name: 'khala_read',
      description: expect.stringMatching(/untrusted.*exact batchToken.*releaseId.*acknowledg/i),
      inputSchema: {
        type: 'object', required: [], additionalProperties: false,
        properties: {
          bindingId: { type: 'string' },
          ackBatchToken: { type: 'string', description: expect.stringMatching(/Exact opaque batchToken/) },
        },
      },
    });
    expect(definition.inputSchema.properties).not.toHaveProperty('releaseId');
  });

  it('builds the typed primary before selection and returns one preselected batch', async () => {
    const read = vi.fn<ReadOperationPort['read']>(async () => ({ kind: 'batch', batch: BATCH }));
    const responseId = `request-${'\\"'.repeat(200)}`;
    const execution = await executeReadTool({
      responseId,
      arguments: { bindingId: 'binding-1' as BindingId },
      acknowledgeToken: 'prior-token',
      read: { read },
    });

    expect(execution.kind).toBe('success');
    if (execution.kind !== 'success') throw new Error('expected successful read');
    expect(execution.preselectedBatch).toBe(BATCH);
    expect(execution.primaryResult).toEqual({
      content: [{ type: 'text', text: '{"kind":"batch"}' }],
      structuredContent: { kind: 'batch' },
    });
    expect(read).toHaveBeenCalledWith({
      bindingId: 'binding-1',
      acknowledgeToken: 'prior-token',
      maxBytes: mcpPayloadBudget(responseId, execution.primaryResult),
    });
  });

  it('returns a stable typed empty result with no fabricated batch', async () => {
    const read = vi.fn<ReadOperationPort['read']>(async () => ({ kind: 'empty' }));
    const execution = await executeReadTool({ responseId: 2, arguments: { bindingId: null }, read: { read } });

    expect(execution).toEqual({
      kind: 'success',
      primaryResult: {
        content: [{ type: 'text', text: '{"kind":"empty"}' }],
        structuredContent: { kind: 'empty' },
      },
      preselectedBatch: null,
    });
  });

  it.each(['binding_not_held', 'listener_busy', 'storage_failed', 'transport_unavailable'] as const)(
    'maps %s to a typed content-free tool error',
    async code => {
      const read = vi.fn<ReadOperationPort['read']>(async () => { throw new CliError(code); });
      const execution = await executeReadTool({ responseId: 3, arguments: { bindingId: null }, read: { read } });

      expect(execution).toEqual({
        kind: 'error',
        primaryResult: {
          content: [{ type: 'text', text: JSON.stringify({ kind: 'refused', code }) }],
          structuredContent: { kind: 'refused', code },
          isError: true,
        },
      });
    },
  );

  it('does not expose an unexpected operational error', async () => {
    const read: ReadOperationPort = { async read() { throw new Error('secret storage path'); } };
    const execution = await executeReadTool({ responseId: 4, arguments: { bindingId: null }, read });
    expect(execution).toMatchObject({
      kind: 'error', primaryResult: { isError: true, structuredContent: { kind: 'refused', code: 'internal_error' } },
    });
    expect(JSON.stringify(execution)).not.toContain('secret storage path');
  });
});
