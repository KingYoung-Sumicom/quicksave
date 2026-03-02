import type { Message, MessageType } from './types.js';

/**
 * Generate a unique message ID
 */
export function generateMessageId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Create a typed message
 */
export function createMessage<T>(type: MessageType, payload: T): Message<T> {
  return {
    id: generateMessageId(),
    type,
    payload,
    timestamp: Date.now(),
  };
}

/**
 * Create a request message and return both the message and a response handler
 */
export function createRequest<TReq>(
  type: MessageType,
  payload: TReq
): {
  message: Message<TReq>;
  responseType: MessageType;
} {
  const message = createMessage(type, payload);
  const responseType = `${type}:response` as MessageType;
  return { message, responseType };
}

/**
 * Parse and validate a message
 */
export function parseMessage(data: string): Message {
  const parsed = JSON.parse(data);

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof parsed.id !== 'string' ||
    typeof parsed.type !== 'string' ||
    typeof parsed.timestamp !== 'number'
  ) {
    throw new Error('Invalid message format');
  }

  return parsed as Message;
}

/**
 * Serialize a message to JSON
 */
export function serializeMessage(message: Message): string {
  return JSON.stringify(message);
}

/**
 * Type guard for response messages
 */
export function isResponseMessage(message: Message): boolean {
  return message.type.endsWith(':response');
}

/**
 * Get the request type from a response type
 */
export function getRequestType(responseType: MessageType): MessageType {
  return responseType.replace(':response', '') as MessageType;
}

/**
 * Request types and their expected response types
 */
export const REQUEST_RESPONSE_MAP: Record<string, string> = {
  'git:status': 'git:status:response',
  'git:diff': 'git:diff:response',
  'git:stage': 'git:stage:response',
  'git:unstage': 'git:unstage:response',
  'git:commit': 'git:commit:response',
  'git:log': 'git:log:response',
  'git:branches': 'git:branches:response',
  'git:checkout': 'git:checkout:response',
  'git:discard': 'git:discard:response',
  'git:untrack': 'git:untrack:response',
  'git:gitignore-add': 'git:gitignore-add:response',
  'git:gitignore-read': 'git:gitignore-read:response',
  'git:gitignore-write': 'git:gitignore-write:response',
  handshake: 'handshake:ack',
  ping: 'pong',
};
