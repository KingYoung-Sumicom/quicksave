import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'crypto';
import type { FileDiff, ClaudeModel, TokenUsage } from '@sumicom/quicksave-shared';

export interface GenerateSummaryOptions {
  diffs: FileDiff[];
  context?: string;
  model?: ClaudeModel;
  recentCommits?: string[];
  branchName?: string;
  conventions?: string;
}

export interface GenerateSummaryResult {
  summary: string;
  description?: string;
  tokenUsage?: TokenUsage;
  cached?: boolean;
}

interface CacheEntry {
  result: GenerateSummaryResult;
  timestamp: number;
}

const DEFAULT_MODEL: ClaudeModel = 'claude-haiku-4-5';

const COMMIT_MESSAGE_TOOL: Anthropic.Tool = {
  name: 'commit_message',
  description: 'Generate a structured git commit message',
  input_schema: {
    type: 'object' as const,
    properties: {
      summary: {
        type: 'string',
        description: 'The commit summary line (under 72 characters, conventional commit format)',
      },
      description: {
        type: 'string',
        description: 'Optional extended description for complex changes',
      },
    },
    required: ['summary'],
  },
};
// Max characters per file diff for AI generation (roughly 1KB)
const MAX_DIFF_CHARS_PER_FILE = 1000;
// Max total characters for all diffs combined
const MAX_TOTAL_DIFF_CHARS = 8000;
// Cache TTL: 5 minutes
const CACHE_TTL_MS = 5 * 60 * 1000;

export class CommitSummaryService {
  private client: Anthropic;
  private cache = new Map<string, CacheEntry>();
  private pendingRequests = new Map<string, Promise<GenerateSummaryResult>>();

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async generateSummary(options: GenerateSummaryOptions): Promise<GenerateSummaryResult> {
    const { diffs, context, model = DEFAULT_MODEL, recentCommits, branchName, conventions } = options;

    const diffText = this.formatDiffsForPrompt(diffs);

    if (!diffText.trim()) {
      return { summary: 'Update files' };
    }

    // Generate cache key from diff content, model, and context
    const cacheKey = this.getCacheKey(diffText, context, model);

    // Check cache first
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      return { ...cached, cached: true };
    }

    // Check if there's already a pending request for this exact content
    const pending = this.pendingRequests.get(cacheKey);
    if (pending) {
      const result = await pending;
      return { ...result, cached: true };
    }

    // Create the request promise and store it
    const requestPromise = this.executeGeneration(diffText, context, model, cacheKey, {
      recentCommits,
      branchName,
      conventions,
    });
    this.pendingRequests.set(cacheKey, requestPromise);

    try {
      return await requestPromise;
    } finally {
      this.pendingRequests.delete(cacheKey);
    }
  }

  private async executeGeneration(
    diffText: string,
    context: string | undefined,
    model: ClaudeModel,
    cacheKey: string,
    extra: { recentCommits?: string[]; branchName?: string; conventions?: string }
  ): Promise<GenerateSummaryResult> {
    const prompt = this.buildPrompt(diffText, context, extra);

    const response = await this.client.messages.create({
      model,
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
      tools: [COMMIT_MESSAGE_TOOL],
      tool_choice: { type: 'tool', name: 'commit_message' },
    });

    const result = this.parseResponse(response);

    // Store in cache
    this.cache.set(cacheKey, {
      result,
      timestamp: Date.now(),
    });

    return result;
  }

  private getCacheKey(diffText: string, context: string | undefined, model: ClaudeModel): string {
    const content = `${model}:${context || ''}:${diffText}`;
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  private getFromCache(key: string): GenerateSummaryResult | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    // Check if cache is still valid
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
      this.cache.delete(key);
      return null;
    }

    return entry.result;
  }

  private formatDiffsForPrompt(diffs: FileDiff[]): string {
    const formattedDiffs: string[] = [];
    let totalChars = 0;

    for (const diff of diffs) {
      if (diff.isBinary) {
        formattedDiffs.push(`File: ${diff.path}\n[Binary file]`);
        continue;
      }

      const hunksContent = diff.hunks.map((h) => h.content).join('\n');
      let fileContent = hunksContent;

      // Truncate individual file if too large
      if (fileContent.length > MAX_DIFF_CHARS_PER_FILE) {
        fileContent = fileContent.slice(0, MAX_DIFF_CHARS_PER_FILE) + '\n... [truncated]';
      }

      const formatted = `File: ${diff.path}\n${fileContent}`;

      // Check if adding this would exceed total limit
      if (totalChars + formatted.length > MAX_TOTAL_DIFF_CHARS) {
        formattedDiffs.push(`... and ${diffs.length - formattedDiffs.length} more files`);
        break;
      }

      formattedDiffs.push(formatted);
      totalChars += formatted.length;
    }

    return formattedDiffs.join('\n\n---\n\n');
  }

  private buildPrompt(
    diffText: string,
    context?: string,
    extra?: { recentCommits?: string[]; branchName?: string; conventions?: string }
  ): string {
    const sections: string[] = [
      'Generate a concise, descriptive git commit message for the following changes.',
      '',
      'Guidelines:',
      '- Use conventional commit format (feat:, fix:, docs:, refactor:, chore:, test:, style:, perf:, ci:, build:)',
      '- Keep the summary line under 72 characters',
      '- Focus on WHAT changed and WHY, not HOW',
      '- Be specific but concise',
    ];

    if (extra?.conventions) {
      sections.push('', 'Project commit conventions:', extra.conventions);
    }

    if (extra?.recentCommits?.length) {
      sections.push(
        '',
        'Recent commits (match this style):',
        ...extra.recentCommits.map((msg) => `- ${msg}`)
      );
    }

    if (extra?.branchName) {
      sections.push('', `Branch: ${extra.branchName}`);
    }

    if (context) {
      sections.push('', `User context: ${context}`);
    }

    sections.push('', 'Git diff:', '```', diffText, '```');

    return sections.join('\n');
  }

  private parseResponse(response: Anthropic.Message): GenerateSummaryResult {
    const tokenUsage: TokenUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };

    // Extract from tool_use block (structured output)
    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
    );

    if (toolUse) {
      const input = toolUse.input as { summary: string; description?: string };
      return {
        summary: input.summary || 'Update code',
        description: input.description,
        tokenUsage,
      };
    }

    // Fallback: parse from text if tool_use not present
    const textBlock = response.content.find(
      (block): block is Anthropic.TextBlock => block.type === 'text'
    );
    if (textBlock) {
      const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return { summary: parsed.summary || 'Update code', description: parsed.description, tokenUsage };
      }
      return { summary: textBlock.text.trim().slice(0, 72), tokenUsage };
    }

    return { summary: 'Update code', tokenUsage };
  }
}
