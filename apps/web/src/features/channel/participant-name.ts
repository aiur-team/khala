/** Routing and proof-key labels are identifiers, not names for the roster. */
export function participantRosterName(name: string, fallback: 'Agent' | 'You' | 'Channel member'): string {
  return /^@[^:\s]+:[^\s]+$/u.test(name) || /^proof[ -]key\b/iu.test(name.trim()) ? fallback : name;
}
