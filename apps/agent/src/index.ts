#!/usr/bin/env node

import { Command } from 'commander';
// @ts-ignore - no types for qrcode-terminal
import qrcode from 'qrcode-terminal';
import { resolve, basename } from 'path';
import { WebRTCConnection } from './connection/connection.js';
import { MessageHandler } from './handlers/messageHandler.js';
import { GitOperations } from './git/operations.js';
import { getOrCreateConfig, getConfigPath } from './config.js';
import type { Message, Repository } from 'quicksave-shared';

const DEFAULT_SIGNALING_SERVER = process.env.QUICKSAVE_SIGNALING_URL || 'wss://signal.quicksave.dev';

const program = new Command();

function collectRepos(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

program
  .name('quicksave-agent')
  .description('Quicksave desktop agent for remote git control')
  .version('0.1.0')
  .option('-r, --repo <path>', 'Path to git repository (can specify multiple)', collectRepos, [])
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
      const { current: currentBranch } = await git.getBranches();
      validRepos.push({
        path: repoPath,
        name: basename(repoPath),
        currentBranch,
      });
    }

    if (validRepos.length === 0) {
      console.error('Error: No valid git repositories found');
      process.exit(1);
    }

    console.log(`Repositories (${validRepos.length}):`);
    for (const repo of validRepos) {
      console.log(`  - ${repo.name} (${repo.path}) [${repo.currentBranch}]`);
    }

    // Load or create config
    const config = getOrCreateConfig(signalingServer);
    console.log(`Config: ${getConfigPath()}`);
    console.log(`Signaling: ${signalingServer}`);
    console.log('');

    // Create connection
    const connection = new WebRTCConnection({
      signalingServer,
      agentId: config.agentId,
      keyPair: config.keyPair,
    });

    // Create message handler with all valid repos
    const messageHandler = new MessageHandler(validRepos, config.license);

    // Handle incoming messages
    connection.on('message', async (message: Message) => {
      const response = await messageHandler.handleMessage(message);
      connection.send(response);
    });

    connection.on('connected', () => {
      console.log('\n✓ PWA connected! Ready for git operations.');
    });

    connection.on('disconnected', () => {
      console.log('\n✗ PWA disconnected. Waiting for reconnection...');
      displayConnectionInfo(config.agentId, config.keyPair.publicKey, options.qr);
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
      connection.disconnect();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
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
  const connectionUrl = `https://quicksave.dev/connect?id=${agentId}&pk=${encodeURIComponent(publicKey)}`;

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

program.parse();
