// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Playwright test fixtures that start the mock relay and inject
 * the agent connection parameters into the page context.
 */

import { test as base, type Page } from '@playwright/test';
import { MockRelay, type MockRelayOptions } from './mock-relay';

function pathToHash(path: string): string {
  let hash = 5381;
  for (let i = 0; i < path.length; i++) {
    hash = ((hash << 5) + hash + path.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export const MOCK_AGENT_ID = 'mock-agent-001';
export const MOCK_REPO_PATH = '/home/user/project';
export const MOCK_PROJECT_ID = `${MOCK_AGENT_ID}:${pathToHash(MOCK_REPO_PATH)}`;

export type TestFixtures = {
  mockRelay: MockRelay;
  /** Navigate to the PWA and connect through the mock relay. Returns after handshake completes. */
  connectToAgent: (page: Page) => Promise<void>;
};

export const test = base.extend<TestFixtures>({
  mockRelay: async ({}, use) => {
    const relay = new MockRelay({ port: 4999 });
    await relay.start();
    await use(relay);
    await relay.stop();
  },

  connectToAgent: async ({ mockRelay }, use) => {
    const connect = async (page: Page) => {
      // Pre-seed localStorage so the app knows about our mock agent.
      // The Vite dev server is started with QUICKSAVE_SIGNALING_URL=ws://localhost:4999
      // so the connectionStore already points to the mock relay.
      await page.addInitScript(
        ({ agentId, publicKey, repoPath }) => {
          // Seed machine store (zustand persist, version 6)
          const machineStoreKey = 'quicksave-machines';
          const now = Date.now();
          const machineData = {
            state: {
              machines: [
                {
                  agentId,
                  publicKey,
                  nickname: 'Mock Agent',
                  icon: 'computer',
                  addedAt: now,
                  updatedAt: now,
                  lastConnectedAt: null,
                  lastRepoPath: repoPath,
                  knownRepos: [],
                  knownCodingPaths: [repoPath],
                  isPro: false,
                  cachedProjects: {
                    [repoPath]: {
                      lastActivityAt: now,
                      sessionCount: 0,
                      repos: [{ path: repoPath, name: 'project' }],
                    },
                  },
                },
              ],
              machineTombstones: {},
            },
            version: 6,
          };
          localStorage.setItem(machineStoreKey, JSON.stringify(machineData));
        },
        {
          agentId: MOCK_AGENT_ID,
          publicKey: mockRelay.publicKey,
          repoPath: MOCK_REPO_PATH,
        }
      );

      // Navigate directly to the current project route. The project route
      // resolves the seeded machine/path and initiates the agent connection.
      await page.goto(`/#/p/${MOCK_PROJECT_ID}`);

      // Wait for the app to complete the handshake and render the project page.
      await page.waitForURL(/#\/p\//, { timeout: 15_000 });
      await page.getByRole('heading', { name: 'Tasks', exact: true }).waitFor({ timeout: 15_000 });
    };

    await use(connect);
  },
});

export { expect } from '@playwright/test';
