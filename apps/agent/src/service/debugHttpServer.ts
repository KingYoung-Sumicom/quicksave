/**
 * Local-only HTTP debug server for inspecting card builder and pipeline state.
 * Gated by QUICKSAVE_DEBUG=1 (or dev mode).
 *
 * Endpoints:
 *   GET /                     — HTML overview page
 *   GET /sessions             — list active sessions with metadata
 *   GET /sessions/:id/cards   — live card builder cards for a session
 *   GET /sessions/:id/state   — full session + card builder internal state
 *   GET /debug                — full daemon debug snapshot
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import type { SessionManager } from '../ai/sessionManager.js';

const DEFAULT_PORT = 7927;

export class DebugHttpServer {
  private server: Server | null = null;
  private sessionManager: SessionManager;

  constructor(sessionManager: SessionManager) {
    this.sessionManager = sessionManager;
  }

  async start(port = DEFAULT_PORT): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => this.handleRequest(req, res));

      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          // Try next port
          server.listen(port + 1, '127.0.0.1');
        } else {
          reject(err);
        }
      });

      server.listen(port, '127.0.0.1', () => {
        this.server = server;
        const addr = server.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : port;
        console.log(`Debug HTTP server listening on http://127.0.0.1:${actualPort}`);
        resolve(actualPort);
      });
    });
  }

  async close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;

    // CORS for local dev tools
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');

    try {
      if (path === '/' || path === '/index.html') {
        this.serveOverview(res);
      } else if (path === '/sessions') {
        this.serveSessions(res);
      } else if (path === '/debug') {
        this.serveDebug(res);
      } else {
        // /sessions/:id/cards or /sessions/:id/state
        const match = path.match(/^\/sessions\/([^/]+)\/(cards|state)$/);
        if (match) {
          const [, sessionId, endpoint] = match;
          if (endpoint === 'cards') {
            this.serveSessionCards(res, sessionId);
          } else {
            this.serveSessionState(res, sessionId);
          }
        } else {
          this.json(res, 404, { error: 'Not found' });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      this.json(res, 500, { error: message });
    }
  }

  private serveSessions(res: ServerResponse): void {
    const sessions = this.sessionManager.getActiveSessions();
    const enriched = sessions.map((s) => {
      const cb = this.sessionManager.getCardBuilder(s.sessionId);
      return {
        ...s,
        cardCount: cb ? cb.getCards().length : 0,
        jsonlCutoff: cb?.jsonlCutoff ?? null,
      };
    });
    this.json(res, 200, { sessions: enriched });
  }

  private serveSessionCards(res: ServerResponse, sessionId: string): void {
    const cb = this.sessionManager.getCardBuilder(sessionId);
    if (!cb) {
      this.json(res, 404, { error: `No active card builder for session ${sessionId}` });
      return;
    }
    this.json(res, 200, { sessionId, cards: cb.getCards() });
  }

  private serveSessionState(res: ServerResponse, sessionId: string): void {
    const sessions = this.sessionManager.getActiveSessions();
    const session = sessions.find((s) => s.sessionId === sessionId || s.sessionId.startsWith(sessionId));
    if (!session) {
      this.json(res, 404, { error: `Session ${sessionId} not found` });
      return;
    }
    const cb = this.sessionManager.getCardBuilder(session.sessionId);
    this.json(res, 200, {
      session,
      cardBuilder: cb ? {
        cards: cb.getCards(),
        jsonlCutoff: cb.jsonlCutoff,
      } : null,
    });
  }

  private serveDebug(res: ServerResponse): void {
    const debugState = this.sessionManager.getDebugState();
    this.json(res, 200, debugState);
  }

  private serveOverview(res: ServerResponse): void {
    const sessions = this.sessionManager.getActiveSessions();
    const sessionRows = sessions.map((s) => {
      const cb = this.sessionManager.getCardBuilder(s.sessionId);
      const cardCount = cb ? cb.getCards().length : 0;
      return `<tr>
        <td><a href="/sessions/${s.sessionId}/cards">${s.sessionId.slice(0, 12)}...</a></td>
        <td>${s.cwd}</td>
        <td>${s.isStreaming ? '🟢 streaming' : '⚪ idle'}</td>
        <td>${cardCount}</td>
        <td><a href="/sessions/${s.sessionId}/state">state</a></td>
      </tr>`;
    }).join('\n');

    const html = `<!DOCTYPE html>
<html>
<head>
  <title>Quicksave Debug</title>
  <meta charset="utf-8">
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; margin: 2rem; background: #0d1117; color: #c9d1d9; }
    h1 { color: #58a6ff; }
    table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
    th, td { border: 1px solid #30363d; padding: 0.5rem 1rem; text-align: left; }
    th { background: #161b22; color: #58a6ff; }
    tr:hover { background: #161b22; }
    a { color: #58a6ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .endpoints { margin: 1rem 0; padding: 1rem; background: #161b22; border-radius: 6px; }
    code { background: #1f2937; padding: 0.2rem 0.4rem; border-radius: 4px; font-size: 0.9rem; }
    .auto-refresh { color: #8b949e; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>Quicksave Debug Server</h1>
  <p class="auto-refresh">Auto-refreshes every 2s</p>

  <div class="endpoints">
    <strong>Endpoints:</strong>
    <code><a href="/sessions">/sessions</a></code>
    <code><a href="/debug">/debug</a></code>
  </div>

  <h2>Active Sessions (${sessions.length})</h2>
  ${sessions.length === 0 ? '<p>No active sessions</p>' : `
  <table>
    <thead><tr><th>Session</th><th>CWD</th><th>Status</th><th>Cards</th><th>Details</th></tr></thead>
    <tbody>${sessionRows}</tbody>
  </table>`}

  <script>setTimeout(() => location.reload(), 2000);</script>
</body>
</html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  private json(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data, null, 2));
  }
}
