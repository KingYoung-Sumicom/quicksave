// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import webpush from 'web-push';
import { PushService } from './pushService.js';

const subscription = {
  endpoint: 'https://push.example/abc',
  keys: { p256dh: 'p', auth: 'a' },
};

const payload = { title: 't', body: 'b', sessionId: 's1' };

function makeService() {
  return new PushService({
    vapidPublicKey: 'BPub',
    vapidPrivateKey: 'PrivKey',
    vapidSubject: 'mailto:ops@example.com',
  });
}

function webPushError(status: number, body?: string): Error {
  const e: Error & { statusCode?: number; body?: string } = new Error('Received unexpected response code');
  e.statusCode = status;
  if (body !== undefined) e.body = body;
  return e;
}

describe('PushService.send', () => {
  let sendSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendSpy = vi.fn();
    vi.spyOn(webpush, 'setVapidDetails').mockImplementation(() => {});
    vi.spyOn(webpush, 'sendNotification').mockImplementation(sendSpy as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ok:true on success', async () => {
    sendSpy.mockResolvedValueOnce({ statusCode: 201 } as never);
    const out = await makeService().send(subscription, payload);
    expect(out.ok).toBe(true);
    expect(out.statusCode).toBe(201);
    expect(out.gone).toBeUndefined();
    expect(out.reason).toBeUndefined();
  });

  it.each([404, 410])('always marks status %d as gone (RFC 8030 mandates prune)', async (status) => {
    sendSpy.mockRejectedValueOnce(webPushError(status));
    const out = await makeService().send(subscription, payload);
    expect(out.ok).toBe(false);
    expect(out.statusCode).toBe(status);
    expect(out.gone).toBe(true);
  });

  it.each([
    'BadSubscription',
    'ExpiredSubscription',
    'NotRegistered',
    'InvalidRegistration',
    'UnauthorizedRegistration',
    'MismatchSenderId',
  ])('marks 400 with per-subscription reason %s as gone', async (reason) => {
    sendSpy.mockRejectedValueOnce(webPushError(400, JSON.stringify({ reason })));
    const out = await makeService().send(subscription, payload);
    expect(out.gone).toBe(true);
    expect(out.reason).toBe(reason);
    expect(out.error).toContain(`reason=${reason}`);
  });

  it('marks 403 with per-subscription reason as gone (e.g. FCM MismatchSenderId)', async () => {
    sendSpy.mockRejectedValueOnce(webPushError(403, JSON.stringify({ reason: 'MismatchSenderId' })));
    const out = await makeService().send(subscription, payload);
    expect(out.gone).toBe(true);
    expect(out.reason).toBe('MismatchSenderId');
  });

  it('does NOT mark 403 BadJwtToken as gone — that is a server-side VAPID config issue', async () => {
    sendSpy.mockRejectedValueOnce(webPushError(403, JSON.stringify({ reason: 'BadJwtToken' })));
    const out = await makeService().send(subscription, payload);
    expect(out.ok).toBe(false);
    expect(out.gone).toBe(false);
    expect(out.reason).toBe('BadJwtToken');
    // Operators need the reason in the log to diagnose the config drift.
    expect(out.error).toContain('reason=BadJwtToken');
  });

  it('does NOT mark 400 with unknown/ambiguous reason as gone — keeps the subscription', async () => {
    sendSpy.mockRejectedValueOnce(webPushError(400, JSON.stringify({ reason: 'BadMessageId' })));
    const out = await makeService().send(subscription, payload);
    expect(out.gone).toBe(false);
    expect(out.reason).toBe('BadMessageId');
  });

  it('falls back to a plain-string body as reason when response is not JSON', async () => {
    // Some services respond with a bare identifier, e.g. `UnauthorizedRegistration`.
    sendSpy.mockRejectedValueOnce(webPushError(400, 'UnauthorizedRegistration'));
    const out = await makeService().send(subscription, payload);
    expect(out.reason).toBe('UnauthorizedRegistration');
    expect(out.gone).toBe(true);
  });

  it('preserves raw body in the error string when no reason can be parsed', async () => {
    sendSpy.mockRejectedValueOnce(webPushError(400, '<html>gateway timeout</html>'));
    const out = await makeService().send(subscription, payload);
    expect(out.gone).toBe(false);
    expect(out.reason).toBeUndefined();
    expect(out.error).toContain('body=<html>gateway timeout</html>');
  });

  it.each([413, 429, 500, 503])('does not prune on transient status %d', async (status) => {
    sendSpy.mockRejectedValueOnce(webPushError(status));
    const out = await makeService().send(subscription, payload);
    expect(out.ok).toBe(false);
    expect(out.gone).toBe(false);
  });

  it('handles non-HTTP errors without a statusCode', async () => {
    sendSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const out = await makeService().send(subscription, payload);
    expect(out.ok).toBe(false);
    expect(out.statusCode).toBeUndefined();
    expect(out.gone).toBe(false);
    expect(out.error).toContain('ECONNREFUSED');
  });
});
