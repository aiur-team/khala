import { rateLimitSafe } from './rate-limit';
export async function proofRequest(homeserver: string, endpoint: string, body?: unknown) {
  return rateLimitSafe(async () => {
    const res = await fetch(homeserver + endpoint, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw Object.assign(new Error(`request_${res.status}`), { errcode: data.errcode, data });
    }
    return res.json();
  });
}
