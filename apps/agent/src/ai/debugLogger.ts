import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const DEBUG_DIR = join(homedir(), '.quicksave', 'debug');

/**
 * Per-session debug logger that writes JSONL files under ~/.quicksave/debug/.
 * Only active when QUICKSAVE_DEBUG=1.
 *
 * Files per session:
 *  - <sessionId>-raw.jsonl      — every raw message from the CLI process
 *  - <sessionId>-cards.jsonl    — every CardEvent pushed to the PWA
 *  - <sessionId>-snapshots.jsonl — card builder state snapshots (on clearCards)
 */
export class DebugLogger {
  private static enabled = process.env.QUICKSAVE_DEBUG === '1';
  private static dirReady = false;

  private sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  updateSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /** Log a raw message received from the CLI stdout. */
  async logRawEvent(msg: unknown): Promise<void> {
    await this.append('raw', msg);
  }

  /** Log a CardEvent being emitted to the PWA. */
  async logCardEvent(event: unknown): Promise<void> {
    await this.append('cards', event);
  }

  /** Log a card builder snapshot (all cards at time of clear). */
  async logCardBuilderSnapshot(cards: unknown[]): Promise<void> {
    await this.append('snapshots', { timestamp: Date.now(), cards });
  }

  private async append(suffix: string, data: unknown): Promise<void> {
    if (!DebugLogger.enabled) return;
    try {
      if (!DebugLogger.dirReady) {
        await mkdir(DEBUG_DIR, { recursive: true });
        DebugLogger.dirReady = true;
      }
      const shortId = this.sessionId.length > 12 ? this.sessionId.slice(0, 12) : this.sessionId;
      const filePath = join(DEBUG_DIR, `${shortId}-${suffix}.jsonl`);
      const line = JSON.stringify(data) + '\n';
      await appendFile(filePath, line);
    } catch {
      // Debug logging must never break the main flow
    }
  }
}
