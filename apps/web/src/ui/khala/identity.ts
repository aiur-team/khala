// Identity primitives (RECREATION-SPEC §3): stable hues, initials and harness
// logos for avatars, owner badges and chips.

import { createContext, createElement, useCallback, useContext, type ReactNode } from 'react';
import claudeSymbol from './assets/claude-symbol.svg';
import codexColor from './assets/codex-color.svg';

/** The viewer's own hue (`source:4080`). */
export const VIEWER_HUE = 214;
export const HUMAN_HUES = [330, 150, 32, 265, 190, 0, 95, 280] as const;
/** The design's four epic hues, reused for agents. */
export const AGENT_HUES = [210, 150, 265, 32] as const;

export type HueSubject =
  | Readonly<{ kind: 'human'; ownerId: string; participantId?: string; isViewer?: boolean }>
  | Readonly<{ kind: 'agent'; participantId: string }>;

/** 32-bit FNV-1a over the UTF-8 bytes of `value`. */
export function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * The avatar hue for a participant. An entry in `overrides`, keyed by
 * participant id, wins; only the design fixture supplies one.
 */
export function participantHue(subject: HueSubject, overrides?: ReadonlyMap<string, number>): number {
  const override = subject.participantId === undefined ? undefined : overrides?.get(subject.participantId);
  if (override !== undefined) return override;
  if (subject.kind === 'agent') return AGENT_HUES[fnv1a(subject.participantId) % AGENT_HUES.length]!;
  if (subject.isViewer) return VIEWER_HUE;
  return HUMAN_HUES[fnv1a(subject.ownerId) % HUMAN_HUES.length]!;
}

const HueOverrides = createContext<ReadonlyMap<string, number> | undefined>(undefined);

/** Supplies participant-id → hue overrides to `useParticipantHue`. Fixture only. */
export function HueOverrideProvider({ hues, children }: Readonly<{ hues: ReadonlyMap<string, number>; children?: ReactNode }>) {
  return createElement(HueOverrides.Provider, { value: hues }, children);
}

/** `participantHue` bound to the nearest `HueOverrideProvider`. */
export function useParticipantHue(): (subject: HueSubject) => number {
  const overrides = useContext(HueOverrides);
  return useCallback((subject: HueSubject) => participantHue(subject, overrides), [overrides]);
}

/**
 * Two-letter initials (`khGuest`, `source:4462-4464`): the first letters of
 * the first two parts, or the first two letters of a single part. An email
 * uses its local part.
 */
export function initials(name: string): string {
  const local = name.includes('@') ? name.slice(0, name.indexOf('@')) : name;
  const parts = local.split(/[._\- ]+/u).filter(Boolean);
  if (parts.length === 0) return '?';
  const letters = parts.length >= 2
    ? [...parts[0]!][0]! + [...parts[1]!][0]!
    : [...parts[0]!].slice(0, 2).join('');
  return letters.toLocaleUpperCase('en-US');
}

type OwnerCandidate = Readonly<{ ownerId?: string | undefined; displayName: string }>;

/**
 * An agent's owner badge initials (`.kh-own`), by the design's rule: the
 * owner's full name, first and last initial (`Kai Watanabe` → `KW`). The
 * owner is found among `humans` by owner id, else by first name; an owner
 * who isn't among them falls back to the initials of `ownerLabel`.
 */
export function ownerInitials(owner: Readonly<{ ownerId?: string | undefined; label: string }>, humans: Iterable<OwnerCandidate>): string {
  const first = (name: string) => name.trim().split(/\s+/u)[0]?.toLocaleLowerCase('en-US') ?? '';
  let byName: OwnerCandidate | undefined;
  for (const human of humans) {
    if (owner.ownerId !== undefined && human.ownerId === owner.ownerId) return initials(human.displayName);
    if (!byName && first(human.displayName) === first(owner.label)) byName = human;
  }
  return initials(byName?.displayName ?? owner.label);
}

type BadgeSubject = Readonly<{ ownerId: string; displayName: string }>;

/**
 * The `.kh-id` badge convention shared by the thread, roster and detail pane.
 * Given every participant on screen, returns a resolver that yields a short,
 * stable owner suffix (`#a1b2`) only for names that collide across owners.
 */
export function buildIdBadgeResolver(participants: readonly BadgeSubject[]): (participant: BadgeSubject) => string | undefined {
  const ownersByName = new Map<string, Set<string>>();
  for (const participant of participants) {
    const owners = ownersByName.get(participant.displayName) ?? new Set<string>();
    owners.add(participant.ownerId);
    ownersByName.set(participant.displayName, owners);
  }
  return participant => (ownersByName.get(participant.displayName)?.size ?? 0) > 1 ? `#${participant.ownerId.slice(-4)}` : undefined;
}

/** The bundled logo URL for a harness, or `null` for one Khala has no logo for. */
export function harnessLogo(harness: string): string | null {
  if (harness === 'claude') return claudeSymbol;
  if (harness === 'codex') return codexColor;
  return null;
}
