import { describe, expect, it } from 'vitest';

import { mapPermissionLevelToCodex, permissionLevelToOverrides } from '../permissionMapping.js';

describe('mapPermissionLevelToCodex', () => {
  it('bypassPermissions → never approval, dangerFullAccess sandbox, user reviewer', () => {
    const m = mapPermissionLevelToCodex('bypassPermissions', { sandboxed: true, cwd: '/tmp/x' });
    expect(m.approvalPolicy).toBe('never');
    expect(m.sandboxPolicy.type).toBe('dangerFullAccess');
    expect(m.approvalsReviewer).toBe('user');
  });

  it('plan → on-request approval, readOnly sandbox', () => {
    const m = mapPermissionLevelToCodex('plan', { sandboxed: true, cwd: '/tmp/x' });
    expect(m.approvalPolicy).toBe('on-request');
    expect(m.sandboxPolicy.type).toBe('readOnly');
  });

  it('acceptEdits → on-failure approval, workspaceWrite sandbox when sandboxed', () => {
    const m = mapPermissionLevelToCodex('acceptEdits', { sandboxed: true, cwd: '/tmp/x' });
    expect(m.approvalPolicy).toBe('on-failure');
    expect(m.sandboxPolicy.type).toBe('workspaceWrite');
  });

  it('acceptEdits without sandbox → dangerFullAccess', () => {
    const m = mapPermissionLevelToCodex('acceptEdits', { sandboxed: false, cwd: '/tmp/x' });
    expect(m.sandboxPolicy.type).toBe('dangerFullAccess');
  });

  it('auto → approvalsReviewer = auto_review', () => {
    const m = mapPermissionLevelToCodex('auto', { sandboxed: true, cwd: '/tmp/x' });
    expect(m.approvalsReviewer).toBe('auto_review');
    expect(m.approvalPolicy).toBe('on-request');
  });

  it('default → on-request approval, workspaceWrite when sandboxed', () => {
    const m = mapPermissionLevelToCodex('default', { sandboxed: true, cwd: '/tmp/x' });
    expect(m.approvalPolicy).toBe('on-request');
    expect(m.sandboxPolicy.type).toBe('workspaceWrite');
  });

  it('workspaceWrite carries cwd as a writable root', () => {
    const m = mapPermissionLevelToCodex('default', { sandboxed: true, cwd: '/home/user/proj' });
    if (m.sandboxPolicy.type === 'workspaceWrite') {
      expect(m.sandboxPolicy.writableRoots).toContain('/home/user/proj');
    } else {
      throw new Error('expected workspaceWrite sandbox');
    }
  });

  it('workspaceWrite with no cwd → empty writableRoots (Codex falls back to default)', () => {
    const m = mapPermissionLevelToCodex('default', { sandboxed: true });
    if (m.sandboxPolicy.type === 'workspaceWrite') {
      expect(m.sandboxPolicy.writableRoots).toEqual([]);
    }
  });
});

describe('permissionLevelToOverrides', () => {
  it('returns the v2 fields needed for OverrideStore.enqueue', () => {
    const o = permissionLevelToOverrides('bypassPermissions', { sandboxed: true, cwd: '/tmp' });
    expect(o.approvalPolicy).toBe('never');
    expect(o.sandboxPolicy.type).toBe('dangerFullAccess');
    expect(o.approvalsReviewer).toBe('user');
  });
});
