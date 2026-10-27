// The shared projection deliberately excludes Matrix member-only `mute` and route evidence.
const ref = name => ({ $ref: `#/$defs/${name}` });
const object = (properties, required = Object.keys(properties)) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });

export function listeningSchema(modes, statuses) {
  const text = { type: 'string' };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://github.com/aiur-team/khala/packages/listener/spec/v1/listening-mode.v1.schema.json',
    title: 'Shared listener v1 projections and hook codec fixtures',
    anyOf: ['mode', 'command', 'control', 'support', 'hookGolden'].map(ref),
    $defs: {
      mode: { type: 'string', enum: [...modes] },
      command: object({ v: { const: 1 }, agent: { type: 'string', minLength: 1 }, mode: ref('mode') }),
      control: object({ requested: nullable(ref('mode')), effective: nullable(ref('mode')),
        effective_reason: nullable(text), version: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } }),
      supportEntry: object({ status: { type: 'string', enum: [...statuses] }, reason: nullable(text) }),
      support: object(Object.fromEntries(modes.map(mode => [mode, ref('supportEntry')]))),
      parsedHook: object({ sessionId: text, event: { enum: ['start', 'prompt', 'tool', 'stop', 'limit'] },
        continuation: { type: 'boolean' }, workspace: text, transcriptPath: text, promptText: text },
      ['sessionId', 'event', 'continuation']),
      hookGolden: object({ harness: { enum: ['claude', 'codex'] }, stdin: text,
        parsed: nullable(ref('parsedHook')), frame: { const: '<frame/>' }, stdout: text,
        stop_context: { type: 'boolean' } }),
    },
  };
}
