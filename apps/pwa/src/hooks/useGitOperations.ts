import { useCallback, useRef } from 'react';
import {
  createMessage,
  type Message,
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
  type SetApiKeyResponsePayload,
  type GetApiKeyStatusResponsePayload,
  type ListReposResponsePayload,
  type SwitchRepoResponsePayload,
  type BrowseDirectoryResponsePayload,
  type AddRepoResponsePayload,
  type Repository,
  type ClaudeModel,
} from '@sumicom/quicksave-shared';
import { useConnectionStore } from '../stores/connectionStore';
import { useGitStore, makeSelectionKey, type SelectionSource } from '../stores/gitStore';
import { WebSocketClient } from '../lib/websocket';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
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
    setAiSummary,
    setGeneratingAiSummary,
    setAiSummaryError,
    setApiKeyConfigured,
    setCurrentRepoPath,
    clearSelection,
    selectedModel,
  } = useGitStore();
  const { setRepoPath, setAvailableRepos } = useConnectionStore();

  const sendRequest = useCallback(
    <T>(message: Message, timeoutMs = 30000): Promise<T> => {
      return new Promise((resolve, reject) => {
        if (!clientRef.current) {
          reject(new Error('Not connected'));
          return;
        }

        const timeout = setTimeout(() => {
          pendingRequests.current.delete(message.id);
          reject(new Error('Request timeout'));
        }, timeoutMs);

        pendingRequests.current.set(message.id, {
          resolve: resolve as (value: unknown) => void,
          reject,
          timeout,
        });

        clientRef.current.send(message);
      });
    },
    [clientRef]
  );

  const handleResponse = useCallback((message: Message) => {
    const pending = pendingRequests.current.get(message.id);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingRequests.current.delete(message.id);

      if (message.type === 'error') {
        pending.reject(new Error((message.payload as { message: string }).message));
      } else {
        pending.resolve(message.payload);
      }
    }
  }, []);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const message = createMessage('git:status', {});
      const response = await sendRequest<StatusResponsePayload>(message);
      setStatus(response);
    } catch (error) {
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
        const message = createMessage('git:commit', { message: commitMessage, description });
        const response = await sendRequest<CommitResponsePayload>(message);
        if (!response.success) {
          throw new Error(response.error || 'Failed to commit');
        }
        clearCommitForm();
        await fetchStatus();
        return response.hash;
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to commit');
        throw error;
      } finally {
        setLoading(false);
      }
    },
    [sendRequest, fetchStatus, clearCommitForm, setLoading, setError]
  );

  const fetchLog = useCallback(
    async (limit = 50) => {
      setLoading(true);
      try {
        const message = createMessage('git:log', { limit });
        const response = await sendRequest<LogResponsePayload>(message);
        setCommits(response.commits);
      } catch (error) {
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
        setError(error instanceof Error ? error.message : 'Failed to write .gitignore');
        return false;
      }
    },
    [sendRequest, fetchStatus, setError]
  );

  const generateCommitSummary = useCallback(
    async (context?: string, model?: ClaudeModel) => {
      setGeneratingAiSummary(true);
      setAiSummaryError(null);
      try {
        const message = createMessage('ai:generate-commit-summary', {
          context,
          model: model ?? selectedModel,
        });
        const response = await sendRequest<GenerateCommitSummaryResponsePayload>(message, 60000);

        if (!response.success) {
          throw new Error(response.error || 'Failed to generate summary');
        }

        setAiSummary(response.summary ?? null, response.description, response.tokenUsage, response.cached);
      } catch (error) {
        setAiSummaryError(error instanceof Error ? error.message : 'Failed to generate summary');
      } finally {
        setGeneratingAiSummary(false);
      }
    },
    [sendRequest, selectedModel, setAiSummary, setGeneratingAiSummary, setAiSummaryError]
  );

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
        return true;
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to switch repository');
        return false;
      } finally {
        setLoading(false);
      }
    },
    [sendRequest, setRepoPath, setCurrentRepoPath, clearSelection, fetchStatus, setLoading, setError]
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

  return {
    handleResponse,
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
    setApiKey,
    checkApiKeyStatus,
    listRepos,
    switchRepo,
    browseDirectory,
    addRepo,
  };
}
