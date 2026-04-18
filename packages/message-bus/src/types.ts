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
};

export type UpdateFrame = {
  kind: 'upd';
  path: string;
  data: unknown;
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

/** Extract `:param` names from a path pattern as a union of string literals. */
export type PathParams<P extends string> =
  P extends `${string}:${infer Param}/${infer Rest}`
    ? { [K in Param | keyof PathParams<`/${Rest}`>]: string }
    : P extends `${string}:${infer Param}`
      ? { [K in Param]: string }
      : Record<string, never>;
