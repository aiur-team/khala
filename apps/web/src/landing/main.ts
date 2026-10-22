import './landing.css';
import { wirePromptCopy } from './copy-prompt';
import { wireThemeToggle } from './theme';
import { wireAiurBanner } from './banner';
import { createFlowField } from './flow-field';
import { mountExampleShowcase } from './showcase';
import { SIGN_IN_RETURN_KEY } from '../composition/human/sign-in-return';

// The sign-in callback returns a cancelled or failed attempt here; say so
// once under the topbar, then drop the parameter so a reload is quiet.
const params = new URLSearchParams(location.search);
const outcome = params.get('sign_in');
if (outcome !== null) {
  const message = outcome === 'cancelled' ? 'Sign-in was cancelled.'
    : outcome === 'error' ? 'Sign-in could not be completed.'
      : outcome === 'expired' ? 'Sign-in expired. ' : null;
  const topbar = document.querySelector('.topbar');
  if (message && topbar) {
    const notice = document.createElement('p');
    notice.className = 'signin-status';
    notice.setAttribute('role', 'status');
    notice.textContent = message;
    if (outcome === 'expired') {
      // Retry returns to the page that began sign-in (an agent confirm link keeps its joinId).
      const retry = document.createElement('a');
      retry.href = `/api/human/auth/login?${new URLSearchParams({ return_to: signInReturnPath() })}`;
      retry.textContent = 'Try again';
      notice.append(retry);
    }
    topbar.after(notice);
  }
  params.delete('sign_in');
  const query = params.toString();
  history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
}

function signInReturnPath(): string {
  try {
    const path = sessionStorage.getItem(SIGN_IN_RETURN_KEY);
    if (path?.startsWith('/') && !path.startsWith('//')) return path;
  } catch { /* Storage can be blocked; fall back to the channel list. */ }
  return '/conversations';
}

const field = createFlowField();
const showcase = document.querySelector<HTMLElement>('#exampleShowcase');
if (showcase) mountExampleShowcase(showcase);

const banner = document.querySelector<HTMLElement>('#aiurBanner');
const bannerClose = document.querySelector<HTMLButtonElement>('#aiurBannerClose');
if (banner && bannerClose) wireAiurBanner(banner, bannerClose);

const toggle = document.querySelector<HTMLButtonElement>('#themeToggle');
if (toggle) {
  wireThemeToggle(toggle);
  toggle.addEventListener('click', field.redraw);
}

const button = document.querySelector<HTMLButtonElement>('#copyBtn');
const line = document.querySelector<HTMLElement>('#agentPrompt');
const status = document.querySelector<HTMLElement>('#copyStatus');
if (button && line && status) wirePromptCopy({ button, line, status });

const scrollcue = document.querySelector<HTMLElement>('#scrollcue');
const onScroll = () => scrollcue?.classList.toggle('gone', window.scrollY > 60);
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();
