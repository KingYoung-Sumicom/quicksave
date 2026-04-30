// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { buildFileTree, flattenTree, getFilePaths } from './fileTree';
import type { TreeNode } from './fileTree';

describe('fileTree', () => {
  describe('buildFileTree', () => {
    it('builds a tree from flat file paths', () => {
      const tree = buildFileTree([
        { path: 'src/index.ts', status: 'modified' },
        { path: 'src/utils/helper.ts', status: 'added' },
        { path: 'README.md', status: 'modified' },
      ]);

      expect(tree.name).toBe('');
      expect(tree.isFile).toBe(false);
      expect(tree.children.size).toBe(2); // 'src' and 'README.md'

      const src = tree.children.get('src')!;
      expect(src.isFile).toBe(false);
      expect(src.children.size).toBe(2); // 'index.ts' and 'utils'

      const indexTs = src.children.get('index.ts')!;
      expect(indexTs.isFile).toBe(true);
      expect(indexTs.status).toBe('modified');
      expect(indexTs.path).toBe('src/index.ts');

      const utils = src.children.get('utils')!;
      expect(utils.isFile).toBe(false);
      const helper = utils.children.get('helper.ts')!;
      expect(helper.isFile).toBe(true);
      expect(helper.status).toBe('added');

      const readme = tree.children.get('README.md')!;
      expect(readme.isFile).toBe(true);
    });

    it('handles empty input', () => {
      const tree = buildFileTree([]);
      expect(tree.children.size).toBe(0);
    });

    it('handles single file', () => {
      const tree = buildFileTree([{ path: 'file.txt' }]);
      expect(tree.children.size).toBe(1);
      const file = tree.children.get('file.txt')!;
      expect(file.isFile).toBe(true);
      expect(file.path).toBe('file.txt');
    });

    it('handles deeply nested paths', () => {
      const tree = buildFileTree([{ path: 'a/b/c/d/e.ts' }]);
      let node = tree;
      for (const part of ['a', 'b', 'c', 'd']) {
        node = node.children.get(part)!;
        expect(node.isFile).toBe(false);
      }
      const leaf = node.children.get('e.ts')!;
      expect(leaf.isFile).toBe(true);
    });

    it('correctly builds paths for nested files', () => {
      const tree = buildFileTree([
        { path: 'src/lib/utils.ts' },
        { path: 'src/lib/types.ts' },
      ]);
      const lib = tree.children.get('src')!.children.get('lib')!;
      expect(lib.children.get('utils.ts')!.path).toBe('src/lib/utils.ts');
      expect(lib.children.get('types.ts')!.path).toBe('src/lib/types.ts');
    });

    it('does not set status on intermediate directories', () => {
      const tree = buildFileTree([{ path: 'src/index.ts', status: 'added' }]);
      const src = tree.children.get('src')!;
      expect(src.status).toBeUndefined();
    });
  });

  describe('flattenTree', () => {
    it('flattens single-child directories', () => {
      const tree = buildFileTree([
        { path: 'src/components/Button.tsx' },
        { path: 'src/components/Input.tsx' },
      ]);
      const flattened = flattenTree(tree);

      // root -> src/components (collapsed) -> Button.tsx, Input.tsx
      expect(flattened.children.size).toBe(1);
      const srcComponents = [...flattened.children.values()][0];
      expect(srcComponents.name).toBe('src/components');
      expect(srcComponents.children.size).toBe(2);
    });

    it('does not flatten directories with multiple children', () => {
      const tree = buildFileTree([
        { path: 'src/index.ts' },
        { path: 'src/utils.ts' },
      ]);
      const flattened = flattenTree(tree);
      const src = [...flattened.children.values()][0];
      expect(src.name).toBe('src');
      expect(src.children.size).toBe(2);
    });

    it('does not flatten when single child is a file', () => {
      const tree = buildFileTree([
        { path: 'src/index.ts' },
      ]);
      const flattened = flattenTree(tree);
      // src has one child (index.ts) which is a file, so src should NOT be merged
      const src = flattened.children.get('src')!;
      expect(src.name).toBe('src');
      expect(src.children.size).toBe(1);
    });

    it('handles empty tree', () => {
      const tree = buildFileTree([]);
      const flattened = flattenTree(tree);
      expect(flattened.children.size).toBe(0);
    });

    it('recursively flattens nested single-child chains', () => {
      const tree = buildFileTree([
        { path: 'a/b/c/d.ts' },
        { path: 'a/b/c/e.ts' },
      ]);
      const flattened = flattenTree(tree);

      // a -> b -> c (two children) should collapse a/b/c
      const collapsed = [...flattened.children.values()][0];
      expect(collapsed.name).toBe('a/b/c');
      expect(collapsed.children.size).toBe(2);
    });
  });

  describe('getFilePaths', () => {
    it('returns all file paths from a tree', () => {
      const tree = buildFileTree([
        { path: 'src/index.ts' },
        { path: 'src/utils.ts' },
        { path: 'README.md' },
      ]);
      const paths = getFilePaths(tree);
      expect(paths.sort()).toEqual(['README.md', 'src/index.ts', 'src/utils.ts']);
    });

    it('returns empty array for empty tree', () => {
      const tree = buildFileTree([]);
      expect(getFilePaths(tree)).toEqual([]);
    });

    it('returns single path for single file', () => {
      const tree = buildFileTree([{ path: 'file.txt' }]);
      expect(getFilePaths(tree)).toEqual(['file.txt']);
    });
  });
});
