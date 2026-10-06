// FROZEN COPY: opened join request validation at U8. Do not edit.
// Copied up to link resolution/consumption; pure validators are frozen here.
import { validateAgentName } from '@khala/contracts/messaging/agent-names';
const isHarnessId = (input: unknown): input is string => typeof input === 'string' && /^[a-z][a-z0-9-]{1,23}$/.exec(input)?.[0] === input;
const validAgentSessionId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value);
const validAgentRejoinSecret = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value);
const error = (code: string, status: number) => ({ status, json: { error: code } });
export async function frozenRegistryControlJoinValidation(request: Request): Promise<{ status: number; json: { error: string } } | 'accepted'> {
    if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return error('invalid_link', 400);
    let body: unknown;
    try { body = await request.json(); } catch { return error('invalid_link', 400); }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return error('invalid_link', 400);
    const r = body as Record<string, unknown>;
    if (Object.keys(r).some(key => !['link', 'harness', 'label', 'sessionId', 'rejoinSecret'].includes(key)) || !['link', 'harness', 'label'].every(key => Object.hasOwn(r, key)) || typeof r.link !== 'string') return error('invalid_link', 400);
    if (Object.hasOwn(r, 'sessionId') && !validAgentSessionId(r.sessionId)) return error('invalid_link', 400);
    if (Object.hasOwn(r, 'rejoinSecret') && !validAgentRejoinSecret(r.rejoinSecret)) return error('invalid_link', 400);
    if (!isHarnessId(r.harness)) return error('invalid_harness', 400);
    const label = validateAgentName(r.label);
    if (!label.ok || [...label.name].length > 40) return error('invalid_label', 400);
    return 'accepted';
}
