#!/usr/bin/env node
/**
 * Copy Pi plugins to dist so they're bundled with the npm package.
 * This mirrors how @earendil-works/pi-coding-agent copies extensions
 * into its dist folder via the copy-assets script.
 */
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distRoot = join(__dirname, '..', 'dist');
const srcDir = join(__dirname, '..', 'src');

const pluginDir = 'pi-plugins';
const distPluginDir = join(distRoot, 'pi-plugins');

// Create the dist/pi-plugins directory
mkdirSync(distPluginDir, { recursive: true });

// Copy all TypeScript plugins (the Pi RPC client loads them as .ts via jiti)
const plugins = [
  'quicksave-permission.ts',
];

let copied = 0;
for (const plugin of plugins) {
  const srcPath = join(srcDir, pluginDir, plugin);
  const destPath = join(distPluginDir, plugin);

  if (!existsSync(srcPath)) {
    console.error(`[copy-pi-plugins] WARN: source not found: ${srcPath}`);
    continue;
  }

  copyFileSync(srcPath, destPath);
  console.log(`[copy-pi-plugins] ✓ ${plugin}`);
  copied++;
}

console.log(`[copy-pi-plugins] Copied ${copied} plugin(s) to dist/pi-plugins/`);
