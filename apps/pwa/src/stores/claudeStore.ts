import { create } from 'zustand';
import type { ClaudeSessionSummary, ClaudeStreamEventType } from '@sumicom/quicksave-shared';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  toolName?: string;
  toolInput?: string;
  timestamp: number;
}

interface ClaudeStore {
  // Session list
  sessions: ClaudeSessionSummary[];
  isLoadingSessions: boolean;

  // Active session
  activeSessionId: string | null;
  activeStreamId: string | null;
  isStreaming: boolean;
  streamError: string | null;

  // Chat messages (current session)
  messages: ChatMessage[];
  historyTotal: number;
  historyHasMore: boolean;
  isLoadingHistory: boolean;

  // UI
  promptInput: string;
  isVisible: boolean;

  // Actions — sessions
  setSessions: (sessions: ClaudeSessionSummary[]) => void;
  setLoadingSessions: (loading: boolean) => void;

  // Actions — active session
  setActiveSession: (sessionId: string | null, streamId?: string | null) => void;
  setStreaming: (streaming: boolean) => void;
  setStreamError: (error: string | null) => void;

  // Actions — messages
  setMessages: (messages: ChatMessage[]) => void;
  prependMessages: (messages: ChatMessage[]) => void;
  appendMessage: (message: ChatMessage) => void;
  appendAssistantText: (text: string) => void;
  setHistoryMeta: (total: number, hasMore: boolean) => void;
  setLoadingHistory: (loading: boolean) => void;
  clearMessages: () => void;

  // Actions — stream events
  handleStreamEvent: (eventType: ClaudeStreamEventType, content: string, toolName?: string, toolInput?: string) => void;

  // Actions — UI
  setPromptInput: (input: string) => void;
  setVisible: (visible: boolean) => void;

  // Reset
  reset: () => void;
}

export const useClaudeStore = create<ClaudeStore>((set, get) => ({
  // Initial state
  sessions: [],
  isLoadingSessions: false,
  activeSessionId: null,
  activeStreamId: null,
  isStreaming: false,
  streamError: null,
  messages: [],
  historyTotal: 0,
  historyHasMore: false,
  isLoadingHistory: false,
  promptInput: '',
  isVisible: false,

  // Sessions
  setSessions: (sessions) => set({ sessions }),
  setLoadingSessions: (loading) => set({ isLoadingSessions: loading }),

  // Active session
  setActiveSession: (sessionId, streamId = null) =>
    set({ activeSessionId: sessionId, activeStreamId: streamId, streamError: null }),
  setStreaming: (streaming) => set({ isStreaming: streaming }),
  setStreamError: (error) => set({ streamError: error, isStreaming: false }),

  // Messages
  setMessages: (messages) => set({ messages }),
  prependMessages: (newMessages) =>
    set((state) => ({ messages: [...newMessages, ...state.messages] })),
  appendMessage: (message) =>
    set((state) => ({ messages: [...state.messages, message] })),
  appendAssistantText: (text) =>
    set((state) => {
      const msgs = [...state.messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'assistant') {
        msgs[msgs.length - 1] = { ...last, content: last.content + text };
      } else {
        msgs.push({ role: 'assistant', content: text, timestamp: Date.now() });
      }
      return { messages: msgs };
    }),
  setHistoryMeta: (total, hasMore) => set({ historyTotal: total, historyHasMore: hasMore }),
  setLoadingHistory: (loading) => set({ isLoadingHistory: loading }),
  clearMessages: () => set({ messages: [], historyTotal: 0, historyHasMore: false }),

  // Stream events → chat messages
  handleStreamEvent: (eventType, content, toolName, toolInput) => {
    const store = get();
    switch (eventType) {
      case 'assistant_text':
        store.appendAssistantText(content);
        break;
      case 'tool_use':
        store.appendMessage({
          role: 'tool',
          content: toolInput || '',
          toolName,
          toolInput,
          timestamp: Date.now(),
        });
        break;
      case 'tool_result':
        store.appendMessage({
          role: 'tool',
          content: content,
          timestamp: Date.now(),
        });
        break;
      case 'system':
        store.appendMessage({
          role: 'system',
          content,
          timestamp: Date.now(),
        });
        break;
      case 'error':
        store.appendMessage({
          role: 'system',
          content: `Error: ${content}`,
          timestamp: Date.now(),
        });
        break;
    }
  },

  // UI
  setPromptInput: (input) => set({ promptInput: input }),
  setVisible: (visible) => set({ isVisible: visible }),

  // Reset
  reset: () =>
    set({
      sessions: [],
      isLoadingSessions: false,
      activeSessionId: null,
      activeStreamId: null,
      isStreaming: false,
      streamError: null,
      messages: [],
      historyTotal: 0,
      historyHasMore: false,
      isLoadingHistory: false,
      promptInput: '',
      isVisible: false,
    }),
}));
