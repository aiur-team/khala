// Runs before first paint (a classic, render-blocking script in <head>; the CSP
// forbids inline script). Resolves the shared Aiur theme tokens from the saved
// choice or the system preference. Storage can throw when site data is blocked.
(function () {
  var stored;
  try {
    stored = window.localStorage.getItem('khala.theme');
  } catch {
    /* follow the system preference */
  }
  var theme = stored === 'light' || stored === 'dark'
    ? stored
    : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);
})();
