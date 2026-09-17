// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { generateAgentKeyPair } from './connection/connection.js';
import { generateAgentId, generateSigningKeyPair, encodeKeyPair, type License } from '@sumicom/quicksave-shared';
import { getQuicksaveDir, getConfigFile } from './service/singleton.js';

export interface AgentConfig {
  agentId: string;
  keyPair: {
    publicKey: string;
    secretKey: string;
  };
  signKeyPair: {
    publicKey: string;
    secretKey: string;
  };
  /**
   * TOFU-pinned PWA group identity. `null` on a fresh / closed agent, which
   * accepts the first successful V2 handshake as the trust anchor and writes
   * both fields here. Once pinned, subsequent handshakes must prove possession
   * of the same Ed25519 signing key before they are accepted.
   *
   * Cleared (set back to `null`) when a tombstone is observed on the pinned
   * mailbox — the agent then enters the "closed" state until the user runs
   * `quicksave pair` again.
   */
  peerPWAPublicKey?: string | null;
  peerPWASignPublicKey?: string | null;
  /**
   * Sticky self-destruct flag set after a verified tombstone. Persists across
   * daemon restarts so a crash/restart window can't silently re-open TOFU.
   * Cleared only by `unlockPairingAndRotate()` (driven by `quicksave pair`).
   */
  closed?: boolean;
  license?: License;
  signalingServer: string;
  anthropicApiKey?: string;
  managedRepos?: string[];
  managedCodingPaths?: string[];
  /** Enable OpenCode's built-in websearch tool (backed by Exa). */
  openCodeEnableExa?: boolean;
  /** Machine-local reviewer used by OpenCode auto-review sessions. */
  openCodeGuardian?: {
    baseUrl: string;
    apiKey?: string;
    model: string;
    enableThinking?: boolean;
    timeoutMs?: number;
    maxConsecutiveDenials?: number;
  };
}

const DEFAULT_SIGNALING_SERVER = 'wss://signal.quicksave.dev';

export function ensureConfigDir(): void {
  const dir = getQuicksaveDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function loadConfig(): AgentConfig | null {
  try {
    if (existsSync(getConfigFile())) {
      const data = readFileSync(getConfigFile(), 'utf-8');
      return JSON.parse(data) as AgentConfig;
    }
  } catch (error) {
    console.error('Failed to load config:', error);
  }
  return null;
}

export function saveConfig(config: AgentConfig): void {
  ensureConfigDir();
  writeFileSync(getConfigFile(), JSON.stringify(config, null, 2));
}

export function createDefaultConfig(signalingServer: string): AgentConfig {
  const config: AgentConfig = {
    agentId: generateAgentId(),
    keyPair: generateAgentKeyPair(),
    signKeyPair: encodeKeyPair(generateSigningKeyPair()),
    peerPWAPublicKey: null,
    peerPWASignPublicKey: null,
    closed: false,
    signalingServer,
  };
  saveConfig(config);
  return config;
}

export function getOrCreateConfig(signalingServer: string): AgentConfig {
  let config = loadConfig();

  if (!config) {
    console.log('No existing config found, generating new identity...');
    config = createDefaultConfig(signalingServer);
    console.log('New agent identity created');
  } else {
    let dirty = false;
    // Backfill signing keypair for configs created before Ed25519 push auth.
    if (!config.signKeyPair) {
      config.signKeyPair = encodeKeyPair(generateSigningKeyPair());
      dirty = true;
    }
    // Pre-TOFU configs are legacy unpaired → normalize missing fields to null.
    if (config.peerPWAPublicKey === undefined) {
      config.peerPWAPublicKey = null;
      dirty = true;
    }
    if (config.peerPWASignPublicKey === undefined) {
      config.peerPWASignPublicKey = null;
      dirty = true;
    }
    if (config.closed === undefined) {
      config.closed = false;
      dirty = true;
    }
    if (config.signalingServer !== signalingServer) {
      config.signalingServer = signalingServer;
      dirty = true;
    }
    if (dirty) saveConfig(config);
  }

  return config;
}

export function addLicense(license: License): void {
  const config = loadConfig();
  if (config) {
    config.license = license;
    saveConfig(config);
  }
}

export function getConfigPath(): string {
  return getConfigFile();
}

// Anthropic API Key helpers
export function getAnthropicApiKey(): string | undefined {
  return loadConfig()?.anthropicApiKey;
}

export function setAnthropicApiKey(apiKey: string): void {
  const config = loadConfig();
  if (config) {
    config.anthropicApiKey = apiKey;
    saveConfig(config);
  }
}

export function hasAnthropicApiKey(): boolean {
  return !!loadConfig()?.anthropicApiKey;
}

/** Whether this machine starts OpenCode with its built-in Exa web search tool. */
export function getOpenCodeEnableExa(): boolean {
  return loadConfig()?.openCodeEnableExa === true;
}

export function setOpenCodeEnableExa(enabled: boolean): void {
  const config = loadConfig() ?? getOrCreateConfig(DEFAULT_SIGNALING_SERVER);
  config.openCodeEnableExa = enabled;
  saveConfig(config);
}

// ── OpenCode guardian (auto-review) ──────────────────────────────────────────
//
// When an OpenCode session runs in the `auto-review` permission mode, the
// daemon routes permission requests through an LLM reviewer instead of
// auto-approving them. The reviewer never runs inside the coding-agent
// provider (no hidden session is created for it) — it calls a
// user-configured, OpenAI-compatible model server directly. This is a
// prerequisite for `auto-review`, not an optional override: with no model
// server configured, `auto-review` is unavailable rather than silently
// falling back to the main session's own model.

export interface GuardianModelServerConfig {
  /** Base URL of an OpenAI-compatible API, e.g. `http://localhost:8000/v1`. */
  baseUrl: string;
  apiKey?: string;
  model: string;
  enableThinking: boolean;
}

export interface GuardianSettingsInput {
  baseUrl: string;
  model: string;
  apiKey?: string | null;
  enableThinking: boolean;
  timeoutMs: number;
  maxConsecutiveDenials: number;
}

function environmentGuardianModelServerConfig(): GuardianModelServerConfig | undefined {
  const baseUrl = process.env.QUICKSAVE_GUARDIAN_MODEL_SERVER_URL?.trim();
  const model = process.env.QUICKSAVE_GUARDIAN_MODEL?.trim();
  if (!baseUrl || !model) return undefined;
  const apiKey = process.env.QUICKSAVE_GUARDIAN_MODEL_SERVER_API_KEY?.trim();
  return {
    baseUrl,
    model,
    ...(apiKey ? { apiKey } : {}),
    enableThinking: parseGuardianThinkingSetting(
      process.env.QUICKSAVE_GUARDIAN_ENABLE_THINKING,
      false,
    ),
  };
}

function parseGuardianThinkingSetting(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || !raw.trim()) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

/** Guardian reviewer model server, or undefined when not configured (in
 *  which case `auto-review` must be rejected, not silently downgraded). */
export function getGuardianModelServerConfig(): GuardianModelServerConfig | undefined {
  const environment = environmentGuardianModelServerConfig();
  if (environment) return environment;
  const stored = loadConfig()?.openCodeGuardian;
  const baseUrl = stored?.baseUrl.trim();
  const model = stored?.model.trim();
  if (!baseUrl || !model) return undefined;
  return {
    baseUrl,
    model,
    ...(stored?.apiKey ? { apiKey: stored.apiKey } : {}),
    enableThinking: parseGuardianThinkingSetting(
      process.env.QUICKSAVE_GUARDIAN_ENABLE_THINKING,
      stored?.enableThinking === true,
    ),
  };
}

/** Wall-clock timeout for one guardian review, in milliseconds. */
export function getOpenCodeGuardianTimeoutMs(): number {
  const raw = Number(process.env.QUICKSAVE_GUARDIAN_TIMEOUT_MS ?? loadConfig()?.openCodeGuardian?.timeoutMs);
  if (!Number.isFinite(raw) || raw <= 0) return 60_000;
  return Math.min(300_000, Math.max(5_000, Math.round(raw)));
}

/** Consecutive guardian denials/failures before a request escalates to the
 *  user for a manual decision. */
export function getOpenCodeGuardianMaxConsecutiveDenials(): number {
  const raw = Number(process.env.QUICKSAVE_GUARDIAN_MAX_CONSECUTIVE ?? loadConfig()?.openCodeGuardian?.maxConsecutiveDenials);
  if (!Number.isFinite(raw) || raw <= 0) return 3;
  return Math.min(10, Math.max(1, Math.round(raw)));
}

export function getOpenCodeGuardianSettingsSnapshot(): {
  configured: boolean;
  source: 'environment' | 'settings' | 'none';
  baseUrl?: string;
  model?: string;
  hasApiKey: boolean;
  enableThinking: boolean;
  timeoutMs: number;
  maxConsecutiveDenials: number;
} {
  const environment = environmentGuardianModelServerConfig();
  const stored = loadConfig()?.openCodeGuardian;
  const active = environment ?? (stored?.baseUrl?.trim() && stored.model?.trim()
    ? {
        baseUrl: stored.baseUrl.trim(),
        model: stored.model.trim(),
        ...(stored.apiKey ? { apiKey: stored.apiKey } : {}),
        enableThinking: parseGuardianThinkingSetting(
          process.env.QUICKSAVE_GUARDIAN_ENABLE_THINKING,
          stored.enableThinking === true,
        ),
      }
    : undefined);
  return {
    configured: Boolean(active),
    source: environment ? 'environment' : active ? 'settings' : 'none',
    ...(active?.baseUrl ? { baseUrl: active.baseUrl } : {}),
    ...(active?.model ? { model: active.model } : {}),
    hasApiKey: Boolean(active?.apiKey),
    enableThinking: active?.enableThinking ?? false,
    timeoutMs: getOpenCodeGuardianTimeoutMs(),
    maxConsecutiveDenials: getOpenCodeGuardianMaxConsecutiveDenials(),
  };
}

export function setOpenCodeGuardianSettings(input: GuardianSettingsInput): void {
  if (environmentGuardianModelServerConfig()) {
    throw new Error('Guardian settings are managed by environment variables on this machine');
  }
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
  const model = input.model.trim();
  if (Boolean(baseUrl) !== Boolean(model)) {
    throw new Error('Guardian base URL and model must either both be set or both be empty');
  }
  if (baseUrl) {
    let parsed: URL;
    try { parsed = new URL(baseUrl); } catch { throw new Error('Guardian base URL must be a valid URL'); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Guardian base URL must use http or https');
    }
  }
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 5_000 || input.timeoutMs > 300_000) {
    throw new Error('Guardian timeout must be between 5 and 300 seconds');
  }
  if (!Number.isInteger(input.maxConsecutiveDenials)
    || input.maxConsecutiveDenials < 1
    || input.maxConsecutiveDenials > 10) {
    throw new Error('Guardian denial threshold must be an integer between 1 and 10');
  }

  const config = loadConfig() ?? getOrCreateConfig(DEFAULT_SIGNALING_SERVER);
  if (!baseUrl) {
    delete config.openCodeGuardian;
  } else {
    const previousKey = config.openCodeGuardian?.apiKey;
    const apiKey = input.apiKey === undefined ? previousKey : input.apiKey?.trim() || undefined;
    config.openCodeGuardian = {
      baseUrl,
      model,
      ...(apiKey ? { apiKey } : {}),
      enableThinking: input.enableThinking,
      timeoutMs: Math.round(input.timeoutMs),
      maxConsecutiveDenials: input.maxConsecutiveDenials,
    };
  }
  saveConfig(config);
}

// Managed repos helpers
export function getManagedRepos(): string[] {
  return loadConfig()?.managedRepos ?? [];
}

export function addManagedRepo(path: string): void {
  const config = loadConfig() ?? getOrCreateConfig(DEFAULT_SIGNALING_SERVER);
  const repos = config.managedRepos ?? [];
  if (!repos.includes(path)) {
    repos.push(path);
    config.managedRepos = repos;
    saveConfig(config);
  }
}

export function removeManagedRepo(path: string): void {
  const config = loadConfig();
  if (!config) return;
  const repos = config.managedRepos ?? [];
  const idx = repos.indexOf(path);
  if (idx !== -1) {
    repos.splice(idx, 1);
    config.managedRepos = repos;
    saveConfig(config);
  }
}

// Managed coding paths helpers
export function getManagedCodingPaths(): string[] {
  return loadConfig()?.managedCodingPaths ?? [];
}

export function addManagedCodingPath(path: string): void {
  const config = loadConfig() ?? getOrCreateConfig(DEFAULT_SIGNALING_SERVER);
  const paths = config.managedCodingPaths ?? [];
  if (!paths.includes(path)) {
    paths.push(path);
    config.managedCodingPaths = paths;
    saveConfig(config);
  }
}

export function removeManagedCodingPath(path: string): void {
  const config = loadConfig();
  if (!config) return;
  const paths = config.managedCodingPaths ?? [];
  const idx = paths.indexOf(path);
  if (idx !== -1) {
    paths.splice(idx, 1);
    config.managedCodingPaths = paths;
    saveConfig(config);
  }
}

/**
 * Rotate the agent's key pair (keeps the same agentId).
 * This invalidates all existing PWA connections.
 */
export function rotateKeyPair(): AgentConfig {
  const config = loadConfig();
  if (!config) {
    throw new Error('No config found. Run the agent first to generate a config.');
  }
  config.keyPair = generateAgentKeyPair();
  saveConfig(config);
  return config;
}

/** True iff the agent has TOFU-pinned a PWA group identity. */
export function isPaired(config: AgentConfig = loadConfig()!): boolean {
  return (
    !!config &&
    !!config.peerPWAPublicKey &&
    !!config.peerPWASignPublicKey
  );
}

/**
 * Pin the given PWA group identity as this agent's trust anchor. Idempotent
 * if the same pair is already stored; throws if a *different* pair is already
 * pinned (caller must `clearPeerPWA` first, which is the tombstone path).
 */
export function pinPeerPWA(
  peerPWAPublicKey: string,
  peerPWASignPublicKey: string,
): AgentConfig {
  const config = loadConfig();
  if (!config) {
    throw new Error('No config found. Run the agent first to generate a config.');
  }
  if (config.peerPWAPublicKey && config.peerPWASignPublicKey) {
    if (
      config.peerPWAPublicKey === peerPWAPublicKey &&
      config.peerPWASignPublicKey === peerPWASignPublicKey
    ) {
      return config;
    }
    throw new Error(
      'Agent is already paired with a different PWA group identity. ' +
        'Clear the pairing (rotate-keys tombstone or manual reset) first.',
    );
  }
  config.peerPWAPublicKey = peerPWAPublicKey;
  config.peerPWASignPublicKey = peerPWASignPublicKey;
  saveConfig(config);
  return config;
}

/**
 * Forget the pinned PWA group identity. Called when a signed tombstone is
 * observed on the pinned mailbox. Rotates the agent's entire cryptographic
 * identity (`agentId`, X25519 box keypair, Ed25519 signing keypair) so the
 * old routing address and keys can no longer be used, and sets `closed: true`
 * so the agent refuses every inbound handshake until `quicksave pair`.
 */
export function clearPeerPWA(): AgentConfig {
  const config = loadConfig();
  if (!config) {
    throw new Error('No config found.');
  }
  config.peerPWAPublicKey = null;
  config.peerPWASignPublicKey = null;
  config.agentId = generateAgentId();
  config.keyPair = generateAgentKeyPair();
  config.signKeyPair = encodeKeyPair(generateSigningKeyPair());
  config.closed = true;
  saveConfig(config);
  return config;
}

/**
 * Lift the `closed` gate and produce a fresh agent identity. Called by the
 * `quicksave pair` CLI path: even if the agent was already in a fresh state
 * after tombstone, rotating again here means each new pairing attempt comes
 * with an unburdened identity — no lingering state from prior pairings.
 */
export function unlockPairingAndRotate(): AgentConfig {
  const config = loadConfig();
  if (!config) {
    throw new Error('No config found.');
  }
  config.peerPWAPublicKey = null;
  config.peerPWASignPublicKey = null;
  config.agentId = generateAgentId();
  config.keyPair = generateAgentKeyPair();
  config.signKeyPair = encodeKeyPair(generateSigningKeyPair());
  config.closed = false;
  saveConfig(config);
  return config;
}
