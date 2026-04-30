#!/usr/bin/env python3
"""One-shot script to rewrite links after the docs rename to .zh-TW.md / .en.md.

Operates on three groups:
- .zh-TW.md sources: link to renamed sibling -> append .zh-TW.md
- .en.md translations: link to renamed sibling -> append .en.md
- external English-facing files: link to renamed file -> append .en.md
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Files that were renamed (basename only).
RENAMED_BASENAMES = [
    "sync-security",
    "2026-04-06-claude-code-tools-spec",
    "quicksave-architecture",
    "2026-04-21-sync-rearchitecture",
    "claude-message-types-reference",
    "cli-coding-agents-evaluation",
    "component-refactoring-guidelines",
    "openai-codex-sdk-types",
    "claude-agent-sdk-message-types",
    "2026-04-07-mobile-chat-layout-design",
]

ZH_TW_FILES = [
    "docs/guidelines/sync-security.zh-TW.md",
    "docs/research/2026-04-06-claude-code-tools-spec.zh-TW.md",
    "docs/references/quicksave-architecture.zh-TW.md",
    "docs/plans/2026-04-21-sync-rearchitecture.zh-TW.md",
    "docs/references/claude-message-types-reference.zh-TW.md",
    "docs/research/cli-coding-agents-evaluation.zh-TW.md",
    "docs/guidelines/component-refactoring-guidelines.zh-TW.md",
    "docs/references/openai-codex-sdk-types.zh-TW.md",
    "docs/references/claude-agent-sdk-message-types.zh-TW.md",
    "docs/plans/2026-04-07-mobile-chat-layout-design.zh-TW.md",
]

EN_FILES = [p.replace(".zh-TW.md", ".en.md") for p in ZH_TW_FILES]

# English-facing files that link to one of the renamed files.
EXTERNAL_FILES = [
    "CLAUDE.md",
    "README.md",
    "docs/guidelines.md",
    "docs/plans/2026-04-17-agentic-commit-message-plan.md",
    "docs/plans/2026-04-10-codex-integration-plan.md",
    "docs/references/codex-app-server/implementation-plan.md",
    "docs/plans/2026-04-13-sdk-v1-provider.md",
    "docs/plans/2026-04-13-provider-abstraction.md",
    "docs/plans/2026-04-11-query-api-migration.md",
    "apps/agent/README.md",
    "apps/pwa/README.md",
    "packages/shared/README.md",
    "apps/agent/src/handlers/legacyBusAdapter.ts",
]

# Match `<basename>.md` not already followed by another path segment
# and not already suffixed (e.g. don't match `foo.md.bak`).
def make_pattern(basename: str) -> re.Pattern[str]:
    return re.compile(rf"(?<![\w.-]){re.escape(basename)}\.md(?![\w.-])")


def rewrite(path: Path, suffix: str) -> int:
    text = path.read_text(encoding="utf-8")
    original = text
    count = 0
    for bn in RENAMED_BASENAMES:
        pat = make_pattern(bn)
        def sub(m: re.Match[str]) -> str:
            nonlocal count
            count += 1
            return f"{bn}{suffix}"
        text = pat.sub(sub, text)
    if text != original:
        path.write_text(text, encoding="utf-8")
    return count


def main() -> int:
    total_zh = total_en = total_ext = 0
    for p in ZH_TW_FILES:
        path = ROOT / p
        n = rewrite(path, ".zh-TW.md")
        total_zh += n
        print(f"  zh-TW {p}: {n} link(s) updated")
    for p in EN_FILES:
        path = ROOT / p
        n = rewrite(path, ".en.md")
        total_en += n
        print(f"  en    {p}: {n} link(s) updated")
    for p in EXTERNAL_FILES:
        path = ROOT / p
        if not path.exists():
            print(f"  (skip) {p}: not found")
            continue
        n = rewrite(path, ".en.md")
        total_ext += n
        print(f"  ext   {p}: {n} link(s) updated")
    print(f"\nTotals: zh-TW={total_zh}, en={total_en}, external={total_ext}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
