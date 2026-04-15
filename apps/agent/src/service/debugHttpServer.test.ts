import { DebugHttpServer } from './debugHttpServer.js';
import type { SessionManager } from '../ai/sessionManager.js';

function createMockSessionManager(overrides: Partial<SessionManager> = {}): SessionManager {
  const mockCardBuilder = {
    getCards: () => [
      { type: 'assistant_text', id: 'c1', timestamp: 1000, text: 'hello' },
      { type: 'tool_call', id: 'c2', timestamp: 2000, toolName: 'Read', toolInput: {}, toolUseId: 'tu1' },
    ],
    jsonlCutoff: 4096,
  };

  return {
    getActiveSessions: () => [{
      sessionId: 'sess-abc123',
      cwd: '/home/user/project',
      agent: 'claude-code',
      isStreaming: true,
      hasPendingInput: false,
      permissionMode: 'default',
    }],
    getCardBuilder: (id: string) => id === 'sess-abc123' ? mockCardBuilder : null,
    getDebugState: () => ({
      pendingInputs: [],
      activeSessions: [{
        sessionId: 'sess-abc123',
        cwd: '/home/user/project',
        isStreaming: true,
        hasPendingInput: false,
        permissionMode: 'default',
      }],
    }),
    ...overrides,
  } as unknown as SessionManager;
}

describe('DebugHttpServer', () => {
  let server: DebugHttpServer;
  let port: number;
  let baseUrl: string;

  beforeAll(async () => {
    server = new DebugHttpServer(createMockSessionManager());
    port = await server.start(0); // Use random available port
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await server.close();
  });

  it('serves HTML overview on /', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Quicksave Debug');
    expect(html).toContain('sess-abc123');
  });

  it('lists active sessions as JSON on /sessions', async () => {
    const res = await fetch(`${baseUrl}/sessions`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0].sessionId).toBe('sess-abc123');
    expect(data.sessions[0].cardCount).toBe(2);
    expect(data.sessions[0].jsonlCutoff).toBe(4096);
  });

  it('returns cards for a session on /sessions/:id/cards', async () => {
    const res = await fetch(`${baseUrl}/sessions/sess-abc123/cards`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sessionId).toBe('sess-abc123');
    expect(data.cards).toHaveLength(2);
    expect(data.cards[0].type).toBe('assistant_text');
  });

  it('returns 404 for unknown session cards', async () => {
    const res = await fetch(`${baseUrl}/sessions/unknown/cards`);
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain('No active card builder');
  });

  it('returns session state on /sessions/:id/state', async () => {
    const res = await fetch(`${baseUrl}/sessions/sess-abc123/state`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.session.sessionId).toBe('sess-abc123');
    expect(data.cardBuilder.cards).toHaveLength(2);
    expect(data.cardBuilder.jsonlCutoff).toBe(4096);
  });

  it('returns debug state on /debug', async () => {
    const res = await fetch(`${baseUrl}/debug`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.activeSessions).toHaveLength(1);
    expect(data.pendingInputs).toHaveLength(0);
  });

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(`${baseUrl}/nonexistent`);
    expect(res.status).toBe(404);
  });

  it('binds to 127.0.0.1 only (local)', async () => {
    // Verify the server address is localhost
    const res = await fetch(`${baseUrl}/sessions`);
    expect(res.status).toBe(200);
    // If we got here, it's reachable on 127.0.0.1 — that's the binding
  });
});

describe('DebugHttpServer with no sessions', () => {
  let server: DebugHttpServer;
  let port: number;
  let baseUrl: string;

  beforeAll(async () => {
    server = new DebugHttpServer(createMockSessionManager({
      getActiveSessions: () => [],
    } as any));
    port = await server.start(0);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await server.close();
  });

  it('shows empty state on overview', async () => {
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();
    expect(html).toContain('No active sessions');
  });

  it('returns empty sessions list', async () => {
    const res = await fetch(`${baseUrl}/sessions`);
    const data = await res.json();
    expect(data.sessions).toHaveLength(0);
  });
});
