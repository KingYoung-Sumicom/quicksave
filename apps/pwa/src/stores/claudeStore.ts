import { create } from 'zustand';
import type { ClaudeSessionSummary, ClaudeStreamEventType, ClaudeUserInputRequestPayload } from '@sumicom/quicksave-shared';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  toolName?: string;      // Present on tool_use messages
  toolInput?: string;     // JSON string of tool input (tool_use only)
  toolResultOf?: string;  // toolName of the preceding tool_use (tool_result only)
  pendingInputRequest?: ClaudeUserInputRequestPayload; // Pending user action on this tool call
  _synthetic?: boolean;   // Created by tagPendingInput before the stream event arrived
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

  // Deferred pending input (arrived before history loaded)
  deferredPendingInput: ClaudeUserInputRequestPayload | null;

  // UI
  promptInput: string;
  isVisible: boolean;

  // Session preferences (applied on next session start)
  selectedModel: string;
  selectedPermissionMode: string;

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

  // Actions — pending input (tag/clear on messages)
  tagPendingInput: (request: ClaudeUserInputRequestPayload) => void;
  clearPendingInput: (requestId: string) => void;

  // Actions — session preferences
  setSelectedModel: (model: string) => void;
  setSelectedPermissionMode: (mode: string) => void;

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
  deferredPendingInput: null,
  promptInput: '',
  isVisible: false,
  selectedModel: 'claude-sonnet-4-6',
  selectedPermissionMode: 'acceptEdits',

  // Sessions
  setSessions: (sessions) => set({ sessions }),
  setLoadingSessions: (loading) => set({ isLoadingSessions: loading }),

  // Active session
  setActiveSession: (sessionId, streamId = null) =>
    set({ activeSessionId: sessionId, activeStreamId: streamId, streamError: null }),
  setStreaming: (streaming) => set({ isStreaming: streaming }),
  setStreamError: (error) => set({ streamError: error, isStreaming: false }),

  // Messages
  setMessages: (messages) => set((state) => {
    const last = messages[messages.length - 1];
    // Apply deferred pending input OR preserve existing pending from prior setMessages
    const deferred = state.deferredPendingInput;
    const existingPending = state.messages.find((m) => m.pendingInputRequest)?.pendingInputRequest;
    const pending = deferred ?? existingPending;

    if (pending && last?.toolName && !last.toolResultOf && !last.pendingInputRequest) {
      messages = [...messages];
      messages[messages.length - 1] = { ...last, pendingInputRequest: pending };
    }
    return { messages, deferredPendingInput: null };
  }),
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
      case 'user_message': {
        // Broadcast from agent when another tab sends a prompt — avoid duplicating our own
        const alreadyHas = store.messages.some(
          (m) => m.role === 'user' && m.content === content
            && Date.now() - m.timestamp < 5000
        );
        if (!alreadyHas) {
          store.appendMessage({ role: 'user', content, timestamp: Date.now() });
        }
        break;
      }
      case 'assistant_text':
        store.appendAssistantText(content);
        break;
      case 'tool_use': {
        // Check if a synthetic message was already created by tagPendingInput
        // (SDK calls canUseTool before yielding tool_use to stream, causing a deadlock
        //  where the stream event only arrives AFTER the user responds)
        const msgs = store.messages;
        const hasSynthetic = msgs.some(
          (m) => m._synthetic && m.role === 'tool' && m.toolName === toolName
        );
        if (hasSynthetic) {
          // Clear the synthetic flag — the real stream event confirms it
          set((state) => ({
            messages: state.messages.map((m) =>
              m._synthetic && m.role === 'tool' && m.toolName === toolName
                ? { ...m, _synthetic: undefined }
                : m
            ),
          }));
          break;
        }

        // Normal: no synthetic, just append
        store.appendMessage({
          role: 'tool',
          content: toolInput || '',
          toolName,
          toolInput,
          timestamp: Date.now(),
        });
        break;
      }
      case 'tool_result': {
        // Associate result with the preceding tool call's toolName
        const msgs = store.messages;
        const prevTool = msgs.length > 0 ? msgs[msgs.length - 1] : undefined;
        const resultOf = prevTool?.role === 'tool' && prevTool.toolName ? prevTool.toolName : undefined;
        store.appendMessage({
          role: 'tool',
          content: content,
          toolResultOf: resultOf,
          timestamp: Date.now(),
        });
      }
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

  // Pending input: tag the last message if it's an unanswered tool call,
  // create a synthetic if streaming (tool_use not yet arrived), or defer for history load.
  tagPendingInput: (request) =>
    set((state) => {
      const last = state.messages[state.messages.length - 1];
      console.log(`[tagPendingInput] requestId=${request.requestId} toolName=${request.toolName} msgCount=${state.messages.length} isStreaming=${state.isStreaming} last.toolName=${last?.toolName} last.toolResultOf=${last?.toolResultOf}`);
      // Last message is a tool call with no result following → tag it
      if (last?.toolName && !last.toolResultOf && !last.pendingInputRequest) {
        console.log(`[tagPendingInput] tagging last message directly`);
        const msgs = [...state.messages];
        msgs[msgs.length - 1] = { ...last, pendingInputRequest: request };
        return { messages: msgs };
      }
      // SDK calls canUseTool BEFORE yielding tool_use to the stream.
      // Create a synthetic message so the user can respond immediately.
      if (state.isStreaming) {
        console.log(`[tagPendingInput] creating synthetic (streaming)`);
        return {
          messages: [...state.messages, {
            role: 'tool' as const,
            content: request.toolInput ? JSON.stringify(request.toolInput) : '',
            toolName: request.toolName,
            toolInput: request.toolInput ? JSON.stringify(request.toolInput) : undefined,
            pendingInputRequest: request,
            _synthetic: true,
            timestamp: Date.now(),
          }],
        };
      }
      // Reconnect: history hasn't loaded yet — defer for setMessages to apply
      console.log(`[tagPendingInput] deferring (not streaming, no matching last message)`);
      return { deferredPendingInput: request };
    }),

  clearPendingInput: (requestId) =>
    set((state) => {
      const msgs = state.messages.map((m) =>
        m.pendingInputRequest?.requestId === requestId
          ? { ...m, pendingInputRequest: undefined }
          : m
      );
      return { messages: msgs };
    }),

  // Session preferences
  setSelectedModel: (model) => set({ selectedModel: model }),
  setSelectedPermissionMode: (mode) => set({ selectedPermissionMode: mode }),

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
      deferredPendingInput: null,
      promptInput: '',
      isVisible: false,
    }),
}));
