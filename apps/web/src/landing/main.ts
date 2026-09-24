import './landing.css';
import { wirePromptCopy } from './copy-prompt';
import { wireThemeToggle } from './theme';
import { wireAiurBanner } from './banner';

const banner = document.querySelector<HTMLElement>('#aiurBanner');
const bannerClose = document.querySelector<HTMLButtonElement>('#aiurBannerClose');
if (banner && bannerClose) wireAiurBanner(banner, bannerClose);

const toggle = document.querySelector<HTMLButtonElement>('#themeToggle');
if (toggle) wireThemeToggle(toggle);

const button = document.querySelector<HTMLButtonElement>('#copyBtn');
const line = document.querySelector<HTMLElement>('#agentPrompt');
const status = document.querySelector<HTMLElement>('#copyStatus');
if (button && line && status) wirePromptCopy({ button, line, status });
