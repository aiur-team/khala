import { describe, expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Panel } from './Panel';
import { StatusBadge } from './StatusBadge';
import { resolveInitialTheme, persistTheme, type ThemeStorage } from './theme';

describe('Panel', () => {
  test('idle status renders children; busy/empty/error render their slot instead', () => {
    const idle = renderToStaticMarkup(<Panel heading="Rooms">the body</Panel>);
    expect(idle).toContain('the body');
    expect(idle).toContain('aria-busy="false"');

    const busy = renderToStaticMarkup(<Panel heading="Rooms" status="busy">the body</Panel>);
    expect(busy).not.toContain('the body');
    expect(busy).toContain('Loading');
    expect(busy).toContain('aria-busy="true"');

    const empty = renderToStaticMarkup(<Panel heading="Rooms" status="empty">the body</Panel>);
    expect(empty).toContain('Nothing here yet');

    const error = renderToStaticMarkup(<Panel heading="Rooms" status="error">the body</Panel>);
    expect(error).toContain('role="alert"');
  });

  test('a custom statusMessage overrides the default copy', () => {
    const html = renderToStaticMarkup(
      <Panel heading="Rooms" status="error" statusMessage="Delivery could not be confirmed.">
        the body
      </Panel>,
    );
    expect(html).toContain('Delivery could not be confirmed.');
    expect(html).not.toContain('Something went wrong.');
  });

  test('renders identically across repeated calls (no incidental state)', () => {
    const first = renderToStaticMarkup(<Panel heading="Rooms">stable</Panel>);
    const second = renderToStaticMarkup(<Panel heading="Rooms">stable</Panel>);
    expect(first).toBe(second);
  });

  test('a disabled footer action keeps its accessible explanation', () => {
    const html = renderToStaticMarkup(
      <Panel
        heading="Review"
        footer={
          <>
            <button disabled aria-describedby="review-disabled-reason">
              Approve
            </button>
            <p id="review-disabled-reason">Approval requires a connector, not shown here.</p>
          </>
        }
      >
        body
      </Panel>,
    );
    expect(html).toContain('aria-describedby="review-disabled-reason"');
    expect(html).toContain('Approval requires a connector');
  });
});

describe('StatusBadge', () => {
  test('renders tone as a class plus explicit text, never color alone', () => {
    const html = renderToStaticMarkup(<StatusBadge tone="caution" label="Delivery unknown" />);
    expect(html).toContain('status-badge--caution');
    expect(html).toContain('Delivery unknown');
  });
});

describe('resolveInitialTheme', () => {
  function storage(value: string | null, opts: { throwsOnGet?: boolean } = {}): ThemeStorage {
    return {
      getItem: () => {
        if (opts.throwsOnGet) throw new Error('storage blocked');
        return value;
      },
      setItem: () => {
        throw new Error('setItem should not be called by resolveInitialTheme');
      },
    };
  }

  test('a host-provided theme always wins', () => {
    expect(resolveInitialTheme({ hostTheme: 'light', storage: storage('dark') })).toBe('light');
  });

  test('a valid stored preference is used absent a host theme', () => {
    expect(resolveInitialTheme({ storage: storage('light') })).toBe('light');
  });

  test('an invalid or missing stored value falls back to the default', () => {
    expect(resolveInitialTheme({ storage: storage('not-a-theme') })).toBe('dark');
    expect(resolveInitialTheme({ storage: storage(null) })).toBe('dark');
  });

  test('blocked storage does not throw and falls back to the default', () => {
    expect(resolveInitialTheme({ storage: storage(null, { throwsOnGet: true }) })).toBe('dark');
  });

  test('resolveInitialTheme with no options at all returns the default', () => {
    expect(resolveInitialTheme()).toBe('dark');
  });
});

describe('persistTheme + resolveInitialTheme round trip', () => {
  test('a theme persisted through the storage port is the theme resolved back from it', () => {
    // Keyed like real storage, so a write under one key and a read under
    // another cannot round-trip.
    const saved = new Map<string, string>();
    const storage: ThemeStorage = {
      getItem: (key) => saved.get(key) ?? null,
      setItem: (key, value) => {
        saved.set(key, value);
      },
    };
    persistTheme('light', storage);
    expect(resolveInitialTheme({ storage })).toBe('light');
  });
});

describe('persistTheme', () => {
  test('writes the choice through the provided storage port', () => {
    let written: [string, string] | undefined;
    persistTheme('light', { getItem: () => null, setItem: (key, value) => { written = [key, value]; } });
    expect(written).toEqual(['khala.theme', 'light']);
  });

  test('blocked storage on write does not throw', () => {
    expect(() =>
      persistTheme('light', {
        getItem: () => null,
        setItem: () => {
          throw new Error('blocked');
        },
      }),
    ).not.toThrow();
  });

  test('a missing storage port is a no-op, not a throw', () => {
    expect(() => persistTheme('dark')).not.toThrow();
  });
});
