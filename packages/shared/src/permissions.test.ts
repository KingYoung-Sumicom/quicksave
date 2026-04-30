// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { matchAllowPattern, generateAllowPattern } from './permissions.js';

describe('matchAllowPattern', () => {
  describe('bare tool name', () => {
    it('matches any Read invocation regardless of input', () => {
      expect(matchAllowPattern('Read', 'Read', { file_path: '/anything' })).toBe(true);
    });

    it('matches Read with empty input', () => {
      expect(matchAllowPattern('Read', 'Read', {})).toBe(true);
    });

    it('does not match a different tool name', () => {
      expect(matchAllowPattern('Read', 'Write', { file_path: '/anything' })).toBe(false);
    });
  });

  describe('Bash legacy cmd:* prefix', () => {
    it('matches a command that starts with the prefix and a space', () => {
      expect(matchAllowPattern('Bash(npm:*)', 'Bash', { command: 'npm install' })).toBe(true);
    });

    it('matches a command that exactly equals the prefix', () => {
      expect(matchAllowPattern('Bash(npm:*)', 'Bash', { command: 'npm' })).toBe(true);
    });

    it('does not match when prefix is followed by non-boundary character', () => {
      expect(matchAllowPattern('Bash(npm:*)', 'Bash', { command: 'npmtest' })).toBe(false);
    });

    it('matches a multi-word prefix containing a space', () => {
      expect(
        matchAllowPattern('Bash(git diff:*)', 'Bash', { command: 'git diff --staged' }),
      ).toBe(true);
    });

    it('does not match when multi-word prefix differs', () => {
      expect(matchAllowPattern('Bash(git diff:*)', 'Bash', { command: 'git status' })).toBe(false);
    });

    it('rejects an empty prefix', () => {
      expect(matchAllowPattern('Bash(:*)', 'Bash', { command: 'anything' })).toBe(false);
    });
  });

  describe('Bash wildcard *', () => {
    it('matches when wildcard fills in arguments', () => {
      expect(
        matchAllowPattern('Bash(npm run *)', 'Bash', { command: 'npm run test --watch' }),
      ).toBe(true);
    });

    it('matches when wildcard sits between literal segments', () => {
      expect(
        matchAllowPattern('Bash(git * --push)', 'Bash', { command: 'git foo --push' }),
      ).toBe(true);
    });

    it('does not match when literal prefix differs', () => {
      expect(
        matchAllowPattern('Bash(npm run *)', 'Bash', { command: 'yarn run test' }),
      ).toBe(false);
    });
  });

  describe('Bash shell metacharacter rejection', () => {
    it('rejects && chained commands even with permissive cmd:* pattern', () => {
      expect(
        matchAllowPattern('Bash(echo:*)', 'Bash', { command: 'echo hi && rm -rf /' }),
      ).toBe(false);
    });

    it('rejects ; chained commands even with permissive wildcard pattern', () => {
      expect(
        matchAllowPattern('Bash(echo *)', 'Bash', { command: 'echo a; echo b' }),
      ).toBe(false);
    });

    it('rejects pipe |', () => {
      expect(
        matchAllowPattern('Bash(echo:*)', 'Bash', { command: 'echo a | grep b' }),
      ).toBe(false);
    });

    it('rejects $( command substitution', () => {
      expect(
        matchAllowPattern('Bash(echo:*)', 'Bash', { command: 'echo $(whoami)' }),
      ).toBe(false);
    });

    it('rejects backtick command substitution', () => {
      expect(
        matchAllowPattern('Bash(echo:*)', 'Bash', { command: 'echo `whoami`' }),
      ).toBe(false);
    });

    it('rejects > redirection', () => {
      expect(
        matchAllowPattern('Bash(echo:*)', 'Bash', { command: 'echo a > /tmp/x' }),
      ).toBe(false);
    });

    it('rejects >> redirection', () => {
      expect(
        matchAllowPattern('Bash(echo:*)', 'Bash', { command: 'echo a >> log' }),
      ).toBe(false);
    });

    it('rejects < redirection', () => {
      expect(
        matchAllowPattern('Bash(echo:*)', 'Bash', { command: 'echo a < input' }),
      ).toBe(false);
    });

    it('allows && when fully inside double quotes', () => {
      expect(
        matchAllowPattern('Bash(echo:*)', 'Bash', { command: 'echo "hello && world"' }),
      ).toBe(true);
    });

    it('allows ; when fully inside single quotes', () => {
      expect(
        matchAllowPattern('Bash(echo:*)', 'Bash', { command: "echo 'a; b'" }),
      ).toBe(true);
    });
  });

  describe('WebFetch domain pattern', () => {
    it('matches a URL with the exact domain', () => {
      expect(
        matchAllowPattern('WebFetch(domain:example.com)', 'WebFetch', {
          url: 'https://example.com/path',
        }),
      ).toBe(true);
    });

    it('does not match a different domain', () => {
      expect(
        matchAllowPattern('WebFetch(domain:example.com)', 'WebFetch', {
          url: 'https://other.com/path',
        }),
      ).toBe(false);
    });

    it('matches a subdomain when pattern uses *.', () => {
      expect(
        matchAllowPattern('WebFetch(domain:*.example.com)', 'WebFetch', {
          url: 'https://docs.example.com/x',
        }),
      ).toBe(true);
    });

    it('does not match the bare domain when pattern requires a subdomain', () => {
      expect(
        matchAllowPattern('WebFetch(domain:*.example.com)', 'WebFetch', {
          url: 'https://example.com/x',
        }),
      ).toBe(false);
    });

    it('rejects pattern without the domain: prefix', () => {
      expect(
        matchAllowPattern('WebFetch(example.com)', 'WebFetch', {
          url: 'https://example.com/x',
        }),
      ).toBe(false);
    });

    it('rejects a legacy https URL pattern', () => {
      expect(
        matchAllowPattern('WebFetch(https://example.com/*)', 'WebFetch', {
          url: 'https://example.com/x',
        }),
      ).toBe(false);
    });

    it('rejects an empty domain', () => {
      expect(
        matchAllowPattern('WebFetch(domain:)', 'WebFetch', {
          url: 'https://example.com/x',
        }),
      ).toBe(false);
    });

    it('returns false for malformed URL input without crashing', () => {
      expect(
        matchAllowPattern('WebFetch(domain:example.com)', 'WebFetch', {
          url: 'not a url',
        }),
      ).toBe(false);
    });

    it('returns false when the url field is missing', () => {
      expect(matchAllowPattern('WebFetch(domain:example.com)', 'WebFetch', {})).toBe(false);
    });
  });

  describe('file tools — absolute path with // prefix', () => {
    it('matches when file_path is under the pattern directory', () => {
      expect(
        matchAllowPattern('Read(//home/jimmy/foo/**)', 'Read', {
          file_path: '/home/jimmy/foo/bar.ts',
        }),
      ).toBe(true);
    });

    it('does not match when file_path is outside the pattern directory', () => {
      expect(
        matchAllowPattern('Read(//home/jimmy/foo/**)', 'Read', {
          file_path: '/etc/passwd',
        }),
      ).toBe(false);
    });

    it('does not match when the tool differs from the pattern tool', () => {
      expect(
        matchAllowPattern('Read(//home/jimmy/foo/**)', 'Write', {
          file_path: '/home/jimmy/foo/bar.ts',
        }),
      ).toBe(false);
    });
  });

  describe('file tools — relative path', () => {
    it('matches when file_path is under the relative pattern', () => {
      expect(
        matchAllowPattern('Edit(./src/**)', 'Edit', {
          file_path: './src/components/Foo.tsx',
        }),
      ).toBe(true);
    });

    it('does not match when file_path is in a different directory', () => {
      expect(
        matchAllowPattern('Edit(./src/**)', 'Edit', {
          file_path: './tests/Foo.tsx',
        }),
      ).toBe(false);
    });
  });

  describe('file tools — single * does not cross /', () => {
    it('matches a file directly inside the directory', () => {
      expect(matchAllowPattern('Read(/tmp/*)', 'Read', { file_path: '/tmp/x.txt' })).toBe(true);
    });

    it('does not match a file in a nested subdirectory', () => {
      expect(
        matchAllowPattern('Read(/tmp/*)', 'Read', { file_path: '/tmp/sub/x.txt' }),
      ).toBe(false);
    });

    it('matches a nested subdirectory file when pattern uses **', () => {
      expect(
        matchAllowPattern('Read(/tmp/**)', 'Read', { file_path: '/tmp/sub/x.txt' }),
      ).toBe(true);
    });
  });

  describe('file tools — alternative input keys', () => {
    it('falls back to path when file_path is missing for Edit', () => {
      expect(matchAllowPattern('Edit(./src/**)', 'Edit', { path: './src/x.ts' })).toBe(true);
    });

    it('uses notebook_path for NotebookEdit', () => {
      expect(
        matchAllowPattern('NotebookEdit(//abs/dir/**)', 'NotebookEdit', {
          notebook_path: '/abs/dir/foo.ipynb',
        }),
      ).toBe(true);
    });

    it('returns false when NotebookEdit input uses the wrong key', () => {
      expect(
        matchAllowPattern('NotebookEdit(//abs/dir/**)', 'NotebookEdit', {
          file_path: '/abs/dir/foo.ipynb',
        }),
      ).toBe(false);
    });
  });
});

describe('generateAllowPattern', () => {
  describe('WebFetch', () => {
    it('extracts the domain from a typical https URL', () => {
      expect(
        generateAllowPattern('WebFetch', { url: 'https://docs.anthropic.com/en/api/messages' }),
      ).toBe('WebFetch(domain:docs.anthropic.com)');
    });

    it('extracts the domain from an http URL', () => {
      expect(generateAllowPattern('WebFetch', { url: 'http://example.com' })).toBe(
        'WebFetch(domain:example.com)',
      );
    });

    it('returns bare WebFetch for a malformed URL', () => {
      expect(generateAllowPattern('WebFetch', { url: 'not a url' })).toBe('WebFetch');
    });

    it('returns bare WebFetch when url is missing', () => {
      expect(generateAllowPattern('WebFetch', {})).toBe('WebFetch');
    });
  });

  describe('WebSearch', () => {
    it('always returns the bare tool name', () => {
      expect(generateAllowPattern('WebSearch', { query: 'anything' })).toBe('WebSearch');
    });
  });

  describe('Bash', () => {
    it('extracts the first token as the prefix', () => {
      expect(generateAllowPattern('Bash', { command: 'npm install foo' })).toBe('Bash(npm:*)');
    });

    it('uses only the first space-separated token', () => {
      expect(generateAllowPattern('Bash', { command: 'git diff --staged' })).toBe('Bash(git:*)');
    });

    it('trims leading whitespace before extracting the token', () => {
      expect(generateAllowPattern('Bash', { command: '  ls  /tmp' })).toBe('Bash(ls:*)');
    });

    it('returns bare Bash for an empty command', () => {
      expect(generateAllowPattern('Bash', { command: '' })).toBe('Bash');
    });
  });

  describe('file tools — absolute paths get // prefix', () => {
    it('uses the parent directory of file_path for Read', () => {
      expect(generateAllowPattern('Read', { file_path: '/home/jimmy/foo/bar.ts' })).toBe(
        'Read(//home/jimmy/foo/**)',
      );
    });

    it('uses the parent directory of file_path for Edit', () => {
      expect(generateAllowPattern('Edit', { file_path: '/etc/hosts' })).toBe('Edit(//etc/**)');
    });

    it('uses notebook_path for NotebookEdit', () => {
      expect(
        generateAllowPattern('NotebookEdit', { notebook_path: '/home/jimmy/work/n.ipynb' }),
      ).toBe('NotebookEdit(//home/jimmy/work/**)');
    });
  });

  describe('file tools — relative paths keep their prefix', () => {
    it('preserves the ./ prefix in the generated pattern', () => {
      expect(generateAllowPattern('Read', { file_path: './src/foo.ts' })).toBe('Read(./src/**)');
    });
  });

  describe('file tools — input fallback', () => {
    it('falls back to path when file_path is missing', () => {
      expect(generateAllowPattern('Edit', { path: '/abs/x.ts' })).toBe('Edit(//abs/**)');
    });
  });

  describe('unknown tool', () => {
    it('returns the bare tool name', () => {
      expect(generateAllowPattern('UnknownTool', {})).toBe('UnknownTool');
    });
  });
});
