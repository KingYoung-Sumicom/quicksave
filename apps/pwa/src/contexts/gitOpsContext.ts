// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { createContext, useContext } from 'react';
import type { RepoViewProps } from '../components/RepoView';

export interface GitOps extends RepoViewProps {
  /** Switch the active git repo on the agent (used when the git panel opens). */
  switchRepo: (path: string) => void;
}

export const GitOpsContext = createContext<GitOps | null>(null);

export function useGitOps(): GitOps | null {
  return useContext(GitOpsContext);
}
