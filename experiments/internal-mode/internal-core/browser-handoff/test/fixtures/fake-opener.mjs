// Stands in for xdg-open: forwards its single target argument to the browser
// as argv, the way a desktop entry's %U field code does, and waits for it.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const browser = fileURLToPath(new URL('./fake-browser.mjs', import.meta.url));
const child = spawn(process.execPath, [browser, process.argv[2]], { stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 0));
