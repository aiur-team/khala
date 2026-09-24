// Keep a previously dismissed banner out of the first paint. This must stay a
// classic same-origin script because the CSP forbids inline scripts.
try {
  if (localStorage.getItem('khala.aiur-banner.dismissed') === '1') {
    document.documentElement.dataset.aiurBanner = 'dismissed';
  }
} catch {
  // Storage can be blocked; the banner remains visible and dismissible.
}
