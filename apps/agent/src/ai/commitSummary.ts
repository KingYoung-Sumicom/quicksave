import Anthropic from '@anthropic-ai/sdk';
import type { FileDiff, ClaudeModel } from '@quicksave/shared';

export interface GenerateSummaryOptions {
  diffs: FileDiff[];
  context?: string;
  model?: ClaudeModel;
}

export interface GenerateSummaryResult {
  summary: string;
  description?: string;
}

const DEFAULT_MODEL: ClaudeModel = 'claude-sonnet-4-20250514';
// Max characters per file diff for AI generation (roughly 1KB)
const MAX_DIFF_CHARS_PER_FILE = 1000;
// Max total characters for all diffs combined
const MAX_TOTAL_DIFF_CHARS = 8000;

export class CommitSummaryService {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async generateSummary(options: GenerateSummaryOptions): Promise<GenerateSummaryResult> {
    const { diffs, context, model = DEFAULT_MODEL } = options;

    const diffText = this.formatDiffsForPrompt(diffs);

    if (!diffText.trim()) {
      return { summary: 'Update files' };
    }

    const prompt = this.buildPrompt(diffText, context);

    const response = await this.client.messages.create({
      model,
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });

    return this.parseResponse(response);
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

  private buildPrompt(diffText: string, context?: string): string {
    return `You are a helpful assistant that generates concise, descriptive git commit messages.

Analyze the following git diff and generate a commit message following these guidelines:
- Use conventional commit format when appropriate (feat:, fix:, docs:, refactor:, etc.)
- Keep the summary line under 72 characters
- Focus on WHAT changed and WHY, not HOW
- Be specific but concise

${context ? `Additional context from the user: ${context}\n\n` : ''}
Git diff:
\`\`\`
${diffText}
\`\`\`

Respond in this exact JSON format:
{
  "summary": "the commit summary line",
  "description": "optional extended description if the changes are complex"
}`;
  }

  private parseResponse(response: Anthropic.Message): GenerateSummaryResult {
    const content = response.content[0];
    if (content.type !== 'text') {
      throw new Error('Unexpected response format');
    }

    // Parse JSON from response
    const jsonMatch = content.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // Fallback: use the raw text as summary
      return { summary: content.text.trim().slice(0, 72) };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      summary: parsed.summary || 'Update code',
      description: parsed.description,
    };
  }
}
