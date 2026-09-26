import { createHmac } from 'node:crypto';

export const CHANNEL_ACCESS_REQUESTER_MAX = 5;
export const CHANNEL_ACCESS_OWNER_MAX = 50;
export const CHANNEL_ACCESS_COOLDOWN_MS = 5 * 60_000;
export const CHANNEL_ACCESS_DEADLINE_MS = 7 * 24 * 60 * 60_000;
export const CHANNEL_ACCESS_PURGE_MS = 30 * 24 * 60 * 60_000;

type OperationKind = 'access' | 'create';
type Purpose =
  | 'binding'
  | 'cooldown'
  | 'mute'
  | 'notification'
  | 'operation'
  | 'request'
  | 'requester';

export type ChannelAccessDerivationInput = Readonly<{
  requester: string;
  sessionFingerprint: string;
  sessionGeneration: number;
  origin: string;
  kind: OperationKind;
  operationId: string;
  ownerId: string;
  targetFingerprint: string;
}>;

export type ChannelAccessArtifacts = Readonly<{
  operationKey: string;
  bindingDigest: string;
  requestHandle: string;
  requesterKey: string;
  cooldownKey: string;
  muteKey: string;
  notificationId: string;
}>;

export type ChannelAccessPolicy = Readonly<{
  limits: Readonly<{ requesterMax: number; ownerMax: number }>;
  derive(input: ChannelAccessDerivationInput): ChannelAccessArtifacts;
  digest(purpose: Purpose, fields: readonly Readonly<[string, string | number]>[]): string;
}>;

export function createChannelAccessPolicy(input: Readonly<{
  key: Uint8Array;
  requesterMax?: number;
  ownerMax?: number;
}>): ChannelAccessPolicy {
  if (!(input.key instanceof Uint8Array) || input.key.byteLength !== 32) {
    throw new TypeError('channel-access key must contain exactly 32 bytes');
  }
  const key = Buffer.from(input.key);
  const requesterMax = readLimit(input.requesterMax, CHANNEL_ACCESS_REQUESTER_MAX);
  const ownerMax = readLimit(input.ownerMax, CHANNEL_ACCESS_OWNER_MAX);
  const digest = (purpose: Purpose, fields: readonly Readonly<[string, string | number]>[]) => {
    const payload = fields.map(([name, value]) => {
      const text = String(value);
      return `${name.length}:${name}${text.length}:${text}`;
    }).join('');
    return createHmac('sha256', key)
      .update(`khala.channel-access.v1\0${purpose}\0${payload}`)
      .digest('base64url');
  };

  return Object.freeze({
    limits: Object.freeze({ requesterMax, ownerMax }),
    digest,
    derive(value) {
      assertInput(value);
      const requesterFields = [
        ['requester', value.requester],
      ] as const;
      const operationFields = [
        ...requesterFields,
        ['operationId', value.operationId],
      ] as const;
      const bindingFields = [
        ...operationFields,
        ['sessionFingerprint', value.sessionFingerprint],
        ['sessionGeneration', value.sessionGeneration],
        ['origin', value.origin],
        ['kind', value.kind],
        ['ownerId', value.ownerId],
        ['targetFingerprint', value.targetFingerprint],
      ] as const;
      const targetFields = [
        ...requesterFields,
        ['ownerId', value.ownerId],
        ['targetFingerprint', value.targetFingerprint],
        ['kind', value.kind],
      ] as const;
      return Object.freeze({
        operationKey: digest('operation', operationFields),
        bindingDigest: digest('binding', bindingFields),
        requestHandle: `careq_${digest('request', bindingFields)}`,
        requesterKey: digest('requester', requesterFields),
        cooldownKey: digest('cooldown', targetFields),
        muteKey: digest('mute', targetFields),
        notificationId: digest('notification', [
          ['ownerId', value.ownerId],
          ['operationKey', digest('operation', operationFields)],
        ]),
      });
    },
  });
}

function readLimit(value: number | undefined, maximum: number): number {
  const limit = value ?? maximum;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new TypeError(`channel-access limit must be an integer from 1 to ${maximum}`);
  }
  return limit;
}

function assertInput(input: ChannelAccessDerivationInput): void {
  const textFields = [
    input.requester,
    input.sessionFingerprint,
    input.origin,
    input.operationId,
    input.ownerId,
    input.targetFingerprint,
  ];
  if (textFields.some(value => typeof value !== 'string' || value.length === 0)) {
    throw new TypeError('channel-access derivation fields must be non-empty');
  }
  if (!Number.isSafeInteger(input.sessionGeneration) || input.sessionGeneration < 0) {
    throw new TypeError('channel-access session generation must be non-negative');
  }
  if (input.kind !== 'access' && input.kind !== 'create') {
    throw new TypeError('channel-access kind is unsupported');
  }
}
