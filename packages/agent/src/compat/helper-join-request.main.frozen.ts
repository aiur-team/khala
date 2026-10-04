// FROZEN COPY: request validation of POST /api/agent/join in
// packages/agent/src/local/routes/agent-join.ts at origin/main 120d9ffa (pre-#1076).
// One machine-wide helper serves every installed CLI and is reused regardless of
// version, so a new CLI can meet this validator. Lines are verbatim up to link
// consumption, which needs the helper store; a body that passes is reported as
// accepted. Do not edit. See join-request-compat.test.ts.
import { parseChannelLink } from '../join';

const HARNESSES = ['claude', 'codex', 'cursor'] as const;
type Harness = typeof HARNESSES[number];
const fail = (status: number, error: string) => ({ status, json: { error } });

export function frozenMainHelperJoinValidation(req: { body: unknown }, ctx: { origin: string }): { status: number; json: { error: string } } | 'accepted' {
      if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body)) return fail(400, 'invalid_link');
      const body = req.body as Record<string, unknown>;
      if (!Object.hasOwn(body, 'link') || Object.keys(body).some(key => !['link', 'harness', 'label'].includes(key))) return fail(400, 'invalid_link');
      if (typeof body.link !== 'string' || !parseChannelLink(body.link)) return fail(400, 'invalid_link');
      const harness = body.harness as Harness;
      if (!(HARNESSES as readonly unknown[]).includes(harness)) return fail(400, 'invalid_harness');
      const url = new URL(body.link);
      if (url.origin !== ctx.origin && url.origin !== ctx.origin.replace('://127.0.0.1:', '://localhost:')) return fail(404, 'link_unavailable');
      const token = url.pathname.slice('/join/'.length);
      if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return fail(404, 'link_unavailable');
      return 'accepted';
}
