// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { ComponentType, ReactNode } from 'react';
import { ReadToolView } from './ReadToolView';
import { EditToolView } from './EditToolView';
import { WriteToolView } from './WriteToolView';
import { BashToolView } from './BashToolView';
import { GrepToolView } from './GrepToolView';
import { GlobToolView } from './GlobToolView';
import { WebFetchToolView } from './WebFetchToolView';
import { WebSearchToolView } from './WebSearchToolView';
import { SkillToolView } from './SkillToolView';
import { AgentToolView } from './AgentToolView';
import { TodoWriteToolView } from './TodoWriteToolView';
import { NotebookEditToolView } from './NotebookEditToolView';
import { AskUserQuestionToolView } from './AskUserQuestionToolView';
import { EnterPlanModeToolView, ExitPlanModeToolView } from './PlanModeToolView';
import { ToolSearchToolView } from './ToolSearchToolView';

export type ToolViewProps = {
  input: Record<string, unknown>;
  headerSuffix?: ReactNode;
  /** Tool's result content when available. Optional fallback for views like
   *  WebSearch whose toolInput can be empty on historical/legacy cards but
   *  whose result text still carries the meaningful payload (e.g.
   *  `Search: <query>`). Most views ignore this. */
  resultContent?: string;
};

export const TOOL_VIEWS: Record<string, ComponentType<ToolViewProps>> = {
  Read: ReadToolView,
  Edit: EditToolView,
  Write: WriteToolView,
  Bash: BashToolView,
  Grep: GrepToolView,
  Glob: GlobToolView,
  WebFetch: WebFetchToolView,
  WebSearch: WebSearchToolView,
  Skill: SkillToolView,
  Agent: AgentToolView,
  TodoWrite: TodoWriteToolView,
  NotebookEdit: NotebookEditToolView,
  AskUserQuestion: AskUserQuestionToolView,
  EnterPlanMode: EnterPlanModeToolView as ComponentType<ToolViewProps>,
  ExitPlanMode: ExitPlanModeToolView,
  ToolSearch: ToolSearchToolView,
};

/** Tool-specific accent colors for the left border */
export const TOOL_COLORS: Record<string, string> = {
  Read: 'border-blue-500/60',
  Edit: 'border-yellow-500/60',
  Write: 'border-green-500/60',
  Bash: 'border-orange-500/60',
  Grep: 'border-purple-500/60',
  Glob: 'border-purple-500/60',
  WebFetch: 'border-cyan-500/60',
  WebSearch: 'border-cyan-500/60',
  Skill: 'border-indigo-500/60',
  Agent: 'border-violet-500/60',
  TodoWrite: 'border-teal-500/60',
  NotebookEdit: 'border-amber-500/60',
  AskUserQuestion: 'border-blue-500/60',
  EnterPlanMode: 'border-indigo-500/60',
  ExitPlanMode: 'border-indigo-500/60',
  ToolSearch: 'border-pink-500/60',
};
