// Per-channel colours (#1308): the viewer's colour in this channel, and a
// variant of it for each of their agents. Taken options stay listed but are
// disabled: base colours another human here chose, and variants a sibling uses.

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { HUMAN_COLOR_IDS, type ChannelColors, type HumanColorId } from '@khala/contracts/m1/colors';
import { CheckIcon } from '../../ui/khala/icons';
import { HUMAN_PALETTE, colorVariants, resolvedColor } from '../../ui/khala/human-colors';
import '../profile/profile.css';

export type ColorOption = Readonly<{ key: string; label: string; fill: string; disabled: boolean }>;

/** The enabled option a key moves to from `index`, skipping disabled ones; `null` for other keys (WAI-ARIA radio group). */
export function nextEnabled(key: string, index: number, options: readonly Pick<ColorOption, 'disabled'>[]): number | null {
  const step = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 0;
  if (!step) return null;
  for (let move = 1; move <= options.length; move++) {
    const at = (index + step * move + options.length * move) % options.length;
    if (!options[at]!.disabled) return at;
  }
  return null;
}

function SwatchGroup({ label, options, value, onChange }: Readonly<{
  label: string; options: readonly ColorOption[]; value: string; onChange(key: string): void;
}>) {
  const labelId = useId();
  const radios = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = options.findIndex(option => option.key === value);
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const next = nextEnabled(event.key, Math.max(selected, 0), options);
    if (next === null) return;
    event.preventDefault();
    radios.current[next]?.focus();
    onChange(options[next]!.key);
  }
  return <div className="kh-colors-sec">
    <span className="kh-prof-lbl" id={labelId}>{label}</span>
    <div className="kh-swatches" role="radiogroup" aria-labelledby={labelId} onKeyDown={onKeyDown}>
      {options.map((option, index) => {
        const on = index === selected;
        return <button key={option.key} ref={node => { radios.current[index] = node; }} type="button" role="radio" className="kh-swatch"
          aria-checked={on} aria-disabled={option.disabled || undefined} aria-label={option.disabled ? `${option.label} (taken)` : option.label}
          title={option.disabled ? `${option.label} (taken)` : option.label} tabIndex={on || selected < 0 && index === 0 ? 0 : -1}
          onClick={() => { if (!option.disabled && !on) onChange(option.key); }}>
          <span style={{ background: option.fill }}>{on ? <CheckIcon /> : null}</span>
        </button>;
      })}
    </div>
  </div>;
}

const SAVE_DELAY_MS = 400;
/** A key for `colors` that ignores agent order. */
export const colorsKey = (colors: ChannelColors): string =>
  JSON.stringify([colors.color ?? null, Object.entries(colors.agents).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]);

export type ColorAgent = Readonly<{ participantId: string; matrixUserId: string; name: string; variant: number }>;

export function ChannelColorsPicker({ save, channelColor, profileColor, taken, agents }: Readonly<{
  save(colors: ChannelColors): Promise<'sent' | 'failed'>;
  /** The viewer's colour for this channel, if they chose one. */
  channelColor: HumanColorId | undefined;
  profileColor: HumanColorId;
  /** Base colours other humans here chose. */
  taken: ReadonlySet<HumanColorId>;
  /** The viewer's own agents and their current variants. */
  agents: readonly ColorAgent[];
}>) {
  const saved: ChannelColors = { ...(channelColor ? { color: channelColor } : {}),
    agents: Object.fromEntries(agents.map(agent => [agent.matrixUserId, agent.variant])) };
  // The last choice shows at once, until the member event carrying it comes back through sync.
  const [pending, setPending] = useState<ChannelColors | null>(null);
  const savedKey = colorsKey(saved);
  useEffect(() => { setPending(current => current && colorsKey(current) === savedKey ? null : current); }, [savedKey]);
  const [error, setError] = useState('');
  const current = pending ?? saved;
  const color = current.color ?? profileColor;
  const variants = colorVariants(resolvedColor(color, 0));

  // Each choice is one member event, so arrowing across swatches sends only the one it settles on.
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const queued = useRef<(() => void) | null>(null);
  const latest = useRef(0);
  const flush = () => { clearTimeout(timer.current); const send = queued.current; queued.current = null; send?.(); };
  // Closing the popover sends a queued choice rather than dropping it.
  useEffect(() => flush, []);
  function apply(next: ChannelColors): void {
    if (colorsKey(next) === colorsKey(current)) return;
    setPending(next);
    setError('');
    clearTimeout(timer.current);
    const request = ++latest.current;
    // Saving writes every agent's current variant, so a default becomes a stored choice.
    queued.current = () => void save(next).catch(() => 'failed' as const).then(result => {
      if (result === 'failed' && request === latest.current) { setPending(null); setError('Couldn’t save. Try again.'); }
    });
    timer.current = setTimeout(flush, SAVE_DELAY_MS);
  }
  const withColor = (id: HumanColorId | undefined): ChannelColors => ({ ...(id ? { color: id } : {}), agents: current.agents });

  return <div className="kh-colors" role="dialog" aria-label="Colors in this channel">
    <SwatchGroup label="Your color here" value={color} onChange={id => apply(withColor(id as HumanColorId))}
      options={HUMAN_COLOR_IDS.map(id => ({ key: id, label: HUMAN_PALETTE[id].label, fill: HUMAN_PALETTE[id].solid,
        disabled: id !== color && taken.has(id) }))} />
    {current.color ? <button type="button" className="kh-btn" onClick={() => apply(withColor(undefined))}>Use profile color</button> : null}
    {agents.map(agent => {
      const variant = current.agents[agent.matrixUserId] ?? agent.variant;
      const siblings = new Set(agents.filter(other => other !== agent).map(other => current.agents[other.matrixUserId] ?? other.variant));
      return <SwatchGroup key={agent.participantId} label={agent.name} value={String(variant)}
        onChange={key => apply({ ...current, agents: { ...current.agents, [agent.matrixUserId]: Number(key) } })}
        options={variants.slice(1).map((shade, index) => ({ key: String(index + 1), label: `${HUMAN_PALETTE[color].label} shade ${index + 1}`,
          fill: shade.tint, disabled: index + 1 !== variant && siblings.has(index + 1) }))} />;
    })}
    {error ? <p className="kh-uname-err" role="alert">{error}</p> : null}
  </div>;
}
