// The one loading state for the channel pane: a centred `.kh-spin` on the pane's
// own background. The label is for assistive technology only.

export function LoadingSpinner({ label = 'Loading conversation', overlay = false }: Readonly<{
  label?: string;
  /** Centre over the positioned parent instead of filling the remaining flex space. */
  overlay?: boolean;
}>) {
  return <div className={overlay ? 'kh-loading kh-loading--overlay' : 'kh-loading'} role="status" aria-label={label}>
    <span className="kh-spin" aria-hidden="true" />
    <span className="sr-only">{label}</span>
  </div>;
}
