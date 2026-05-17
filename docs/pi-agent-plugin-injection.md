# Pi Agent Plugin Injection

How to inject custom plugins (extensions) into the Pi coding agent at startup, including Quicksave's permission control plugin.

## Table of Contents

- [Extension System Overview](#extension-system-overview)
- [Three Injection Methods](#three-injection-methods)
  - [Method 1: CLI `--extensions` Flag](#method-1-cli---extensions-flag)
  - [Method 2: Global Extension Directory](#method-2-global-extension-directory)
  - [Method 3: Programmatic `extensionFactories`](#method-3-programmatic-extensionfactories)
- [Extension Anatomy](#extension-anatomy)
  - [ExtensionFactory](#extensionfactory)
  - [ExtensionAPI Surface](#extensionapi-surface)
  - [ExtensionContext](#extensioncontext)
- [Quicksave Plugin Architecture](#quicksave-plugin-architecture)
  - [Permission Modes](#permission-modes)
  - [Plugin Lifecycle](#plugin-lifecycle)
  - [Implementation Strategy](#implementation-strategy)
- [Event Types Reference](#event-types-reference)
- [Loading Order and Precedence](#loading-order-and-precedence)
- [Error Handling](#error-handling)
- [RPC Mode Considerations](#rpc-mode-considerations)

---

## Extension System Overview

Pi extensions are TypeScript modules that can:

- Subscribe to agent lifecycle events (`on()` for events like `session_start`, `tool_call`, `context`, etc.)
- Register LLM-callable tools (`registerTool()`)
- Register commands, keyboard shortcuts, and CLI flags (`registerCommand()`, `registerShortcut()`, `registerFlag()`)
- Interact with the user via UI primitives (`ctx.ui.select()`, `ctx.ui.confirm()`, etc.)
- Inject provider configurations (`registerProvider()`)
- Modify the system prompt (`before_agent_start`)
- Intercept and mutate tool calls (`tool_call`)

### Extension Discovery Locations

Pi scans three locations for extensions, in this order:

```
1. Project-local:   <cwd>/.pi/extensions/
2. Global:          $PI_CODING_AGENT_DIR/extensions/
3. Explicit paths:  --extensions <path> [--extensions <path> ...]
```

Each location is scanned for:
- `*.ts` or `*.js` files (loaded directly)
- Subdirectories with `index.ts`/`index.js`
- Subdirectories with `package.json` containing `pi.extensions` field

---

## Three Injection Methods

### Method 1: CLI `--extensions` Flag

**Best for:** Quicksave's per-session plugin injection.

Pi accepts the `--extensions <path>` flag. Paths can be absolute or relative (resolved against `cwd`). Directories are auto-discovered.

```bash
pi --extensions /path/to/my-plugin.ts --extensions /path/to/another-plugin.ts
```

In Quicksave's `piProvider.ts`:

```typescript
// piProvider.ts
const extensionArgs = [
  ...this.pluginPaths,  // [ '--extensions', '/path/to/quicksave-permission.ts', ... ]
];

const rpcClient = new RpcClient({
  args: extensionArgs,
  // ...
});
```

**Pros:**
- Plugin path passed at session startup — no filesystem writes needed
- Each session can have different plugins
- No persistence concerns

**Cons:**
- Plugin source must be shipped with Quicksave (bundled in npm package)
- Must be written to disk or inlined at startup

### Method 2: Global Extension Directory

**Best for:** User-installed extensions, persistent across all Pi usage.

If `$PI_CODING_AGENT_DIR/extensions/` is set and scanned, extensions placed there are auto-discovered.

**Problem for Quicksave:** Quicksave sets `PI_CODING_AGENT_DIR` to a **per-session ephemeral directory**:

```
<run-dir>/pi-sessions/{sessionId}/
  └── extensions/          ← deleted when session ends
```

Using this path means plugins vanish between sessions.

**Workaround:** Write the plugin to a **permanent** location:

```
~/.quicksave/pi-plugins/
  ├── quicksave-permission.ts
  └── quicksave-approval.ts
```

Then set `PI_CODING_AGENT_DIR` to point at that permanent directory:

```typescript
const globalExtensionsDir = path.join(os.homedir(), '.quicksave', 'pi-plugins');
// Or better: pass --extensions instead (Method 1)
```

### Method 3: Programmatic `extensionFactories`

**Best for:** Advanced scenarios (e.g., dynamic plugin generation, hot-reload).

The `main()` entry point accepts an `options` parameter:

```typescript
// In main.ts
export interface MainOptions {
  extensionFactories?: ExtensionFactory[];
}

export async function main(args: string[], options?: MainOptions) {
  // ...
  const services = await createAgentSessionServices({
    // ...
    resourceLoaderOptions: {
      extensionFactories: options?.extensionFactories,
    },
  });
}
```

This bypasses the filesystem entirely — factory functions are called directly.

**Limitation for Quicksave:** Quicksave launches Pi via `child_process.spawn()` (RPC mode), not by calling `main()` directly. This injection point is only usable when Quicksave runs as a **child process** of Pi, not the other way around. **Not applicable to Quicksave.**

---

## Extension Anatomy

### ExtensionFactory

An extension is a TypeScript file that **exports a default factory function**:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI): void {
  // Registration calls (synchronous)
  pi.registerTool({...});
  pi.registerCommand("my-cmd", {...});
  pi.registerFlag("my-flag", {
    type: "boolean",
    default: false,
    description: "Enable feature X"
  });
  pi.on("session_start", async (event, ctx) => {
    // Event handlers (async)
  });
}
```

The factory is loaded via **jiti** (a JIT TypeScript compiler). It can import:
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-tui`
- `@earendil-works/pi-ai`
- `@earendil-works/pi-ai/oauth`
- `typebox` and its subpaths

### ExtensionAPI Surface

| Category | Method | Purpose |
|----------|--------|---------|
| **Events** | `on(event, handler)` | Subscribe to 25+ event types |
| **Tools** | `registerTool(toolDef)` | Register LLM-callable tools |
| **Commands** | `registerCommand(name, options)` | Register slash commands (`/my-cmd`) |
| **Shortcuts** | `registerShortcut(keyId, options)` | Register keyboard shortcuts |
| **Flags** | `registerFlag(name, options)` | Register CLI flags |
| **Rendering** | `registerMessageRenderer(type, renderer)` | Custom message UI rendering |
| **Messaging** | `sendMessage(msg, opts)` | Send custom message to session |
| **Messaging** | `sendUserMessage(content, opts)` | Send user message, triggers turn |
| **State** | `appendEntry(type, data)` | Persist data to session (not sent to LLM) |
| **Session** | `setSessionName(name)` | Set session display name |
| **Session** | `setLabel(id, label)` | Label a session entry |
| **Execution** | `exec(cmd, args, opts)` | Execute shell command |
| **Tools** | `getActiveTools()` / `setActiveTools(names)` | Get/set active tools |
| **Models** | `getModel()` / `setModel(model)` | Get/set current model |
| **Thinking** | `getThinkingLevel()` / `setThinkingLevel(level)` | Get/set thinking level |
| **Providers** | `registerProvider(name, config)` | Register/override API provider |
| **Providers** | `unregisterProvider(name)` | Remove provider |
| **Events** | `events: EventBus` | Shared event bus for communication |

### ExtensionContext

Passed to event handlers and command callbacks:

| Property | Type | Description |
|----------|------|-------------|
| `ctx.ui` | `ExtensionUIContext` | User interaction primitives |
| `ctx.hasUI` | `boolean` | True in interactive mode |
| `ctx.cwd` | `string` | Current working directory |
| `ctx.sessionManager` | `ReadonlySessionManager` | Session tree operations |
| `ctx.model` | `Model<any> \| undefined` | Current model |
| `ctx.isIdle()` | `() => boolean` | Agent not streaming? |
| `ctx.signal` | `AbortSignal \| undefined` | Current abort signal |
| `ctx.abort()` | `() => void` | Abort current operation |
| `ctx.getContextUsage()` | `() => ContextUsage \| undefined` | Token usage stats |
| `ctx.compact()` | `(opts?) => void` | Trigger context compaction |
| `ctx.getSystemPrompt()` | `() => string` | Current effective system prompt |

Extended `ExtensionCommandContext` adds:
- `ctx.waitForIdle()` — wait for streaming to finish
- `ctx.newSession(opts)` — start new session
- `ctx.fork(entryId, opts)` — fork from an entry
- `ctx.navigateTree(targetId, opts)` — navigate session tree
- `ctx.switchSession(path, opts)` — switch sessions
- `ctx.reload()` — reload all resources

---

## Quicksave Plugin Architecture

### Permission Modes

Quicksave needs to inject a permission plugin that supports three modes:

| Mode | Behavior |
|------|----------|
| **auto** | Tool calls execute silently without user confirmation |
| **ask** | Show confirmation dialog before each tool call |
| **yolo** | Execute all tool calls without any confirmation |

### Plugin Lifecycle

```
1. Quicksave daemon starts
2. User creates session with agent="pi"
3. piProvider.setupSession():
   a. Write permission plugin to bundled path (or install to ~/.quicksave/pi-plugins/)
   b. Add --extensions flag to spawn args
4. Pi spawns via RPC
5. Pi CLI main() parses --extensions
6. ResourceLoader.discoverAndLoadExtensions() scans paths
7. loadExtension() for each plugin:
   a. jiti loads the TypeScript file
   b. Calls factory(pi: ExtensionAPI)
   c. Extension registers tools/flags/event handlers
8. Plugin begins intercepting events
```

### Implementation Strategy

The permission plugin should:

1. **Register CLI flags** so the daemon can configure permission mode:
```typescript
pi.registerFlag("quicksave-permission-mode", {
  type: "string",
  default: "ask",
  description: "Permission mode: auto, ask, yolo"
});
```

2. **Intercept tool calls** via `tool_call` event:
```typescript
pi.on("tool_call", async (event, ctx) => {
  const mode = pi.getFlag("quicksave-permission-mode");
  
  if (mode === "ask") {
    // Show confirmation UI
    const confirmed = await ctx.ui.confirm(
      `Execute ${event.toolName}?`,
      JSON.stringify(event.input, null, 2)
    );
    if (!confirmed) {
      return { block: true, reason: "User denied" };
    }
  }
  // auto/yolo: proceed silently
});
```

3. **Subscribe to `before_agent_start`** to inject system prompt guidance:
```typescript
pi.on("before_agent_start", async (event, ctx) => {
  const mode = pi.getFlag("quicksave-permission-mode");
  const prompt = `\n\nPermission Mode: ${mode}\n`;
  return { systemPrompt: event.systemPrompt + prompt };
});
```

4. **Handle `tool_execution_start` / `tool_execution_end`** for logging/audit.

### File Placement

The plugin should be bundled in the `@earendil-works/pi-coding-agent` npm package:

```
packages/coding-agent/src/extensions/
  └── quicksave-permission.ts    # Permission control plugin
  └── quicksave-approval.ts      # User approval workflow (optional)
```

And copied during build:

```json
// packages/coding-agent/package.json scripts
"copy-assets": "shx mkdir -p dist/extensions && shx cp src/extensions/*.ts dist/extensions/"
```

Quicksave references it at runtime:

```typescript
// piProvider.ts (in apps/agent)
const pluginPath = path.join(
  require.resolve("@earendil-works/pi-coding-agent"),
  "..",
  "dist",
  "extensions",
  "quicksave-permission.ts"
);
```

### Alternative: Standalone NPM Package

If the plugin should be independent from the Pi package, publish it as a separate npm package:

```
@quicksave/pi-permission-plugin
├── package.json
├── src/permission.ts
└── dist/permission.js        # Published
```

Quicksave adds it to `--extensions`:

```bash
pi --extensions @quicksave/pi-permission-plugin
```

This follows the npm extension pattern Pi supports via `packageManager.resolveExtensionSources()`.

---

## Event Types Reference

### Session Events

| Event | Fired When | Result Support |
|-------|-----------|----------------|
| `session_start` | New session loaded/restarted | No |
| `session_before_switch` | Before switching sessions | `cancel?: boolean` |
| `session_before_fork` | Before forking a session | `cancel?: boolean` |
| `session_before_compact` | Before context compaction | `cancel?: boolean`, `compaction?: CompactionResult` |
| `session_compact` | After compaction | No |
| `session_shutdown` | Session tearing down (quit/reload/replacement) | No |
| `session_before_tree` | Before tree navigation | `cancel?: boolean` |
| `session_tree` | After tree navigation | No |

### Agent Events

| Event | Fired When | Result Support |
|-------|-----------|----------------|
| `context` | Before each LLM call | `messages?: AgentMessage[]` |
| `before_provider_request` | Before sending to API | `unknown` |
| `after_provider_response` | After API response | No |
| `before_agent_start` | User submits prompt, before loop | `message?`, `systemPrompt?` |
| `agent_start` | Agent loop begins | No |
| `agent_end` | Agent loop ends | No |
| `turn_start` | Each turn begins | No |
| `turn_end` | Each turn ends | No |
| `message_start` | Message begins (any type) | No |
| `message_update` | Token-by-token streaming | No |
| `message_end` | Message finalized | `message?: AgentMessage` |

### Tool Events

| Event | Fired When | Result Support |
|-------|-----------|----------------|
| `tool_call` | **Before** tool executes | `block?: boolean, reason?: string` |
| `tool_result` | **After** tool executes | `content?`, `details?`, `isError?` |
| `tool_execution_start` | Tool execution begins | No |
| `tool_execution_update` | Streaming output from tool | No |
| `tool_execution_end` | Tool finishes | No |

### Other Events

| Event | Fired When | Result Support |
|-------|-----------|----------------|
| `user_bash` | User runs `!command` | `operations?`, `result?` |
| `input` | User types input | `action: "continue" \| "transform" \| "handled"` |
| `model_select` | Model changed | No |
| `thinking_level_select` | Thinking level changed | No |
| `resources_discover` | Session startup/reload | `skillPaths?`, `promptPaths?`, `themePaths?` |

---

## Loading Order and Precedence

Extensions are loaded in this order (later extensions take precedence for conflicts):

1. **Project-local** (`<cwd>/.pi/extensions/`) — discovered first
2. **Global** (`$agentDir/extensions/`) — discovered second
3. **Explicit paths** (`--extensions`) — discovered last, highest precedence

For conflicting registrations (same tool name, same command name), the **later-loaded extension wins** and a diagnostic error is logged.

Example precedence for tool overrides:

```
quicksave-permission.ts (via --extensions)   ← wins (loaded last)
~/.pi/extensions/user-tool.ts                 ← project-local (loaded 1st)
~/.pi/agent/extensions/other-ext.ts          ← global (loaded 2nd)
```

---

## Error Handling

Extension loading errors are reported via:

1. **Load-time errors** (factory throws):
   ```json
   { "path": "/path/to/extension.ts", "error": "Failed to load extension: Module not found" }
   ```

2. **Registration errors** (same name conflict):
   ```json
   { "path": "/path/to/extension.ts", "error": "Tool 'read' already registered by builtin" }
   ```

3. **Event handler errors** (caught and logged, don't crash the agent):
   ```json
   { "extensionPath": "/path/to/extension.ts", "event": "tool_call", "error": "...", "stack": "..." }
   ```

4. **Diagnostics** reported via `resourceLoader.getExtensions().errors`:
   ```typescript
   const { errors, extensions } = resourceLoader.getExtensions();
   ```

---

## RPC Mode Considerations

When Pi runs in RPC mode (which Quicksave uses):

- **No interactive UI** — `ctx.ui.select()`, `ctx.ui.confirm()`, etc. return no user interaction
- **No TUI widgets** — `setFooter()`, `setHeader()`, `setWidget()` are no-ops
- **`ctx.hasUI` is `false`** — extensions should check this before using UI methods
- **Extensions still work** — `on()` event handlers fire, `registerTool()` works, tool calls execute normally

For permission plugins in RPC mode:

```typescript
pi.on("tool_call", async (event, ctx) => {
  const mode = pi.getFlag("quicksave-permission-mode");
  
  if (mode === "ask" && ctx.hasUI) {
    // Only show UI when not in RPC/daemon mode
    const confirmed = await ctx.ui.confirm("Execute?", "...");
    if (!confirmed) return { block: true };
  }
  // In RPC mode, always proceed (daemon controls permissions via config)
});
```

---

## Appendix: Example Permission Plugin

```typescript
/**
 * Quicksave Permission Plugin
 *
 * Intercepts tool calls and enforces permission modes:
 *   auto  - silent execution
 *   ask   - require confirmation (UI in interactive, logged in RPC)
 *   yolo  - no checks at all
 *
 * Usage:
 *   pi --extensions quicksave-permission.ts --quicksave-permission-mode ask
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function quicksavePermission(pi: ExtensionAPI): void {
  // Register the permission mode flag
  pi.registerFlag("quicksave-permission-mode", {
    type: "string",
    default: "ask",
    description: "Quicksave permission mode: auto, ask, yolo"
  });

  // Tool call interceptor
  pi.on("tool_call", async (event, ctx) => {
    const mode = pi.getFlag("quicksave-permission-mode") as string;

    // YOLO: always allow
    if (mode === "yolo") {
      return;
    }

    // AUTO: allow but log
    if (mode === "auto") {
      ctx.ui.notify(`[quicksave/auto] ${event.toolName} executing`, "info");
      return;
    }

    // ASK: require confirmation
    if (mode === "ask") {
      if (ctx.hasUI) {
        const confirmed = await ctx.ui.confirm(
          `Execute ${event.toolName}?`,
          `Arguments: ${JSON.stringify(event.input, null, 2)}`
        );
        if (!confirmed) {
          return { block: true, reason: "User denied in ask mode" };
        }
      } else {
        // RPC mode: log but proceed (daemon handles security)
        ctx.ui.notify(`[quicksave/ask] ${event.toolName} executed (RPC mode)`, "info");
      }
    }

    // Unknown mode: default to ask
    return;
  });

  // Also hook tool execution for logging
  pi.on("tool_execution_start", async (event) => {
    const mode = pi.getFlag("quicksave-permission-mode") as string;
    if (mode !== "yolo") {
      console.error(`[quicksave] ${event.toolName} started: ${JSON.stringify(event.args)}`);
    }
  });

  pi.on("tool_execution_end", async (event) => {
    const mode = pi.getFlag("quicksave-permission-mode") as string;
    if (mode !== "yolo") {
      console.error(`[quicksave] ${event.toolName} completed: isError=${event.isError}`);
    }
  });
}
```

---

## Appendix: Extension API Type Reference

### `registerFlag()`

```typescript
pi.registerFlag(name: string, options: {
  description?: string;
  type: "boolean" | "string";
  default?: boolean | string;
}): void;
```

Registered flags appear in CLI help (`pi --help`) and can be set via flags:

```bash
pi --quicksave-permission-mode yolo
```

### `registerTool()`

```typescript
import { Type } from "typebox";

pi.registerTool({
  name: "my-tool",
  label: "My Tool",
  description: "Does something cool",
  parameters: Type.Object({
    input: Type.String({ description: "Input parameter" })
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    return {
      content: [{ type: "text", text: "Result!" }],
      details: { success: true }
    };
  }
});
```

### `registerCommand()`

```typescript
pi.registerCommand("my-cmd", {
  description: "My custom command",
  handler: async (args, ctx) => {
    ctx.ui.notify(`Command called with: ${args}`, "info");
  }
});
```

### `on()` Event Handler

```typescript
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName === "bash") {
    // Block dangerous commands
    if (event.input.command.includes("rm -rf /")) {
      return { block: true, reason: "Dangerous command blocked" };
    }
  }
});
```

### `sendUserMessage()`

```typescript
// Inject a message that triggers the agent to do something
pi.sendUserMessage("Please summarize the current session.", {
  deliverAs: "followUp"  // queues during streaming or sends after
});
```

---

## Appendix: Quicksave Integration Checklist

For Quicksave's specific implementation:

- [ ] Bundle permission plugin in `@earendil-works/pi-coding-agent/dist/extensions/`
- [ ] Add `copy-assets` step to copy extensions to dist
- [ ] In `piProvider.ts`: resolve bundled plugin path
- [ ] Pass `--extensions <plugin-path>` to RPC client spawn args
- [ ] Pass `--quicksave-permission-mode <mode>` to RPC client spawn args
- [ ] Handle RPC mode (no UI, daemon-controlled permissions)
- [ ] Wire up daemon-to-provider communication for mode changes
- [ ] Test across session lifecycle (fork, resume, new session)
- [ ] Add error handling for missing plugin files
