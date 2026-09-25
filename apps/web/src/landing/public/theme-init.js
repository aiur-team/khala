// Runs before first paint (a classic, render-blocking script in <head>; the CSP
// forbids inline script). Applies a theme the visitor chose earlier; with no
// stored choice the page follows prefers-color-scheme through CSS alone. Keep
// the key and values in step with ../theme.ts. Storage can throw when site
// data is blocked, so the access is guarded and the page renders without it.
(function () {
  try {
    var stored = window.localStorage.getItem('khala.theme');
    if (stored === 'light' || stored === 'dark') document.documentElement.setAttribute('data-theme', stored);
  } catch {
    /* no stored choice: follow the system preference */
  }
})();
