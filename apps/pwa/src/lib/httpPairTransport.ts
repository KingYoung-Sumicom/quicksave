import type { PairSlot, PairTransport } from './pairClient';

/**
 * HTTP/SSE implementation of `PairTransport`. Talks to the relay's
 * `/pair-requests/{addr}` routes. Drop-in replacement for `MockRelay`.
 */
export class HttpPairTransport implements PairTransport {
  private baseUrl: string;

  constructor(signalingServer: string) {
    this.baseUrl = signalingServer
      .replace(/\/+$/, '')
      .replace('wss://', 'https://')
      .replace('ws://', 'http://');
  }

  async postSlot(
    addr: string,
    slot: { data: string; kind?: string },
  ): Promise<{ id: string }> {
    const res = await fetch(`${this.baseUrl}/pair-requests/${addr}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: slot.data, kind: slot.kind }),
    });
    if (!res.ok) {
      const msg = await safeErrorMessage(res);
      throw new Error(`postSlot failed (${res.status}): ${msg}`);
    }
    const body = (await res.json()) as { id: string };
    return { id: body.id };
  }

  async getSlots(addr: string): Promise<PairSlot[]> {
    const res = await fetch(`${this.baseUrl}/pair-requests/${addr}`);
    if (res.status === 404) return [];
    if (!res.ok) {
      const msg = await safeErrorMessage(res);
      throw new Error(`getSlots failed (${res.status}): ${msg}`);
    }
    const body = (await res.json()) as { slots?: PairSlot[] };
    return body.slots ?? [];
  }

  async deleteMailbox(addr: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/pair-requests/${addr}`, {
      method: 'DELETE',
    });
    // 204 expected; 404 acceptable (already gone)
    if (!res.ok && res.status !== 404) {
      const msg = await safeErrorMessage(res);
      throw new Error(`deleteMailbox failed (${res.status}): ${msg}`);
    }
  }

  subscribeToMailbox(
    addr: string,
    onSlot: (slot: PairSlot) => void,
  ): () => void {
    const url = `${this.baseUrl}/pair-requests/${addr}/subscribe`;
    const es = new EventSource(url);
    es.addEventListener('slot', (ev) => {
      try {
        const slot = JSON.parse((ev as MessageEvent).data) as PairSlot;
        onSlot(slot);
      } catch {
        // ignore malformed events
      }
    });
    // Auto-reconnect is built into EventSource; surface errors via console.
    es.onerror = () => {
      // Non-fatal: EventSource retries automatically. If the server is gone
      // for good, the caller's TTL will eventually fire and cancel the pair.
    };
    return () => {
      es.close();
    };
  }
}

async function safeErrorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (body && typeof body.error === 'string') return body.error;
    return JSON.stringify(body);
  } catch {
    try {
      return await res.text();
    } catch {
      return '(no body)';
    }
  }
}
