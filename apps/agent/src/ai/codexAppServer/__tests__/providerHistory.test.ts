// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from 'vitest';

import type { ResumeSessionOpts, StartSessionOpts } from '../../provider.js';
import {
  buildThreadResumeParams,
  buildThreadStartParams,
  codexSkillsToSlashCommands,
  hydrateThreadItems,
  isUnsupportedCodexMethod,
  projectCodexThreadCards,
  readCodexHistoryPage,
  subagentThreadSnapshot,
} from '../provider.js';
import type { SkillsListResponse } from '../schema/generated/v2/SkillsListResponse.js';
import type { Thread } from '../schema/generated/v2/Thread.js';

describe('CodexAppServerProvider history persistence', () => {
  it('uses the legacy history path only for a missing app-server method', () => {
    expect(isUnsupportedCodexMethod({ code: -32601 })).toBe(true);
    expect(isUnsupportedCodexMethod({ code: -32000 })).toBe(false);
    expect(isUnsupportedCodexMethod(new Error('thread/items/list is not supported yet'))).toBe(false);
  });

  it('does not send removed legacy history flags when starting a thread', () => {
    const opts: StartSessionOpts = {
      prompt: 'start',
      cwd: '/tmp/quicksave-codex-history',
      permissionLevel: 'default',
      sandboxed: true,
    };

    expect(buildThreadStartParams(opts)).not.toHaveProperty('persistExtendedHistory');
    expect(buildThreadStartParams(opts)).not.toHaveProperty('experimentalRawEvents');
  });

  it('passes Fast mode to thread/start', () => {
    const params = buildThreadStartParams({
      prompt: 'start',
      cwd: '/tmp/quicksave-codex-fast',
      permissionLevel: 'default',
      sandboxed: true,
      serviceTier: 'fast',
    });
    expect(params.serviceTier).toBe('fast');
  });

  it('does not send removed legacy history flags when resuming a thread', () => {
    const opts: ResumeSessionOpts = {
      sessionId: 'thr_history',
      prompt: 'continue',
      cwd: '/tmp/quicksave-codex-history',
      permissionLevel: 'default',
      sandboxed: true,
    };

    expect(buildThreadResumeParams(opts)).not.toHaveProperty('persistExtendedHistory');
    expect(buildThreadResumeParams(opts)).not.toHaveProperty('excludeTurns');
  });

  it('passes Fast mode to thread/resume', () => {
    const params = buildThreadResumeParams({
      sessionId: 'thr_fast',
      prompt: 'continue',
      cwd: '/tmp/quicksave-codex-fast',
      permissionLevel: 'default',
      sandboxed: true,
      serviceTier: 'fast',
    });
    expect(params.serviceTier).toBe('fast');
  });

  it('maps enabled Codex skills to slash command suggestions', () => {
    const response: SkillsListResponse = {
      data: [
        {
          cwd: '/repo',
          errors: [],
          skills: [
            {
              name: '/imagegen',
              description: 'Generate images',
              shortDescription: 'Legacy visual generation',
              interface: {
                shortDescription: 'Create visual assets',
                defaultPrompt: 'Use the imagegen skill.',
              },
              path: '/skills/imagegen/SKILL.md',
              scope: 'system',
              enabled: true,
            },
            {
              name: 'disabled',
              description: 'Do not show this',
              path: '/skills/disabled/SKILL.md',
              scope: 'system',
              enabled: false,
            },
          ],
        },
      ],
    };

    expect(codexSkillsToSlashCommands(response, '/repo')).toEqual([
      {
        name: 'imagegen',
        description: 'Create visual assets',
        source: 'codex-skill',
      },
    ]);
  });

  it('falls back to all Codex skill entries when the preferred cwd has none', () => {
    const response: SkillsListResponse = {
      data: [
        {
          cwd: '/other',
          errors: [],
          skills: [
            {
              name: 'openai-docs',
              description: 'Official OpenAI docs',
              path: '/skills/openai-docs/SKILL.md',
              scope: 'system',
              enabled: true,
            },
          ],
        },
      ],
    };

    expect(codexSkillsToSlashCommands(response, '/repo')).toEqual([
      {
        name: 'openai-docs',
        description: 'Official OpenAI docs',
        source: 'codex-skill',
      },
    ]);
  });
});

describe('readCodexHistoryPage', () => {
  const paginatedThread = {
    id: 'thr-page', historyMode: 'paginated', turns: [],
  } as unknown as Thread;
  const turn = {
    id: 'turn-newest', items: [], itemsView: 'notLoaded', status: 'completed',
    error: null, startedAt: 1, completedAt: 2, durationMs: 1,
  } as unknown as Thread['turns'][number];

  it('loads only the requested native turn page and returns its opaque cursor', async () => {
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'thread/read') return { thread: paginatedThread };
      if (method === 'thread/turns/list') {
        expect(params).toMatchObject({ threadId: 'thr-page', limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
        return { data: [turn], nextCursor: 'next-native-turn', backwardsCursor: null };
      }
      if (method === 'thread/items/list') {
        expect(params).toMatchObject({ threadId: 'thr-page', turnId: 'turn-newest', sortDirection: 'asc' });
        return {
          data: [{ turnId: 'turn-newest', item: { type: 'agentMessage', id: 'msg-1', text: 'Newest reply' } }],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      throw new Error(`unexpected ${method}`);
    });
    const handle = { cliVersion: '0.153.4', rpc: { request } } as never;

    const page = await readCodexHistoryPage(handle, {
      sessionId: 'thr-page', cwd: '/repo', offset: 0, limit: 1,
    });

    expect(page.cards).toHaveLength(1);
    expect(page.cards[0]).toMatchObject({ id: 'thr-page:codex:turn-newest:1', text: 'Newest reply' });
    expect(page.total).toBeUndefined();
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toMatch(/^codex-turn-page:/);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'thread/read', 'thread/turns/list', 'thread/items/list',
    ]);
  });

  it('uses turns/list with full items for legacy threads, without items/list', async () => {
    const legacyThread = { ...paginatedThread, historyMode: 'legacy' } as Thread;
    const fullTurn = {
      ...turn,
      itemsView: 'full',
      items: [{ type: 'agentMessage', id: 'legacy-msg', text: 'Legacy reply' }],
    } as unknown as Thread['turns'][number];
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'thread/read') return { thread: legacyThread };
      if (method === 'thread/turns/list') {
        expect(params).toMatchObject({ itemsView: 'full', sortDirection: 'desc' });
        return { data: [fullTurn], nextCursor: null, backwardsCursor: null };
      }
      throw new Error(`unexpected ${method}`);
    });
    const handle = { cliVersion: '0.153.4', rpc: { request } } as never;

    const page = await readCodexHistoryPage(handle, {
      sessionId: 'thr-page', cwd: '/repo', offset: 0, limit: 1,
    });

    expect(page.cards[0]).toMatchObject({ id: 'thr-page:codex:turn-newest:1', text: 'Legacy reply' });
    expect(request.mock.calls.map(([method]) => method)).toEqual(['thread/read', 'thread/turns/list']);
  });
});

describe('subagentThreadSnapshot', () => {
  it('hydrates paginated item entries into their matching turns', () => {
    const thread = { id: 'child-thread', turns: [] } as unknown as Thread;
    const turn = {
      id: 'turn-1', items: [], itemsView: 'notLoaded', status: 'completed',
      error: null, startedAt: 0, completedAt: 1, durationMs: 1,
    } as unknown as Thread['turns'][number];
    const item = { type: 'agentMessage', id: 'message-1', text: 'Done.' };

    expect(hydrateThreadItems(thread, [turn], [{ turnId: 'turn-1', item } as never])).toMatchObject({
      turns: [{ id: 'turn-1', itemsView: 'full', items: [item] }],
    });
  });

  it('includes dynamic tools and web searches in sub-agent activity', () => {
    const thread = {
      id: 'child-thread',
      preview: 'Inspect the repository',
      agentNickname: 'Euler',
      agentRole: null,
      status: { type: 'idle' },
      turns: [{
        items: [
          {
            type: 'dynamicToolCall',
            id: 'dynamic-1',
            namespace: null,
            tool: 'exec',
            arguments: { cmd: 'rg -n TODO apps' },
            status: 'completed',
            contentItems: [{ type: 'inputText', text: 'apps/example.ts:10:TODO' }],
            success: true,
            durationMs: 12,
          },
          {
            type: 'webSearch',
            id: 'search-1',
            query: '',
            action: { type: 'search', query: 'Codex app-server tools', queries: null },
          },
        ],
      }],
    } as unknown as Thread;

    expect(subagentThreadSnapshot(thread).activities).toEqual([
      {
        id: 'dynamic-1',
        type: 'tool',
        title: 'exec',
        detail: 'apps/example.ts:10:TODO',
        status: 'completed',
      },
      {
        id: 'search-1',
        type: 'tool',
        title: 'Web search',
        detail: 'Codex app-server tools',
        status: 'completed',
      },
    ]);
  });
});

describe('projectCodexThreadCards', () => {
  it('builds final cards from durable items without relying on stream deltas', () => {
    const thread = {
      id: 'thr-history',
      turns: [{ id: 'turn-1', startedAt: 1, items: [
        { type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: 'Inspect this repo' }] },
        { type: 'commandExecution', id: 'cmd-1', command: 'git status --short', aggregatedOutput: ' M app.ts', status: 'completed' },
        { type: 'agentMessage', id: 'message-1', text: 'The repo has one changed file.' },
      ] }],
    } as unknown as Thread;

    const cards = projectCodexThreadCards('thr-history', '/repo', thread);
    expect(cards.map((card) => card.type)).toEqual(['user', 'tool_call', 'assistant_text']);
    expect(cards[0]).toMatchObject({ text: 'Inspect this repo', turnId: 'turn-1' });
    expect(cards[2]).toMatchObject({ text: 'The repo has one changed file.', streaming: false });
  });
});
