// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import {
  codexApprovalResponse,
  codexApprovalToPermissionPrompt,
} from '../approvalMapping.js';

describe('Codex app-server approval mapping', () => {
  it('maps legacy execCommandApproval to a Bash permission prompt', () => {
    const prompt = codexApprovalToPermissionPrompt('execCommandApproval', 'req-1', {
      conversationId: 'thr_1',
      callId: 'call_1',
      approvalId: null,
      command: ['git', 'add', '-A'],
      cwd: '/repo',
      reason: 'Need to write .git/index',
      parsedCmd: [],
    });

    expect(prompt).toEqual({
      toolName: 'Bash',
      toolInput: {
        command: 'git add -A',
        argv: ['git', 'add', '-A'],
        cwd: '/repo',
        reason: 'Need to write .git/index',
      },
      toolUseId: 'call_1',
    });
  });

  it('uses v2 command decisions for item command approvals', () => {
    expect(
      codexApprovalResponse(
        'item/commandExecution/requestApproval',
        {},
        { action: 'allow' },
      ),
    ).toEqual({ decision: 'accept' });

    expect(
      codexApprovalResponse(
        'item/commandExecution/requestApproval',
        {},
        { action: 'deny' },
      ),
    ).toEqual({ decision: 'decline' });
  });

  it('uses legacy review decisions for execCommandApproval', () => {
    expect(codexApprovalResponse('execCommandApproval', {}, { action: 'allow' })).toEqual({
      decision: 'approved',
    });
    expect(codexApprovalResponse('execCommandApproval', {}, { action: 'deny' })).toEqual({
      decision: 'denied',
    });
  });

  it('grants the requested subset for permissions approval', () => {
    const params = {
      threadId: 'thr_1',
      turnId: 'turn_1',
      itemId: 'item_1',
      cwd: '/repo',
      reason: 'Need .git writes',
      permissions: {
        network: null,
        fileSystem: {
          read: null,
          write: ['/repo/.git'],
        },
      },
    };

    expect(codexApprovalResponse('item/permissions/requestApproval', params, { action: 'allow' })).toEqual({
      scope: 'session',
      permissions: {
        fileSystem: {
          read: null,
          write: ['/repo/.git'],
        },
      },
    });
  });
});
