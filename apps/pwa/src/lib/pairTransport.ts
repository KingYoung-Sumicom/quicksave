import type { PairTransport } from './pairClient';
import { HttpPairTransport } from './httpPairTransport';
import { useConnectionStore } from '../stores/connectionStore';

/**
 * Returns a live `PairTransport` wired to the configured signaling server.
 * Each call returns a fresh instance; state lives server-side so there's no
 * reason to memoize.
 */
export function getDefaultPairTransport(): PairTransport {
  const signalingServer = useConnectionStore.getState().signalingServer;
  return new HttpPairTransport(signalingServer);
}
