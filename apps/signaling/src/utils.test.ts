import { describe, it, expect } from 'vitest';
import { parseUrl } from './utils.js';

describe('parseUrl', () => {
  it('should parse valid agent URL', () => {
    const result = parseUrl('/agent/abc123def');
    expect(result).toEqual({
      role: 'agent',
      agentId: 'abc123def',
    });
  });

  it('should parse valid pwa URL', () => {
    const result = parseUrl('/pwa/abc123def');
    expect(result).toEqual({
      role: 'pwa',
      agentId: 'abc123def',
    });
  });

  it('should handle URL-safe base64 characters', () => {
    const result = parseUrl('/agent/abc-123_DEF');
    expect(result).toEqual({
      role: 'agent',
      agentId: 'abc-123_DEF',
    });
  });

  it('should reject invalid role', () => {
    expect(parseUrl('/client/abc123def')).toBeNull();
    expect(parseUrl('/server/abc123def')).toBeNull();
  });

  it('should reject missing agent ID', () => {
    expect(parseUrl('/agent/')).toBeNull();
    expect(parseUrl('/agent')).toBeNull();
  });

  it('should reject empty path', () => {
    expect(parseUrl('')).toBeNull();
    expect(parseUrl('/')).toBeNull();
  });

  it('should reject agent ID that is too short', () => {
    expect(parseUrl('/agent/abc')).toBeNull();
    expect(parseUrl('/agent/1234567')).toBeNull(); // 7 chars
  });

  it('should accept minimum valid agent ID length (8 chars)', () => {
    const result = parseUrl('/agent/12345678');
    expect(result).toEqual({
      role: 'agent',
      agentId: '12345678',
    });
  });

  it('should reject agent ID that is too long', () => {
    const longId = 'a'.repeat(65);
    expect(parseUrl(`/agent/${longId}`)).toBeNull();
  });

  it('should accept maximum valid agent ID length (64 chars)', () => {
    const maxId = 'a'.repeat(64);
    const result = parseUrl(`/agent/${maxId}`);
    expect(result).toEqual({
      role: 'agent',
      agentId: maxId,
    });
  });

  it('should reject URLs with query params or fragments', () => {
    expect(parseUrl('/agent/abc123def?foo=bar')).toBeNull();
    expect(parseUrl('/agent/abc123def#section')).toBeNull();
  });

  it('should reject URLs with extra path segments', () => {
    expect(parseUrl('/agent/abc123def/extra')).toBeNull();
  });

  it('should reject agent IDs with special characters', () => {
    expect(parseUrl('/agent/abc.123')).toBeNull();
    expect(parseUrl('/agent/abc@123')).toBeNull();
    expect(parseUrl('/agent/abc 123')).toBeNull();
  });
});
