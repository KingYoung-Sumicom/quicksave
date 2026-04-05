#!/usr/bin/env node

import { Command } from 'commander';
// @ts-ignore - no types for qrcode-terminal
import qrcode from 'qrcode-terminal';
import { resolve } from 'path';
import { hostname } from 'os';
import { getConfigPath, rotateKeyPair, addManagedRepo, addManagedCodingPath } from './config.js';
import { GitOperations } from './git/operations.js';
import { runDaemon } from './service/run.js';
import { IpcClient as IpcClientClass } from './service/ipcClient.js';
import { readServiceState } from './service/stateStore.js';
import { isProcessAlive } from './service/singleton.js';
import type { StatusResult, PairingInfoResult } from './service/types.js';

const program = new Command();

function collectValues(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

program
  .name('quicksave-agent')
  .description('Quicksave desktop agent for remote git control')
  .version('0.4.0')
  .allowExcessArguments(false)
  .option('-r, --repo <path>', 'Path to git repository (can specify multiple)', collectValues, [])
  .option('-c, --coding-path <path>', 'Path for Claude Code sessions (can specify multiple, non-git dirs OK)', collectValues, [])
  .option('-s, --signaling <url>', 'Signaling server URL')
  .option('--no-qr', 'Disable QR code display')
  .action(async (options) => {
    // Persist any CLI-provided repos/coding paths to config
    const repoPaths: string[] = options.repo;
    for (const p of repoPaths) {
      addManagedRepo(resolve(p));
    }
    const codingPaths: string[] = options.codingPath || [];
    for (const p of codingPaths) {
      addManagedCodingPath(resolve(p));
    }

    // Auto-detect current directory's repo
    if (repoPaths.length === 0) {
      const cwd = process.cwd();
      const git = new GitOperations(cwd);
      if (await git.isValidRepo()) {
        const root = await git.getGitRoot();
        addManagedRepo(root);
        repoPaths.push(root);
      }
    }

    // Ensure daemon is running
    const { ensureDaemon } = await import('./service/ensureDaemon.js');
    let client: IpcClientClass;
    try {
      const result = await ensureDaemon();
      client = result.client;
      console.log(`Quicksave Agent v0.4.0 (daemon pid: ${result.hello.daemonPid})`);
      console.log('='.repeat(50));
    } catch (err) {
      console.error('Failed to connect to daemon:', (err as Error).message);
      process.exit(1);
    }

    // Notify the running daemon about repos (idempotent — no-op if already known)
    for (const p of repoPaths) {
      try {
        await client.request('add-repo', { path: resolve(p) });
      } catch { /* daemon already has it or will pick it up on restart */ }
    }

    // Get pairing info and display
    try {
      const info = await client.request<PairingInfoResult>('get-pairing-info');
      console.log(`Config: ${getConfigPath()}`);
      console.log('');
      displayPairingInfo(info, options.qr);
    } catch (err) {
      console.error('Failed to get pairing info:', (err as Error).message);
    }

    // Subscribe to live events
    await client.request('subscribe-events');
    client.onNotification((method, params) => {
      if (method === 'event.peerConnected') {
        const p = params as { peerId: string; peerCount: number };
        console.log(`\n+ PWA connected: ${p.peerId}... (${p.peerCount} peer${p.peerCount !== 1 ? 's' : ''})`);
      } else if (method === 'event.peerDisconnected') {
        const p = params as { peerId: string; peerCount: number };
        console.log(`\n- PWA disconnected: ${p.peerId}... (${p.peerCount} peer${p.peerCount !== 1 ? 's' : ''})`);
      } else if (method === 'event.repoAdded') {
        const p = params as { repo: { name: string; path: string } };
        console.log(`\n+ Repo added: ${p.repo.name} (${p.repo.path})`);
      } else if (method === 'event.repoRemoved') {
        const p = params as { path: string };
        console.log(`\n- Repo removed: ${p.path}`);
      } else if (method === 'event.daemonStatus') {
        // Daemon status change (e.g., shutting down)
        if ((params as any).shutting_down) {
          console.log('\nDaemon is shutting down...');
          client.close();
          process.exit(0);
        }
      }
    });

    // Ctrl+C detaches (leaves daemon running)
    process.on('SIGINT', () => {
      console.log('\nDetaching (daemon still running)...');
      client.close();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      client.close();
      process.exit(0);
    });
  });

function displayPairingInfo(info: PairingInfoResult, showQr: boolean): void {
  console.log('Agent ID:');
  console.log(`  ${info.agentId}`);
  console.log('');

  console.log('Connection URL:');
  console.log(`  ${info.pairingUrl}`);
  console.log('');

  if (showQr) {
    console.log('Scan QR code to connect:');
    console.log('');
    qrcode.generate(info.pairingUrl, { small: true });
  }

  console.log('');
  if (info.peerCount > 0) {
    console.log(`Connected to ${info.peerCount} peer${info.peerCount !== 1 ? 's' : ''}`);
  } else {
    console.log('Waiting for PWA connection...');
  }
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
      const pairingUrl = `https://quicksave.dev/connect?id=${config.agentId}&pk=${encodeURIComponent(config.keyPair.publicKey)}&name=${encodeURIComponent(hostname())}`;
      console.log('Connection URL:');
      console.log(`  ${pairingUrl}\n`);
      qrcode.generate(pairingUrl, { small: true });
    } catch (err) {
      console.error('Failed to rotate keys:', (err as Error).message);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// Service subcommands
// ---------------------------------------------------------------------------

const serviceCmd = program
  .command('service')
  .description('Manage the quicksave background service');

serviceCmd
  .command('run')
  .description('Run the daemon in the foreground (not normally invoked directly)')
  .action(async () => {
    await runDaemon();
  });

serviceCmd
  .command('start')
  .description('Start the background daemon')
  .action(async () => {
    // Check if already running
    const state = readServiceState();
    if (state && isProcessAlive(state.pid)) {
      console.log(`Daemon is already running (pid: ${state.pid})`);
      return;
    }

    const { ensureDaemon } = await import('./service/ensureDaemon.js');
    try {
      const { hello } = await ensureDaemon();
      console.log(`Daemon started (pid: ${hello.daemonPid})`);
    } catch (err) {
      console.error('Failed to start daemon:', (err as Error).message);
      process.exit(1);
    }
  });

serviceCmd
  .command('stop')
  .description('Stop the running daemon')
  .action(async () => {
    const state = readServiceState();
    if (!state) {
      console.log('No daemon is running.');
      return;
    }

    if (!isProcessAlive(state.pid)) {
      console.log('Daemon process is dead. Cleaning up stale files...');
      const { cleanStaleRuntime } = await import('./service/singleton.js');
      const { removeServiceState } = await import('./service/stateStore.js');
      cleanStaleRuntime();
      removeServiceState();
      console.log('Done.');
      return;
    }

    try {
      const client = new IpcClientClass();
      await client.connect(state.socketPath);
      await client.request('shutdown');
      client.close();
      console.log('Daemon stopped.');
    } catch (err) {
      console.error('Failed to stop daemon:', (err as Error).message);
      process.exit(1);
    }
  });

serviceCmd
  .command('status')
  .description('Show daemon status')
  .action(async () => {
    const state = readServiceState();
    if (!state) {
      console.log('No daemon is running.');
      return;
    }

    if (!isProcessAlive(state.pid)) {
      console.log('Daemon process is dead (stale service.json).');
      console.log(`  Last PID: ${state.pid}`);
      console.log(`  Started:  ${state.startedAt}`);
      return;
    }

    try {
      const client = new IpcClientClass();
      await client.connect(state.socketPath);
      const status = await client.request<StatusResult>('status');
      client.close();

      console.log('Quicksave daemon is running');
      console.log(`  PID:              ${status.pid}`);
      console.log(`  Version:          ${status.version}`);
      console.log(`  Uptime:           ${formatUptime(status.uptime)}`);
      console.log(`  Connection:       ${status.connectionState}`);
      console.log(`  Peers:            ${status.peerCount}`);
      console.log(`  Active sessions:  ${status.activeSessions}`);
      console.log(`  Managed repos:    ${status.managedRepos}`);
    } catch (err) {
      console.error('Failed to query daemon:', (err as Error).message);
      process.exit(1);
    }
  });

serviceCmd
  .command('info')
  .description('Show daemon info from service.json (no IPC required)')
  .action(() => {
    const state = readServiceState();
    if (!state) {
      console.log('No service state file found.');
      return;
    }

    const alive = isProcessAlive(state.pid);
    console.log(`PID:        ${state.pid} (${alive ? 'alive' : 'dead'})`);
    console.log(`Version:    ${state.version}`);
    console.log(`IPC:        ${state.ipcVersion}`);
    console.log(`Build ID:   ${state.buildId}`);
    console.log(`Started:    ${state.startedAt}`);
    console.log(`Heartbeat:  ${state.lastHeartbeatAt}`);
    console.log(`Socket:     ${state.socketPath}`);
    console.log(`Agent ID:   ${state.agentId}`);
    console.log(`Signaling:  ${state.signalingServer}`);
    console.log(`Connection: ${state.connectionState}`);
    console.log(`Peers:      ${state.peerCount}`);
  });

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

program.parse();
