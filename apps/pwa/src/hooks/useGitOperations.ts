// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useCallback, useRef } from 'react';
import {
  type StatusResponsePayload,
  type DiffResponsePayload,
  type StageResponsePayload,
  type StagePatchResponsePayload,
  type CommitResponsePayload,
  type LogResponsePayload,
  type BranchesResponsePayload,
  type CheckoutResponsePayload,
  type DiscardResponsePayload,
  type UntrackResponsePayload,
  type GitignoreAddResponsePayload,
  type GitignoreReadResponsePayload,
  type GitignoreWriteResponsePayload,
  type GenerateCommitSummaryResponsePayload,
  type ClearCommitSummaryResponsePayload,
  type SetApiKeyResponsePayload,
  type GetApiKeyStatusResponsePayload,
  type ListReposResponsePayload,
  type SwitchRepoResponsePayload,
  type BrowseDirectoryResponsePayload,
  type AddRepoResponsePayload,
  type AddCodingPathResponsePayload,
  type RemoveRepoResponsePayload,
  type RemoveCodingPathResponsePayload,
  type CloneRepoResponsePayload,
  type SubmodulesResponsePayload,
  type AgentCheckUpdateResponsePayload,
  type AgentUpdateResponsePayload,
  type AgentRestartResponsePayload,
  type GitConfigGetResponsePayload,
  type GitConfigSetResponsePayload,
  type Repository,
  type CodingPath,
  type ClaudeModel,
} from '@sumicom/quicksave-shared';
import type { MessageBusClient } from '@sumicom/quicksave-message-bus';
import { useConnectionStore } from '../stores/connectionStore';
import { useGitStore, makeSelectionKey, type SelectionSource } from '../stores/gitStore';
import { WebSocketClient } from '../lib/websocket';

/**
 * Sentinel thrown when a request is dropped because the user has switched
 * repo or agent before the response arrived. Callers should swallow these —
 * they are not user-facing errors.
 */
export const SUPERSEDED_ERROR = 'SUPERSEDED';
const isSuperseded = (error: unknown): boolean =>
  error instanceof Error && error.message === SUPERSEDED_ERROR;

/**
 * Marker attached to a git:* in-flight bus command so `cancelPendingGit` can
 * flag it as superseded without having to cancel the underlying bus promise
 * (the bus client does not expose cancellation).
 */
type InFlightGit = { superseded: boolean };

export function useGitOperations(
  clientRef: React.RefObject<WebSocketClient | null>,
  getBus: () => MessageBusClient | null,
) {
  const inFlightGit = useRef<Set<InFlightGit>>(new Set());
  const {
    setStatus,
    setFileDiff,
    setDiffLoading,
    setCommits,
    setBranches,
    setLoading,
    setError,
    clearCommitForm,
    applyCommitSummaryState,
    resetAiSummaryLocal,
    applyAiSummaryLocal,
    setApiKeyConfigured,
    setCurrentRepoPath,
    clearSelection,
    selectedModel,
    attributionEnabled,
    commitSummarySource,
  } = useGitStore();
  const { setRepoPath, setAvailableRepos, setAvailableCodingPaths, availableCodingPaths } = useConnectionStore();

  /**
   * Issue a bus command. For `git:*` verbs:
   *  - Stamps the current repoPath into the payload via the reserved
   *    `__repoPath` field so the agent's REPO_MISMATCH guard can compare.
   *  - Snapshots active agent + repo at send time and re-checks them at
   *    resolve time — if the user switched workspace while the command was in
   *    flight, rejects with `SUPERSEDED_ERROR` so the caller can silently drop
   *    the result instead of overwriting the new workspace's store.
   *  - Translates the agent's `REPO_MISMATCH: ...` error into `SUPERSEDED`
   *    for the same reason.
   *  - Strips the server-echoed `__repoPath` from the data before returning.
   */
  const sendCommand = useCallback(
    <T>(verb: string, payload: unknown, timeoutMs = 30000): Promise<T> => {
      const bus = getBus();
      if (!bus) return Promise.reject(new Error('Not connected'));

      const isGit = verb.startsWith('git:');
      const snapshotAgentId = clientRef.current?.getActiveAgentId() ?? null;
      const snapshotRepoPath = useGitStore.getState().currentRepoPath;
      const entry: InFlightGit = { superseded: false };
      if (isGit) inFlightGit.current.add(entry);

      let wirePayload: unknown = payload;
      if (isGit && snapshotRepoPath) {
        wirePayload = { ...(payload as object), __repoPath: snapshotRepoPath };
      }

      return bus
        .command<unknown>(verb, wirePayload, { timeoutMs, queueWhileDisconnected: true })
        .then((result) => {
          if (!isGit) return result as T;
          inFlightGit.current.delete(entry);
          const currentAgent = clientRef.current?.getActiveAgentId() ?? null;
          const currentRepo = useGitStore.getState().currentRepoPath;
          const responseRepo =
            result && typeof result === 'object' && '__repoPath' in result
              ? (result as { __repoPath?: string }).__repoPath ?? null
              : null;
          const stale =
            entry.superseded ||
            currentAgent !== snapshotAgentId ||
            currentRepo !== snapshotRepoPath ||
            (responseRepo !== null && responseRepo !== snapshotRepoPath);
          if (stale) throw new Error(SUPERSEDED_ERROR);
          if (result && typeof result === 'object' && '__repoPath' in result) {
            const { __repoPath: _omit, ...rest } = result as Record<string, unknown>;
            void _omit;
            return rest as T;
          }
          return result as T;
        })
        .catch((err) => {
          if (isGit) inFlightGit.current.delete(entry);
          if (err instanceof Error) {
            if (err.message.startsWith('REPO_MISMATCH')) throw new Error(SUPERSEDED_ERROR);
            if (isGit && entry.superseded) throw new Error(SUPERSEDED_ERROR);
          }
          throw err;
        });
    },
    [getBus, clientRef],
  );

  /**
   * Mark every in-flight git:* command as superseded. Called before switching
   * repo or active agent so late-arriving responses from the previous
   * workspace are discarded instead of overwriting the new one's store.
   */
  const cancelPendingGit = useCallback(() => {
    for (const entry of inFlightGit.current) entry.superseded = true;
    inFlightGit.current.clear();
  }, []);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const response = await sendCommand<StatusResponsePayload>('git:status', {});
      setStatus(response);
    } catch (error) {
      if (isSuperseded(error)) return;
      setError(error instanceof Error ? error.message : 'Failed to fetch status');
    } finally {
      setLoading(false);
    }
  }, [sendCommand, setStatus, setLoading, setError]);

  const fetchDiff = useCallback(
    async (path: string, staged = false, source?: SelectionSource) => {
      const key = makeSelectionKey(path, source ?? (staged ? 'staged' : 'unstaged'));
      setDiffLoading(key, true);
      try {
        const response = await sendCommand<DiffResponsePayload>('git:diff', { path, staged });
        setFileDiff(key, response);
      } catch (error) {
        setDiffLoading(key, false);
        if (isSuperseded(error)) return;
        setError(error instanceof Error ? error.message : 'Failed to fetch diff');
      }
    },
    [sendCommand, setFileDiff, setDiffLoading, setError]
  );

  const stageFiles = useCallback(
    async (paths: string[]) => {
      setLoading(true);
      try {
        const response = await sendCommand<StageResponsePayload>('git:stage', { paths });
        if (!response.success) {
          throw new Error(response.error || 'Failed to stage files');
        }
        await fetchStatus();
      } catch (error) {
        if (isSuperseded(error)) return;
        setError(error instanceof Error ? error.message : 'Failed to stage files');
      } finally {
        setLoading(false);
      }
    },
    [sendCommand, fetchStatus, setLoading, setError]
  );

  const unstageFiles = useCallback(
    async (paths: string[]) => {
      setLoading(true);
      try {
        const response = await sendCommand<StageResponsePayload>('git:unstage', { paths });
        if (!response.success) {
          throw new Error(response.error || 'Failed to unstage files');
        }
        await fetchStatus();
      } catch (error) {
        if (isSuperseded(error)) return;
        setError(error instanceof Error ? error.message : 'Failed to unstage files');
      } finally {
        setLoading(false);
      }
    },
    [sendCommand, fetchStatus, setLoading, setError]
  );

  const stagePatch = useCallback(
    async (patch: string) => {
      setLoading(true);
      try {
        const response = await sendCommand<StagePatchResponsePayload>('git:stage-patch', { patch });
        if (!response.success) {
          throw new Error(response.error || 'Failed to stage patch');
        }
        await fetchStatus();
      } catch (error) {
        if (isSuperseded(error)) return;
        setError(error instanceof Error ? error.message : 'Failed to stage patch');
      } finally {
        setLoading(false);
      }
    },
    [sendCommand, fetchStatus, setLoading, setError]
  );

  const unstagePatch = useCallback(
    async (patch: string) => {
      setLoading(true);
      try {
        const response = await sendCommand<StagePatchResponsePayload>('git:unstage-patch', { patch });
        if (!response.success) {
          throw new Error(response.error || 'Failed to unstage patch');
        }
        await fetchStatus();
      } catch (error) {
        if (isSuperseded(error)) return;
        setError(error instanceof Error ? error.message : 'Failed to unstage patch');
      } finally {
        setLoading(false);
      }
    },
    [sendCommand, fetchStatus, setLoading, setError]
  );

  const commit = useCallback(
    async (commitMessage: string, description?: string) => {
      setLoading(true);
      try {
        const response = await sendCommand<CommitResponsePayload>('git:commit', {
          message: commitMessage,
          description,
          attribution: attributionEnabled,
        });
        if (!response.success) {
          throw new Error(response.error || 'Failed to commit');
        }
        clearCommitForm();
        await fetchStatus();
        return response.hash;
      } catch (error) {
        if (isSuperseded(error)) throw error;
        setError(error instanceof Error ? error.message : 'Failed to commit');
        throw error;
      } finally {
        setLoading(false);
      }
    },
    [sendCommand, fetchStatus, clearCommitForm, setLoading, setError, attributionEnabled]
  );

  const fetchLog = useCallback(
    async (limit = 50) => {
      setLoading(true);
      try {
        const response = await sendCommand<LogResponsePayload>('git:log', { limit });
        setCommits(response.commits);
      } catch (error) {
        if (isSuperseded(error)) return;
        setError(error instanceof Error ? error.message : 'Failed to fetch log');
      } finally {
        setLoading(false);
      }
    },
    [sendCommand, setCommits, setLoading, setError]
  );

  const fetchBranches = useCallback(async () => {
    setLoading(true);
    try {
      const response = await sendCommand<BranchesResponsePayload>('git:branches', {});
      setBranches(response.branches, response.current);
    } catch (error) {
      if (isSuperseded(error)) return;
      setError(error instanceof Error ? error.message : 'Failed to fetch branches');
    } finally {
      setLoading(false);
    }
  }, [sendCommand, setBranches, setLoading, setError]);

  const checkout = useCallback(
    async (branch: string, create = false) => {
      setLoading(true);
      try {
        const response = await sendCommand<CheckoutResponsePayload>('git:checkout', { branch, create });
        if (!response.success) {
          throw new Error(response.error || 'Failed to checkout');
        }
        await fetchStatus();
        await fetchBranches();
      } catch (error) {
        if (isSuperseded(error)) return;
        setError(error instanceof Error ? error.message : 'Failed to checkout');
      } finally {
        setLoading(false);
      }
    },
    [sendCommand, fetchStatus, fetchBranches, setLoading, setError]
  );

  const discardChanges = useCallback(
    async (paths: string[]) => {
      setLoading(true);
      try {
        const response = await sendCommand<DiscardResponsePayload>('git:discard', { paths });
        if (!response.success) {
          throw new Error(response.error || 'Failed to discard changes');
        }
        await fetchStatus();
      } catch (error) {
        if (isSuperseded(error)) return;
        setError(error instanceof Error ? error.message : 'Failed to discard changes');
      } finally {
        setLoading(false);
      }
    },
    [sendCommand, fetchStatus, setLoading, setError]
  );

  const untrackFiles = useCallback(
    async (paths: string[]) => {
      setLoading(true);
      try {
        const response = await sendCommand<UntrackResponsePayload>('git:untrack', { paths });
        if (!response.success) {
          throw new Error(response.error || 'Failed to untrack files');
        }
        await fetchStatus();
      } catch (error) {
        if (isSuperseded(error)) return;
        setError(error instanceof Error ? error.message : 'Failed to untrack files');
      } finally {
        setLoading(false);
      }
    },
    [sendCommand, fetchStatus, setLoading, setError]
  );

  const addToGitignore = useCallback(
    async (pattern: string) => {
      setLoading(true);
      try {
        const response = await sendCommand<GitignoreAddResponsePayload>('git:gitignore-add', { pattern });
        if (!response.success) {
          throw new Error(response.error || 'Failed to add to .gitignore');
        }
        await fetchStatus();
      } catch (error) {
        if (isSuperseded(error)) return;
        setError(error instanceof Error ? error.message : 'Failed to add to .gitignore');
      } finally {
        setLoading(false);
      }
    },
    [sendCommand, fetchStatus, setLoading, setError]
  );

  const readGitignore = useCallback(async () => {
    try {
      const response = await sendCommand<GitignoreReadResponsePayload>('git:gitignore-read', {});
      return response;
    } catch (error) {
      if (isSuperseded(error)) return null;
      setError(error instanceof Error ? error.message : 'Failed to read .gitignore');
      return null;
    }
  }, [sendCommand, setError]);

  const writeGitignore = useCallback(
    async (content: string) => {
      try {
        const response = await sendCommand<GitignoreWriteResponsePayload>('git:gitignore-write', { content });
        if (!response.success) {
          throw new Error(response.error || 'Failed to write .gitignore');
        }
        await fetchStatus();
        return true;
      } catch (error) {
        if (isSuperseded(error)) return false;
        setError(error instanceof Error ? error.message : 'Failed to write .gitignore');
        return false;
      }
    },
    [sendCommand, fetchStatus, setError]
  );

  // Kick off commit-summary generation. Result + progress now flow via the
  // agent's `ai:commit-summary:updated` broadcast — this request only confirms
  // that the agent accepted the kickoff (or reports a validation error like a
  // missing API key). Long-running generations survive PWA reloads because
  // the agent owns the state.
  const generateCommitSummary = useCallback(
    async (context?: string, model?: ClaudeModel) => {
      try {
        const response = await sendCommand<GenerateCommitSummaryResponsePayload>(
          'ai:generate-commit-summary',
          {
            context,
            model: model ?? selectedModel,
            attribution: attributionEnabled,
            source: commitSummarySource,
          },
          15_000,
        );

        if (!response.success) {
          throw new Error(response.error || 'Failed to generate summary');
        }
        // If the agent returned a state snapshot (post-kickoff), mirror it
        // immediately so the UI reflects the `generating` phase without
        // waiting for the push to arrive.
        if (response.state) {
          applyCommitSummaryState(response.state);
        }
      } catch (error) {
        // Surface kickoff-time errors (e.g. missing API key) via the store.
        const message = error instanceof Error ? error.message : 'Failed to generate summary';
        const { currentRepoPath } = useGitStore.getState();
        applyCommitSummaryState({
          repoPath: currentRepoPath ?? '',
          status: 'error',
          error: message,
          completedAt: Date.now(),
        });
      }
    },
    [sendCommand, selectedModel, attributionEnabled, commitSummarySource, applyCommitSummaryState]
  );

  // Dismiss the pending AI suggestion: clear locally + tell the agent to drop
  // its state so other tabs/devices see the dismissal too.
  const dismissAiSummary = useCallback(async () => {
    resetAiSummaryLocal();
    try {
      await sendCommand<ClearCommitSummaryResponsePayload>('ai:commit-summary:clear', {}, 10_000);
    } catch {
      // Non-fatal — the local state is already cleared.
    }
  }, [sendCommand, resetAiSummaryLocal]);

  // Apply the pending suggestion into the commit form, and clear the agent
  // state (it's no longer "pending" — the user used it).
  const applyAiSuggestion = useCallback(async () => {
    const applied = applyAiSummaryLocal();
    if (!applied) return;
    try {
      await sendCommand<ClearCommitSummaryResponsePayload>('ai:commit-summary:clear', {}, 10_000);
    } catch {
      // Non-fatal — agent will re-clear on commit anyway.
    }
  }, [sendCommand, applyAiSummaryLocal]);

  const setApiKey = useCallback(
    async (apiKey: string) => {
      try {
        const response = await sendCommand<SetApiKeyResponsePayload>('ai:set-api-key', { apiKey });

        if (!response.success) {
          throw new Error(response.error || 'Failed to save API key');
        }

        setApiKeyConfigured(true);
        return true;
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to save API key');
        return false;
      }
    },
    [sendCommand, setApiKeyConfigured, setError]
  );

  const checkApiKeyStatus = useCallback(async () => {
    try {
      const response = await sendCommand<GetApiKeyStatusResponsePayload>('ai:get-api-key-status', {});
      setApiKeyConfigured(response.configured);
    } catch {
      // Silently fail - API key status check is not critical
      setApiKeyConfigured(false);
    }
  }, [sendCommand, setApiKeyConfigured]);

  const listRepos = useCallback(async () => {
    try {
      const response = await sendCommand<ListReposResponsePayload>('agent:list-repos', {}, 5000);
      setAvailableRepos(response.repos);
      return response;
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to list repos');
      return null;
    }
  }, [sendCommand, setAvailableRepos, setError]);

  const switchRepo = useCallback(
    async (path: string) => {
      // Drop any in-flight git:* responses for the previous repo so they
      // can't overwrite the new repo's status/diff after they arrive.
      cancelPendingGit();
      setLoading(true);
      try {
        const response = await sendCommand<SwitchRepoResponsePayload>('agent:switch-repo', { path }, 10000);
        if (!response.success) {
          throw new Error(response.error || 'Failed to switch repository');
        }
        setRepoPath(response.newPath);
        setCurrentRepoPath(response.newPath);
        clearSelection();
        await fetchStatus();
        return true;
      } catch (error) {
        if (isSuperseded(error)) return false;
        setError(error instanceof Error ? error.message : 'Failed to switch repository');
        return false;
      } finally {
        setLoading(false);
      }
    },
    [sendCommand, cancelPendingGit, setRepoPath, setCurrentRepoPath, clearSelection, fetchStatus, setLoading, setError]
  );

  const browseDirectory = useCallback(
    async (path?: string) => {
      try {
        const response = await sendCommand<BrowseDirectoryResponsePayload>(
          'agent:browse-directory',
          { path: path || '' },
          10000,
        );
        return response;
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to browse directory');
        return null;
      }
    },
    [sendCommand, setError]
  );

  const addRepo = useCallback(
    async (path: string): Promise<Repository | null> => {
      try {
        const response = await sendCommand<AddRepoResponsePayload>('agent:add-repo', { path }, 10000);
        if (!response.success) {
          throw new Error(response.error || 'Failed to add repository');
        }
        // Refresh the available repos list
        await listRepos();
        return response.repo ?? null;
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to add repository');
        return null;
      }
    },
    [sendCommand, listRepos, setError]
  );

  const cloneRepo = useCallback(
    async (url: string, targetDir: string): Promise<Repository | null> => {
      try {
        const response = await sendCommand<CloneRepoResponsePayload>('agent:clone-repo', { url, targetDir }, 120000);
        if (!response.success) {
          throw new Error(response.error || 'Failed to clone repository');
        }
        await listRepos();
        return response.repo ?? null;
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to clone repository');
        return null;
      }
    },
    [sendCommand, listRepos, setError]
  );

  const addCodingPath = useCallback(
    async (path: string): Promise<CodingPath | null> => {
      try {
        const response = await sendCommand<AddCodingPathResponsePayload>(
          'agent:add-coding-path',
          { path },
          10000,
        );
        if (!response.success) {
          throw new Error(response.error || 'Failed to add workspace');
        }
        if (response.path) {
          setAvailableCodingPaths([...availableCodingPaths, response.path]);
        }
        return response.path ?? null;
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to add workspace');
        return null;
      }
    },
    [sendCommand, setAvailableCodingPaths, availableCodingPaths, setError]
  );

  const removeRepo = useCallback(
    async (path: string): Promise<boolean> => {
      try {
        const response = await sendCommand<RemoveRepoResponsePayload>('agent:remove-repo', { path }, 10000);
        if (!response.success) {
          throw new Error(response.error || 'Failed to remove repository');
        }
        await listRepos();
        return true;
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to remove repository');
        return false;
      }
    },
    [sendCommand, listRepos, setError]
  );

  const removeCodingPath = useCallback(
    async (path: string): Promise<boolean> => {
      try {
        const response = await sendCommand<RemoveCodingPathResponsePayload>(
          'agent:remove-coding-path',
          { path },
          10000,
        );
        if (!response.success) {
          throw new Error(response.error || 'Failed to remove workspace');
        }
        setAvailableCodingPaths(availableCodingPaths.filter((cp) => cp.path !== path));
        return true;
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to remove workspace');
        return false;
      }
    },
    [sendCommand, setAvailableCodingPaths, availableCodingPaths, setError]
  );

  const listSubmodules = useCallback(async () => {
    try {
      const response = await sendCommand<SubmodulesResponsePayload>('git:submodules', {}, 10000);
      return response.submodules;
    } catch {
      return [];
    }
  }, [sendCommand]);

  const checkAgentUpdate = useCallback(async () => {
    try {
      return await sendCommand<AgentCheckUpdateResponsePayload>('agent:check-update', {}, 15000);
    } catch (error) {
      return {
        currentVersion: 'unknown',
        updateAvailable: false,
        error: error instanceof Error ? error.message : 'Failed to check for updates',
      };
    }
  }, [sendCommand]);

  const updateAgent = useCallback(async () => {
    try {
      return await sendCommand<AgentUpdateResponsePayload>('agent:update', {}, 180000);
    } catch (error) {
      return {
        success: false,
        previousVersion: 'unknown',
        restarting: false,
        error: error instanceof Error ? error.message : 'Failed to update agent',
      };
    }
  }, [sendCommand]);

  const getGitIdentity = useCallback(async () => {
    try {
      return await sendCommand<GitConfigGetResponsePayload>('git:config-get', {}, 5000);
    } catch {
      return { name: undefined, email: undefined };
    }
  }, [sendCommand]);

  const setGitIdentity = useCallback(
    async (name: string, email: string) => {
      try {
        const response = await sendCommand<GitConfigSetResponsePayload>(
          'git:config-set',
          { name, email },
          10000,
        );
        if (!response.success) {
          throw new Error(response.error || 'Failed to set git identity');
        }
        return true;
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to set git identity');
        return false;
      }
    },
    [sendCommand, setError]
  );

  const restartAgent = useCallback(async () => {
    try {
      return await sendCommand<AgentRestartResponsePayload>('agent:restart', {}, 30000);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to restart agent',
      };
    }
  }, [sendCommand]);

  return {
    cancelPendingGit,
    fetchStatus,
    fetchDiff,
    stageFiles,
    unstageFiles,
    stagePatch,
    unstagePatch,
    commit,
    fetchLog,
    fetchBranches,
    checkout,
    discardChanges,
    untrackFiles,
    addToGitignore,
    readGitignore,
    writeGitignore,
    generateCommitSummary,
    dismissAiSummary,
    applyAiSuggestion,
    setApiKey,
    checkApiKeyStatus,
    listRepos,
    switchRepo,
    browseDirectory,
    addRepo,
    removeRepo,
    cloneRepo,
    addCodingPath,
    removeCodingPath,
    listSubmodules,
    getGitIdentity,
    setGitIdentity,
    checkAgentUpdate,
    updateAgent,
    restartAgent,
  };
}
