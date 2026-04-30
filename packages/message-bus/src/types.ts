// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Wire frames exchanged between client and server.
 *
 * Commands are one-shot request/response.
 * Subscriptions deliver an initial snapshot followed by updates until unsub.
 */

export type CommandFrame = {
  kind: 'cmd';
  id: string;
  verb: string;
  payload: unknown;
};

export type CommandResultFrame =
  | { kind: 'result'; id: string; ok: true; data: unknown }
  | { kind: 'result'; id: string; ok: false; error: string };

export type SubscribeFrame = {
  kind: 'sub';
  path: string;
};

export type SnapshotFrame = {
  kind: 'snap';
  path: string;
  data: unknown;
  /**
   * Monotonic per-path sequence number. Snapshot carries the seq of the
   * latest publish at the time the snapshot data was captured; clients drop
   * any snapshot whose seq is not newer than the last-applied frame for the
   * same path, preventing a raced snapshot from overwriting a more-recent
   * update. Absent on frames from legacy servers — clients fall back to the
   * pre-seq behavior (apply unconditionally) in that case.
   */
  seq?: number;
};

export type UpdateFrame = {
  kind: 'upd';
  path: string;
  data: unknown;
  /**
   * Monotonic per-path sequence number assigned at publish time. See
   * `SnapshotFrame.seq`. Absent on frames from legacy servers.
   */
  seq?: number;
};

export type SubscribeErrorFrame = {
  kind: 'sub-error';
  path: string;
  error: string;
};

export type UnsubscribeFrame = {
  kind: 'unsub';
  path: string;
};

export type ClientFrame = CommandFrame | SubscribeFrame | UnsubscribeFrame;
export type ServerFrame =
  | CommandResultFrame
  | SnapshotFrame
  | UpdateFrame
  | SubscribeErrorFrame;

export type AnyFrame = ClientFrame | ServerFrame;

/**
 * Reserved command verb for one-shot snapshot retrieval. Clients send
 * `{ path }` and the server invokes the matching subscription handler's
 * `snapshot()` without creating a subscription. Userland `onCommand`
 * handlers cannot re-register this verb.
 */
export const GET_SNAPSHOT_VERB = '$getSnapshot';

/** Extract `:param` names from a path pattern as a union of string literals. */
export type PathParams<P extends string> =
  P extends `${string}:${infer Param}/${infer Rest}`
    ? { [K in Param | keyof PathParams<`/${Rest}`>]: string }
    : P extends `${string}:${infer Param}`
      ? { [K in Param]: string }
      : Record<string, never>;
