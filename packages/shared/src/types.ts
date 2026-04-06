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
  | 'agent:list-coding-paths'
  | 'agent:list-coding-paths:response'
  | 'agent:add-coding-path'
  | 'agent:add-coding-path:response'
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

export interface CodingPath {
  path: string;
  name: string; // basename
}

// ============================================================================
// Request/Response Payloads
// ============================================================================

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
  gitBranch?: string;
  messageCount?: number;
  isActive?: boolean;
  isStreaming?: boolean;
  hasPendingInput?: boolean;
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
  allowedTools?: string[];
  systemPrompt?: string;
  model?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
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
  role: 'user' | 'assistant';
  content: string;
  toolName?: string;
  toolInput?: string;
  toolResult?: string;
  truncated?: boolean;
}

export interface ClaudeGetMessagesResponsePayload {
  messages: ClaudeHistoryMessage[];
  total: number;
  hasMore: boolean;
  error?: string;
}

// Stream event types (agent-push)
export type ClaudeStreamEventType =
  | 'assistant_text'
  | 'tool_use'
  | 'tool_result'
  | 'user_message'
  | 'system'
  | 'error';

export interface ClaudeStreamPayload {
  streamId: string;
  sessionId: string;
  eventType: ClaudeStreamEventType;
  content: string;
  toolName?: string;
  toolInput?: string;
  isPartial?: boolean;
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
}

// User input response (PWA → agent)
export interface ClaudeUserInputResponsePayload {
  sessionId: string;
  requestId: string;
  action: 'allow' | 'deny' | 'respond';
  response?: string;
  selectedKey?: string;
}
