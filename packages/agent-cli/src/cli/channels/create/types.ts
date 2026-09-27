import type { AccessRequestOutcome } from '@khala/contracts/messaging/index';
import type { AccessRefusalCode, ChannelAccessResult } from '../types.js';

/** A proposed title is untrusted data; the owner alone decides whether a channel is created. */
export type CreateRequestInput = Readonly<{ title: string; operationId: string; origin: string | null }>;
export type CreateStatusInput = Readonly<{ operationId: string; origin: string | null }>;

// Results reuse the access port shape: `status` stays `unknown` so the create
// service decodes it with the closed status decoder, which has no channel field.
export type ChannelCreatePort = Readonly<{
  requestChannelCreate(input: CreateRequestInput, signal?: AbortSignal): Promise<ChannelAccessResult>;
  channelCreateStatus(input: CreateStatusInput, signal?: AbortSignal): Promise<ChannelAccessResult>;
}>;

export type CreateErrorCode = AccessRefusalCode | 'unavailable';
/** `reuse_operation_id` means retry only under the same operation ID; a new ID could create a second request. */
export type CreateNextAction = 'repair_connector' | 'reuse_operation_id';
/**
 * The exact object printed by `khala channels create` / `create-status` and
 * returned by `khala_create_channel` / `khala_channel_create_status`. It never
 * carries a channel ID, binding, grant, or membership: creation is not synchronous.
 */
export type CreateOutput =
  | Readonly<{ ok: true; v: 1; operationId: string; outcome: AccessRequestOutcome; next: CreateNextAction | null }>
  | Readonly<{ ok: false; v: 1; error: CreateErrorCode; operationId: string; next: CreateNextAction | null }>;
