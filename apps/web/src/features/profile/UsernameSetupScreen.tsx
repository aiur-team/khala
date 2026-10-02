// First sign-in: a human without a username chooses one before entering Khala.

import { useEffect, useRef, type ReactNode } from 'react';
import type { ThemeChoice } from '../../shell/types';
import { KhalaApp } from '../../ui/khala/KhalaApp';
import { useProfile } from './ProfileProvider';
import { UsernameForm } from './UsernameForm';
import './profile.css';

export type UsernameShellProps = Readonly<{
  theme: ThemeChoice;
  onThemeChange?(theme: ThemeChoice): void;
  homeHref?: string;
  brandActions?: ReactNode;
}>;

export function UsernameSetupScreen({ onSaved = () => undefined, ...shell }: UsernameShellProps & Readonly<{ onSaved?(username: string): void }>) {
  const { suggestion } = useProfile();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return <KhalaApp className="khala-username-setup" {...shell} main={
    <section className="kh-state kh-uname-page" aria-labelledby="kh-uname-title">
      <div className="kh-uname-card">
        <h1 id="kh-uname-title" ref={heading} tabIndex={-1}>Choose your username</h1>
        <p>This is how people and agents mention you in Khala. You can change it later in Settings.</p>
        <UsernameForm initial={suggestion} submitLabel="Continue" onSaved={onSaved} />
      </div>
    </section>
  } />;
}
