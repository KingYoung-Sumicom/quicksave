import { useCallback, useRef } from 'react';
import {
  createMessage,
  type Message,
  type ErrorPayload,
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
  type GetCommitSummaryResponsePayload,
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

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  /** True if this is a `git:*` request, which is repo-scoped and must be
   *  validated against the current agent + repo on response. */
  isGit: boolean;
  /** Snapshot of agent + repo at send time. The response is dropped if either
   *  has changed by the time it arrives. */
  scope: { agentId: string | null; repoPath: string | null };
};

export function useGitOperations(clientRef: React.RefObject<WebSocketClient | null>) {
  const pendingRequests = useRef<Map<string, PendingRequest>>(new Map());
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

  const sendRequest = useCallback(
    <T>(message: Message, timeoutMs = 30000): Promise<T> => {
      return new Promise((resolve, reject) => {
        if (!clientRef.current) {
          reject(new Error('Not connected'));
          return;
        }

        const isGit = message.type.startsWith('git:');
        const repoPath = useGitStore.getState().currentRepoPath;
        const agentId = clientRef.current.getActiveAgentId();
        // Stamp git:* requests with the repo we expect to operate on. The
        // agent rejects with REPO_MISMATCH if its peer state has moved on,
        // and the PWA validates the response envelope on the way back.
        if (isGit && repoPath) {
          message.repoPath = repoPath;
        }

        const timeout = setTimeout(() => {
          pendingRequests.current.delete(message.id);
          reject(new Error('Request timeout'));
        }, timeoutMs);

        pendingRequests.current.set(message.id, {
          resolve: resolve as (value: unknown) => void,
          reject,
          timeout,
          isGit,
          scope: { agentId, repoPath },
        });

        clientRef.current.send(message);
      });
    },
    [clientRef]
  );

  /**
   * Reject every in-flight git:* request with `SUPERSEDED`. Call this before
   * switching repo or active agent so any late responses don't overwrite the
   * store with the previous workspace's data.
   */
  const cancelPendingGit = useCallback(() => {
    for (const [id, entry] of pendingRequests.current) {
      if (!entry.isGit) continue;
      clearTimeout(entry.timeout);
      pendingRequests.current.delete(id);
      entry.reject(new Error(SUPERSEDED_ERROR));
    }
  }, []);

  const handleResponse = useCallback((message: Message) => {
    const pending = pendingRequests.current.get(message.id);
    if (!pending) return;

    // Repo-scoped validation for git:* responses. If the user has switched
    // agent or repo since the request went out, drop the response so the
    // store can't be overwritten with stale data from another workspace.
    if (pending.isGit) {
      const currentAgent = clientRef.current?.getActiveAgentId() ?? null;
      const currentRepo = useGitStore.getState().currentRepoPath;
      const responseRepo = message.repoPath ?? null;
      const stale =
        currentAgent !== pending.scope.agentId ||
        currentRepo !== pending.scope.repoPath ||
        (responseRepo !== null && responseRepo !== pending.scope.repoPath);

      // Treat the agent's REPO_MISMATCH error the same way: the agent's view
      // of this peer's repo had already moved on by the time it processed
      // the request. The response is meaningless to the current view.
      const isRepoMismatchErr =
        message.type === 'error' &&
        (message.payload as ErrorPayload | undefined)?.code === 'REPO_MISMATCH';

      if (stale || isRepoMismatchErr) {
        clearTimeout(pending.timeout);
        pendingRequests.current.delete(message.id);
        pending.reject(new Error(SUPERSEDED_ERROR));
        return;
      }
    }

    clearTimeout(pending.timeout);
    pendingRequests.current.delete(message.id);

    if (message.type === 'error') {
      pending.reject(new Error((message.payload as { message: string }).message));
    } else {
      pending.resolve(message.payload);
    }
  }, [clientRef]);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const message = createMessage('git:status', {});
      const response = await sendRequest<StatusResponsePayload>(message);
      setStatus(response);
    } catch (error) {
      if (isSuperseded(error)) return;
      setError(error instanceof Error ? error.message : 'Failed to fetch status');
    } finally {
      setLoading(false);
    }
  }, [sendRequest, setStatus, setLoading, setError]);

  const fetchDiff = useCallback(
    async (path: string, staged = false, source?: SelectionSource) => {
      const key = makeSelectionKey(path, source ?? (staged ? 'staged' : 'unstaged'));
      setDiffLoading(key, true);
      try {
        const message = createMessage('git:diff', { path, staged });
        const response = await sendRequest<DiffResponsePayload>(message);
        setFileDiff(key, response);
      } catch (error) {
        setDiffLoading(key, false);
        if (isSuperseded(error)) return;
        setError(error instanceof Error ? error.message : 'Failed to fetch diff');
      }
    },
    [sendRequest, setFileDiff, setDiffLoading, setError]
  );

  const stageFiles = useCallback(
    async (paths: string[]) => {
      setLoading(true);
      try {
        const message = createMessage('git:stage', { paths });
        const response = await sendRequest<StageResponsePayload>(message);
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
    [sendRequest, fetchStatus, setLoading, setError]
  );

  const unstageFiles = useCallback(
    async (paths: string[]) => {
      setLoading(true);
      try {
        const message = createMessage('git:unstage', { paths });
        const response = await sendRequest<StageResponsePayload>(message);
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
    [sendRequest, fetchStatus, setLoading, setError]
  );

  const stagePatch = useCallback(
    async (patch: string) => {
      setLoading(true);
      try {
        const message = createMessage('git:stage-patch', { patch });
        const response = await sendRequest<StagePatchResponsePayload>(message);
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
    [sendRequest, fetchStatus, setLoading, setError]
  );

  const unstagePatch = useCallback(
    async (patch: string) => {
      setLoading(true);
      try {
        const message = createMessage('git:unstage-patch', { patch });
        const response = await sendRequest<StagePatchResponsePayload>(message);
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
    [sendRequest, fetchStatus, setLoading, setError]
  );

  const commit = useCallback(
    async (commitMessage: string, description?: string) => {
      setLoading(true);
      try {
        const message = createMessage('git:commit', { message: commitMessage, description, attribution: attributionEnabled });
        const response = await sendRequest<CommitResponsePayload>(message);
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
    [sendRequest, fetchStatus, clearCommitForm, setLoading, setError, attributionEnabled]
  );

  const fetchLog = useCallback(
    async (limit = 50) => {
      setLoading(true);
      try {
        const message = createMessage('git:log', { limit });
        const response = await sendRequest<LogResponsePayload>(message);
        setCommits(response.commits);
      } catch (error) {
        if (isSuperseded(error)) return;
        setError(error instanceof Error ? error.message : 'Failed to fetch log');
      } finally {
        setLoading(false);
      }
    },
    [sendRequest, setCommits, setLoading, setError]
  );

  const fetchBranches = useCallback(async () => {
    setLoading(true);
    try {
      const message = createMessage('git:branches', {});
      const response = await sendRequest<BranchesResponsePayload>(message);
      setBranches(response.branches, response.current);
    } catch (error) {
      if (isSuperseded(error)) return;
      setError(error instanceof Error ? error.message : 'Failed to fetch branches');
    } finally {
      setLoading(false);
    }
  }, [sendRequest, setBranches, setLoading, setError]);

  const checkout = useCallback(
    async (branch: string, create = false) => {
      setLoading(true);
      try {
        const message = createMessage('git:checkout', { branch, create });
        const response = await sendRequest<CheckoutResponsePayload>(message);
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
    [sendRequest, fetchStatus, fetchBranches, setLoading, setError]
  );

  const discardChanges = useCallback(
    async (paths: string[]) => {
      setLoading(true);
      try {
        const message = createMessage('git:discard', { paths });
        const response = await sendRequest<DiscardResponsePayload>(message);
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
    [sendRequest, fetchStatus, setLoading, setError]
  );

  const untrackFiles = useCallback(
    async (paths: string[]) => {
      setLoading(true);
      try {
        const message = createMessage('git:untrack', { paths });
        const response = await sendRequest<UntrackResponsePayload>(message);
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
    [sendRequest, fetchStatus, setLoading, setError]
  );

  const addToGitignore = useCallback(
    async (pattern: string) => {
      setLoading(true);
      try {
        const message = createMessage('git:gitignore-add', { pattern });
        const response = await sendRequest<GitignoreAddResponsePayload>(message);
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
    [sendRequest, fetchStatus, setLoading, setError]
  );

  const readGitignore = useCallback(async () => {
    try {
      const message = createMessage('git:gitignore-read', {});
      const response = await sendRequest<GitignoreReadResponsePayload>(message);
      return response;
    } catch (error) {
      if (isSuperseded(error)) return null;
      setError(error instanceof Error ? error.message : 'Failed to read .gitignore');
      return null;
    }
  }, [sendRequest, setError]);

  const writeGitignore = useCallback(
    async (content: string) => {
      try {
        const message = createMessage('git:gitignore-write', { content });
        const response = await sendRequest<GitignoreWriteResponsePayload>(message);
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
    [sendRequest, fetchStatus, setError]
  );

  // Kick off commit-summary generation. Result + progress now flow via the
  // agent's `ai:commit-summary:updated` broadcast — this request only confirms
  // that the agent accepted the kickoff (or reports a validation error like a
  // missing API key). Long-running generations survive PWA reloads because
  // the agent owns the state.
  const generateCommitSummary = useCallback(
    async (context?: string, model?: ClaudeModel) => {
      try {
        const message = createMessage('ai:generate-commit-summary', {
          context,
          model: model ?? selectedModel,
          attribution: attributionEnabled,
          source: commitSummarySource,
        });
        const response = await sendRequest<GenerateCommitSummaryResponsePayload>(message, 15_000);

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
    [sendRequest, selectedModel, attributionEnabled, commitSummarySource, applyCommitSummaryState]
  );

  // Fetch the current agent-owned commit-summary state for the active repo.
  // Call on initial connect and after repo switch so we hydrate any pending
  // suggestion that was produced while this PWA was disconnected.
  const refreshCommitSummary = useCallback(
    async (repoPath?: string) => {
      try {
        const message = createMessage('ai:commit-summary:get', repoPath ? { repoPath } : {});
        const response = await sendRequest<GetCommitSummaryResponsePayload>(message, 10_000);
        applyCommitSummaryState(response.state);
      } catch {
        // Non-fatal — a stale local state just won't hydrate from the agent.
      }
    },
    [sendRequest, applyCommitSummaryState]
  );

  // Dismiss the pending AI suggestion: clear locally + tell the agent to drop
  // its state so other tabs/devices see the dismissal too.
  const dismissAiSummary = useCallback(async () => {
    resetAiSummaryLocal();
    try {
      const message = createMessage('ai:commit-summary:clear', {});
      await sendRequest<ClearCommitSummaryResponsePayload>(message, 10_000);
    } catch {
      // Non-fatal — the local state is already cleared.
    }
  }, [sendRequest, resetAiSummaryLocal]);

  // Apply the pending suggestion into the commit form, and clear the agent
  // state (it's no longer "pending" — the user used it).
  const applyAiSuggestion = useCallback(async () => {
    const applied = applyAiSummaryLocal();
    if (!applied) return;
    try {
      const message = createMessage('ai:commit-summary:clear', {});
      await sendRequest<ClearCommitSummaryResponsePayload>(message, 10_000);
    } catch {
      // Non-fatal — agent will re-clear on commit anyway.
    }
  }, [sendRequest, applyAiSummaryLocal]);

  const setApiKey = useCallback(
    async (apiKey: string) => {
      try {
        const message = createMessage('ai:set-api-key', { apiKey });
        const response = await sendRequest<SetApiKeyResponsePayload>(message);

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
    [sendRequest, setApiKeyConfigured, setError]
  );

  const checkApiKeyStatus = useCallback(async () => {
    try {
      const message = createMessage('ai:get-api-key-status', {});
      const response = await sendRequest<GetApiKeyStatusResponsePayload>(message);
      setApiKeyConfigured(response.configured);
    } catch {
      // Silently fail - API key status check is not critical
      setApiKeyConfigured(false);
    }
  }, [sendRequest, setApiKeyConfigured]);

  const listRepos = useCallback(async () => {
    try {
      const message = createMessage('agent:list-repos', {});
      const response = await sendRequest<ListReposResponsePayload>(message, 5000);
      setAvailableRepos(response.repos);
      return response;
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to list repos');
      return null;
    }
  }, [sendRequest, setAvailableRepos, setError]);

  const switchRepo = useCallback(
    async (path: string) => {
      // Drop any in-flight git:* responses for the previous repo so they
      // can't overwrite the new repo's status/diff after they arrive.
      cancelPendingGit();
      setLoading(true);
      try {
        const message = createMessage('agent:switch-repo', { path });
        const response = await sendRequest<SwitchRepoResponsePayload>(message, 10000);
        if (!response.success) {
          throw new Error(response.error || 'Failed to switch repository');
        }
        setRepoPath(response.newPath);
        setCurrentRepoPath(response.newPath);
        clearSelection();
        await fetchStatus();
        // Hydrate any pending AI suggestion the agent may have for this repo.
        // Non-blocking — the UI will update as soon as it arrives.
        void refreshCommitSummary(response.newPath);
        return true;
      } catch (error) {
        if (isSuperseded(error)) return false;
        setError(error instanceof Error ? error.message : 'Failed to switch repository');
        return false;
      } finally {
        setLoading(false);
      }
    },
    [sendRequest, cancelPendingGit, setRepoPath, setCurrentRepoPath, clearSelection, fetchStatus, refreshCommitSummary, setLoading, setError]
  );

  const browseDirectory = useCallback(
    async (path?: string) => {
      try {
        const message = createMessage('agent:browse-directory', { path: path || '' });
        const response = await sendRequest<BrowseDirectoryResponsePayload>(message, 10000);
        return response;
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to browse directory');
        return null;
      }
    },
    [sendRequest, setError]
  );

  const addRepo = useCallback(
    async (path: string): Promise<Repository | null> => {
      try {
        const message = createMessage('agent:add-repo', { path });
        const response = await sendRequest<AddRepoResponsePayload>(message, 10000);
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
    [sendRequest, listRepos, setError]
  );

  const cloneRepo = useCallback(
    async (url: string, targetDir: string): Promise<Repository | null> => {
      try {
        const message = createMessage('agent:clone-repo', { url, targetDir });
        const response = await sendRequest<CloneRepoResponsePayload>(message, 120000);
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
    [sendRequest, listRepos, setError]
  );

  const addCodingPath = useCallback(
    async (path: string): Promise<CodingPath | null> => {
      try {
        const message = createMessage('agent:add-coding-path', { path });
        const response = await sendRequest<AddCodingPathResponsePayload>(message, 10000);
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
    [sendRequest, setAvailableCodingPaths, availableCodingPaths, setError]
  );

  const removeRepo = useCallback(
    async (path: string): Promise<boolean> => {
      try {
        const message = createMessage('agent:remove-repo', { path });
        const response = await sendRequest<RemoveRepoResponsePayload>(message, 10000);
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
    [sendRequest, listRepos, setError]
  );

  const removeCodingPath = useCallback(
    async (path: string): Promise<boolean> => {
      try {
        const message = createMessage('agent:remove-coding-path', { path });
        const response = await sendRequest<RemoveCodingPathResponsePayload>(message, 10000);
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
    [sendRequest, setAvailableCodingPaths, availableCodingPaths, setError]
  );

  const listSubmodules = useCallback(async () => {
    try {
      const message = createMessage('git:submodules', {});
      const response = await sendRequest<SubmodulesResponsePayload>(message, 10000);
      return response.submodules;
    } catch {
      return [];
    }
  }, [sendRequest]);

  const checkAgentUpdate = useCallback(async () => {
    try {
      const message = createMessage('agent:check-update', {});
      return await sendRequest<AgentCheckUpdateResponsePayload>(message, 15000);
    } catch (error) {
      return {
        currentVersion: 'unknown',
        updateAvailable: false,
        error: error instanceof Error ? error.message : 'Failed to check for updates',
      };
    }
  }, [sendRequest]);

  const updateAgent = useCallback(async () => {
    try {
      const message = createMessage('agent:update', {});
      return await sendRequest<AgentUpdateResponsePayload>(message, 180000);
    } catch (error) {
      return {
        success: false,
        previousVersion: 'unknown',
        restarting: false,
        error: error instanceof Error ? error.message : 'Failed to update agent',
      };
    }
  }, [sendRequest]);

  const getGitIdentity = useCallback(async () => {
    try {
      const message = createMessage('git:config-get', {});
      return await sendRequest<GitConfigGetResponsePayload>(message, 5000);
    } catch {
      return { name: undefined, email: undefined };
    }
  }, [sendRequest]);

  const setGitIdentity = useCallback(
    async (name: string, email: string) => {
      try {
        const message = createMessage('git:config-set', { name, email });
        const response = await sendRequest<GitConfigSetResponsePayload>(message, 10000);
        if (!response.success) {
          throw new Error(response.error || 'Failed to set git identity');
        }
        return true;
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to set git identity');
        return false;
      }
    },
    [sendRequest, setError]
  );

  const restartAgent = useCallback(async () => {
    try {
      const message = createMessage('agent:restart', {});
      return await sendRequest<AgentRestartResponsePayload>(message, 30000);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to restart agent',
      };
    }
  }, [sendRequest]);

  return {
    handleResponse,
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
    refreshCommitSummary,
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
