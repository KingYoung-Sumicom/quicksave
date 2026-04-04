import { type ComponentType } from 'react';
import { ReadToolView } from './toolViews/ReadToolView';
import { EditToolView } from './toolViews/EditToolView';
import { WriteToolView } from './toolViews/WriteToolView';
import { BashToolView } from './toolViews/BashToolView';
import { GrepToolView } from './toolViews/GrepToolView';
import { GlobToolView } from './toolViews/GlobToolView';
import { WebFetchToolView } from './toolViews/WebFetchToolView';
import { WebSearchToolView } from './toolViews/WebSearchToolView';
import { SkillToolView } from './toolViews/SkillToolView';
import { FallbackToolView } from './toolViews/FallbackToolView';

const TOOL_VIEWS: Record<string, ComponentType<{ input: Record<string, unknown> }>> = {
  Read: ReadToolView,
  Edit: EditToolView,
  Write: WriteToolView,
  Bash: BashToolView,
  Grep: GrepToolView,
  Glob: GlobToolView,
  WebFetch: WebFetchToolView,
  WebSearch: WebSearchToolView,
  Skill: SkillToolView,
};

export function ToolCallMessage({ toolName, toolInput, content }: {
  toolName?: string;
  toolInput?: string;
  content: string;
}) {
  let parsedInput: Record<string, unknown> = {};
  try {
    parsedInput = JSON.parse(toolInput || content || '{}');
  } catch {
    // fallback to empty
  }

  const ToolView = toolName ? TOOL_VIEWS[toolName] : undefined;

  return (
    <div className="flex justify-start">
      <div className="bg-slate-700/50 border border-slate-600 rounded-lg px-3 py-2 max-w-[85%] text-xs text-slate-300 overflow-hidden">
        <div className="flex items-start gap-1.5">
          <svg className="w-3 h-3 text-slate-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
          </svg>
          <div className="flex-1 min-w-0">
            {ToolView
              ? <ToolView input={parsedInput} />
              : <FallbackToolView toolName={toolName} content={toolInput || content} />}
          </div>
        </div>
      </div>
    </div>
  );
}
