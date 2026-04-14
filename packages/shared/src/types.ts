// ============================================================================
// Message Types
// ============================================================================

export interface Message<T = unknown> {
  id: string;
  type: MessageType;
  payload: T;
  timestamp: number;
}

export type MessageType =
  | 'ping'
  | 'pong'
  | 'handshake'
  | 'handshake:ack'
  | 'git:status'
  | 'git:status:response'
  | 'git:diff'
  | 'git:diff:response'
  | 'git:stage'
  | 'git:stage:response'
  | 'git:unstage'
  | 'git:unstage:response'
  | 'git:stage-patch'
  | 'git:stage-patch:response'
  | 'git:unstage-patch'
  | 'git:unstage-patch:response'
  | 'git:commit'
  | 'git:commit:response'
  | 'git:log'
  | 'git:log:response'
  | 'git:branches'
  | 'git:branches:response'
  | 'git:checkout'
  | 'git:checkout:response'
  | 'git:discard'
  | 'git:discard:response'
  | 'git:untrack'
  | 'git:untrack:response'
  | 'git:gitignore-add'
  | 'git:gitignore-add:response'
  | 'git:submodules'
  | 'git:submodules:response'
  | 'git:config-get'
  | 'git:config-get:response'
  | 'git:config-set'
  | 'git:config-set:response'
  | 'git:gitignore-read'
  | 'git:gitignore-read:response'
  | 'git:gitignore-write'
  | 'git:gitignore-write:response'
  | 'ai:generate-commit-summary'
  | 'ai:generate-commit-summary:response'
  | 'ai:set-api-key'
  | 'ai:set-api-key:response'
  | 'ai:get-api-key-status'
  | 'ai:get-api-key-status:response'
  | 'agent:list-repos'
  | 'agent:list-repos:response'
  | 'agent:switch-repo'
  | 'agent:switch-repo:response'
  | 'agent:browse-directory'
  | 'agent:browse-directory:response'
  | 'agent:add-repo'
  | 'agent:add-repo:response'
  | 'agent:remove-repo'
  | 'agent:remove-repo:response'
  | 'agent:clone-repo'
  | 'agent:clone-repo:response'
  | 'agent:list-coding-paths'
  | 'agent:list-coding-paths:response'
  | 'agent:add-coding-path'
  | 'agent:add-coding-path:response'
  | 'agent:remove-coding-path'
  | 'agent:remove-coding-path:response'
  | 'agent:check-update'
  | 'agent:check-update:response'
  | 'agent:update'
  | 'agent:update:response'
  | 'agent:restart'
  | 'agent:restart:response'
  // Claude Code SDK Remote Control
  | 'claude:list-sessions'
  | 'claude:list-sessions:response'
  | 'claude:start'
  | 'claude:start:response'
  | 'claude:resume'
  | 'claude:resume:response'
  | 'claude:cancel'
  | 'claude:cancel:response'
  | 'claude:close'
  | 'claude:close:response'
  | 'claude:get-messages'
  | 'claude:get-messages:response'
  | 'claude:stream'       // agent-push: streaming content
  | 'claude:stream:end'   // agent-push: session turn complete
  | 'claude:user-input-request'   // agent-push: session needs user input
  | 'claude:user-input-response'  // pwa-push: user's response to input request
  | 'claude:user-input-resolved'  // agent-push: pending input was resolved (notify other tabs)
  | 'claude:session-updated'      // agent-push: session state changed (active/streaming/pending)
  | 'claude:get-preferences'
  | 'claude:get-preferences:response'
  | 'claude:set-preferences'
  | 'claude:set-preferences:response'
  | 'claude:preferences-updated'  // agent-push: preferences changed, broadcast to all peers
  | 'claude:set-session-permission'           // pwa-push: change permission level for a specific session
  | 'claude:set-session-permission:response'  // agent-push: permission change applied
  | 'claude:active-sessions'                  // pwa-request: get in-memory active sessions
  | 'claude:active-sessions:response'         // agent-response: active sessions snapshot
  // Card-based protocol (v2)
  | 'claude:card-event'            // agent-push: card add/update/append_text
  | 'claude:card-stream-end'       // agent-push: card streaming turn complete
  | 'claude:get-cards'             // pwa-request: get card history
  | 'claude:get-cards:response'    // agent-response: card history
  | 'claude:unsubscribe'           // pwa-push: unsubscribe from session events
  | 'claude:unsubscribe:response'  // agent-response: unsubscribe ack
  | 'session:get-config'           // pwa-request: get session config
  | 'session:get-config:response'  // agent-response: session config
  | 'session:set-config'           // pwa-request: set a key on session config
  | 'session:set-config:response'  // agent-response: set-config ack with full config
  | 'session:config-updated'       // agent-push: session config changed
  // Session registry (history)
  | 'session:list-history'           // pwa-request: list session history
  | 'session:list-history:response'  // agent-response: session history list
  | 'session:update-history'         // pwa-request: update session history entry
  | 'session:update-history:response' // agent-response: update ack
  | 'session:delete-history'         // pwa-request: delete session history entry
  | 'session:delete-history:response' // agent-response: delete ack
  | 'session:history-updated'        // agent-push: session history changed
  | 'error';

// ============================================================================
// Git Types
// ============================================================================

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';

export interface FileChange {
  path: string;
  status: FileStatus;
  oldPath?: string; // For renamed/copied files
}

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  staged: FileChange[];
  unstaged: FileChange[];
  untracked: string[];
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  content: string;
}

export interface ImageData {
  old?: string; // data URI for previous version
  new?: string; // data URI for current version
}

export interface FileDiff {
  path: string;
  oldPath?: string;
  hunks: DiffHunk[];
  isBinary: boolean;
  truncated?: boolean;
  truncatedReason?: string;
  imageData?: ImageData;
}

export interface Commit {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  email: string;
  date: string;
}

export interface Branch {
  name: string;
  current: boolean;
  remote?: string;
}

export interface Repository {
  path: string;
  name: string;
  currentBranch?: string;
}

export interface Submodule {
  name: string;
  path: string;
  branch?: string;
}

export interface CodingPath {
  path: string;
  name: string; // basename
}

// ============================================================================
// Request/Response Payloads
// ============================================================================

// Claude preferences (model, reasoning effort) — owned by agent, synced to PWA.
// permissionMode is session-scoped; use claude:set-session-permission to change it.
export interface ClaudePreferences {
  model: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max';
}

export type ClaudeGetPreferencesRequestPayload = Record<string, never>;

export interface ClaudeGetPreferencesResponsePayload {
  preferences: ClaudePreferences;
}

export interface ClaudeSetPreferencesRequestPayload {
  preferences: Partial<ClaudePreferences>;
}

export interface ClaudeSetPreferencesResponsePayload {
  success: boolean;
  preferences: ClaudePreferences; // always the current applied value
  error?: string;
}

export type ClaudePreferencesUpdatedPayload = ClaudePreferences;

export interface ClaudeSetSessionPermissionRequestPayload {
  sessionId: string;
  permissionMode: string;
}

export interface ClaudeSetSessionPermissionResponsePayload {
  success: boolean;
  sessionId: string;
  permissionMode: string;
}

// ============================================================================
// Generic per-session config
// ============================================================================

/** Any JSON-primitive value that can be stored as a session config entry. */
export type ConfigValue = string | number | boolean | null;

export type AgentId = 'claude-code' | 'codex';

/** PWA → Agent: get the full config for a session */
export interface SessionGetConfigRequestPayload {
  sessionId: string;
}

/** Agent → PWA: full session config */
export interface SessionGetConfigResponsePayload {
  sessionId: string;
  config: Record<string, ConfigValue>;
}

/** PWA → Agent: set a single key on a session's config */
export interface SessionSetConfigRequestPayload {
  sessionId: string;
  key: string;
  value: ConfigValue;
}

/** Agent → PWA: response with the full config after update */
export interface SessionSetConfigResponsePayload {
  success: boolean;
  sessionId: string;
  config: Record<string, ConfigValue>;
  error?: string;
}

/** Agent → PWA (push broadcast): a session's config was updated */
export interface SessionConfigUpdatedPayload {
  sessionId: string;
  config: Record<string, ConfigValue>;
}

// ============================================================================
// Session Registry (History) Types
// ============================================================================

export interface SessionRegistryEntry {
  sessionId: string;
  cwd: string;
  agent?: AgentId;
  repoName?: string;
  gitBranch?: string;
  title?: string;
  firstPrompt?: string;
  createdAt: number;
  lastAccessedAt: number;
  messageCount?: number;
  totalCostUsd?: number;
  pinned?: boolean;
  archived?: boolean;
}

export interface SessionListHistoryRequestPayload {
  cwd?: string;
}

export interface SessionListHistoryResponsePayload {
  entries: SessionRegistryEntry[];
  error?: string;
}

export interface SessionUpdateHistoryRequestPayload {
  sessionId: string;
  cwd: string;
  updates: Partial<Pick<SessionRegistryEntry, 'title' | 'pinned' | 'archived'>>;
}

export interface SessionUpdateHistoryResponsePayload {
  success: boolean;
  entry?: SessionRegistryEntry;
  error?: string;
}

export interface SessionDeleteHistoryRequestPayload {
  sessionId: string;
  cwd: string;
}

export interface SessionDeleteHistoryResponsePayload {
  success: boolean;
  error?: string;
}

export interface SessionHistoryUpdatedPayload {
  cwd: string;
  entry: SessionRegistryEntry;
  action: 'upsert' | 'delete';
}

export interface ClaudeActiveSession {
  sessionId: string;
  cwd: string;
  agent?: AgentId;
  isStreaming: boolean;
  hasPendingInput: boolean;
  permissionMode: string;
  sandboxed?: boolean;
}

export type ClaudeActiveSessionsRequestPayload = Record<string, never>;

export interface ClaudeActiveSessionsResponsePayload {
  sessions: ClaudeActiveSession[];
}

// Handshake
export interface HandshakePayload {
  publicKey: string; // Base64 encoded
  license?: License;
}

export interface HandshakeAckPayload {
  success: boolean;
  agentVersion: string;
  repoPath: string;
  availableRepos?: Repository[];
  availableCodingPaths?: CodingPath[];
  preferences?: ClaudePreferences;
  latestVersion?: string; // Cached npm registry check (agent-side, 12h dedup)
  devBuild?: boolean; // true when running from source (non-production build)
  codexModels?: CodexModelInfo[]; // Cached OpenAI /v1/models (agent-side, 12h dedup)
}

// Codex / OpenAI model discovery
export interface CodexModelInfo {
  id: string;
  name: string;
  reasoningEfforts?: string[]; // e.g. ['low', 'medium', 'high', 'xhigh']
}

export interface CodexListModelsResponsePayload {
  models: CodexModelInfo[];
  error?: string;
}

// Status
export interface StatusRequestPayload {
  path?: string;
}

export type StatusResponsePayload = GitStatus;

// Diff
export interface DiffRequestPayload {
  path: string;
  staged?: boolean;
}

export type DiffResponsePayload = FileDiff;

// Stage/Unstage
export interface StageRequestPayload {
  paths: string[];
}

export interface StageResponsePayload {
  success: boolean;
  error?: string;
}

export type UnstageRequestPayload = StageRequestPayload;
export type UnstageResponsePayload = StageResponsePayload;

// Stage/Unstage Patch (for line-level staging)
export interface StagePatchRequestPayload {
  patch: string; // Unified diff format
}

export interface StagePatchResponsePayload {
  success: boolean;
  error?: string;
}

export type UnstagePatchRequestPayload = StagePatchRequestPayload;
export type UnstagePatchResponsePayload = StagePatchResponsePayload;

// Commit
export interface CommitRequestPayload {
  message: string;
  description?: string;
  attribution?: boolean;
}

export interface CommitResponsePayload {
  success: boolean;
  hash?: string;
  error?: string;
}

// Log
export interface LogRequestPayload {
  limit?: number;
}

export interface LogResponsePayload {
  commits: Commit[];
}

// Branches
export type BranchesRequestPayload = Record<string, never>;

export interface BranchesResponsePayload {
  branches: Branch[];
  current: string;
}

// Checkout
export interface CheckoutRequestPayload {
  branch: string;
  create?: boolean;
}

export interface CheckoutResponsePayload {
  success: boolean;
  error?: string;
}

// Discard
export interface DiscardRequestPayload {
  paths: string[];
}

export interface DiscardResponsePayload {
  success: boolean;
  error?: string;
}

// Untrack (git rm --cached)
export interface UntrackRequestPayload {
  paths: string[];
}

export interface UntrackResponsePayload {
  success: boolean;
  error?: string;
}

// Submodules
export type SubmodulesRequestPayload = Record<string, never>;

export interface SubmodulesResponsePayload {
  submodules: Submodule[];
}

// Git Config (identity)
export type GitConfigGetRequestPayload = Record<string, never>;

export interface GitConfigGetResponsePayload {
  name?: string;
  email?: string;
}

export interface GitConfigSetRequestPayload {
  name: string;
  email: string;
}

export interface GitConfigSetResponsePayload {
  success: boolean;
  error?: string;
}

// Gitignore - Add pattern
export interface GitignoreAddRequestPayload {
  pattern: string;
}

export interface GitignoreAddResponsePayload {
  success: boolean;
  error?: string;
}

// Gitignore - Read
export type GitignoreReadRequestPayload = Record<string, never>;

export interface GitignoreReadResponsePayload {
  content: string;
  exists: boolean;
}

// Gitignore - Write
export interface GitignoreWriteRequestPayload {
  content: string;
}

export interface GitignoreWriteResponsePayload {
  success: boolean;
  error?: string;
}

// Error
export interface ErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}

// List Repos
export type ListReposRequestPayload = Record<string, never>;

export interface ListReposResponsePayload {
  repos: Repository[];
  current: string;
}

// Switch Repo
export interface SwitchRepoRequestPayload {
  path: string;
}

export interface SwitchRepoResponsePayload {
  success: boolean;
  newPath: string;
  error?: string;
}

// Browse Directory
export interface BrowseDirectoryRequestPayload {
  path: string;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isGitRepo: boolean;
}

export interface BrowseDirectoryResponsePayload {
  path: string;
  parentPath: string | null;
  entries: DirectoryEntry[];
  error?: string;
}

// Add Repo
export interface AddRepoRequestPayload {
  path: string;
}

export interface AddRepoResponsePayload {
  success: boolean;
  repo?: Repository;
  error?: string;
}

// Remove Repo
export interface RemoveRepoRequestPayload {
  path: string;
}

export interface RemoveRepoResponsePayload {
  success: boolean;
  error?: string;
}

// Clone Repo
export interface CloneRepoRequestPayload {
  url: string;
  targetDir: string;
}

export interface CloneRepoResponsePayload {
  success: boolean;
  repo?: Repository;
  clonedPath?: string;
  error?: string;
}

// List Coding Paths
export type ListCodingPathsRequestPayload = Record<string, never>;

export interface ListCodingPathsResponsePayload {
  paths: CodingPath[];
}

// Add Coding Path
export interface AddCodingPathRequestPayload {
  path: string;
}

export interface AddCodingPathResponsePayload {
  success: boolean;
  path?: CodingPath;
  error?: string;
}

// Remove Coding Path
export interface RemoveCodingPathRequestPayload {
  path: string;
}

export interface RemoveCodingPathResponsePayload {
  success: boolean;
  error?: string;
}

// Agent Update Check
export type AgentCheckUpdateRequestPayload = Record<string, never>;

export interface AgentCheckUpdateResponsePayload {
  currentVersion: string;
  latestVersion?: string;
  updateAvailable: boolean;
  error?: string;
}

// Agent Self-Update
export type AgentUpdateRequestPayload = Record<string, never>;

export interface AgentUpdateResponsePayload {
  success: boolean;
  previousVersion: string;
  newVersion?: string;  // npm install output parsed version
  restarting: boolean;  // true if daemon will restart automatically
  error?: string;
}

// Agent Restart (dev builds only)
export type AgentRestartRequestPayload = Record<string, never>;

export interface AgentRestartResponsePayload {
  success: boolean;
  error?: string;
}

// ============================================================================
// License Types
// ============================================================================

export interface License {
  version: 1;
  publicKey: string;
  issuedAt: number;
  type: 'pro';
  signature: string;
}

// ============================================================================
// Signaling Types
// ============================================================================

export type SignalingMessageType =
  | 'peer-connected'
  | 'peer-offline'
  | 'data'
  | 'bye'
  | 'pwa-bye'
  | 'sync-updated'
  | 'error';

export interface SignalingMessage {
  type: SignalingMessageType;
  payload?: unknown;
}

// ============================================================================
// Key Exchange Types (V2 Protocol)
// ============================================================================

/**
 * Key exchange message - PWA sends encrypted session DEK to Agent
 * This provides forward secrecy: if Agent is compromised, only current session is exposed
 */
export interface KeyExchangeV2 {
  type: 'key-exchange';
  version: 2;
  encryptedDEK: string; // Session DEK encrypted with Agent's public key (base64)
  timestamp: number; // Unix timestamp for replay protection
}

/**
 * V2 key exchange acknowledgment from Agent
 */
export interface KeyExchangeV2Ack {
  type: 'key-exchange-ack';
  version: 2;
}

/**
 * Key exchange message type
 */
export type KeyExchangeMessage = KeyExchangeV2;

// ============================================================================
// Routed Message Envelope
// ============================================================================

export interface RoutedMessage {
  from: string;   // "pwa:{publicKey}" or "agent:{agentId}"
  to: string;     // "pwa:{publicKey}" or "agent:{agentId}"
  payload: string; // opaque string (encrypted or JSON)
}

// ============================================================================
// Sync Types
// ============================================================================

export interface SyncBlob {
  encryptedData: string; // sealed-box encrypted backup v2 JSON
  timestamp: number;
}

export interface Tombstone {
  type: 'rotated';
  oldPublicKey: string;  // base64 X25519 public key
  signature: string;     // Ed25519 sign("rotated:{oldPublicKey}", oldSigningSecretKey)
}

export interface PairedDevice {
  publicKey: string;
  label: string;
  pairedAt: number;
}

// ============================================================================
// Connection Types
// ============================================================================

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

export interface ConnectionInfo {
  state: ConnectionState;
  agentId: string;
  signalingServer: string;
  connectedAt?: number;
  error?: string;
}

// ============================================================================
// AI Types
// ============================================================================

export type ClaudeModel =
  | 'claude-haiku-4-5'
  | 'claude-sonnet-4-6'
  | 'claude-opus-4-6';

export const CLAUDE_MODELS: { id: ClaudeModel; name: string; label: string; description: string }[] = [
  { id: 'claude-haiku-4-5', name: 'Haiku', label: 'Haiku 4.5', description: 'Fast & affordable' },
  { id: 'claude-sonnet-4-6', name: 'Sonnet', label: 'Sonnet 4.6', description: 'Balanced speed & quality' },
  { id: 'claude-opus-4-6', name: 'Opus', label: 'Opus 4.6', description: 'Highest quality' },
];

// Generate Commit Summary
export interface GenerateCommitSummaryRequestPayload {
  context?: string;
  model?: ClaudeModel;
  attribution?: boolean;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface GenerateCommitSummaryResponsePayload {
  success: boolean;
  summary?: string;
  description?: string;
  error?: string;
  errorCode?: 'NO_API_KEY' | 'NO_STAGED_CHANGES' | 'API_ERROR' | 'RATE_LIMITED';
  tokenUsage?: TokenUsage;
  cached?: boolean;
}

// API Key Management
export interface SetApiKeyRequestPayload {
  apiKey: string;
}

export interface SetApiKeyResponsePayload {
  success: boolean;
  error?: string;
}

export interface GetApiKeyStatusResponsePayload {
  configured: boolean;
}

// ============================================================================
// Claude Code SDK Remote Control Types
// ============================================================================

// Session summary (from listSessions)
export interface ClaudeSessionSummary {
  sessionId: string;
  summary: string;
  lastModified: number;
  createdAt?: number;
  cwd?: string;
  agent?: AgentId;
  gitBranch?: string;
  messageCount?: number;
  isActive?: boolean;
  isStreaming?: boolean;
  hasPendingInput?: boolean;
  permissionMode?: string;
}

// List Sessions
export interface ClaudeListSessionsRequestPayload {
  cwd?: string;
}

export interface ClaudeListSessionsResponsePayload {
  sessions: ClaudeSessionSummary[];
  error?: string;
}

// Start Session
export interface ClaudeStartRequestPayload {
  prompt: string;
  cwd?: string;
  agent?: AgentId;
  allowedTools?: string[];
  systemPrompt?: string;
  model?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  sandboxed?: boolean;
}

export interface ClaudeStartResponsePayload {
  success: boolean;
  sessionId?: string;
  streamId?: string;
  error?: string;
}

// Resume Session
export interface ClaudeResumeRequestPayload {
  sessionId: string;
  prompt: string;
  cwd?: string;
  agent?: AgentId;
}

export interface ClaudeResumeResponsePayload {
  success: boolean;
  sessionId?: string;
  streamId?: string;
  error?: string;
}

// Cancel Session
export interface ClaudeCancelRequestPayload {
  sessionId: string;
}

export interface ClaudeCancelResponsePayload {
  success: boolean;
  error?: string;
}

// Close Session (user explicitly ends a session)
export interface ClaudeCloseRequestPayload {
  sessionId: string;
}

export interface ClaudeCloseResponsePayload {
  success: boolean;
  error?: string;
}

// Get Messages (paginated)
export interface ClaudeGetMessagesRequestPayload {
  sessionId: string;
  cwd?: string;
  offset?: number;  // defaults to 0
  limit?: number;   // defaults to 50
}

export interface ClaudeHistoryMessage {
  index: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolName?: string;
  toolInput?: string;
  toolUseId?: string;    // Unique ID for this tool call (tool_use block id)
  toolResult?: string;
  toolResultForId?: string;  // toolUseId this result belongs to (tool_result block tool_use_id)
  truncated?: boolean;
}

export interface ClaudeSubagentBlock {
  toolUseId: string;          // Matches parent session's Agent tool_use_id
  agentId: string;            // SDK agentId (subagent JSONL filename stem)
  description: string;
  summary?: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  toolUseCount: number;
  lastToolName?: string;
}

export interface ClaudeGetMessagesResponsePayload {
  messages: ClaudeHistoryMessage[];
  total: number;
  hasMore: boolean;
  error?: string;
  subagentBlocks?: ClaudeSubagentBlock[];  // Keyed by toolUseId for the parent Task call
  toolNameMap?: Record<string, string>;    // toolUseId → toolName for ALL messages (not just current page)
}

// Stream event types (agent-push)
export type ClaudeStreamEventType =
  | 'assistant_text'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'user_message'
  | 'system'
  | 'error'
  | 'subagent_start'     // subagent task started (task_started SDK event)
  | 'subagent_progress'  // subagent progress update (task_progress SDK event)
  | 'subagent_end';      // subagent task completed (task_notification SDK event)

export interface ClaudeStreamPayload {
  streamId: string;
  sessionId: string;
  eventType: ClaudeStreamEventType;
  content: string;
  toolName?: string;
  toolInput?: string;
  toolUseId?: string;        // Present on tool_use events (block.id)
  toolResultForId?: string;  // Present on tool_result events (block.tool_use_id)
  isPartial?: boolean;
  // Subagent fields
  agentId?: string;          // subagent_start/end: SDK agentId (matches subagent JSONL filename)
  toolUseCount?: number;     // subagent_progress: total tool uses so far
  lastToolName?: string;     // subagent_progress: last tool used by subagent
  subagentStatus?: 'completed' | 'failed' | 'stopped'; // subagent_end
  subagentSummary?: string;  // subagent_end: summary from task_notification
}

export interface ClaudeStreamEndPayload {
  streamId: string;
  sessionId: string;
  success: boolean;
  error?: string;
  totalCostUsd?: number;
  tokenUsage?: { input: number; output: number };
}

// User input request types (agent → PWA)
export type ClaudeUserInputType = 'permission' | 'question';

export interface ClaudeUserInputOption {
  key: string;
  label: string;
  description?: string;
}

export interface ClaudeUserInputRequestPayload {
  sessionId: string;
  requestId: string;
  inputType: ClaudeUserInputType;
  title: string;
  message?: string;
  options?: ClaudeUserInputOption[];
  // Permission-specific fields
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;  // tool_use block id for exact card matching on reconnect
  agentId?: string;  // Present when permission is from a subagent
}

// User input response (PWA → agent)
export interface ClaudeUserInputResponsePayload {
  sessionId: string;
  requestId: string;
  action: 'allow' | 'deny' | 'respond';
  response?: string;
  selectedKey?: string;
  /** Wildcard pattern to persist in project .claude/settings.local.json allow list */
  allowPattern?: string;
}
