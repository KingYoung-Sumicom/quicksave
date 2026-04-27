#!/usr/bin/env bash
# Regenerate the vendored Codex app-server TypeScript schema.
#
#   pnpm --filter @sumicom/quicksave run regen-codex-schema
#   ./apps/agent/scripts/regen-codex-schema.sh
#
# Strategy: vendor the entire `v2/` subtree (it's the live API surface),
# plus a whitelist of top-level shared files that we either consume
# directly or that v2/ files import from `../`. This keeps the schema
# maintainable — adding a new dispatch entry usually doesn't require
# editing this script.
#
# After bumping the codex CLI:
#   1. Run this script.
#   2. Update CODEX_SCHEMA_PINNED_VERSION in
#      apps/agent/src/ai/codexAppServer/version.ts.
#   3. Review the diff under apps/agent/src/ai/codexAppServer/schema/generated/.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DEST="$REPO_ROOT/apps/agent/src/ai/codexAppServer/schema/generated"

# Top-level files to vendor. v2/ files often `import ... from "../<Name>"`,
# so we need transitively-required top-level files here too.
TOP_LEVEL=(
  "RequestId.ts"
  "ClientInfo.ts"
  "ClientNotification.ts"
  "ClientRequest.ts"
  "InitializeCapabilities.ts"
  "InitializeParams.ts"
  "InitializeResponse.ts"
  "ServerNotification.ts"
  "ServerRequest.ts"
  "AbsolutePathBuf.ts"
  "Personality.ts"
  "ServiceTier.ts"
  "ReasoningEffort.ts"
  "ReasoningSummary.ts"
  "MessagePhase.ts"
  "ResponseItem.ts"
  "AgentPath.ts"
  "ApplyPatchApprovalParams.ts"
  "ApplyPatchApprovalResponse.ts"
  "ExecCommandApprovalParams.ts"
  "ExecCommandApprovalResponse.ts"
  "FuzzyFileSearchParams.ts"
  "FuzzyFileSearchResponse.ts"
  "FuzzyFileSearchResult.ts"
  "FuzzyFileSearchMatchType.ts"
  "FuzzyFileSearchSessionUpdatedNotification.ts"
  "FuzzyFileSearchSessionCompletedNotification.ts"
  "GetAuthStatusParams.ts"
  "GetAuthStatusResponse.ts"
  "GetConversationSummaryParams.ts"
  "GetConversationSummaryResponse.ts"
  "GitDiffToRemoteParams.ts"
  "GitDiffToRemoteResponse.ts"
  "GitSha.ts"
  "GhostCommit.ts"
  "ConversationGitInfo.ts"
  "ConversationSummary.ts"
  "AuthMode.ts"
  "ContentItem.ts"
  "ImageDetail.ts"
  "InputModality.ts"
  "LocalShellAction.ts"
  "LocalShellExecAction.ts"
  "LocalShellStatus.ts"
  "FunctionCallOutputBody.ts"
  "FunctionCallOutputContentItem.ts"
  "ForcedLoginMethod.ts"
  "ParsedCommand.ts"
  "PlanType.ts"
  "RealtimeConversationVersion.ts"
  "RealtimeOutputModality.ts"
  "RealtimeVoice.ts"
  "RealtimeVoicesList.ts"
  "ReasoningItemContent.ts"
  "ReasoningItemReasoningSummary.ts"
  "Resource.ts"
  "ResourceContent.ts"
  "ResourceTemplate.ts"
  "ReviewDecision.ts"
  "SessionSource.ts"
  "Settings.ts"
  "SubAgentSource.ts"
  "ThreadId.ts"
  "ThreadMemoryMode.ts"
  "Tool.ts"
  "Verbosity.ts"
  "WebSearchAction.ts"
  "WebSearchContextSize.ts"
  "WebSearchLocation.ts"
  "WebSearchMode.ts"
  "WebSearchToolConfig.ts"
  "FileChange.ts"
  "ExecPolicyAmendment.ts"
  "NetworkPolicyAmendment.ts"
  "CollaborationMode.ts"
  "ModeKind.ts"
  "NetworkPolicyRuleAction.ts"
)

if ! command -v codex >/dev/null; then
  echo "error: 'codex' CLI not found on PATH. Install codex 0.125.0+ first." >&2
  exit 1
fi

CLI_VERSION="$(codex --version 2>/dev/null | awk '{print $NF}')"
PINNED_VERSION="$(grep -oE "CODEX_SCHEMA_PINNED_VERSION = '[^']+'" "$REPO_ROOT/apps/agent/src/ai/codexAppServer/version.ts" | sed -E "s/.*= '([^']+)'.*/\1/")"

echo "codex CLI version: $CLI_VERSION"
echo "schema pin:        $PINNED_VERSION"
if [ "$CLI_VERSION" != "$PINNED_VERSION" ]; then
  echo "warning: CLI version differs from the pin. Update CODEX_SCHEMA_PINNED_VERSION after committing." >&2
fi

TMP="$(mktemp -d -t codex-schema.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

echo "Generating schema → $TMP …"
codex app-server generate-ts --out "$TMP"

echo "Copying schema → $DEST …"
mkdir -p "$DEST/v2" "$DEST/serde_json"

# Wipe top-level + v2 + serde_json so deletions are visible in git diff.
# Keep README.md, index.ts, and the v2/index.ts barrel.
find "$DEST" -maxdepth 1 -type f -name '*.ts' ! -name 'index.ts' -delete
find "$DEST/v2" -maxdepth 1 -type f -name '*.ts' ! -name 'index.ts' -delete
find "$DEST/serde_json" -maxdepth 1 -type f -name '*.ts' -delete

# Rewrite imports — both top-level and v2/ files are missing `.js` extensions
# in their relative imports, but our NodeNext resolution requires them.
rewrite_imports() {
  local file="$1"
  sed -i \
    -e 's|from "\(\.\./\?\)\([^"]\+\)"|from "\1\2.js"|g' \
    -e 's|from "\(\./\)\([^"]\+\)"|from "\1\2.js"|g' \
    "$file"
}

# Top-level whitelist
for entry in "${TOP_LEVEL[@]}"; do
  src="$TMP/$entry"
  if [ ! -f "$src" ]; then
    echo "  ! whitelist miss: $entry (not produced; remove from TOP_LEVEL)" >&2
    continue
  fi
  cp "$src" "$DEST/$entry"
  rewrite_imports "$DEST/$entry"
done
echo "  + ${#TOP_LEVEL[@]} top-level files"

# All of v2/
v2_count=0
for src in "$TMP/v2"/*.ts; do
  base="$(basename "$src")"
  cp "$src" "$DEST/v2/$base"
  rewrite_imports "$DEST/v2/$base"
  v2_count=$((v2_count + 1))
done
echo "  + $v2_count v2/ files"

# serde_json/JsonValue.ts (referenced from many v2 files)
if [ -f "$TMP/serde_json/JsonValue.ts" ]; then
  cp "$TMP/serde_json/JsonValue.ts" "$DEST/serde_json/JsonValue.ts"
  rewrite_imports "$DEST/serde_json/JsonValue.ts"
  echo "  + serde_json/JsonValue.ts"
fi

echo
echo "Done. Review changes with: git diff -- '$DEST'"
