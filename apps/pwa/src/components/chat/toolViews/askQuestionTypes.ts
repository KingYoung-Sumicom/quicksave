/** Shared types for AskUserQuestion tool views. */

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  header?: string;
  options?: AskOption[];
  multiSelect?: boolean;
}

export interface AskUserQuestionOutput {
  questions?: AskQuestion[];
  answers?: Record<string, string>;
  annotations?: Record<string, { preview?: string; notes?: string }>;
}
