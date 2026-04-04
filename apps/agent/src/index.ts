#!/usr/bin/env node

import { Command } from 'commander';
// @ts-ignore - no types for qrcode-terminal
import qrcode from 'qrcode-terminal';
import { resolve, basename } from 'path';
import { hostname } from 'os';
import { AgentConnection } from './connection/connection.js';
import { MessageHandler } from './handlers/messageHandler.js';
import { GitOperations } from './git/operations.js';
import { getOrCreateConfig, getConfigPath, rotateKeyPair } from './config.js';
import type { Message, Repository } from '@sumicom/quicksave-shared';

const DEFAULT_SIGNALING_SERVER = process.env.QUICKSAVE_SIGNALING_URL || 'wss://signal.quicksave.dev';

const program = new Command();

function collectValues(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

program
  .name('quicksave-agent')
  .description('Quicksave desktop agent for remote git control')
  .version('0.1.0')
  .option('-r, --repo <path>', 'Path to git repository (can specify multiple)', collectValues, [])
  .option('-c, --coding-path <path>', 'Path for Claude Code sessions (can specify multiple, non-git dirs OK)', collectValues, [])
  .option('-s, --signaling <url>', 'Signaling server URL', DEFAULT_SIGNALING_SERVER)
  .option('--no-qr', 'Disable QR code display')
  .action(async (options) => {
    // Default to current directory if no repos specified
    const repoPaths: string[] = options.repo.length > 0 ? options.repo : ['.'];
    const resolvedPaths = repoPaths.map((p: string) => resolve(p));
    const signalingServer = options.signaling;

    console.log('Quicksave Agent v0.1.0');
    console.log('='.repeat(50));

    // Verify all git repositories
    const validRepos: Repository[] = [];
    for (const repoPath of resolvedPaths) {
      const git = new GitOperations(repoPath);
      const isValid = await git.isValidRepo();
      if (!isValid) {
        console.error(`Warning: ${repoPath} is not a valid git repository, skipping`);
        continue;
      }
      const rootPath = await git.getGitRoot();
      const { current: currentBranch } = await git.getBranches();
      validRepos.push({
        path: rootPath,
        name: basename(rootPath),
        currentBranch,
      });
    }

    if (validRepos.length === 0) {
      console.warn('Warning: No valid git repositories found. Use the PWA to browse and add a repository.');
    } else {
      console.log(`Repositories (${validRepos.length}):`);
      for (const repo of validRepos) {
        console.log(`  - ${repo.name} (${repo.path}) [${repo.currentBranch}]`);
      }
    }

    // Load or create config
    const config = getOrCreateConfig(signalingServer);
    console.log(`Config: ${getConfigPath()}`);
    console.log(`Signaling: ${signalingServer}`);
    console.log('');

    // Create connection
    const connection = new AgentConnection({
      signalingServer,
      agentId: config.agentId,
      keyPair: config.keyPair,
    });

    // Resolve coding paths
    const resolvedCodingPaths = (options.codingPath || []).map((p: string) => resolve(p));

    // Create message handler with all valid repos + coding paths
    const messageHandler = new MessageHandler(validRepos, config.license, resolvedCodingPaths);

    // Handle incoming messages
    connection.on('message', async (message: Message, peerAddress: string) => {
      const response = await messageHandler.handleMessage(
        message,
        peerAddress,
        (msg: Message) => connection.send(msg, peerAddress)
      );
      connection.send(response, peerAddress);
    });

    connection.on('connected', (peerAddress: string) => {
      const peerKey = peerAddress.replace('pwa:', '');
      console.log(`\n+ PWA connected: ${peerKey.slice(0, 12)}... (${connection.getPeerCount()} client${connection.getPeerCount() !== 1 ? 's' : ''})`);
    });

    connection.on('disconnected', (peerAddress: string) => {
      const peerKey = peerAddress.replace('pwa:', '');
      messageHandler.removeClient(peerAddress);
      console.log(`\n- PWA disconnected: ${peerKey.slice(0, 12)}... (${connection.getPeerCount()} client${connection.getPeerCount() !== 1 ? 's' : ''})`);
      if (!connection.hasPeers()) {
        displayConnectionInfo(config.agentId, config.keyPair.publicKey, options.qr);
      }
    });

    connection.on('error', (error) => {
      console.error('Connection error:', error.message);
    });

    // Start connection
    try {
      await connection.start();
      displayConnectionInfo(config.agentId, config.keyPair.publicKey, options.qr);
    } catch (error) {
      console.error('Failed to start agent:', error);
      process.exit(1);
    }

    // Handle shutdown
    process.on('SIGINT', () => {
      console.log('\nShutting down...');
      messageHandler.cleanup();
      connection.disconnect();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      messageHandler.cleanup();
      connection.disconnect();
      process.exit(0);
    });
  });

function displayConnectionInfo(agentId: string, publicKey: string, showQr: boolean): void {
  console.log('');
  console.log('='.repeat(50));
  console.log('Connection Info');
  console.log('='.repeat(50));
  console.log('');
  console.log('Agent ID:');
  console.log(`  ${agentId}`);
  console.log('');
  console.log('Public Key:');
  console.log(`  ${publicKey}`);
  console.log('');

  // Create connection URL for PWA
  const connectionUrl = `https://quicksave.dev/connect?id=${agentId}&pk=${encodeURIComponent(publicKey)}&name=${encodeURIComponent(hostname())}`;

  console.log('Connection URL:');
  console.log(`  ${connectionUrl}`);
  console.log('');

  if (showQr) {
    console.log('Scan QR code to connect:');
    console.log('');
    qrcode.generate(connectionUrl, { small: true });
  }

  console.log('');
  console.log('Waiting for PWA connection...');
}

program
  .command('rotate-keys')
  .description('Generate a new keypair (invalidates all existing PWA connections)')
  .action(() => {
    try {
      const config = rotateKeyPair();
      console.log('\nKey pair rotated successfully.\n');
      console.log(`  Agent ID:    ${config.agentId} (unchanged)`);
      console.log(`  Public Key:  ${config.keyPair.publicKey} (NEW)\n`);
      console.log('All existing PWA connections are now invalid.');
      console.log('Re-scan the QR code on your trusted devices to reconnect.\n');
      displayConnectionInfo(config.agentId, config.keyPair.publicKey, true);
    } catch (err) {
      console.error('Failed to rotate keys:', (err as Error).message);
      process.exit(1);
    }
  });

program.parse();
