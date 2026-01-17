import { WebSocket } from 'ws';

interface ParsedUrl {
  role: 'agent' | 'pwa';
  agentId: string;
}

interface SignalingMessage {
  type: string;
  payload?: unknown;
}

/**
 * Parse WebSocket connection URL
 * Expected format: /agent/{agentId} or /pwa/{agentId}
 */
export function parseUrl(url: string): ParsedUrl | null {
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
    agentId,
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
