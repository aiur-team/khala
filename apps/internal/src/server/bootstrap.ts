// The fixed browser bridge. The document contains no inline script; the external
// script reads the one-time credential from the fragment, clears the fragment
// immediately, exchanges it on the same origin, keeps the returned request secret
// in sessionStorage and replaces the location with the selected channel route.

export const BOOTSTRAP_DOCUMENT_ROUTE = '/__khala/bootstrap';
export const BOOTSTRAP_SCRIPT_ROUTE = '/__khala/bootstrap.js';
export const SESSION_EXCHANGE_ROUTE = '/__khala/session';
export const SESSION_COOKIE = 'khala_session';
export const REQUEST_SECRET_HEADER = 'x-khala-request-secret';
export const REQUEST_SECRET_STORAGE_KEY = 'khala.requestSecret';

export const BOOTSTRAP_DOCUMENT = Buffer.from([
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="referrer" content="no-referrer">',
  '<title>Khala</title>',
  `<script src="${BOOTSTRAP_SCRIPT_ROUTE}"></script>`,
  '</head>',
  '<body></body>',
  '</html>',
  '',
].join('\n'), 'utf8');

export const BOOTSTRAP_SCRIPT = Buffer.from(`(() => {
  'use strict';
  const fragment = new URLSearchParams(location.hash.slice(1));
  const credential = fragment.get('credential');
  const channelId = fragment.get('channel');
  history.replaceState(null, '', location.pathname);
  const fail = () => { document.title = 'Khala: this link is no longer valid'; };
  if (!credential || !channelId) { fail(); return; }
  fetch(${JSON.stringify(SESSION_EXCHANGE_ROUTE)}, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential, channelId }),
  })
    .then(response => response.ok ? response.json() : Promise.reject(new Error('exchange')))
    .then(result => {
      if (typeof result.requestSecret !== 'string' || typeof result.route !== 'string' || !result.route.startsWith('/channels/')) {
        throw new Error('exchange');
      }
      sessionStorage.setItem(${JSON.stringify(REQUEST_SECRET_STORAGE_KEY)}, result.requestSecret);
      location.replace(result.route);
    })
    .catch(fail);
})();
`, 'utf8');
