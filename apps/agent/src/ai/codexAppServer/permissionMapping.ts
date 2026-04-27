import type { CodexPermissionPreset, PermissionLevel } from '../provider.js';
import { normalizePermissionLevelForAgent } from '../provider.js';

import type { ApprovalsReviewer } from './schema/generated/v2/ApprovalsReviewer.js';
import type { AskForApproval } from './schema/generated/v2/AskForApproval.js';
import type { SandboxPolicy } from './schema/generated/v2/SandboxPolicy.js';

/**
 * Codex's user-facing permission presets, mapped onto the v2
 * fields we send via `turn/start` overrides.
 *
 * v2 has two orthogonal axes:
 * - `approvalPolicy`: when does Codex prompt the client to approve
 *   an action? `"untrusted" | "on-failure" | "on-request" | "never"`
 *   (plus an experimental `granular` variant we don't expose yet).
 * - `sandboxPolicy`: what filesystem / network access does the
 *   sandbox grant? `readOnly | workspaceWrite | dangerFullAccess`
 *   (or `externalSandbox` for OS-level sandboxes — not used here).
 *
 * Adjust this matrix when product wants new presets — keep all
 * Codex-specific permission semantics in this one file.
 */
export interface CodexPermissionMapping {
  approvalPolicy: AskForApproval;
  sandboxPolicy: SandboxPolicy;
  approvalsReviewer: ApprovalsReviewer;
}

export function mapCodexPermissionPreset(
  preset: CodexPermissionPreset,
  opts: { sandboxed: boolean; cwd?: string },
): CodexPermissionMapping {
  const writableRoots = opts.cwd ? [opts.cwd] : [];
  const fullAccess: SandboxPolicy = { type: 'dangerFullAccess' };
  const readOnly: SandboxPolicy = {
    type: 'readOnly',
    access: { type: 'fullAccess' },
    networkAccess: false,
  };
  const workspaceWrite: SandboxPolicy = {
    type: 'workspaceWrite',
    writableRoots,
    readOnlyAccess: { type: 'fullAccess' },
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };

  switch (preset) {
    case 'full-access':
      return {
        approvalPolicy: 'never',
        sandboxPolicy: fullAccess,
        approvalsReviewer: 'user',
      };
    case 'read-only':
      return {
        approvalPolicy: 'on-request',
        sandboxPolicy: readOnly,
        approvalsReviewer: 'user',
      };
    case 'auto-review':
      return {
        approvalPolicy: 'on-request',
        sandboxPolicy: opts.sandboxed ? workspaceWrite : fullAccess,
        approvalsReviewer: 'auto_review',
      };
    case 'default':
    default:
      // Standard: ask on every privileged action.
      return {
        approvalPolicy: 'on-request',
        sandboxPolicy: opts.sandboxed ? workspaceWrite : fullAccess,
        approvalsReviewer: 'user',
      };
  }
}

export function mapPermissionLevelToCodex(
  level: PermissionLevel,
  opts: { sandboxed: boolean; cwd?: string },
): CodexPermissionMapping {
  return mapCodexPermissionPreset(
    normalizePermissionLevelForAgent('codex', level) as CodexPermissionPreset,
    opts,
  );
}

/**
 * Convert the legacy single-axis permission level into the
 * runtime-mutable subset used by `OverrideStore`. Used by SessionManager
 * when `setPermissionLevel` is called — drives the next `turn/start`'s
 * `approvalPolicy` / `sandboxPolicy` overrides.
 */
export function permissionLevelToOverrides(
  level: PermissionLevel,
  opts: { sandboxed: boolean; cwd?: string },
): {
  approvalPolicy: AskForApproval;
  sandboxPolicy: SandboxPolicy;
  approvalsReviewer: ApprovalsReviewer;
} {
  const m = mapPermissionLevelToCodex(level, opts);
  return {
    approvalPolicy: m.approvalPolicy,
    sandboxPolicy: m.sandboxPolicy,
    approvalsReviewer: m.approvalsReviewer,
  };
}
