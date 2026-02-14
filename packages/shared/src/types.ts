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

export interface FileDiff {
  path: string;
  oldPath?: string;
  hunks: DiffHunk[];
  isBinary: boolean;
  truncated?: boolean;
  truncatedReason?: string;
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
  | 'bye';

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
  | 'claude-sonnet-4-5'
  | 'claude-opus-4-5';

export const CLAUDE_MODELS: { id: ClaudeModel; name: string; description: string }[] = [
  { id: 'claude-haiku-4-5', name: 'Haiku', description: 'Fast & affordable' },
  { id: 'claude-sonnet-4-5', name: 'Sonnet', description: 'Balanced speed & quality' },
  { id: 'claude-opus-4-5', name: 'Opus', description: 'Highest quality' },
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
