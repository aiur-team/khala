// FROZEN COPY: opened join request validation at U8. Do not edit.
// Copied up to link resolution/consumption; pure validators are frozen here.
import { parseChannelLink } from '../join';
const isHarnessId = (input: unknown): input is string => typeof input === 'string' && /^[a-z][a-z0-9-]{1,23}$/.exec(input)?.[0] === input;
const validAgentSessionId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value);
const validAgentRejoinSecret = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value);
const fail = (status: number, error: string) => ({ status, json: { error } });
export function frozenRegistryHelperJoinValidation(req: { body: unknown }, ctx: { origin: string }): { status: number; json: { error: string } } | 'accepted' {
      if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body)) return fail(400, 'invalid_link');
      const body = req.body as Record<string, unknown>;
      if (!Object.hasOwn(body, 'link') || Object.keys(body).some(key => !['link', 'harness', 'label', 'sessionId', 'rejoinSecret'].includes(key))) return fail(400, 'invalid_link');
      if (typeof body.link !== 'string' || !parseChannelLink(body.link)) return fail(400, 'invalid_link');
      if (Object.hasOwn(body, 'sessionId') && !validAgentSessionId(body.sessionId)) return fail(400, 'invalid_link');
      if (Object.hasOwn(body, 'rejoinSecret') && !validAgentRejoinSecret(body.rejoinSecret)) return fail(400, 'invalid_link');
      const harness = body.harness;
      if (!isHarnessId(harness)) return fail(400, 'invalid_harness');
      const url = new URL(body.link);
      if (url.origin !== ctx.origin && url.origin !== ctx.origin.replace('://127.0.0.1:', '://localhost:')) return fail(404, 'link_unavailable');
      const token = url.pathname.slice('/join/'.length);
      if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return fail(404, 'link_unavailable');
      return 'accepted';
}
