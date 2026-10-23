// Per-channel colours (#1308, operator request 2026-10-23): the viewer picks
// any palette colour for themselves and each of their agents. Colours others
// hold stay pickable; each viewer's page resolves clashes for itself.

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { ChannelColorKey, ChannelColors } from '@khala/contracts/m1/colors';
import { CheckIcon } from '../../ui/khala/icons';
import { colorOf } from '../../ui/khala/human-colors';
import '../profile/profile.css';

/** The option an arrow key moves to from `index`, wrapping; `null` for other keys (WAI-ARIA radio group). */
export function nextIndex(key: string, index: number, count: number): number | null {
  const step = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 0;
  return step ? (index + step + count) % count : null;
}

function SwatchGroup({ label, options, value, onChange }: Readonly<{
  label: string; options: readonly ChannelColorKey[]; value: ChannelColorKey; onChange(key: ChannelColorKey): void;
}>) {
  const labelId = useId();
  const radios = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = options.indexOf(value);
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const next = nextIndex(event.key, Math.max(selected, 0), options.length);
    if (next === null) return;
    event.preventDefault();
    radios.current[next]?.focus();
    onChange(options[next]!);
  }
  return <div className="kh-colors-sec">
    <span className="kh-prof-lbl" id={labelId}>{label}</span>
    <div className="kh-swatches" role="radiogroup" aria-labelledby={labelId} onKeyDown={onKeyDown}>
      {options.map((key, index) => {
        const on = index === selected;
        const color = colorOf(key);
        return <button key={key} ref={node => { radios.current[index] = node; }} type="button" role="radio" className="kh-swatch"
          aria-checked={on} aria-label={color.label} title={color.label} tabIndex={on || selected < 0 && index === 0 ? 0 : -1}
          onClick={() => { if (!on) onChange(key); }}>
          <span style={{ background: color.tint }}>{on ? <CheckIcon /> : null}</span>
        </button>;
      })}
    </div>
  </div>;
}

const SAVE_DELAY_MS = 400;
/** A key for `colors` that ignores agent order. */
export const colorsKey = (colors: ChannelColors): string =>
  JSON.stringify([colors.color ?? null, Object.entries(colors.agents).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]);

export type ColorAgent = Readonly<{ participantId: string; matrixUserId: string; name: string; color: ChannelColorKey }>;

export function ChannelColorsPicker({ save, channelColor, shownColor, palette, agents }: Readonly<{
  save(colors: ChannelColors): Promise<'sent' | 'failed'>;
  /** The viewer's colour for this channel, if they chose one. */
  channelColor: ChannelColorKey | undefined;
  /** The viewer's colour as shown when they chose none here. */
  shownColor: ChannelColorKey;
  /** The channel's current palette. */
  palette: readonly ChannelColorKey[];
  /** The viewer's own agents and their current colours. */
  agents: readonly ColorAgent[];
}>) {
  const saved: ChannelColors = { ...(channelColor ? { color: channelColor } : {}),
    agents: Object.fromEntries(agents.map(agent => [agent.matrixUserId, agent.color])) };
  // The last choice shows at once, until the member event carrying it comes back through sync.
  const [pending, setPending] = useState<ChannelColors | null>(null);
  const savedKey = colorsKey(saved);
  useEffect(() => { setPending(current => current && colorsKey(current) === savedKey ? null : current); }, [savedKey]);
  const [error, setError] = useState('');
  const current = pending ?? saved;
  // A chosen colour outside a palette that has since shrunk stays listed.
  const optionsFor = (key: ChannelColorKey) => palette.includes(key) ? palette : [...palette, key];

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
    // Saving writes every agent's current colour, so a default becomes a stored choice.
    queued.current = () => void save(next).catch(() => 'failed' as const).then(result => {
      if (result === 'failed' && request === latest.current) { setPending(null); setError('Couldn’t save. Try again.'); }
    });
    timer.current = setTimeout(flush, SAVE_DELAY_MS);
  }
  const color = current.color ?? shownColor;

  return <div className="kh-colors" role="dialog" aria-label="Colors in this channel">
    <SwatchGroup label="Your color here" value={color} options={optionsFor(color)} onChange={key => apply({ ...current, color: key })} />
    {agents.map(agent => {
      const value = current.agents[agent.matrixUserId] ?? agent.color;
      return <SwatchGroup key={agent.participantId} label={agent.name} value={value} options={optionsFor(value)}
        onChange={key => apply({ ...current, agents: { ...current.agents, [agent.matrixUserId]: key } })} />;
    })}
    {error ? <p className="kh-uname-err" role="alert">{error}</p> : null}
  </div>;
}
