// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import type { Card, SubagentCard } from '@sumicom/quicksave-shared';
import { useSessionStore } from '../../stores/sessionStore';
import { collectSubagents, SubagentsPanel } from './SubagentsPanel';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function system(text: string, timestamp: number): Card {
  return { type: 'system', id: `system-${timestamp}`, timestamp, text, subtype: 'info' };
}

describe('collectSubagents', () => {
  it('recovers legacy activity cards and keeps the latest status per path', () => {
    const agents = collectSubagents([
      system('Sub-agent active: /root/route_candidate_tiers', 1),
      system('Sub-agent active: /root/bounded_cartesian', 2),
      system('Sub-agent interrupted: /root/route_candidate_tiers', 3),
    ]);

    expect(agents).toHaveLength(2);
    expect(agents[0]).toMatchObject({
      agentPath: '/root/route_candidate_tiers',
      status: 'stopped',
      statusMessage: 'Interrupted',
      activities: [
        expect.objectContaining({ title: 'Active' }),
        expect.objectContaining({ title: 'Interrupted' }),
      ],
    });
    expect(agents[1]).toMatchObject({
      agentPath: '/root/bounded_cartesian',
      status: 'running',
      statusMessage: 'Active',
      activities: [expect.objectContaining({ title: 'Active' })],
    });
  });

  it('keeps structured sub-agent details when a legacy status follows', () => {
    const structured: SubagentCard = {
      type: 'subagent',
      id: 'subagent-1',
      timestamp: 1,
      description: 'Route analysis',
      toolUseId: 'tool-1',
      agentId: 'agent-1',
      agentPath: '/root/route_candidate_tiers',
      status: 'running',
      statusMessage: 'Started',
      toolUseCount: 2,
      activities: [{ id: 'activity-1', type: 'tool', title: 'Search' }],
    };

    expect(collectSubagents([
      structured,
      system('Sub-agent interrupted: /root/route_candidate_tiers', 2),
    ])).toEqual([expect.objectContaining({
      id: 'subagent-1',
      status: 'stopped',
      toolUseCount: 2,
      activities: [
        expect.objectContaining({ id: 'activity-1', title: 'Search' }),
        expect.objectContaining({ id: 'system-2', title: 'Interrupted' }),
      ],
    })]);
  });

  it('ignores unrelated system messages', () => {
    expect(collectSubagents([system('Context compacted', 1)])).toEqual([]);
  });

  it('expands a legacy item into visible status and activity details', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    useSessionStore.getState().setCards([
      system('Sub-agent active: /root/route_candidate_tiers', Date.now()),
    ]);

    try {
      await act(async () => root.render(React.createElement(SubagentsPanel)));
      const item = container.querySelector('button');
      expect(item).not.toBeNull();
      await act(async () => item?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

      expect(container.textContent).toContain('Status');
      expect(container.textContent).toContain('Active');
      expect(container.textContent).toContain('/root/route_candidate_tiers');
      expect(container.textContent).toContain('Detailed activity is unavailable');
    } finally {
      await act(async () => root.unmount());
      container.remove();
      useSessionStore.getState().reset();
    }
  });

  it('uses session cards for structured agents, collapsible tools, and pending permission actions', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const responses: unknown[] = [];
    useSessionStore.getState().setCards([{
      type: 'subagent',
      id: 'subagent-1',
      timestamp: Date.now(),
      description: 'Investigate the route',
      toolUseId: 'tool-use-1',
      agentId: 'agent-1',
      agentPath: '/tmp/agent-1',
      status: 'running',
      statusMessage: 'Working',
      toolUseCount: 1,
      activities: [
        { id: 'activity-message', type: 'message', title: 'Response', detail: 'first-message', status: 'completed' },
        { id: 'activity-reasoning', type: 'reasoning', title: 'Reasoning', detail: 'second-reasoning', status: 'completed' },
        { id: 'activity-tool', type: 'tool', title: 'npm test', detail: 'tool-output', status: 'completed' },
        { id: 'activity-response-2', type: 'message', title: 'Response', detail: 'third-message', status: 'completed' },
      ],
      pendingInput: {
        sessionId: 'session-1',
        requestId: 'request-1',
        inputType: 'permission',
        title: 'Allow command?',
        message: 'The agent wants to run a command.',
      },
    }]);

    try {
      await act(async () => root.render(React.createElement(SubagentsPanel, {
        onRespondToUserInput: (response) => responses.push(response),
      })));
      const buttons = [...container.querySelectorAll('button')];
      await act(async () => buttons[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

      expect(container.textContent).toContain('Investigate the route');
      expect(container.textContent).toContain('first-message');
      expect(container.textContent).toContain('2 turn items');
      expect(container.textContent).toContain('third-message');
      expect(container.textContent).toContain('Allow command?');
      expect(container.textContent).toContain('/tmp/agent-1');
      expect(container.textContent).not.toContain('second-reasoning');
      expect(container.textContent).not.toContain('tool-output');

      const groupToggle = container.querySelector('button[aria-label="Show 2 hidden turn items"]');
      expect(groupToggle).not.toBeNull();
      await act(async () => groupToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      expect(container.textContent).toContain('second-reasoning');
      expect(container.textContent).toContain('npm test');
      expect(container.textContent!.indexOf('second-reasoning')).toBeLessThan(container.textContent!.indexOf('npm test'));
      expect(container.textContent!.indexOf('npm test')).toBeLessThan(container.textContent!.indexOf('third-message'));

      const toolToggle = [...container.querySelectorAll('button[aria-expanded="false"]')]
        .find((button) => button.textContent?.includes('npm test'));
      expect(toolToggle).not.toBeNull();
      await act(async () => toolToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      expect(container.textContent).toContain('tool-output');

      const allow = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Allow');
      expect(allow).toBeDefined();
      await act(async () => allow?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      expect(responses).toEqual([expect.objectContaining({
        sessionId: 'session-1',
        requestId: 'request-1',
        action: 'allow',
      })]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      useSessionStore.getState().reset();
    }
  });
});
