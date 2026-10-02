// Time labels for the list, thread rows and day separators. The product
// passes no time zone (the viewer's local time); fixtures and tests pass UTC.

export type TimeOptions = Readonly<{ timeZone?: string }>;

function formatter(options: TimeOptions, format: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', options.timeZone ? { ...format, timeZone: options.timeZone } : format);
}

/** `h:mm` with no meridiem, e.g. 22:05 → `10:05`. */
export function clockLabel(date: Date, options: TimeOptions = {}): string {
  return formatter(options, { hour: 'numeric', minute: '2-digit', hour12: true })
    .formatToParts(date)
    .filter(part => part.type === 'hour' || part.type === 'minute' || (part.type === 'literal' && part.value === ':'))
    .map(part => part.value)
    .join('');
}

/** `h:mm AM`, e.g. `9:41 AM`. */
export function dayTime(date: Date, options: TimeOptions = {}): string {
  return formatter(options, { hour: 'numeric', minute: '2-digit', hour12: true }).format(date).replace(/ /gu, ' ');
}

function calendarDay(date: Date, options: TimeOptions): number {
  const parts = formatter(options, { year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(part => part.type === type)!.value);
  return Date.UTC(value('year'), value('month') - 1, value('day')) / 86_400_000;
}

/** `Today`, `Yesterday`, a weekday within the last six days, else `Thu, Sep 24`. */
export function dayLabel(date: Date, now: Date, options: TimeOptions = {}): string {
  const daysAgo = calendarDay(now, options) - calendarDay(date, options);
  if (daysAgo === 0) return 'Today';
  if (daysAgo === 1) return 'Yesterday';
  if (daysAgo > 1 && daysAgo <= 6) return formatter(options, { weekday: 'long' }).format(date);
  return formatter(options, { weekday: 'short', month: 'short', day: 'numeric' }).format(date);
}
