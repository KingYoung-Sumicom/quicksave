import { WebSocket } from 'ws';

interface ConnectionStats {
  totalConnections: number;
  activeAgents: number;
  activePwas: number;
  peakAgents: number;
  peakPwas: number;
  messagesRelayed: number;
  startTime: number;
}

export class ConnectionManager {
  private agents: Map<string, WebSocket> = new Map();
  private pwas: Map<string, WebSocket> = new Map();
  private stats: ConnectionStats = {
    totalConnections: 0,
    activeAgents: 0,
    activePwas: 0,
    peakAgents: 0,
    peakPwas: 0,
    messagesRelayed: 0,
    startTime: Date.now(),
  };

  get agentCount(): number {
    return this.agents.size;
  }

  get pwaCount(): number {
    return this.pwas.size;
  }

  hasAgent(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  hasPwa(agentId: string): boolean {
    return this.pwas.has(agentId);
  }

  getAgent(agentId: string): WebSocket | undefined {
    return this.agents.get(agentId);
  }

  getPwa(agentId: string): WebSocket | undefined {
    return this.pwas.get(agentId);
  }

  addAgent(agentId: string, ws: WebSocket): void {
    this.agents.set(agentId, ws);
    this.stats.totalConnections++;
    this.stats.activeAgents = this.agents.size;
    if (this.stats.activeAgents > this.stats.peakAgents) {
      this.stats.peakAgents = this.stats.activeAgents;
    }
  }

  addPwa(agentId: string, ws: WebSocket): void {
    this.pwas.set(agentId, ws);
    this.stats.totalConnections++;
    this.stats.activePwas = this.pwas.size;
    if (this.stats.activePwas > this.stats.peakPwas) {
      this.stats.peakPwas = this.stats.activePwas;
    }
  }

  removeAgent(agentId: string): void {
    this.agents.delete(agentId);
    this.stats.activeAgents = this.agents.size;
  }

  removePwa(agentId: string): void {
    this.pwas.delete(agentId);
    this.stats.activePwas = this.pwas.size;
  }

  incrementMessagesRelayed(): void {
    this.stats.messagesRelayed++;
  }

  getStats(): ConnectionStats & { uptime: number } {
    return {
      ...this.stats,
      uptime: Date.now() - this.stats.startTime,
    };
  }
}
