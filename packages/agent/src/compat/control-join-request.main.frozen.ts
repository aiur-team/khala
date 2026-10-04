// FROZEN COPY: request validation of POST /api/agent/join in
// apps/control/src/agent-join/agent-routes.ts at origin/main 120d9ffa (pre-#1076).
// This is the hosted control plane that is in production when a rejoin-capable CLI
// ships. Lines are verbatim up to link resolution, which needs the control store;
// a body that passes is reported as accepted. Do not edit. See join-request-compat.test.ts.
import { validateAgentName } from '@khala/contracts/messaging/agent-names';

const error = (code: string, status: number) => ({ status, json: { error: code } });

export async function frozenMainControlJoinValidation(request: Request): Promise<{ status: number; json: { error: string } } | 'accepted'> {
    if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return error('invalid_link', 400);
    let body: unknown;
    try { body = await request.json(); } catch { return error('invalid_link', 400); }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return error('invalid_link', 400);
    const r = body as Record<string, unknown>;
    if (Object.keys(r).length !== 3 || !['link', 'harness', 'label'].every(key => Object.hasOwn(r, key)) || typeof r.link !== 'string') return error('invalid_link', 400);
    if (r.harness !== 'claude' && r.harness !== 'codex') return error('invalid_harness', 400);
    const label = validateAgentName(r.label);
    if (!label.ok || [...label.name].length > 40) return error('invalid_label', 400);
    return 'accepted';
}
