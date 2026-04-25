/**
 * Check whether a tool call matches a Claude Code allow-list pattern,
 * and generate suggested patterns from a tool call.
 *
 * Pattern formats follow Claude Code's `settings.json` permission rules
 * (validated by the SDK's `lY1` rule validator):
 *
 *   - `ToolName`                       — matches all invocations of that tool
 *   - `Bash(prefix:*)`                 — legacy command-prefix match (e.g. `Bash(npm:*)` → `npm install`)
 *   - `Bash(npm run *)`                — wildcard match anywhere in the command
 *   - `WebFetch(domain:host)`          — exact host match (`*` allowed in host: `domain:*.example.com`)
 *   - `Read(./relative/**)` / `Read(//absolute/**)` — file-glob match (`//` prefix = absolute path)
 *   - `WebSearch`                      — pattern not supported by SDK; only the bare form
 */
export function matchAllowPattern(
  pattern: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): boolean {
  // Parse pattern: "ToolName" or "ToolName(arg)"
  const parenIdx = pattern.indexOf('(');
  if (parenIdx === -1) {
    // Simple tool name match — allow all invocations
    return pattern === toolName;
  }

  const patternTool = pattern.slice(0, parenIdx);
  if (patternTool !== toolName) return false;

  // Extract the argument pattern (strip trailing ')')
  const argPattern = pattern.slice(parenIdx + 1, pattern.endsWith(')') ? -1 : undefined);

  if (toolName === 'Bash') {
    const command = (toolInput.command as string | undefined)?.trim();
    if (!command) return false;
    // Refuse to auto-match if the command contains shell metacharacters that
    // could chain or redirect execution. We can't safely parse shell syntax,
    // so fall through to the permission prompt.
    if (hasShellMetachars(command)) return false;
    return matchBashPattern(argPattern, command);
  }

  if (toolName === 'WebFetch') {
    const url = toolInput.url as string | undefined;
    if (!url) return false;
    return matchWebFetchPattern(argPattern, url);
  }

  if (FILE_PATTERN_TOOLS.has(toolName)) {
    const filePath = getFilePath(toolName, toolInput);
    if (!filePath) return false;
    return matchFilePattern(argPattern, filePath);
  }

  return false;
}

const FILE_PATTERN_TOOLS = new Set([
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'NotebookRead',
  'Glob',
]);

/** Extract the file path from a file-pattern-tool's input. */
function getFilePath(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === 'NotebookEdit' || toolName === 'NotebookRead') {
    return (input.notebook_path as string) ?? null;
  }
  if (toolName === 'Glob') {
    // Glob's primary input is `pattern`; matched directly as a file pattern.
    return (input.pattern as string) ?? null;
  }
  return ((input.file_path ?? input.path) as string) ?? null;
}

/**
 * Match a Bash command against a permission pattern.
 *
 * Two pattern syntaxes are supported (matching SDK behaviour):
 *  - Legacy prefix:   `prefix:*` — matches if the command equals `prefix` or starts with `prefix `.
 *                     Everything before `:*` is a literal prefix; embedded spaces are allowed
 *                     (e.g. `git diff:*` matches `git diff --staged`).
 *  - Wildcard:        any pattern using `*` — matches with `*` spanning any characters.
 */
function matchBashPattern(argPattern: string, command: string): boolean {
  if (argPattern.endsWith(':*')) {
    const prefix = argPattern.slice(0, -2);
    if (!prefix) return false; // `:*` alone is invalid per SDK
    return command === prefix || command.startsWith(prefix + ' ');
  }
  // Wildcard match. For Bash, `*` should span any characters (including '/'
  // and spaces) so that patterns like `Bash(npm run *)` match
  // `npm run test --watch`.
  return wildcardMatch(argPattern, command, { crossSegments: true });
}

/**
 * Match a WebFetch URL against a `domain:host` pattern.
 *
 * The host portion supports `*` wildcards (e.g. `domain:*.example.com`).
 * The pattern must use the `domain:` prefix; the SDK validator rejects
 * raw URL patterns.
 */
function matchWebFetchPattern(argPattern: string, url: string): boolean {
  if (!argPattern.startsWith('domain:')) return false;
  const hostPattern = argPattern.slice('domain:'.length);
  if (!hostPattern) return false;
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  return wildcardMatch(hostPattern, hostname);
}

/**
 * Match a file path against a permission pattern.
 *
 * Patterns may use:
 *  - `//absolute/path/**` — leading `//` denotes an absolute path; the extra
 *    slash is stripped before comparison so it matches values like `/absolute/path/file`.
 *  - `./relative/path/**` — project-relative; matched literally against the
 *    input value (which may already include `./`).
 *  - `~/home/relative` — left as-is; the matcher is not cwd-aware so user-edited
 *    `~` patterns will only match if the input value also begins with `~`.
 */
function matchFilePattern(argPattern: string, filePath: string): boolean {
  let pattern = argPattern;
  if (pattern.startsWith('//')) {
    pattern = pattern.slice(1); // // → / (absolute path convention)
  }
  return wildcardMatch(pattern, filePath);
}

/** Returns true if the command contains shell metacharacters that could chain
 *  or redirect execution. If so, we refuse to auto-allow — the user must
 *  approve via the permission prompt. */
function hasShellMetachars(command: string): boolean {
  // Strip quoted strings (single and double) to avoid false positives
  // on metacharacters inside quotes like: echo "hello && world"
  const stripped = command
    .replace(/"(?:[^"\\]|\\.)*"/g, '')   // remove double-quoted
    .replace(/'[^']*'/g, '');             // remove single-quoted
  // Check for shell operators: && || ; | > >> < << $( ` { }
  return /&&|\|\||[;|`]|[<>]{1,2}|\$\(|\{.*\}/.test(stripped);
}

/**
 * Simple wildcard matcher.
 *
 * - `**` matches any characters (across `/`).
 * - `*`  matches any characters within a single path segment by default
 *   (i.e. excludes `/`). Pass `crossSegments: true` to make `*` span any chars,
 *   which is the right semantic for Bash commands and domain hostnames.
 */
function wildcardMatch(
  pattern: string,
  value: string,
  opts: { crossSegments?: boolean } = {},
): boolean {
  const singleStar = opts.crossSegments ? '.*' : '[^/]*';
  // Convert wildcard pattern to regex. Escape regex specials, then convert
  // `**` and `*` to regex equivalents.
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape regex chars (not * and ?)
    .replace(/\*\*/g, '\0')                  // placeholder for **
    .replace(/\*/g, singleStar)              // * = single segment (or any)
    .replace(/\0/g, '.*');                   // ** = any
  return new RegExp(`^${regex}$`).test(value);
}

/**
 * Generate a suggested allow-list wildcard pattern from a tool call.
 *
 * Returned patterns conform to Claude Code's `settings.json` allow-rule syntax
 * (validated by the SDK):
 *   - `Bash(cmd:*)`                  — legacy command-prefix match
 *   - `WebFetch(domain:host)`        — host match (no scheme/path)
 *   - `Read(//absolute/dir/**)`      — recursive glob, `//` prefix = absolute
 *   - `Read(./relative/dir/**)`      — recursive glob, project-relative
 *   - `ToolName`                     — allow all invocations
 */
export function generateAllowPattern(
  toolName: string,
  toolInput: Record<string, unknown>,
): string {
  switch (toolName) {
    case 'WebFetch': {
      const raw = toolInput.url as string | undefined;
      if (!raw) return toolName;
      try {
        const u = new URL(raw);
        return `WebFetch(domain:${u.hostname})`;
      } catch {
        return 'WebFetch';
      }
    }

    case 'WebSearch':
      // SDK validator rejects WebSearch patterns containing `*` or `?`.
      // We don't have a meaningful query-prefix to suggest, so allow all.
      return 'WebSearch';

    case 'Bash': {
      const cmd = toolInput.command as string | undefined;
      if (!cmd) return toolName;
      const firstWord = cmd.trim().split(/\s+/)[0];
      if (!firstWord) return toolName;
      return `Bash(${firstWord}:*)`;
    }

    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
    case 'NotebookRead': {
      const filePath = getFilePath(toolName, toolInput);
      if (!filePath) return toolName;
      const dir = filePath.replace(/\/[^/]+$/, '');
      // Double-slash prefix for absolute paths (Claude Code convention)
      const normalized = dir.startsWith('/') ? `/${dir}` : dir;
      return `${toolName}(${normalized}/**)`;
    }

    default:
      return toolName;
  }
}
