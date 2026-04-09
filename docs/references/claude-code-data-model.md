# Claude Code Data Model & SDK Reference

> Last updated: 2026-04-09

This document captures our understanding of the `.claude/` directory structure and the Agent SDK's public API for reading session data. **We do NOT read raw files directly** — all access goes through SDK functions to avoid breakage on SDK upgrades.

## Directory Structure (informational only)

```
~/.claude/
├── projects/
│   └── <project-dir-name>/          # cwd with non-alphanum → '-'
│       ├── <sessionId>.jsonl         # Main session transcript
│       └── <sessionId>/
│           └── subagents/
│               └── agent-<agentId>.jsonl   # Subagent transcript
├── settings.json
└── ...
```

- `project-dir-name`: SDK mirrors the cwd path, replacing non-alphanumeric chars with `-`. Paths over 200 chars get a hash suffix.
- Each session has one JSONL file. Subagents get separate JSONL files under `<sessionId>/subagents/`.

## JSONL Entry Shape (raw, DO NOT read directly)

Each line in a JSONL file is a JSON object with at minimum:

| Field | Type | Notes |
|-------|------|-------|
| `type` | `'user' \| 'assistant' \| 'system'` | Message role |
| `uuid` | `string` | Unique message ID |
| `sessionId` | `string` | Parent session UUID |
| `parentUuid` | `string \| null` | Chain link for conversation threading |
| `timestamp` | `number` | ms since epoch |
| `message` | `object` | Anthropic API message (content blocks, model, usage, etc.) |
| `isSidechain` | `boolean` | `true` for subagent entries in the parent JSONL (rare) |
| `toolUseResult` | `object \| undefined` | Present on user messages that are Agent tool results |
| `toolUseResult.agentId` | `string` | SDK-internal subagent ID |
| `toolUseResult.status` | `string` | `'completed' \| 'failed' \| 'stopped'` |
| `toolUseResult.totalToolUseCount` | `number` | How many tools the subagent used |

System entries with `subtype: 'compact_boundary'` mark compaction epochs.

## SDK Public API

### Session Listing

```typescript
import { listSessions, getSessionInfo } from '@anthropic-ai/claude-agent-sdk';

// List all sessions (sorted by lastModified desc)
const sessions: SDKSessionInfo[] = await listSessions({ dir?: string, limit?: number, offset?: number });

// Get single session metadata (faster than listing all)
const info: SDKSessionInfo | undefined = await getSessionInfo(sessionId, { dir?: string });
```

**`SDKSessionInfo` fields:**
- `sessionId`, `summary`, `lastModified`, `fileSize?`, `customTitle?`, `firstPrompt?`, `gitBranch?`, `cwd?`, `tag?`, `createdAt?`

### Reading Messages

```typescript
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';

const messages: SessionMessage[] = await getSessionMessages(sessionId, {
  dir?: string,
  limit?: number,
  offset?: number,
  includeSystemMessages?: boolean,  // default false
});
```

**`SessionMessage` fields** (SDK strips raw fields via internal transform):
- `type`: `'user' | 'assistant' | 'system'`
- `uuid`: string
- `session_id`: string
- `message`: unknown (the Anthropic API message object)
- `parent_tool_use_id`: null (always null — hardcoded by SDK transform)
- `timestamp?`: number

**Important:** The SDK transform (`cz()`) discards `isSidechain`, `toolUseResult`, `agentId`, and other raw fields. Only the fields above are available through the public API.

**Compaction behavior:** `getSessionMessages` follows the `parentUuid` chain, which stops at `compact_boundary` entries. Only messages from the current compaction epoch are returned. Use `includeSystemMessages: true` to see system entries.

### Subagents

```typescript
import { listSubagents, getSubagentMessages } from '@anthropic-ai/claude-agent-sdk';

// List subagent IDs for a session
const agentIds: string[] = await listSubagents(sessionId, { dir?: string });

// Read a subagent's conversation
const msgs: SessionMessage[] = await getSubagentMessages(sessionId, agentId, {
  dir?: string,
  limit?: number,
  offset?: number,
});
```

### Session Mutation

```typescript
import { renameSession, tagSession, forkSession } from '@anthropic-ai/claude-agent-sdk';

await renameSession(sessionId, 'New Title', { dir?: string });
await tagSession(sessionId, 'my-tag', { dir?: string });  // null to remove
const { sessionId: newId } = await forkSession(sessionId, {
  dir?: string,
  upToMessageId?: string,  // slice transcript up to this UUID
  title?: string,
});
```

### Session Lifecycle (V2 Unstable)

```typescript
import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
} from '@anthropic-ai/claude-agent-sdk';

const session = unstable_v2_createSession({ model, ... });
const resumed = unstable_v2_resumeSession(sessionId, { model, ... });
```

## What the SDK Does NOT Expose

These fields exist in raw JSONL but are stripped by the SDK reader:

| Raw Field | Workaround |
|-----------|------------|
| `toolUseResult.agentId` | Derive from `tool_use name=Agent` / `tool_result` pairs in message content |
| `toolUseResult.totalToolUseCount` | Not available through SDK; streaming events provide this live |
| `toolUseResult.status` | Infer from presence of `tool_result` matching the Agent `tool_use` |
| `isSidechain` | Filter on SDK results (field may still be present but always check) |
| `parentUuid` chain | SDK handles internally for message ordering |

## Design Decisions

- **No raw JSONL reading.** All session data access goes through SDK functions. This insulates us from internal format changes across SDK versions.
- **Subagent blocks derived from message content.** Since `toolUseResult.agentId` isn't available via SDK, we identify subagent invocations by finding `tool_use` blocks with `name === 'Agent'` in assistant messages, then match them to `tool_result` blocks in subsequent user messages.
- **Cold pending detection.** We detect pending permission requests by checking if the last message from `getSessionMessages` (or `getSubagentMessages`) is an assistant message ending with a `tool_use` block that has no corresponding `tool_result`.
