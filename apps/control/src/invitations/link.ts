/** The only share URL accepted by browser and native-agent resolution. */
export function inviteFromShareLink(url: URL, origin: string): string | null {
  if (url.origin !== origin || url.username || url.password || url.search || url.hash
    || !url.pathname.startsWith('/join/')) return null;
  const encoded = url.pathname.slice('/join/'.length);
  if (!encoded || encoded.includes('/')) return null;
  try {
    const invite = decodeURIComponent(encoded);
    return /^[A-Za-z0-9_-]{8,256}$/u.test(invite) ? invite : null;
  } catch {
    return null;
  }
}
