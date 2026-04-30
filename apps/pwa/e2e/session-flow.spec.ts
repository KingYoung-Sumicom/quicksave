// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { test, expect } from './fixtures';
import type { Card, CardEvent } from '@sumicom/quicksave-shared';

const MOCK_SESSION_ID = 'session-existing-001';
const MOCK_REPO_PATH = '/home/user/project';

const mockCards: Card[] = [
  {
    id: `${MOCK_SESSION_ID}:0`,
    type: 'user',
    text: 'Hello, can you help me?',
    timestamp: Date.now() - 60_000,
  },
  {
    id: `${MOCK_SESSION_ID}:1`,
    type: 'assistant_text',
    text: 'Of course! How can I assist you today?',
    timestamp: Date.now() - 59_000,
  },
];

const cardEventsOnStart: CardEvent[] = [
  {
    type: 'add',
    sessionId: '', // overridden by mock relay
    card: {
      id: 'new:0',
      type: 'assistant_text',
      text: 'I will help you with that.',
      timestamp: Date.now(),
    },
  },
];

test.describe('Session Flow', () => {
  test('connects to agent and sees the dashboard', async ({ page, mockRelay, connectToAgent }) => {
    await connectToAgent(page);

    // Agent dashboard should show the coding section with the project path
    await expect(page.locator('h2', { hasText: 'Coding' })).toBeVisible();
    await expect(page.getByText('project').first()).toBeVisible();
  });

  test('navigates to coding path and sees session list', async ({ page, mockRelay, connectToAgent }) => {
    // Set up a mock session so the list is not empty
    mockRelay.setSessions([
      {
        sessionId: MOCK_SESSION_ID,
        summary: 'Test session about coding',
        lastModified: Date.now() - 60_000,
        cwd: MOCK_REPO_PATH,
        agent: 'claude-code',
      },
    ]);

    await connectToAgent(page);

    // Click on the coding path entry (the project name)
    await page.getByText('project').last().click();

    // Should navigate to the coding panel and show the session list
    await page.waitForURL(/#\/agent\/mock-agent-001\/coding\//);

    // The session summary should appear in the list
    await expect(page.getByText('Test session about coding').first()).toBeVisible({ timeout: 10_000 });
  });

  test('loads cards for an existing session', async ({ page, mockRelay, connectToAgent }) => {
    mockRelay.setSessions([
      {
        sessionId: MOCK_SESSION_ID,
        summary: 'Test session',
        lastModified: Date.now(),
        cwd: MOCK_REPO_PATH,
        agent: 'claude-code',
      },
    ]);
    mockRelay.setCards(mockCards);

    await connectToAgent(page);

    // Navigate to the coding path
    await page.getByText('project').last().click();
    await page.waitForURL(/#\/agent\/mock-agent-001\/coding\//);

    // Click on the existing session
    await page.getByText('Test session').first().click();

    // Cards should load — verify the user message and assistant response
    await expect(page.getByText('Hello, can you help me?')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Of course! How can I assist you today?')).toBeVisible();
  });

  test('starts a new session and sees card events', async ({ page, mockRelay, connectToAgent }) => {
    mockRelay.setSessions([]);
    mockRelay.setCards([]);

    await connectToAgent(page);

    // Navigate to the coding path
    await page.getByText('project').last().click();
    await page.waitForURL(/#\/agent\/mock-agent-001\/coding\//);

    // Click "New Session" button
    await page.getByText('New Session').click();

    // Should show the new session empty state with config options
    await expect(page.getByText('Type a message below to start the session')).toBeVisible({ timeout: 10_000 });
  });

  test('new-session flow renders streamed assistant card after first prompt', async ({ page, mockRelay, connectToAgent }) => {
    // Regression: the ?new → /s/:id transition previously flipped isChat=false
    // during the intermediate render, which would tear down the bus subscription
    // on a session that had just been started. The transition must stay stable.
    mockRelay.setSessions([]);
    mockRelay.setCards([]);
    mockRelay.setCardEventsOnStart([
      {
        type: 'add',
        sessionId: '',
        card: {
          id: 'new:0',
          type: 'assistant_text',
          text: 'I will help you with that.',
          timestamp: Date.now(),
        },
      },
    ]);

    await connectToAgent(page);

    await page.getByText('project').last().click();
    await page.waitForURL(/#\/p\/[^/]+$/);

    await page.getByText('New Session').click();
    await page.waitForURL(/#\/p\/[^/]+\/s\/new/, { timeout: 10_000 });
    await expect(page.getByText('Type a message below to start the session')).toBeVisible({ timeout: 10_000 });

    await page.locator('textarea').fill('Hello agent');
    await page.locator('button[title="Send"]').click();

    // Wait for the URL to settle on the real session id and for the streamed
    // assistant card to render — this guarantees the full transition has run.
    await page.waitForURL(/#\/p\/[^/]+\/s\/mock-session-/, { timeout: 10_000 });
    await expect(page.getByText('I will help you with that.')).toBeVisible({ timeout: 10_000 });

    const startResponse = mockRelay.receivedMessages.find((m) => m.type === 'claude:start');
    expect(startResponse, 'PWA should have sent a claude:start request').toBeTruthy();
  });

  test('navigating to ?new clears cards, navigating back reloads them', async ({ page, mockRelay, connectToAgent }) => {
    mockRelay.setSessions([
      {
        sessionId: MOCK_SESSION_ID,
        summary: 'Test session',
        lastModified: Date.now(),
        cwd: MOCK_REPO_PATH,
        agent: 'claude-code',
      },
    ]);
    mockRelay.setCards(mockCards);

    await connectToAgent(page);

    // Navigate to coding path and select the session
    await page.getByText('project').last().click();
    await page.waitForURL(/#\/agent\/mock-agent-001\/coding\//);
    await page.getByText('Test session').first().click();

    // Verify cards are loaded
    await expect(page.getByText('Hello, can you help me?')).toBeVisible({ timeout: 10_000 });

    // Click the "+" button in the nav drawer to start a new session
    await page.locator('button[title="New session"]').click();

    // Previous cards should be gone, new session state should show
    await expect(page.getByText('Hello, can you help me?')).not.toBeVisible();
    await expect(page.getByText('Type a message below to start the session')).toBeVisible();

    // Go back in browser history — cards should reload
    await page.goBack();
    await expect(page.getByText('Hello, can you help me?')).toBeVisible({ timeout: 10_000 });
  });
});
