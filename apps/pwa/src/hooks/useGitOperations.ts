import { useCallback, useRef } from 'react';
import {
  createMessage,
  type Message,
  type StatusResponsePayload,
  type DiffResponsePayload,
  type StageResponsePayload,
  type CommitResponsePayload,
  type LogResponsePayload,
  type BranchesResponsePayload,
  type CheckoutResponsePayload,
  type DiscardResponsePayload,
} from '@quicksave/shared';
import { useGitStore } from '../stores/gitStore';
import { WebRTCClient } from '../lib/webrtc';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export function useGitOperations(clientRef: React.RefObject<WebRTCClient | null>) {
  const pendingRequests = useRef<Map<string, PendingRequest>>(new Map());
  const { setStatus, setSelectedDiff, setCommits, setBranches, setLoading, setError, clearCommitForm } =
    useGitStore();

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
    console.log('[DEBUG] handleResponse called:', message.type, message.id);
    const pending = pendingRequests.current.get(message.id);
    if (pending) {
      console.log('[DEBUG] Found pending request for:', message.id);
      clearTimeout(pending.timeout);
      pendingRequests.current.delete(message.id);

      if (message.type === 'error') {
        pending.reject(new Error((message.payload as { message: string }).message));
      } else {
        pending.resolve(message.payload);
      }
    } else {
      console.log('[DEBUG] No pending request for:', message.id, 'Pending IDs:', Array.from(pendingRequests.current.keys()));
    }
  }, []);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const message = createMessage('git:status', {});
      console.log('[DEBUG] Sending status request:', message.id);
      const response = await sendRequest<StatusResponsePayload>(message);
      console.log('[DEBUG] Status response received:', JSON.stringify(response, null, 2));
      setStatus(response);
    } catch (error) {
      console.error('[DEBUG] Status fetch error:', error);
      setError(error instanceof Error ? error.message : 'Failed to fetch status');
    } finally {
      setLoading(false);
    }
  }, [sendRequest, setStatus, setLoading, setError]);

  const fetchDiff = useCallback(
    async (path: string, staged = false) => {
      setLoading(true);
      try {
        const message = createMessage('git:diff', { path, staged });
        console.log('[DEBUG] Fetching diff for:', path, 'staged:', staged);
        const response = await sendRequest<DiffResponsePayload>(message);
        console.log('[DEBUG] Diff response:', JSON.stringify(response, null, 2));
        setSelectedDiff(response);
      } catch (error) {
        console.error('[DEBUG] Diff fetch error:', error);
        setError(error instanceof Error ? error.message : 'Failed to fetch diff');
      } finally {
        setLoading(false);
      }
    },
    [sendRequest, setSelectedDiff, setLoading, setError]
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

  return {
    handleResponse,
    fetchStatus,
    fetchDiff,
    stageFiles,
    unstageFiles,
    commit,
    fetchLog,
    fetchBranches,
    checkout,
    discardChanges,
  };
}
