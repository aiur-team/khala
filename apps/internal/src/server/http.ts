import type { IncomingMessage, ServerResponse } from 'node:http';

// Every response carries the same isolation set. The CSP admits same-origin
// external scripts only: no inline, eval, worker, frame, object or form target.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'none'",
  "child-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'origin-agent-cluster': '?1',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

/** Finite, content-free error codes. Raw exception text never becomes a code. */
export type ErrorCode =
  | 'bad_request' | 'invalid_host' | 'forbidden_origin' | 'not_found' | 'method_not_allowed'
  | 'unauthenticated' | 'forbidden' | 'unsupported_media_type' | 'payload_too_large' | 'invalid_request'
  | 'not_joined' | 'operation_mismatch' | 'invalid_cursor' | 'too_many_requests' | 'unavailable'
  | 'outcome_unknown' | 'request_timeout' | 'internal_error';

export function applySecurityHeaders(response: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
}

export function sendBytes(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: Uint8Array,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  applySecurityHeaders(response);
  for (const [name, value] of Object.entries(extraHeaders)) response.setHeader(name, value);
  response.statusCode = status;
  response.setHeader('content-type', contentType);
  response.setHeader('content-length', String(body.byteLength));
  response.end(body);
}

export function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  sendBytes(response, status, 'application/json; charset=utf-8', Buffer.from(JSON.stringify(value), 'utf8'), extraHeaders);
}

export function sendNoContent(response: ServerResponse, status = 204): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  applySecurityHeaders(response);
  response.statusCode = status;
  response.end();
}

/** Content-free error envelope. `close` also ends the connection so an unread body is never consumed. */
export function sendError(response: ServerResponse, status: number, code: ErrorCode, close = false): void {
  sendJson(response, status, { error: { code } }, close ? { connection: 'close' } : {});
}

export class BodyError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  constructor(status: number, code: ErrorCode) {
    super(code);
    this.name = 'BodyError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Reads one bounded request body. Declared lengths above the bound are refused
 * before any byte is consumed; streamed bodies are cut off at the bound.
 */
export function readBoundedBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = request.headers['content-length'];
  if (declared !== undefined && (!/^\d{1,12}$/.test(declared) || Number(declared) > maxBytes)) {
    return Promise.reject(new BodyError(413, 'payload_too_large'));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onAbort);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > maxBytes) {
        cleanup();
        request.pause();
        reject(new BodyError(413, 'payload_too_large'));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    const onError = () => {
      cleanup();
      reject(new BodyError(400, 'bad_request'));
    };
    const onAbort = () => {
      cleanup();
      reject(new BodyError(400, 'bad_request'));
    };
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onAbort);
  });
}

/** Parses a bounded JSON object body with an exact media type. */
export async function readJsonObject(
  context: Readonly<{ request: IncomingMessage; readBody(maxBytes: number): Promise<Buffer> }>,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  if (!isJsonMediaType(context.request.headers['content-type'])) throw new BodyError(415, 'unsupported_media_type');
  const body = await context.readBody(maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw new BodyError(400, 'invalid_request');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new BodyError(400, 'invalid_request');
  return parsed as Record<string, unknown>;
}

function isJsonMediaType(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.toLowerCase().replace(/\s+/g, '');
  return normalized === 'application/json' || normalized === 'application/json;charset=utf-8';
}

/** Counts raw header occurrences; Node folds or drops duplicates in `headers`. */
export function headerValues(request: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]!.toLowerCase() === name) values.push(request.rawHeaders[index + 1]!);
  }
  return values;
}
