import './landing.css';
import { wirePromptCopy } from './copy-prompt';
import { wireThemeToggle } from './theme';
import { wireAiurBanner } from './banner';
import { createFlowField } from './flow-field';

const field = createFlowField();

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
