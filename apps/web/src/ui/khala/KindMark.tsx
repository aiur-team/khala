// The kind marker beside a sender's name (operator request 2026-10-04): a
// person icon in Aiur blue for humans, a robot icon in its complementary
// orange for agents. It replaces the old `Human` pill; the label stays for
// screen readers.

import { RobotIcon, UserIcon } from './icons';

export function KindMark({ kind }: Readonly<{ kind: 'human' | 'agent' }>) {
  const label = kind === 'human' ? 'Human' : 'Agent';
  return <span className={`kh-kind kh-kind-${kind}`} role="img" aria-label={label} title={label}>
    {kind === 'human' ? <UserIcon /> : <RobotIcon />}
  </span>;
}
