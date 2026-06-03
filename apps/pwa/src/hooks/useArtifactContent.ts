// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useEffect, useState } from 'react';
import type {
  Artifact,
  ArtifactFetchRequestPayload,
  ArtifactFetchResponsePayload,
} from '@sumicom/quicksave-shared';
import { getBusForAgent } from '../lib/busRegistry';
import { useClaudeStore } from '../stores/claudeStore';

export type ArtifactContentState =
  | { status: 'loading' }
  | { status: 'ready'; artifact: Artifact; markdown: string }
  | { status: 'error'; error: string };

const cache = new Map<string, Artifact>();

export function useArtifactContent(
  sessionId: string | null | undefined,
  artifactId: string | null | undefined,
): ArtifactContentState {
  const agentId = useClaudeStore((s) =>
    sessionId ? (s.sessions[sessionId]?.machineAgentId ?? null) : null,
  );
  const [state, setState] = useState<ArtifactContentState>({ status: 'loading' });

  useEffect(() => {
    if (!sessionId || !artifactId || !agentId) {
      setState({ status: 'loading' });
      return;
    }
    let cancelled = false;
    const cacheKey = `${sessionId}:${artifactId}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      setState({ status: 'ready', artifact: cached, markdown: decodeBase64Utf8(cached.contentBase64) });
      return;
    }

    setState({ status: 'loading' });
    fetchArtifact({ sessionId, artifactId }, agentId)
      .then((artifact) => {
        if (cancelled) return;
        cache.set(cacheKey, artifact);
        setState({ status: 'ready', artifact, markdown: decodeBase64Utf8(artifact.contentBase64) });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Failed to load artifact';
        setState({ status: 'error', error: message });
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, artifactId, agentId]);

  return state;
}

async function fetchArtifact(req: ArtifactFetchRequestPayload, agentId: string): Promise<Artifact> {
  const bus = getBusForAgent(agentId);
  if (!bus) throw new Error('Not connected');
  const res = await bus.command<ArtifactFetchResponsePayload, ArtifactFetchRequestPayload>(
    'artifact:fetch',
    req,
    { timeoutMs: 30_000, queueWhileDisconnected: true },
  );
  return res.artifact;
}

function decodeBase64Utf8(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
