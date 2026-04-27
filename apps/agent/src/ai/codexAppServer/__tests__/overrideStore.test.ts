import { describe, expect, it } from 'vitest';

import { RuntimeOverrideStore } from '../overrideStore.js';

describe('RuntimeOverrideStore.enqueue + drain', () => {
  it('drains queued patches', () => {
    const s = new RuntimeOverrideStore();
    s.enqueue({ model: 'gpt-5.4' });
    s.enqueue({ effort: 'high' });
    expect(s.drain()).toEqual({ model: 'gpt-5.4', effort: 'high' });
  });

  it('drain does not commit by itself — second drain returns same', () => {
    const s = new RuntimeOverrideStore();
    s.enqueue({ model: 'gpt-5.4' });
    expect(s.drain()).toEqual({ model: 'gpt-5.4' });
    expect(s.drain()).toEqual({ model: 'gpt-5.4' });
  });

  it('commit promotes pending → effective; second drain returns empty', () => {
    const s = new RuntimeOverrideStore();
    s.enqueue({ model: 'gpt-5.4' });
    s.drain();
    s.commit();
    s.enqueue({ model: 'gpt-5.4' }); // same value
    expect(s.drain()).toEqual({}); // no-op override is filtered
  });

  it('commit + new enqueue with new value drains the new value', () => {
    const s = new RuntimeOverrideStore();
    s.enqueue({ model: 'gpt-5.4' });
    s.drain();
    s.commit();
    s.enqueue({ model: 'gpt-5.5' });
    expect(s.drain()).toEqual({ model: 'gpt-5.5' });
  });

  it('multiple enqueues for the same key — last write wins', () => {
    const s = new RuntimeOverrideStore();
    s.enqueue({ effort: 'low' });
    s.enqueue({ effort: 'high' });
    s.enqueue({ effort: 'medium' });
    expect(s.drain()).toEqual({ effort: 'medium' });
  });

  it('enqueue null is treated as explicit clear', () => {
    const s = new RuntimeOverrideStore();
    s.reseedFromServer({ model: 'gpt-5.4' });
    s.enqueue({ model: null });
    expect(s.drain()).toEqual({ model: null });
  });

  it('drain filters out fields equal to serverEffective (no-op overrides)', () => {
    const s = new RuntimeOverrideStore();
    s.reseedFromServer({ model: 'gpt-5.4', effort: 'medium' });
    s.enqueue({ model: 'gpt-5.4', effort: 'high' });
    expect(s.drain()).toEqual({ effort: 'high' });
  });

  it('reseedFromServer wipes pending — server is the new truth', () => {
    const s = new RuntimeOverrideStore();
    s.enqueue({ model: 'gpt-5.5' });
    s.reseedFromServer({ model: 'gpt-5.4' });
    expect(s.drain()).toEqual({});
    expect(s.pendingSnapshot()).toEqual({});
  });

  it('hasPending reflects whether anything was enqueued since last commit', () => {
    const s = new RuntimeOverrideStore();
    expect(s.hasPending()).toBe(false);
    s.enqueue({ model: 'x' });
    expect(s.hasPending()).toBe(true);
    s.drain();
    expect(s.hasPending()).toBe(true); // drain doesn't clear pending
    s.commit();
    expect(s.hasPending()).toBe(false);
  });
});

describe('RuntimeOverrideStore — sandboxPolicy structural diff', () => {
  it('treats deeply-equal SandboxPolicy as equal (no-op)', () => {
    const s = new RuntimeOverrideStore();
    s.reseedFromServer({
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
    s.enqueue({ sandboxPolicy: { type: 'dangerFullAccess' } });
    expect(s.drain()).toEqual({});
  });

  it('treats different SandboxPolicy variant as a real change', () => {
    const s = new RuntimeOverrideStore();
    s.reseedFromServer({
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
    s.enqueue({
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: ['/tmp'],
        readOnlyAccess: { type: 'fullAccess' },
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });
    const drained = s.drain();
    expect(drained.sandboxPolicy?.type).toBe('workspaceWrite');
  });
});
