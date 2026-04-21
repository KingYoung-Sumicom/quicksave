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
  /** True when the push service says the subscription is permanently gone (404/410). */
  gone?: boolean;
  error?: string;
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
      const gone = status === 404 || status === 410;
      return {
        endpoint: subscription.endpoint,
        ok: false,
        statusCode: status,
        gone,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
