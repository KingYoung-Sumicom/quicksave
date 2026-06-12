// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import type { ResumeSessionOpts, StartSessionOpts } from '../../provider.js';
import { buildThreadResumeParams, buildThreadStartParams, codexSkillsToSlashCommands } from '../provider.js';
import type { SkillsListResponse } from '../schema/generated/v2/SkillsListResponse.js';

describe('CodexAppServerProvider history persistence', () => {
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
