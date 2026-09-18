export type StatusTone = 'neutral' | 'positive' | 'caution' | 'critical';

export interface StatusBadgeProps {
  tone: StatusTone;
  label: string;
}

/** Presentation only: tone plus text. Never derives readiness from model/connectivity state. */
export function StatusBadge({ tone, label }: StatusBadgeProps) {
  return <span className={`status-badge status-badge--${tone}`}>{label}</span>;
}
