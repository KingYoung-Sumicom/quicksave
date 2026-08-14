// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import type { Card, SubagentCard } from '@sumicom/quicksave-shared';
import { useClaudeStore } from '../../stores/claudeStore';
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
    useClaudeStore.getState().setCards([
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
      useClaudeStore.getState().reset();
    }
  });
});
