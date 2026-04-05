import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { generateAgentKeyPair } from './connection/connection.js';
import { generateAgentId, type License } from '@sumicom/quicksave-shared';

export interface AgentConfig {
  agentId: string;
  keyPair: {
    publicKey: string;
    secretKey: string;
  };
  license?: License;
  signalingServer: string;
  anthropicApiKey?: string;
  managedRepos?: string[];
  managedCodingPaths?: string[];
}

const CONFIG_DIR = join(homedir(), '.quicksave');
const CONFIG_FILE = join(CONFIG_DIR, 'agent.json');

export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function loadConfig(): AgentConfig | null {
  try {
    if (existsSync(CONFIG_FILE)) {
      const data = readFileSync(CONFIG_FILE, 'utf-8');
      return JSON.parse(data) as AgentConfig;
    }
  } catch (error) {
    console.error('Failed to load config:', error);
  }
  return null;
}

export function saveConfig(config: AgentConfig): void {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function createDefaultConfig(signalingServer: string): AgentConfig {
  const config: AgentConfig = {
    agentId: generateAgentId(),
    keyPair: generateAgentKeyPair(),
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
  } else if (config.signalingServer !== signalingServer) {
    // Update signaling server if changed
    config.signalingServer = signalingServer;
    saveConfig(config);
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
  return CONFIG_FILE;
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
  const config = loadConfig();
  if (!config) return;
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
  const config = loadConfig();
  if (!config) return;
  const paths = config.managedCodingPaths ?? [];
  if (!paths.includes(path)) {
    paths.push(path);
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
