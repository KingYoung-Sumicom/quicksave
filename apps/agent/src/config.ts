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
  license?: License;
  signalingServer: string;
  anthropicApiKey?: string;
  managedRepos?: string[];
  managedCodingPaths?: string[];
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
