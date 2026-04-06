# Claude Agent SDK Tool Schemas (v0.2.91)

Source: `@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts`

## Tool Name Mapping (SDK name → Tool name in stream)

| SDK Interface | Tool Name |
|---|---|
| FileReadInput/Output | Read |
| FileEditInput/Output | Edit |
| FileWriteInput/Output | Write |
| BashInput/Output | Bash |
| GrepInput/Output | Grep |
| GlobInput/Output | Glob |
| AgentInput/Output | Agent |
| TodoWriteInput/Output | TodoWrite |
| WebFetchInput/Output | WebFetch |
| WebSearchInput/Output | WebSearch |
| NotebookEditInput/Output | NotebookEdit |
| AskUserQuestionInput/Output | AskUserQuestion |
| ExitPlanModeInput/Output | ExitPlanMode |
| TaskOutputInput | TaskOutput |
| TaskStopInput/Output | TaskStop |
| McpInput | Mcp (dynamic MCP tools) |
| ListMcpResourcesInput | ListMcpResources |
| ReadMcpResourceInput/Output | ReadMcpResource |
| ConfigInput/Output | Config |
| EnterWorktreeInput/Output | EnterWorktree |
| ExitWorktreeInput/Output | ExitWorktree |

Note: `EnterPlanMode`, `Skill`, and `ToolSearch` do not appear in sdk-tools.d.ts — they may be internal tools without formal schema.

## Key Schemas (Simplified)

### AskUserQuestionInput
```typescript
{
  questions: Array<{  // 1-4 questions
    question: string;
    header: string;   // max 12 chars chip label
    options: Array<{  // 2-4 options
      label: string;
      description: string;
      preview?: string;  // optional code/mockup preview
    }>;
    multiSelect: boolean;
  }>;
}
```

### AskUserQuestionOutput
```typescript
{
  questions: Array<{ question, header, options[], multiSelect }>;  // echoed back
  answers: { [questionText: string]: string };  // user's selected option label(s), comma-separated for multi-select
  annotations?: { [questionText: string]: { preview?: string; notes?: string } };
}
```

### TodoWriteInput
```typescript
{
  todos: Array<{
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
    activeForm: string;
  }>;
}
```

### TodoWriteOutput
```typescript
{
  oldTodos: Array<{ content, status, activeForm }>;
  newTodos: Array<{ content, status, activeForm }>;
  verificationNudgeNeeded?: boolean;
}
```

### ExitPlanModeOutput
```typescript
{
  plan: string | null;
  isAgent: boolean;
  filePath?: string;
  hasTaskTool?: boolean;
  planWasEdited?: boolean;
  awaitingLeaderApproval?: boolean;
  requestId?: string;
}
```

### BashOutput
```typescript
{
  stdout: string;
  stderr: string;
  interrupted: boolean;
  backgroundTaskId?: string;
  // ... many optional fields
}
```

### FileEditOutput
```typescript
{
  filePath: string;
  oldString: string;
  newString: string;
  originalFile: string;
  structuredPatch: Array<{ oldStart, oldLines, newStart, newLines, lines: string[] }>;
  userModified: boolean;
  replaceAll: boolean;
  gitDiff?: { filename, status, additions, deletions, changes, patch };
}
```

### AgentOutput
```typescript
// Completed agent
{
  agentId: string;
  agentType?: string;
  content: Array<{ type: 'text'; text: string }>;
  totalToolUseCount: number;
  totalDurationMs: number;
  totalTokens: number;
  usage: { input_tokens, output_tokens, ... };
  status: 'completed';
  prompt: string;
}
// OR async launched
{
  status: 'async_launched';
  agentId: string;
  description: string;
  prompt: string;
  outputFile?: string;
}
```
