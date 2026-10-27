// The shared projection deliberately excludes Matrix member-only `mute` and route evidence.
const ref = name => ({ $ref: `#/$defs/${name}` });
const object = (properties, required = Object.keys(properties)) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });

export function listeningSchema(modes, statuses, backlogs, carriers) {
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
        effective_reason: nullable(text), version: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        backlog_on_leave_async: { type: 'string', enum: [...backlogs],
          description: 'skip advances past unread backlog (Khala); notice keeps bodies pull-only and shows a notice.' } },
      ['requested', 'effective', 'effective_reason', 'version']),
      supportEntry: object({ status: { type: 'string', enum: [...statuses] }, reason: nullable(text) }),
      steerSupportEntry: object({ status: { type: 'string', enum: [...statuses] }, reason: nullable(text),
        steer_carrier: { type: 'string', enum: [...carriers],
          description: 'Renderers must read this carrier: emulated_interrupt must display steer (interrupts current turn).' } },
      ['status', 'reason']),
      support: object(Object.fromEntries(modes.map(mode => [mode,
        ref(mode === 'steer' ? 'steerSupportEntry' : 'supportEntry')]))),
      parsedHook: object({ sessionId: text, event: { enum: ['start', 'prompt', 'tool', 'stop', 'limit'] },
        continuation: { type: 'boolean' }, workspace: text, transcriptPath: text, promptText: text },
      ['sessionId', 'event', 'continuation']),
      hookGolden: object({ harness: { enum: ['claude', 'codex'] }, stdin: text,
        parsed: nullable(ref('parsedHook')), frame: { const: '<frame/>' }, stdout: text,
        stop_context: { type: 'boolean' } }),
    },
  };
}
