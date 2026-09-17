// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
//
// OpenCode Guardian — LLM auto-review of tool calls (Codex `auto_review` style).
//
// When an OpenCode session runs in the `auto-review` permission mode, tool
// calls that reach OpenCode's permission boundary (permission.asked events)
// are NOT auto-approved. They are routed to a reviewer call against a
// user-configured, OpenAI-compatible model server (`getGuardianModelServerConfig`)
// — no session is ever created on the coding-agent provider for this. That
// is a deliberate choice, not just a simplification:
//   • no hidden-session leak — a previous design opened a real OpenCode
//     session per main session and relied on explicit disposal that only
//     ran on daemon shutdown, leaving orphaned sessions in OpenCode's own
//     store whenever a main session ended without a clean daemon restart
//   • provider-agnostic — the same reviewer call works regardless of which
//     coding-agent CLI is driving the main session, since it never touches
//     that provider's session/tool machinery at all
//   • independent reviewer identity — the user can point the reviewer at a
//     different (and ideally stronger) model than whatever is generating
//     the tool calls being reviewed
//
// A configured model server is a prerequisite for `auto-review`, not an
// optional override: with none configured, `auto-review` must be rejected
// by the caller rather than silently falling back to the main session's
// own model.
//
// Verdicts are applied fail-closed: a review timeout, a transport error, or a
// malformed response all result in DENY. After N consecutive denials/failures
// the circuit breaker escalates the next request to the human user instead of
// letting the reviewer keep blocking (see SessionEventRouter).
//
// The reviewer is a "reviewer swap, not a permission grant" (Codex phrasing):
// it only changes WHO decides at an existing approval boundary. It never
// widens what the main agent may do.

import type { OpenCodeServer, OpenCodeV2Message } from './openCodeServer.js';
import { callGuardianModel } from './guardianModelClient.js';
import {
  getOpenCodeGuardianMaxConsecutiveDenials,
  getOpenCodeGuardianTimeoutMs,
  type GuardianModelServerConfig,
} from '../config.js';

/** Legacy title of the hidden guardian review sessions this provider used to
 *  create before the model-server reviewer. Kept so `openCodeProvider.ts`
 *  can keep filtering any that are still orphaned on disk from before this
 *  change out of the user-facing session list. */
export const GUARDIAN_SESSION_TITLE = 'quicksave-guardian';
/** Legacy session.metadata key for the same reason. */
export const GUARDIAN_OWNER_METADATA_KEY = 'quicksaveGuardianOf';

export type GuardianRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type GuardianUserAuthorization = 'unknown' | 'low' | 'medium' | 'high';
export type GuardianOutcome = 'allow' | 'deny';

export interface GuardianAssessment {
  riskLevel: GuardianRiskLevel;
  userAuthorization: GuardianUserAuthorization;
  outcome: GuardianOutcome;
  rationale: string;
}

/** One tool call under review, as observed on the permission boundary. */
export interface GuardianToolRequest {
  /** Quicksave-canonical tool name, e.g. `Bash`, `Edit`, or an MCP full name. */
  toolName: string;
  /** OpenCode permission category, e.g. `bash`, `edit`, `mcp__server__tool`. */
  permission: string;
  /** OpenCode patterns (for bash this is the command line itself). */
  patterns: string[];
  /** Normalized tool arguments from the permission event metadata. */
  input: Record<string, unknown>;
}

export interface GuardianDecision {
  outcome: GuardianOutcome;
  rationale: string;
  riskLevel?: GuardianRiskLevel;
  /** Set when the decision came from a review failure (fail-closed). */
  error?: string;
}

const GUARDIAN_POLICY = `You are the Quicksave Guardian — an automated security reviewer for a coding-agent session.
You do not execute anything. You review exactly one pending tool call and decide whether it may run.

You have no tools. Do not attempt to use any. Your only output is the JSON verdict object.

The context you receive:
- user_intent: the user's most recent request(s) in this session
- recent_actions: the most recent messages and tool calls before this one
- requested_action: the exact tool call under review

Policy — ALLOW the action when it is routine work that serves the user's stated intent:
- reading, creating, editing, building, testing, linting, or formatting files inside the project
- project-local development commands (installs, test/lint/build runs, dev servers in the workspace)
- git operations that do not force-push, do not rewrite shared history, and do not publish to a remote the user did not ask for
- network access required for the task (package registries, documentation, APIs the user configured)
- MCP tool calls that serve the task (part lookups, design-data queries, session bookkeeping)

Policy — DENY the action when any of these hold:
- it is destructive or irreversible beyond the task's scope (recursive deletes outside the project, dropping databases, force-deleting branches, overwriting credentials or files the user did not mention)
- it reads or transmits secrets, tokens, environment variables, or private data to an unknown destination
- it escalates privileges (sudo, system-file changes, modifying security or permission settings, tampering with SSH keys)
- it contradicts the user's stated intent, or its purpose cannot be determined from the context
- it is an indirect workaround for a previously denied action
- it targets infrastructure, data, or accounts the user did not ask to touch

Risk levels: low = routine read-only or local development work; medium = writes, installs, or network with side effects; high = irreversible or security-relevant; critical = credential access, privilege escalation, or broad data loss.

If the risk is high or critical and the context does not show explicit user authorization for it, DENY.
If you are uncertain, DENY — the user can always approve manually.
Never DENY a purely read-only action that does not touch credentials or private data.

Respond with ONLY one JSON object. It must have exactly these fields:
- "risk_level": one of "low", "medium", "high", "critical"
- "user_authorization": one of "unknown", "low", "medium", "high"
- "outcome": one of "allow", "deny"
- "rationale": one or two sentences in plain English

Example: {"risk_level":"low","user_authorization":"high","outcome":"allow","rationale":"Routine read-only command that matches the user's request."}
No prose, no markdown, nothing outside the JSON object.`;

/** Structured-output contract for the reviewer's final verdict. */
export const GUARDIAN_ASSESSMENT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    risk_level: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
    user_authorization: { type: 'string', enum: ['unknown', 'low', 'medium', 'high'] },
    outcome: { type: 'string', enum: ['allow', 'deny'] },
    rationale: { type: 'string' },
  },
  required: ['risk_level', 'user_authorization', 'outcome', 'rationale'],
  additionalProperties: false,
};

const CONTEXT_MESSAGE_LIMIT = 12;
const CONTEXT_TOTAL_BUDGET = 6000;
const USER_INTENT_BUDGET = 800;
const USER_INTENT_MAX = 2;
const LINE_BUDGET = 400;

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function v2ToolStateText(state: Record<string, unknown>): string {
  const input = state.input;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    try {
      const text = JSON.stringify(input);
      if (text !== '{}') return text;
    } catch { /* fall through */ }
  }
  const output = state.output ?? state.content;
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') {
          return (item as { text: string }).text;
        }
        try { return JSON.stringify(item); } catch { return ''; }
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export interface GuardianContext {
  userIntent: string[];
  recentActions: string[];
}

/** Build the compact reviewer context from a v2 message page.
 *
 * `descMessages` must be newest-first, as returned by
 * `getMessagePage(order: 'desc')`. */
export function buildGuardianContext(descMessages: readonly OpenCodeV2Message[]): GuardianContext {
  const ascending = [...descMessages].reverse().slice(-CONTEXT_MESSAGE_LIMIT);

  // Collected newest-first; present chronologically (oldest request first).
  const userIntent: string[] = [];
  const intentMessageIds = new Set<string>();
  for (let i = ascending.length - 1; i >= 0 && userIntent.length < USER_INTENT_MAX; i--) {
    const message = ascending[i];
    if (message.type === 'user' && message.text?.trim()) {
      userIntent.push(truncate(message.text.trim(), USER_INTENT_BUDGET));
      intentMessageIds.add(message.id);
    }
  }
  userIntent.reverse();

  const recentActions: string[] = [];
  let budget = CONTEXT_TOTAL_BUDGET;
  for (const message of ascending) {
    if (budget <= 0) break;
    if (message.type === 'user') {
      if (intentMessageIds.has(message.id)) continue;
      const text = message.text?.trim();
      if (!text) continue;
      const line = `user: ${truncate(text, LINE_BUDGET)}`;
      recentActions.push(line);
      budget -= line.length;
      continue;
    }
    if (message.type !== 'assistant') continue;
    for (const content of message.content ?? []) {
      if (budget <= 0) break;
      let line = '';
      if (content.type === 'text' && typeof content.text === 'string' && content.text.trim()) {
        line = `assistant: ${truncate(content.text.trim(), LINE_BUDGET)}`;
      } else if (content.type === 'tool') {
        const name = typeof content.name === 'string' ? content.name : 'unknown';
        const state = content.state && typeof content.state === 'object'
          ? content.state as Record<string, unknown>
          : {};
        const status = typeof state.status === 'string' ? state.status : 'unknown';
        const detail = v2ToolStateText(state);
        line = `tool ${name} [${status}]${detail ? `: ${truncate(detail, LINE_BUDGET)}` : ''}`;
      }
      if (line) {
        recentActions.push(line);
        budget -= line.length;
      }
    }
  }
  return { userIntent, recentActions };
}

/** Serialize the review request into the reviewer's user message. */
export function buildGuardianReviewText(
  request: GuardianToolRequest,
  context: GuardianContext,
): string {
  return JSON.stringify(
    {
      requested_action: {
        tool: request.toolName,
        permission_category: request.permission,
        patterns: request.patterns,
        arguments: request.input,
      },
      user_intent: context.userIntent,
      recent_actions: context.recentActions,
    },
    null,
    2,
  );
}

/** Parse the reviewer's verdict from a structured-output object or a text
 *  response (code-fenced or bare JSON). Returns null when unparseable. */
export function parseGuardianAssessment(raw: unknown): GuardianAssessment | null {
  let candidate: unknown = raw;
  if (typeof raw === 'string') {
    let text = raw.trim();
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence?.[1]) text = fence[1].trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      candidate = JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const obj = candidate as Record<string, unknown>;
  // Models occasionally drift from the contract (e.g. "decision" instead of
  // "outcome", "risk" instead of "risk_level") when the provider does not
  // enforce the JSON schema — accept the common aliases.
  const pickEnum = (keys: readonly string[], allowed: readonly string[]): string | null => {
    for (const key of keys) {
      const value = obj[key];
      if (typeof value === 'string' && allowed.includes(value)) return value;
    }
    return null;
  };
  const outcome = pickEnum(['outcome', 'decision'], ['allow', 'deny']) as GuardianOutcome | null;
  if (!outcome) return null;
  const riskLevels: readonly string[] = ['low', 'medium', 'high', 'critical'];
  const parsedRiskLevel = pickEnum(['risk_level', 'risk'], riskLevels);
  const authorizations: readonly string[] = ['unknown', 'low', 'medium', 'high'];
  const parsedAuthorization = pickEnum(['user_authorization', 'authorization'], authorizations);
  const parsedRationale = typeof obj.rationale === 'string' ? obj.rationale.trim() : '';
  // Be liberal only for a fail-closed denial. An allow decision must satisfy
  // the complete security contract even when the model server ignored our
  // response_format schema; partial or drifted allows are not authorization.
  if (outcome === 'allow' && (!parsedRiskLevel || !parsedAuthorization || !parsedRationale)) {
    return null;
  }
  const riskLevel = (parsedRiskLevel ?? 'high') as GuardianRiskLevel;
  const userAuthorization = (parsedAuthorization ?? 'unknown') as GuardianUserAuthorization;
  const rationale = parsedRationale || 'no rationale provided';
  return { riskLevel, userAuthorization, outcome, rationale };
}

export interface OpenCodeGuardianOptions {
  server: OpenCodeServer;
  directory: string;
  /** The main session this guardian serves (transcript source for context). */
  mainSessionId: string;
  /** Reviewer model server. Required — callers must reject `auto-review`
   *  before constructing a guardian when this is unset. */
  modelServer: GuardianModelServerConfig;
  timeoutMs?: number;
  maxConsecutiveDenials?: number;
}

export class OpenCodeGuardian {
  private readonly server: OpenCodeServer;
  private readonly directory: string;
  private readonly mainSessionId: string;
  private readonly modelServer: GuardianModelServerConfig;
  private readonly timeoutMs: number;
  private readonly maxConsecutiveDenials: number;
  /** Reviews are serialized: no reason to fan out concurrent reviewer calls
   *  for the same session, and it keeps the circuit breaker's consecutive
   *  count meaningful. */
  private reviewChain: Promise<unknown> = Promise.resolve();
  private consecutiveDenials = 0;

  constructor(opts: OpenCodeGuardianOptions) {
    this.server = opts.server;
    this.directory = opts.directory;
    this.mainSessionId = opts.mainSessionId;
    this.modelServer = opts.modelServer;
    this.timeoutMs = opts.timeoutMs ?? getOpenCodeGuardianTimeoutMs();
    this.maxConsecutiveDenials = opts.maxConsecutiveDenials ?? getOpenCodeGuardianMaxConsecutiveDenials();
  }

  /** Circuit breaker tripped — the next request must escalate to the user. */
  get shouldEscalateToUser(): boolean {
    return this.consecutiveDenials >= this.maxConsecutiveDenials;
  }

  get consecutiveDenialCount(): number {
    return this.consecutiveDenials;
  }

  /** Reset the breaker after the user has decided manually. */
  recordUserDecision(): void {
    this.consecutiveDenials = 0;
  }

  /** Queue one review. Always resolves (fail-closed denials are returned,
   *  never thrown). */
  review(request: GuardianToolRequest): Promise<GuardianDecision> {
    const run = this.reviewChain
      .then(() => this.runReview(request))
      .catch((err) => ({
        outcome: 'deny' as const,
        rationale: `Guardian review failed: ${err instanceof Error ? err.message : String(err)}`,
        riskLevel: 'high' as const,
        error: err instanceof Error ? err.message : String(err),
      }));
    this.reviewChain = run.catch(() => undefined);
    return run;
  }

  /** No-op: the reviewer never creates provider-side state to clean up.
   *  Kept for call-site compatibility (session teardown still calls this). */
  async dispose(): Promise<void> {}

  private async runReview(request: GuardianToolRequest): Promise<GuardianDecision> {
    try {
      const context = await this.buildContext();
      const reviewText = buildGuardianReviewText(request, context);
      const assessment = await this.runReviewOnce(reviewText);
      if (assessment.outcome === 'allow') {
        this.consecutiveDenials = 0;
      } else {
        this.consecutiveDenials += 1;
      }
      return {
        outcome: assessment.outcome,
        rationale: assessment.rationale,
        riskLevel: assessment.riskLevel,
      };
    } catch (err) {
      this.consecutiveDenials += 1;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[openCode:guardian] review failed (session=${this.mainSessionId.slice(0, 8)}): ${message}`);
      return {
        outcome: 'deny',
        rationale: `Guardian review failed: ${message}`,
        riskLevel: 'high',
        error: message,
      };
    }
  }

  private async buildContext(): Promise<GuardianContext> {
    try {
      const page = await this.server.getMessagePage(this.mainSessionId, {
        limit: CONTEXT_MESSAGE_LIMIT,
        order: 'desc',
        directory: this.directory,
      });
      return buildGuardianContext(page.items);
    } catch {
      // No transcript available (brand-new session) — review on intent alone.
      return { userIntent: [], recentActions: [] };
    }
  }

  private async runReviewOnce(reviewText: string): Promise<GuardianAssessment> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const raw = await callGuardianModel({
        baseUrl: this.modelServer.baseUrl,
        apiKey: this.modelServer.apiKey,
        model: this.modelServer.model,
        enableThinking: this.modelServer.enableThinking,
        systemPrompt: GUARDIAN_POLICY,
        userMessage: reviewText,
        schema: GUARDIAN_ASSESSMENT_SCHEMA,
        signal: controller.signal,
      });
      const assessment = parseGuardianAssessment(raw);
      if (!assessment) throw new Error('guardian model server returned an unparseable assessment');
      return assessment;
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`guardian review timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
