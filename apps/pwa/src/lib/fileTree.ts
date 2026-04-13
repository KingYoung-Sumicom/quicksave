import type { FileStatus } from '@sumicom/quicksave-shared';

/** Tree node for file/directory hierarchy */
export interface TreeNode {
  name: string;
  path: string;
  isFile: boolean;
  status?: FileStatus;
  children: Map<string, TreeNode>;
}

/** Build a tree from flat file paths */
export function buildFileTree(files: Array<{ path: string; status?: FileStatus }>): TreeNode {
  const root: TreeNode = { name: '', path: '', isFile: false, children: new Map() };

  for (const file of files) {
    const parts = file.path.split('/');
    let current = root;
    let currentPath = '';

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isLast = i === parts.length - 1;

      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          path: currentPath,
          isFile: isLast,
          status: isLast ? file.status : undefined,
          children: new Map(),
        });
      }
      current = current.children.get(part)!;
    }
  }

  return root;
}

/** Flatten single-child directories (e.g., src/components -> src/components) */
export function flattenTree(node: TreeNode): TreeNode {
  const newChildren = new Map<string, TreeNode>();
  for (const [key, child] of node.children) {
    newChildren.set(key, flattenTree(child));
  }
  node.children = newChildren;

  if (!node.isFile && node.children.size === 1 && node.name !== '') {
    const [, child] = [...node.children.entries()][0];
    if (!child.isFile) {
      const mergedName = node.name ? `${node.name}/${child.name}` : child.name;
      return { ...child, name: mergedName };
    }
  }

  return node;
}

/** Get all file paths under a tree node */
export function getFilePaths(node: TreeNode): string[] {
  if (node.isFile) return [node.path];
  const paths: string[] = [];
  for (const child of node.children.values()) {
    paths.push(...getFilePaths(child));
  }
  return paths;
}
