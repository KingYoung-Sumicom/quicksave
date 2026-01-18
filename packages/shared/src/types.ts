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
  | 'offer'
  | 'answer'
  | 'ice-candidate'
  | 'peer-connected'
  | 'peer-offline'
  | 'bye';

export interface SignalingMessage {
  type: SignalingMessageType;
  payload?: unknown;
}

// ============================================================================
// Connection Types
// ============================================================================

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'signaling'
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
