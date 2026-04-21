import webpush, { type PushSubscription, type SendResult } from 'web-push';

export interface PushServiceConfig {
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidSubject: string;
}

export interface NotifyPayload {
  title: string;
  body: string;
  sessionId: string;
  agentId?: string;
  /** Optional deep-link path within the PWA. Defaults to `/` (home / ticket list). */
  url?: string;
  tag?: string;
}

export interface NotifyOutcome {
  endpoint: string;
  ok: boolean;
  statusCode?: number;
  /**
   * True when the push service says this *specific subscription* is permanently
   * unusable — caller should drop it. Covers:
   *   - 404/410 (RFC 8030: subscription was unregistered)
   *   - 400/403 whose JSON body `reason` is a known per-subscription fatal
   *     code (e.g. `BadSubscription`, `NotRegistered`).
   *
   * Intentionally NOT set for ambiguous 400/403 (e.g. `BadJwtToken`,
   * `InternalServerError`) because those usually indicate a server-side
   * config problem that would otherwise wipe the whole subscription fleet.
   */
  gone?: boolean;
  /** Short machine-readable reason extracted from the response body, if any. */
  reason?: string;
  error?: string;
}

/**
 * Reasons that mean "this subscription is dead, retrying will never succeed".
 * Apple (`web.push.apple.com`) and FCM/Google/Mozilla push services all
 * report them in the JSON response body under `"reason"` or `"error"`.
 *
 * Sources:
 *   - Apple APNs/web-push: BadSubscription, ExpiredProviderToken (on sub).
 *   - FCM: NotRegistered, InvalidRegistration, UnauthorizedRegistration,
 *     MismatchSenderId (sub was created under a different VAPID pubkey —
 *     applicationServerKey won't ever match after a rotation).
 *   - Generic web-push: `UnauthorizedRegistration` aka "push service rejected
 *     VAPID for this endpoint".
 */
const SUBSCRIPTION_FATAL_REASONS = new Set<string>([
  'BadSubscription',
  'ExpiredSubscription',
  'NotRegistered',
  'InvalidRegistration',
  'UnauthorizedRegistration',
  'MismatchSenderId',
]);

function extractReason(body: unknown): string | undefined {
  if (typeof body !== 'string' || body.length === 0) return undefined;
  // Apple/FCM return a tiny JSON object; don't trust it blindly though.
  try {
    const parsed = JSON.parse(body) as { reason?: unknown; error?: unknown };
    if (typeof parsed.reason === 'string') return parsed.reason;
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    // Not JSON — fall through; some services return a plain string like
    // `UnauthorizedRegistration`. Use it directly if it's short.
    if (body.length <= 64 && /^[A-Za-z]+$/.test(body.trim())) return body.trim();
  }
  return undefined;
}

/**
 * Thin wrapper around web-push. The relay owns this; agent-side code never
 * touches VAPID keys. Errors are normalised so callers can prune dead
 * subscriptions without interpreting node errors by hand.
 */
export class PushService {
  constructor(config: PushServiceConfig) {
    webpush.setVapidDetails(
      config.vapidSubject,
      config.vapidPublicKey,
      config.vapidPrivateKey,
    );
  }

  async send(subscription: PushSubscription, payload: NotifyPayload): Promise<NotifyOutcome> {
    try {
      const result = await webpush.sendNotification(
        subscription,
        JSON.stringify(payload),
      ) as SendResult;
      return {
        endpoint: subscription.endpoint,
        ok: true,
        statusCode: result.statusCode,
      };
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      // `web-push`'s generic `.message` is always "Received unexpected
      // response code" — the real detail is on `.body`, which Apple/FCM use
      // to report the failure reason as JSON.
      const rawBody = (err as { body?: unknown }).body;
      const reason = extractReason(rawBody);

      const specMandatedGone = status === 404 || status === 410;
      const reasonFatal = reason !== undefined && SUBSCRIPTION_FATAL_REASONS.has(reason);
      const gone = specMandatedGone || reasonFatal;

      const baseMsg = err instanceof Error ? err.message : String(err);
      const reasonTag = reason ? ` reason=${reason}` : '';
      const bodyTag = !reason && typeof rawBody === 'string' && rawBody.length > 0
        ? ` body=${rawBody.slice(0, 200)}` : '';

      return {
        endpoint: subscription.endpoint,
        ok: false,
        statusCode: status,
        gone,
        reason,
        error: `${baseMsg}${reasonTag}${bodyTag}`,
      };
    }
  }
}
