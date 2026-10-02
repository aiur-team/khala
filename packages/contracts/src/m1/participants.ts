import { type Decoded, array, decodeWith, elementPath, fail, identifier, label, literal, object, utcTimestamp } from '../messaging/decode';
import { type Harness, M1_LABEL_MAX_BYTES, readAgentLabel, readHarness, readMatrixUserId } from './agent-join';
import { type HumanColorId, readHumanColorId } from './colors';

import { readHumanInitials } from './initials';

export type AgentOwnerRecord = { matrixUserId: string; ownerId: string; ownerLabel: string; harness: Harness; label: string; createdAt: string };

export type Participant =
  | { matrixUserId: string; participantId: string; ownerId: string; displayName: string; kind: 'human'; email?: string; color?: HumanColorId; initials?: string }
  | { matrixUserId: string; participantId: string; ownerId: string; displayName: string; kind: 'agent'; ownerLabel: string; harness: Harness; ownerColor?: HumanColorId; ownerInitials?: string }
  | { matrixUserId: string; displayName: string; kind: 'unknown' };   // an unknown member never fails the whole response
export type ParticipantsResponse = { participants: Participant[] };

/**
 * `ownerFirstName` is derived from the owner's verified email. Take the first `.`, `_`, `-` or `+`-separated token of the local part, strip trailing digits and capitalise it; if the result is empty, use `Owner`. Example: `kevin.weaver2@gmail.com` → `Kevin`. KM-122, KM-132 and KM-135 use this same rule via `ownerFirstName(email)` exported from `packages/contracts/src/m1/participants.ts`, which KM-104 owns.
 * - **Human labels come from Matrix display names, everywhere.** When KM-122 mints a browser session, it sets the human's own Matrix display name to the stored username, or `ownerFirstName(verifiedEmail)` when no profile exists: read it first, write only if different. Readers (control participants, browser, KM-143 agent intake) use the display name. Fallback when it is missing: control's participants `displayName` falls back to the full `matrixUserId` (C3); KM-143's `senderLabel` falls back to the user id localpart.
 */
export const MAX_PARTICIPANTS = 100;
/**
 * A human's verified sign-in email, shown to other members of the same channel.
 * Control writes it at browser-session mint and returns it only from the
 * room-scoped participants lookup, after checking the caller is joined.
 */
export type HumanEmailRecord = { v: 1; ownerId: string; email: string };
export const humanEmailRecordKey = (ownerId: string): string => `humans/${encodeURIComponent(ownerId)}/email`;
const EMAIL = /^[^\s@]+@[^\s@]+$/u;
export function readParticipantEmail(input: unknown, path: string): string {
  const email = identifier(input, path);
  if (!EMAIL.test(email)) fail(path, 'invalid_value');
  return email;
}
export const agentOwnerRecordKey = (matrixUserId: string): string => `agents/${encodeURIComponent(matrixUserId)}`;
export function ownerFirstName(email: string): string {
  const at = email.lastIndexOf('@');
  const local = at === -1 ? email : email.slice(0, at);
  const token = (local.split(/[._+-]/u)[0] ?? '').replace(/\d+$/u, '');
  return token ? token.charAt(0).toUpperCase() + token.slice(1) : 'Owner';
}

export function decodeAgentOwnerRecord(input: unknown): Decoded<AgentOwnerRecord> {
  return decodeWith(() => {
    const r = object(input, '', ['matrixUserId', 'ownerId', 'ownerLabel', 'harness', 'label', 'createdAt']);
    const ownerLabel = label(r.field('ownerLabel'), r.at('ownerLabel'), M1_LABEL_MAX_BYTES);
    if (!ownerLabel) fail(r.at('ownerLabel'), 'empty');
    return {
      matrixUserId: readMatrixUserId(r.field('matrixUserId'), r.at('matrixUserId')),
      ownerId: identifier(r.field('ownerId'), r.at('ownerId')),
      ownerLabel,
      harness: readHarness(r.field('harness'), r.at('harness')),
      label: readAgentLabel(r.field('label'), r.at('label')),
      createdAt: utcTimestamp(r.field('createdAt'), r.at('createdAt')),
    };
  });
}

function readParticipant(input: unknown, path: string): Participant {
  const kind = literal((input as Record<string, unknown> | null)?.['kind'], path ? `${path}.kind` : 'kind', ['human', 'agent', 'unknown']);
  const keys = ['matrixUserId', 'displayName', 'kind'];
  if (kind !== 'unknown') keys.push('participantId', 'ownerId');
  if (kind === 'human' && typeof input === 'object' && input !== null && Object.hasOwn(input, 'email')) keys.push('email');
  if (kind === 'agent') keys.push('ownerLabel', 'harness');
  const colorKey = kind === 'human' ? 'color' : kind === 'agent' ? 'ownerColor' : null;
  if (colorKey && typeof input === 'object' && input !== null && Object.hasOwn(input, colorKey)) keys.push(colorKey);
  const initialsKey = kind === 'human' ? 'initials' : kind === 'agent' ? 'ownerInitials' : null;
  if (initialsKey && typeof input === 'object' && input !== null && Object.hasOwn(input, initialsKey)) keys.push(initialsKey);
  const r = object(input, path, keys);
  const common = {
    matrixUserId: readMatrixUserId(r.field('matrixUserId'), r.at('matrixUserId')),
    displayName: label(r.field('displayName'), r.at('displayName'), M1_LABEL_MAX_BYTES),
  };
  if (kind === 'unknown') return { ...common, kind };
  const known = {
    ...common,
    participantId: identifier(r.field('participantId'), r.at('participantId')),
    ownerId: identifier(r.field('ownerId'), r.at('ownerId')),
  };
  if (kind === 'human') return { ...known, kind,
    ...(keys.includes('email') ? { email: readParticipantEmail(r.field('email'), r.at('email')) } : {}),
    ...(keys.includes('initials') ? { initials: readHumanInitials(r.field('initials'), r.at('initials')) } : {}),
    ...(keys.includes('color') ? { color: readHumanColorId(r.field('color'), r.at('color')) } : {}),
  };
  return {
    ...known,
    kind,
    ownerLabel: label(r.field('ownerLabel'), r.at('ownerLabel'), M1_LABEL_MAX_BYTES),
    harness: readHarness(r.field('harness'), r.at('harness')),
    ...(keys.includes('ownerInitials') ? { ownerInitials: readHumanInitials(r.field('ownerInitials'), r.at('ownerInitials')) } : {}),
    ...(keys.includes('ownerColor') ? { ownerColor: readHumanColorId(r.field('ownerColor'), r.at('ownerColor')) } : {}),
  };
}

export function decodeParticipant(input: unknown): Decoded<Participant> {
  return decodeWith(() => readParticipant(input, ''));
}

export function decodeParticipantsResponse(input: unknown): Decoded<ParticipantsResponse> {
  return decodeWith(() => {
    const r = object(input, '', ['participants']);
    const entries = array(r.field('participants'), r.at('participants'));
    if (entries.length > MAX_PARTICIPANTS) fail(r.at('participants'), 'too_long');
    const seen = new Set<string>();
    const participants = entries.map((entry, index) => {
      const path = elementPath(r.at('participants'), index);
      const participant = readParticipant(entry, path);
      if (seen.has(participant.matrixUserId)) fail(path, 'duplicate');
      seen.add(participant.matrixUserId);
      return participant;
    });
    return { participants };
  });
}
