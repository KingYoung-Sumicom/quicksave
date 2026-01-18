#!/usr/bin/env python3
"""
Claude Code PermissionRequest hook for auto-approving build commands.
Accepts most TypeScript, pnpm, and npm build/test requests.
"""
import json
import sys
import re


def main():
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        # If we can't parse input, fall through to user prompt
        output = {
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "decision": {"behavior": "ask"}
            }
        }
        print(json.dumps(output))
        return

    tool_name = input_data.get("tool_name", "")
    tool_input = input_data.get("tool_input", {})
    command = tool_input.get("command", "")

    # Patterns to auto-approve (using regex)
    SAFE_PATTERNS = [
        # pnpm commands
        r"^pnpm install($|\s)",
        r"^pnpm run (build|test|lint|typecheck|dev|start)",
        r"^pnpm -r build",
        r"^pnpm (build|test|lint)",
        # npm commands
        r"^npm install($|\s)",
        r"^npm run (build|test|lint|typecheck|dev|start)",
        r"^npm (build|test|lint)",
        # TypeScript
        r"^tsc($|\s)",
        r"^npx tsc",
        # Common dev tools
        r"^node ",
        r"^bun ",
        r"^deno ",
        # Git read-only
        r"^git (status|log|diff|branch|show|ls-files)",
    ]

    def is_safe(cmd):
        for pattern in SAFE_PATTERNS:
            if re.match(pattern, cmd):
                return True
        return False

    if tool_name == "Bash" and is_safe(command):
        output = {
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "decision": {"behavior": "allow"}
            }
        }
    else:
        # Fall through to user prompt for unknown commands
        output = {
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "decision": {"behavior": "ask"}
            }
        }

    print(json.dumps(output))


if __name__ == "__main__":
    main()
