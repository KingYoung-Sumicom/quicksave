/**
 * Playwright test fixtures that start the mock relay and inject
 * the agent connection parameters into the page context.
 */

import { test as base, type Page } from '@playwright/test';
import { MockRelay, type MockRelayOptions } from './mock-relay';

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
        ({ agentId, publicKey }) => {
          // Seed machine store (zustand persist, version 2)
          const machineStoreKey = 'quicksave-machines';
          const machineData = {
            state: {
              machines: [
                {
                  agentId,
                  publicKey,
                  nickname: 'Mock Agent',
                  icon: 'computer',
                  addedAt: Date.now(),
                  lastConnectedAt: null,
                  lastRepoPath: null,
                  knownRepos: [],
                  knownCodingPaths: [],
                  isPro: false,
                },
              ],
            },
            version: 2,
          };
          localStorage.setItem(machineStoreKey, JSON.stringify(machineData));
        },
        {
          agentId: 'mock-agent-001',
          publicKey: mockRelay.publicKey,
        }
      );

      // Navigate to the app root — the fleet dashboard should appear with our mock agent
      await page.goto('/');

      // Click on the mock agent card to initiate connection.
      // Desktop layout shows ProjectList both in sidebar and content pane — use .first().
      await page.getByText('Mock Agent').first().click();

      // Wait for the app to complete the handshake and navigate to the project page.
      await page.waitForURL(/#\/p\//, { timeout: 15_000 });
    };

    await use(connect);
  },
});

export { expect } from '@playwright/test';
