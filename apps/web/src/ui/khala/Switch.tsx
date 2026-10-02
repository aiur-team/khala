// Switch (RECREATION-SPEC §12.2): `button.kh-sw[role=switch]`.

export function Switch({ checked, onChange, label, disabled = false, title }: Readonly<{
  checked: boolean;
  onChange?(checked: boolean): void;
  label: string;
  disabled?: boolean;
  title?: string;
}>) {
  return <button type="button" className="kh-sw" role="switch" aria-checked={checked} aria-label={label}
    disabled={disabled} {...(title ? { title } : {})} onClick={() => onChange?.(!checked)} />;
}
