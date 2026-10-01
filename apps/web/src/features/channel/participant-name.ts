/** Matrix IDs are routing identifiers, not display names for the roster. */
export function participantRosterName(name: string, fallback: 'Agent' | 'You' | 'Channel member'): string {
  return /^@[^:\s]+:[^\s]+$/u.test(name) ? fallback : name;
}
