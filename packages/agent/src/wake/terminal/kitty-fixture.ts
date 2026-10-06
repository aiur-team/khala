// Representative kitten @ ls output: unrelated shells, multiple tabs/OS windows,
// and a foreground process group containing both the agent and its child.
export function kittyLsFixture(foregroundPids: number[] = [100, 101]) {
  const window = (id: number, pid: number, title: string, isSelf = false) => ({
    id, pid, title, is_self: isSelf, is_focused: isSelf,
    cwd: '/home/user/project', cmdline: ['/bin/zsh'],
    env: { TERM: 'xterm-kitty' }, lines: 24, columns: 80, user_vars: {}, at_prompt: true,
    foreground_processes: [{ pid, cwd: '/home/user/project', cmdline: ['/bin/zsh'] }],
  });
  return [
    { id: 1, platform_window_id: 1001, is_focused: true, is_active: true, last_focused: 1, wm_class: ['kitty', 'kitty'], tabs: [
      { id: 1, title: 'shell', is_focused: false, layout: 'splits', active_window_history: [], groups: [], windows: [window(3, 50, 'zsh')] },
      { id: 2, title: 'agent', is_focused: true, layout: 'splits', active_window_history: [], groups: [], windows: [
        window(8, 60, 'kitten @', true),
        { ...window(9, 100, 'codex'), at_prompt: false, cmdline: ['codex'],
          foreground_processes: foregroundPids.map(pid => ({ pid, cwd: '/home/user/project', cmdline: [pid === 100 ? 'codex' : 'node'] })) },
      ] },
    ] },
    { id: 2, platform_window_id: 1002, is_focused: false, is_active: false, last_focused: 0, wm_class: ['kitty', 'kitty'], tabs: [
      { id: 3, title: 'other shell', is_focused: true, layout: 'splits', active_window_history: [], groups: [], windows: [window(12, 70, 'zsh')] },
    ] },
  ];
}
