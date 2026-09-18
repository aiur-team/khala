// Minimal cookie-carrying user agent. Each instance models one browser profile
// on one machine; a copied link opened elsewhere uses a separate instance.
// It records what a human would see or do so journey evidence can list them.

export type Visible = { kind: 'human-action' | 'page'; detail: string };

export class Browser {
  readonly log: Visible[] = [];
  private readonly jar = new Map<string, Map<string, string>>();

  human(detail: string): void {
    this.log.push({ kind: 'human-action', detail });
  }

  // Cookies are scoped by host, not port, as in real browsers.
  private cookieHeader(url: URL): string {
    return [...(this.jar.get(url.hostname) ?? new Map())].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  private store(url: URL, response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      const cookies = this.jar.get(url.hostname) ?? new Map<string, string>();
      if (value === '' || /max-age=0|expires=thu, 01 jan 1970/i.test(header)) cookies.delete(name);
      else cookies.set(name, value);
      this.jar.set(url.hostname, cookies);
    }
  }

  // Follows redirects like a top-level navigation and returns the final page.
  async navigate(target: string, init: { method?: string; form?: Record<string, string>; headers?: Record<string, string> } = {}): Promise<{ url: URL; status: number; body: string }> {
    let url = new URL(target);
    let method = init.method ?? 'GET';
    let body: string | undefined = init.form ? new URLSearchParams(init.form).toString() : undefined;
    for (let hop = 0; hop < 20; hop++) {
      const headers: Record<string, string> = { ...(init.headers ?? {}), cookie: this.cookieHeader(url) };
      if (body !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
      const response = await fetch(url, { method, headers, body, redirect: 'manual' });
      this.store(url, response);
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        url = new URL(location, url);
        method = 'GET';
        body = undefined;
        continue;
      }
      const text = await response.text();
      this.log.push({ kind: 'page', detail: `${response.status} ${url.origin}${url.pathname}` });
      return { url, status: response.status, body: text };
    }
    throw new Error('redirect loop');
  }

  // Same-origin script request from the signed-in web app (cookie + CSRF header).
  async appRequest(target: string, method: string, csrf: string | undefined, payload?: unknown, bearer?: string): Promise<Response> {
    const url = new URL(target);
    const headers: Record<string, string> = { cookie: this.cookieHeader(url), 'content-type': 'application/json' };
    if (csrf) headers['x-khala-csrf'] = csrf;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    return fetch(url, { method, headers, body: payload === undefined ? undefined : JSON.stringify(payload) });
  }
}
