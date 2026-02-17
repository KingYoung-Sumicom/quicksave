import { WebSocket } from 'ws';

export interface ParsedUrl {
  role: 'agent' | 'pwa';
  id: string; // agentId for agents, publicKey for new-style PWAs
  isPwaKey?: boolean; // true if connected as /pwa/key/{publicKey}
}

interface SignalingMessage {
  type: string;
  payload?: unknown;
}

/**
 * Parse WebSocket connection URL
 * Expected formats:
 *   /agent/{agentId}        - Agent connection (legacy)
 *   /pwa/{agentId}          - PWA connection (legacy)
 *   /pwa/key/{publicKey}    - PWA connection by public key (new)
 */
export function parseUrl(url: string): ParsedUrl | null {
  // Try new /pwa/key/{publicKey} format first
  // publicKey is URL-encoded; raw base64 chars (+, /, =) become %XX
  const keyMatch = url.match(/^\/pwa\/key\/([a-zA-Z0-9_\-%.]+)$/);
  if (keyMatch) {
    const publicKey = decodeURIComponent(keyMatch[1]);
    if (publicKey.length < 8 || publicKey.length > 512) {
      return null;
    }
    return {
      role: 'pwa',
      id: publicKey,
      isPwaKey: true,
    };
  }

  // Legacy /agent/{id} or /pwa/{id} format
  const match = url.match(/^\/(agent|pwa)\/([a-zA-Z0-9_-]+)$/);
  if (!match) {
    return null;
  }

  const [, role, agentId] = match;

  // Validate agent ID length (should be reasonable)
  if (agentId.length < 8 || agentId.length > 64) {
    return null;
  }

  return {
    role: role as 'agent' | 'pwa',
    id: agentId,
  };
}

/**
 * Send a JSON message to a WebSocket
 */
export function sendMessage(ws: WebSocket, message: SignalingMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}
