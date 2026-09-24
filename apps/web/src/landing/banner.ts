export const AIUR_BANNER_STORAGE_KEY = 'khala.aiur-banner.dismissed';

type BannerStorage = Pick<Storage, 'getItem' | 'setItem'>;

function safeStorage(): BannerStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function bannerWasDismissed(storage: BannerStorage | null): boolean {
  try {
    return storage?.getItem(AIUR_BANNER_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberDismissal(storage: BannerStorage | null): void {
  try {
    storage?.setItem(AIUR_BANNER_STORAGE_KEY, '1');
  } catch {
    // Dismissal still lasts for this page load.
  }
}

export function wireAiurBanner(
  banner: HTMLElement,
  close: HTMLButtonElement,
  storage: BannerStorage | null = safeStorage(),
): () => void {
  const dismissed = bannerWasDismissed(storage);
  banner.hidden = dismissed;
  if (dismissed) document.documentElement.dataset.aiurBanner = 'dismissed';
  const dismiss = () => {
    banner.hidden = true;
    document.documentElement.dataset.aiurBanner = 'dismissed';
    rememberDismissal(storage);
  };
  close.addEventListener('click', dismiss);
  return () => close.removeEventListener('click', dismiss);
}
