import { describe, it, expect } from 'vitest';
import {
  generateMessageId,
  createMessage,
  createRequest,
  parseMessage,
  serializeMessage,
  isResponseMessage,
  getRequestType,
  REQUEST_RESPONSE_MAP,
} from './protocol.js';

describe('generateMessageId', () => {
  it('should generate unique IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateMessageId());
    }
    expect(ids.size).toBe(100);
  });

  it('should generate IDs with expected format', () => {
    const id = generateMessageId();
    // Format: timestamp-randomString
    expect(id).toMatch(/^\d+-[a-z0-9]+$/);
  });
});

describe('createMessage', () => {
  it('should create a properly structured message', () => {
    const payload = { test: 'data' };
    const message = createMessage('ping', payload);

    expect(message.id).toBeDefined();
    expect(message.type).toBe('ping');
    expect(message.payload).toEqual(payload);
    expect(message.timestamp).toBeDefined();
    expect(typeof message.timestamp).toBe('number');
  });

  it('should create unique IDs for each message', () => {
    const msg1 = createMessage('ping', {});
    const msg2 = createMessage('ping', {});

    expect(msg1.id).not.toBe(msg2.id);
  });

  it('should set timestamp close to current time', () => {
    const before = Date.now();
    const message = createMessage('pong', { timestamp: 0 });
    const after = Date.now();

    expect(message.timestamp).toBeGreaterThanOrEqual(before);
    expect(message.timestamp).toBeLessThanOrEqual(after);
  });
});

describe('createRequest', () => {
  it('should create request with correct response type', () => {
    const { message, responseType } = createRequest('git:status', { path: '/' });

    expect(message.type).toBe('git:status');
    expect(message.payload).toEqual({ path: '/' });
    expect(responseType).toBe('git:status:response');
  });

  it('should work with different request types', () => {
    const types = ['git:diff', 'git:stage', 'git:commit', 'git:log'];

    for (const type of types) {
      const { responseType } = createRequest(type as any, {});
      expect(responseType).toBe(`${type}:response`);
    }
  });
});

describe('parseMessage', () => {
  it('should parse valid JSON message', () => {
    const original = createMessage('ping', { data: 'test' });
    const json = JSON.stringify(original);

    const parsed = parseMessage(json);

    expect(parsed.id).toBe(original.id);
    expect(parsed.type).toBe(original.type);
    expect(parsed.payload).toEqual(original.payload);
    expect(parsed.timestamp).toBe(original.timestamp);
  });

  it('should throw on invalid JSON', () => {
    expect(() => parseMessage('not valid json')).toThrow();
  });

  it('should throw on missing id', () => {
    const invalid = JSON.stringify({ type: 'ping', payload: {}, timestamp: 123 });
    expect(() => parseMessage(invalid)).toThrow('Invalid message format');
  });

  it('should throw on missing type', () => {
    const invalid = JSON.stringify({ id: '123', payload: {}, timestamp: 123 });
    expect(() => parseMessage(invalid)).toThrow('Invalid message format');
  });

  it('should throw on missing timestamp', () => {
    const invalid = JSON.stringify({ id: '123', type: 'ping', payload: {} });
    expect(() => parseMessage(invalid)).toThrow('Invalid message format');
  });

  it('should throw on null message', () => {
    expect(() => parseMessage('null')).toThrow('Invalid message format');
  });

  it('should throw on array', () => {
    expect(() => parseMessage('[]')).toThrow('Invalid message format');
  });
});

describe('serializeMessage', () => {
  it('should serialize message to JSON string', () => {
    const message = createMessage('ping', { test: true });
    const json = serializeMessage(message);

    expect(typeof json).toBe('string');

    const parsed = JSON.parse(json);
    expect(parsed.id).toBe(message.id);
    expect(parsed.type).toBe(message.type);
    expect(parsed.payload).toEqual(message.payload);
  });

  it('should produce valid JSON that can be parsed back', () => {
    const original = createMessage('git:status:response', {
      branch: 'main',
      staged: [],
      unstaged: [],
      untracked: [],
      ahead: 0,
      behind: 0,
    });

    const json = serializeMessage(original);
    const parsed = parseMessage(json);

    expect(parsed).toEqual(original);
  });
});

describe('isResponseMessage', () => {
  it('should identify response messages', () => {
    expect(isResponseMessage({ id: '1', type: 'git:status:response', payload: {}, timestamp: 1 })).toBe(true);
    expect(isResponseMessage({ id: '1', type: 'git:diff:response', payload: {}, timestamp: 1 })).toBe(true);
    expect(isResponseMessage({ id: '1', type: 'handshake:ack', payload: {}, timestamp: 1 })).toBe(false);
  });

  it('should identify non-response messages', () => {
    expect(isResponseMessage({ id: '1', type: 'ping', payload: {}, timestamp: 1 })).toBe(false);
    expect(isResponseMessage({ id: '1', type: 'git:status', payload: {}, timestamp: 1 })).toBe(false);
    expect(isResponseMessage({ id: '1', type: 'handshake', payload: {}, timestamp: 1 })).toBe(false);
  });
});

describe('getRequestType', () => {
  it('should extract request type from response type', () => {
    expect(getRequestType('git:status:response' as any)).toBe('git:status');
    expect(getRequestType('git:diff:response' as any)).toBe('git:diff');
    expect(getRequestType('git:commit:response' as any)).toBe('git:commit');
  });
});

describe('REQUEST_RESPONSE_MAP', () => {
  it('should contain all git operations', () => {
    const expectedOperations = [
      'git:status',
      'git:diff',
      'git:stage',
      'git:unstage',
      'git:commit',
      'git:log',
      'git:branches',
      'git:checkout',
      'git:discard',
    ];

    for (const op of expectedOperations) {
      expect(REQUEST_RESPONSE_MAP[op]).toBeDefined();
      expect(REQUEST_RESPONSE_MAP[op]).toBe(`${op}:response`);
    }
  });

  it('should contain handshake mapping', () => {
    expect(REQUEST_RESPONSE_MAP['handshake']).toBe('handshake:ack');
  });

  it('should contain ping/pong mapping', () => {
    expect(REQUEST_RESPONSE_MAP['ping']).toBe('pong');
  });
});
