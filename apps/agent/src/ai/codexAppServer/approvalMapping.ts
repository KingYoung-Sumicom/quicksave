// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { ClaudeUserInputResponsePayload } from '@sumicom/quicksave-shared';

import type { CommandExecutionRequestApprovalParams } from './schema/generated/v2/CommandExecutionRequestApprovalParams.js';
import type { CommandExecutionRequestApprovalResponse } from './schema/generated/v2/CommandExecutionRequestApprovalResponse.js';
import type { FileChangeRequestApprovalResponse } from './schema/generated/v2/FileChangeRequestApprovalResponse.js';
import type { PermissionsRequestApprovalParams } from './schema/generated/v2/PermissionsRequestApprovalParams.js';
import type { PermissionsRequestApprovalResponse } from './schema/generated/v2/PermissionsRequestApprovalResponse.js';
import type { ApplyPatchApprovalParams } from './schema/generated/ApplyPatchApprovalParams.js';
import type { ApplyPatchApprovalResponse } from './schema/generated/ApplyPatchApprovalResponse.js';
import type { ExecCommandApprovalParams } from './schema/generated/ExecCommandApprovalParams.js';
import type { ExecCommandApprovalResponse } from './schema/generated/ExecCommandApprovalResponse.js';

export interface CodexPermissionPrompt {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string;
}

export type CodexApprovalMethod =
  | 'item/commandExecution/requestApproval'
  | 'item/fileChange/requestApproval'
  | 'item/permissions/requestApproval'
  | 'execCommandApproval'
  | 'applyPatchApproval';

export function codexApprovalToPermissionPrompt(
  method: CodexApprovalMethod,
  requestId: string,
  params: unknown,
): CodexPermissionPrompt {
  switch (method) {
    case 'item/commandExecution/requestApproval': {
      const p = params as CommandExecutionRequestApprovalParams;
      return {
        toolName: 'Bash',
        toolInput: {
          command: p.command ?? '',
          cwd: p.cwd ?? '',
          ...(p.reason ? { reason: p.reason } : {}),
          ...(p.additionalPermissions ? { additionalPermissions: p.additionalPermissions } : {}),
        },
        toolUseId: approvalToolUseId(requestId, p.itemId, p.approvalId),
      };
    }
    case 'execCommandApproval': {
      const p = params as ExecCommandApprovalParams;
      return {
        toolName: 'Bash',
        toolInput: {
          command: Array.isArray(p.command) ? p.command.join(' ') : '',
          argv: p.command,
          cwd: p.cwd,
          ...(p.reason ? { reason: p.reason } : {}),
        },
        toolUseId: approvalToolUseId(requestId, p.callId, p.approvalId),
      };
    }
    case 'item/fileChange/requestApproval': {
      const p = params as { itemId?: string; reason?: string | null; grantRoot?: string | null };
      return {
        toolName: 'Edit',
        toolInput: {
          ...(p.reason ? { reason: p.reason } : {}),
          ...(p.grantRoot ? { grantRoot: p.grantRoot } : {}),
        },
        toolUseId: approvalToolUseId(requestId, p.itemId),
      };
    }
    case 'applyPatchApproval': {
      const p = params as ApplyPatchApprovalParams;
      return {
        toolName: 'Edit',
        toolInput: {
          fileChanges: p.fileChanges,
          ...(p.reason ? { reason: p.reason } : {}),
          ...(p.grantRoot ? { grantRoot: p.grantRoot } : {}),
        },
        toolUseId: approvalToolUseId(requestId, p.callId),
      };
    }
    case 'item/permissions/requestApproval': {
      const p = params as PermissionsRequestApprovalParams;
      return {
        toolName: 'Permissions',
        toolInput: {
          cwd: p.cwd,
          permissions: p.permissions,
          ...(p.reason ? { reason: p.reason } : {}),
        },
        toolUseId: approvalToolUseId(requestId, p.itemId),
      };
    }
  }
}

export function codexApprovalResponse(
  method: CodexApprovalMethod,
  params: unknown,
  decision: Pick<ClaudeUserInputResponsePayload, 'action'>,
):
  | CommandExecutionRequestApprovalResponse
  | FileChangeRequestApprovalResponse
  | PermissionsRequestApprovalResponse
  | ExecCommandApprovalResponse
  | ApplyPatchApprovalResponse {
  const allowed = decision.action !== 'deny';
  switch (method) {
    case 'item/commandExecution/requestApproval':
      return { decision: allowed ? 'accept' : 'decline' };
    case 'item/fileChange/requestApproval':
      return { decision: allowed ? 'accept' : 'decline' };
    case 'execCommandApproval':
      return { decision: allowed ? 'approved' : 'denied' };
    case 'applyPatchApproval':
      return { decision: allowed ? 'approved' : 'denied' };
    case 'item/permissions/requestApproval':
      return {
        scope: 'session',
        permissions: allowed ? grantedPermissionsFromRequest(params as PermissionsRequestApprovalParams) : {},
      };
  }
}

function approvalToolUseId(requestId: string, itemId?: string | null, approvalId?: string | null): string {
  return approvalId ?? itemId ?? requestId;
}

function grantedPermissionsFromRequest(params: PermissionsRequestApprovalParams): PermissionsRequestApprovalResponse['permissions'] {
  return {
    ...(params.permissions.network ? { network: params.permissions.network } : {}),
    ...(params.permissions.fileSystem ? { fileSystem: params.permissions.fileSystem } : {}),
  };
}
