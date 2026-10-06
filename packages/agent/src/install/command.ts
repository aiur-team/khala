/** Quote direct Node/script commands for the platform's hook shell. */
export function nodeScriptCommand(platform: NodeJS.Platform, node: string, script: string): string {
  // Bare node and forward slashes work in PowerShell, cmd and Git Bash.
  if (platform === 'win32') return `node "${script.replaceAll('\\', '/')}"`;
  const quote = (value: string): string => /^[A-Za-z0-9_./:-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
  return `${quote(node)} ${quote(script)}`;
}
