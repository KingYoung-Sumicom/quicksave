// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getGuardianServerState,
  recordGuardianServerResult,
  resetGuardianServerState,
} from './guardianServerState.js';

describe('guardian server state', () => {
  beforeEach(() => {
    resetGuardianServerState();
  });

  it('starts unknown and stays unknown until a review or probe records a result', () => {
    expect(getGuardianServerState()).toEqual({ status: 'unknown' });
    resetGuardianServerState();
    expect(getGuardianServerState()).toEqual({ status: 'unknown' });
  });

  it('records ok results with a timestamp and no error', () => {
    recordGuardianServerResult(true);
    const state = getGuardianServerState();
    expect(state.status).toBe('ok');
    expect(typeof state.lastCheckedAt).toBe('number');
    expect(state.lastError).toBeUndefined();
  });

  it('records failures with the error reason', () => {
    recordGuardianServerResult(false, 'guardian model server 500: boom');
    const state = getGuardianServerState();
    expect(state.status).toBe('failed');
    expect(state.lastError).toBe('guardian model server 500: boom');
    expect(typeof state.lastCheckedAt).toBe('number');
  });

  it('records failures without an error reason', () => {
    recordGuardianServerResult(false);
    expect(getGuardianServerState()).toEqual({ status: 'failed', lastCheckedAt: expect.any(Number) });
  });

  it('the latest result wins', () => {
    recordGuardianServerResult(false, 'first failure');
    recordGuardianServerResult(true);
    expect(getGuardianServerState().status).toBe('ok');
    expect(getGuardianServerState().lastError).toBeUndefined();
    recordGuardianServerResult(false, 'second failure');
    expect(getGuardianServerState().lastError).toBe('second failure');
  });

  it('returns copies so callers cannot mutate the daemon state', () => {
    recordGuardianServerResult(false, 'err');
    const state = getGuardianServerState();
    state.status = 'ok';
    state.lastError = 'mutated';
    expect(getGuardianServerState()).toMatchObject({ status: 'failed', lastError: 'err' });
  });
});
