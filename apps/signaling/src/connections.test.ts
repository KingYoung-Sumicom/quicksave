import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConnectionManager } from './connections.js';
import { WebSocket } from 'ws';

// Create a mock WebSocket
function createMockWs(): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
  } as unknown as WebSocket;
}

describe('ConnectionManager', () => {
  let manager: ConnectionManager;

  beforeEach(() => {
    manager = new ConnectionManager();
  });

  describe('agent management', () => {
    it('should add and retrieve agent', () => {
      const ws = createMockWs();
      manager.addAgent('agent-1', ws);

      expect(manager.hasAgent('agent-1')).toBe(true);
      expect(manager.getAgent('agent-1')).toBe(ws);
    });

    it('should track agent count', () => {
      expect(manager.agentCount).toBe(0);

      manager.addAgent('agent-1', createMockWs());
      expect(manager.agentCount).toBe(1);

      manager.addAgent('agent-2', createMockWs());
      expect(manager.agentCount).toBe(2);
    });

    it('should remove agent', () => {
      manager.addAgent('agent-1', createMockWs());
      expect(manager.hasAgent('agent-1')).toBe(true);

      manager.removeAgent('agent-1');
      expect(manager.hasAgent('agent-1')).toBe(false);
      expect(manager.getAgent('agent-1')).toBeUndefined();
    });

    it('should return false for non-existent agent', () => {
      expect(manager.hasAgent('nonexistent')).toBe(false);
      expect(manager.getAgent('nonexistent')).toBeUndefined();
    });
  });

  describe('pwa management', () => {
    it('should add and retrieve pwa', () => {
      const ws = createMockWs();
      manager.addPwa('agent-1', ws);

      expect(manager.hasPwa('agent-1')).toBe(true);
      expect(manager.getPwa('agent-1')).toBe(ws);
    });

    it('should track pwa count', () => {
      expect(manager.pwaCount).toBe(0);

      manager.addPwa('agent-1', createMockWs());
      expect(manager.pwaCount).toBe(1);

      manager.addPwa('agent-2', createMockWs());
      expect(manager.pwaCount).toBe(2);
    });

    it('should remove pwa', () => {
      manager.addPwa('agent-1', createMockWs());
      expect(manager.hasPwa('agent-1')).toBe(true);

      manager.removePwa('agent-1');
      expect(manager.hasPwa('agent-1')).toBe(false);
    });
  });

  describe('pwa by key management', () => {
    it('should add and retrieve pwa by key', () => {
      const ws = createMockWs();
      manager.addPwaByKey('publicKey123', ws);

      expect(manager.getPwaByKey('publicKey123')).toBe(ws);
    });

    it('should track pwa by key in pwaCount', () => {
      expect(manager.pwaCount).toBe(0);

      manager.addPwaByKey('key1', createMockWs());
      expect(manager.pwaCount).toBe(1);

      manager.addPwaByKey('key2', createMockWs());
      expect(manager.pwaCount).toBe(2);
    });

    it('should combine legacy pwas and pwasByKey in pwaCount', () => {
      manager.addPwa('agent-1', createMockWs());
      manager.addPwaByKey('key1', createMockWs());

      expect(manager.pwaCount).toBe(2);
    });

    it('should remove pwa by key', () => {
      manager.addPwaByKey('key1', createMockWs());
      expect(manager.getPwaByKey('key1')).toBeDefined();

      manager.removePwaByKey('key1');
      expect(manager.getPwaByKey('key1')).toBeUndefined();
    });

    it('should return undefined for non-existent key', () => {
      expect(manager.getPwaByKey('nonexistent')).toBeUndefined();
    });

    it('should track pwasByKey stats', () => {
      manager.addPwaByKey('key1', createMockWs());
      manager.addPwaByKey('key2', createMockWs());

      const stats = manager.getStats();
      expect(stats.activePwasByKey).toBe(2);
      expect(stats.peakPwasByKey).toBe(2);

      manager.removePwaByKey('key1');

      const stats2 = manager.getStats();
      expect(stats2.activePwasByKey).toBe(1);
      expect(stats2.peakPwasByKey).toBe(2);
    });

    it('should track totalConnections for pwasByKey', () => {
      manager.addPwaByKey('key1', createMockWs());
      expect(manager.getStats().totalConnections).toBe(1);

      manager.addPwaByKey('key2', createMockWs());
      expect(manager.getStats().totalConnections).toBe(2);
    });
  });

  describe('getByAddress', () => {
    it('should look up agent by address', () => {
      const ws = createMockWs();
      manager.addAgent('myAgent', ws);

      expect(manager.getByAddress('agent:myAgent')).toBe(ws);
    });

    it('should look up legacy pwa by address', () => {
      const ws = createMockWs();
      manager.addPwa('myAgent', ws);

      expect(manager.getByAddress('pwa:myAgent')).toBe(ws);
    });

    it('should look up pwa by key via address', () => {
      const ws = createMockWs();
      manager.addPwaByKey('myPublicKey', ws);

      expect(manager.getByAddress('pwa:myPublicKey')).toBe(ws);
    });

    it('should prefer pwasByKey over legacy pwas for same id', () => {
      const legacyWs = createMockWs();
      const keyWs = createMockWs();
      manager.addPwa('sameId', legacyWs);
      manager.addPwaByKey('sameId', keyWs);

      expect(manager.getByAddress('pwa:sameId')).toBe(keyWs);
    });

    it('should fall back to legacy pwa if pwasByKey has no match', () => {
      const legacyWs = createMockWs();
      manager.addPwa('legacyId', legacyWs);

      expect(manager.getByAddress('pwa:legacyId')).toBe(legacyWs);
    });

    it('should return undefined for invalid address format', () => {
      expect(manager.getByAddress('invalid')).toBeUndefined();
      expect(manager.getByAddress('')).toBeUndefined();
    });

    it('should return undefined for unknown role', () => {
      expect(manager.getByAddress('unknown:id')).toBeUndefined();
    });

    it('should return undefined for non-existent id', () => {
      expect(manager.getByAddress('agent:nonexistent')).toBeUndefined();
      expect(manager.getByAddress('pwa:nonexistent')).toBeUndefined();
    });

    it('should handle address with colons in the id', () => {
      const ws = createMockWs();
      manager.addPwaByKey('key:with:colons', ws);

      expect(manager.getByAddress('pwa:key:with:colons')).toBe(ws);
    });
  });

  describe('stats tracking', () => {
    it('should track total connections', () => {
      const stats = manager.getStats();
      expect(stats.totalConnections).toBe(0);

      manager.addAgent('agent-1', createMockWs());
      expect(manager.getStats().totalConnections).toBe(1);

      manager.addPwa('agent-1', createMockWs());
      expect(manager.getStats().totalConnections).toBe(2);
    });

    it('should track peak connections', () => {
      manager.addAgent('agent-1', createMockWs());
      manager.addAgent('agent-2', createMockWs());
      manager.addAgent('agent-3', createMockWs());

      expect(manager.getStats().peakAgents).toBe(3);

      manager.removeAgent('agent-1');
      manager.removeAgent('agent-2');

      // Peak should remain at 3 even after removals
      expect(manager.getStats().peakAgents).toBe(3);
      expect(manager.getStats().activeAgents).toBe(1);
    });

    it('should include uptime in stats', () => {
      const stats = manager.getStats();
      expect(stats.uptime).toBeGreaterThanOrEqual(0);
    });

    it('should track active counts separately from peak', () => {
      manager.addPwa('agent-1', createMockWs());
      manager.addPwa('agent-2', createMockWs());

      expect(manager.getStats().activePwas).toBe(2);
      expect(manager.getStats().peakPwas).toBe(2);

      manager.removePwa('agent-1');

      expect(manager.getStats().activePwas).toBe(1);
      expect(manager.getStats().peakPwas).toBe(2);
    });
  });

  describe('agent and pwa pairing', () => {
    it('should allow same agent ID for agent and pwa', () => {
      const agentWs = createMockWs();
      const pwaWs = createMockWs();

      manager.addAgent('shared-id', agentWs);
      manager.addPwa('shared-id', pwaWs);

      expect(manager.getAgent('shared-id')).toBe(agentWs);
      expect(manager.getPwa('shared-id')).toBe(pwaWs);
    });

    it('should handle replacement of existing connection', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      manager.addAgent('agent-1', ws1);
      manager.addAgent('agent-1', ws2);

      expect(manager.getAgent('agent-1')).toBe(ws2);
    });
  });
});
