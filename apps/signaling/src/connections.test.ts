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
