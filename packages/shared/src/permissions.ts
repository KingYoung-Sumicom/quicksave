/**
 * Check whether a tool call matches a Claude Code allow-list pattern.
 *
 * Pattern formats:
 *   - `ToolName`              — matches all invocations of that tool
 *   - `ToolName(pattern)`     — matches the tool's primary input against pattern
 *   - `*` in pattern          — matches any characters within a single path/command segment
 *   - `**` in pattern         — matches any characters across segments (recursive)
 *   - For Bash, `:` separates command words: `Bash(docker:*)` matches `docker compose up`
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

  // Get the tool's primary input value
  const inputValue = getPrimaryInput(toolName, toolInput);
  if (inputValue === null) return false;

  // For Bash: if the command contains shell metacharacters (chaining, piping,
  // redirection, subshells, etc.), refuse to auto-match — fall through to
  // permission prompt. Trying to split/parse shell syntax ourselves would
  // inevitably diverge from real bash behavior and create security holes.
  if (toolName === 'Bash') {
    if (hasShellMetachars(inputValue)) return false;
    const normalized = inputValue.trim().replace(/\s+/g, ':');
    return wildcardMatch(argPattern, normalized);
  }

  return wildcardMatch(argPattern, inputValue);
}

/** Extract the primary input value used for pattern matching. */
function getPrimaryInput(toolName: string, input: Record<string, unknown>): string | null {
  switch (toolName) {
    case 'Bash':
      return (input.command as string) ?? null;
    case 'WebFetch':
      return (input.url as string) ?? null;
    case 'WebSearch':
      return (input.query as string) ?? null;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return ((input.file_path ?? input.path) as string) ?? null;
    default:
      return null;
  }
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

/** Simple wildcard matcher supporting `*` (single segment) and `**` (recursive). */
function wildcardMatch(pattern: string, value: string): boolean {
  // Convert wildcard pattern to regex
  // Escape regex special chars, then convert wildcards
  let regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape regex chars (not * and ?)
    .replace(/\*\*/g, '\0')                  // placeholder for **
    .replace(/\*/g, '[^/]*')                 // * = anything except /
    .replace(/\0/g, '.*');                   // ** = anything
  return new RegExp(`^${regex}$`).test(value);
}

/**
 * Generate a suggested allow-list wildcard pattern from a tool call.
 *
 * The returned string follows the Claude Code `settings.local.json` syntax:
 *   - `Bash(cmd:*)`           — command-prefix match
 *   - `WebFetch(https://host/path/*)`  — URL-prefix match
 *   - `Read(//absolute/dir/**)`        — recursive glob
 *   - `ToolName`                       — allow all invocations
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
        // Keep origin + first path segment, wildcard the rest
        const segments = u.pathname.split('/').filter(Boolean);
        const prefix = segments.length > 0 ? `/${segments[0]}` : '';
        return `WebFetch(${u.origin}${prefix}/*)`;
      } catch {
        return `WebFetch(${raw})`;
      }
    }

    case 'WebSearch':
      // Queries aren't pattern-matchable, allow all searches
      return 'WebSearch';

    case 'Bash': {
      const cmd = toolInput.command as string | undefined;
      if (!cmd) return toolName;
      const firstWord = cmd.trim().split(/\s+/)[0];
      return `Bash(${firstWord}:*)`;
    }

    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit': {
      const filePath = (toolInput.file_path ?? toolInput.path) as string | undefined;
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
