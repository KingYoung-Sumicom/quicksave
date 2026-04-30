// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import {
  createMessage,
  type MessageType,
} from '@sumicom/quicksave-shared';
import type { MessageBusServer } from '@sumicom/quicksave-message-bus';
import type { MessageHandler } from './messageHandler.js';

/**
 * Verbs from the legacy `MessageHandler` switch that are exposed as bus
 * commands. The PWA can invoke any of these via
 * `messageBusClient.command(verb, payload)`; the adapter wraps the payload
 * in a `Message` envelope, dispatches through `MessageHandler.handleMessage`,
 * and translates the response back into a bus result frame.
 *
 * **This list is one of three coupled sources** for the request/response
 * surface — see CLAUDE.md "Doc Sync Pointers". Adding a new verb requires
 * touching:
 *   1. `messageHandler.ts` switch (the handler itself)
 *   2. This array (the bus exposure)
 *   3. The relevant docs (`docs/references/quicksave-architecture.en.md`)
 */
export const LEGACY_BUS_VERBS: MessageType[] = [
  'ping',
  // git
  'git:status',
  'git:diff',
  'git:stage',
  'git:unstage',
  'git:stage-patch',
  'git:unstage-patch',
  'git:commit',
  'git:log',
  'git:branches',
  'git:checkout',
  'git:discard',
  'git:untrack',
  'git:submodules',
  'git:config-get',
  'git:config-set',
  'git:gitignore-add',
  'git:gitignore-read',
  'git:gitignore-write',
  // ai
  'ai:generate-commit-summary',
  'ai:commit-summary:clear',
  'ai:set-api-key',
  'ai:get-api-key-status',
  // agent
  'agent:list-repos',
  'agent:switch-repo',
  'agent:browse-directory',
  'agent:add-repo',
  'agent:remove-repo',
  'agent:clone-repo',
  'agent:list-coding-paths',
  'agent:add-coding-path',
  'agent:remove-coding-path',
  'agent:check-update',
  'agent:update',
  'agent:restart',
  // codex
  'codex:list-models',
  'codex:login-start',
  'codex:login-status',
  'codex:login-cancel',
  // claude
  'claude:start',
  'claude:resume',
  'claude:cancel',
  'claude:close',
  'claude:end-task',
  'claude:user-input-response',
  'claude:set-preferences',
  'claude:set-session-permission',
  'claude:get-cards',
  // session
  'session:set-config',
  'session:control-request',
  'session:update-history',
  'session:delete-history',
  'session:list-archived',
  // project
  'project:list-summaries',
  'project:list-repos',
  'project:delete',
  // push
  'push:subscription-offer',
  // terminal
  'terminal:create',
  'terminal:input',
  'terminal:resize',
  'terminal:close',
  'terminal:rename',
  // files
  'files:list',
  'files:read',
];

/**
 * Bridge legacy `MessageHandler` request/response verbs onto a
 * `MessageBusServer`. Each verb in `verbs` is registered as a bus command
 * whose payload is dispatched through `handler.handleMessage`.
 *
 * Two adapter rules of the wire protocol live here:
 * - **`__repoPath` smuggling**: the bus protocol has no envelope-level
 *   metadata, so `git:*` callers tuck `__repoPath` into the payload. The
 *   adapter lifts it onto `msg.repoPath` before dispatch and strips it
 *   from the payload, then mirrors the server's stamped `repoPath` back
 *   into `git:*` responses so the PWA can scope-check.
 * - **Error encoding**: structured errors (e.g. `REPO_MISMATCH`) are
 *   returned as `"CODE: message"` strings on the rejected promise so
 *   callers can `String#startsWith` to detect specific codes.
 */
export function wireLegacyBusVerbs(
  bus: MessageBusServer,
  handler: MessageHandler,
  verbs: readonly MessageType[] = LEGACY_BUS_VERBS,
): void {
  for (const verb of verbs) {
    bus.onCommand(verb, async (rawPayload: unknown, { peer }) => {
      let repoPath: string | undefined;
      let payload: unknown = rawPayload;
      if (payload && typeof payload === 'object' && '__repoPath' in payload) {
        const obj = payload as Record<string, unknown>;
        if (typeof obj.__repoPath === 'string') repoPath = obj.__repoPath;
        const { __repoPath: _omit, ...rest } = obj;
        void _omit;
        payload = rest;
      }
      const msg = createMessage(verb, payload);
      if (repoPath !== undefined) msg.repoPath = repoPath;
      const response = await handler.handleMessage(msg, peer);
      if (response.type === 'error') {
        const err = response.payload as { code?: string; message?: string };
        const code = err.code ?? '';
        const text = err.message ?? 'Handler error';
        throw new Error(code ? `${code}: ${text}` : text);
      }
      if (verb.startsWith('git:') && typeof response.repoPath === 'string') {
        return { ...(response.payload as object), __repoPath: response.repoPath };
      }
      return response.payload;
    });
  }
}
