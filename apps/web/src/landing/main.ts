import './landing.css';
import { wirePromptCopy } from './copy-prompt';
import { wireThemeToggle } from './theme';

const toggle = document.querySelector<HTMLButtonElement>('#themeToggle');
if (toggle) wireThemeToggle(toggle);

const button = document.querySelector<HTMLButtonElement>('#copyBtn');
const line = document.querySelector<HTMLElement>('#agentPrompt');
const status = document.querySelector<HTMLElement>('#copyStatus');
if (button && line && status) wirePromptCopy({ button, line, status });
