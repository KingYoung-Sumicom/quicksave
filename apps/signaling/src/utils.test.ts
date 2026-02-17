import { describe, it, expect } from 'vitest';
import { parseUrl } from './utils.js';

describe('parseUrl', () => {
  it('should parse valid agent URL', () => {
    const result = parseUrl('/agent/abc123def');
    expect(result).toEqual({
      role: 'agent',
      id: 'abc123def',
    });
  });

  it('should parse valid pwa URL', () => {
    const result = parseUrl('/pwa/abc123def');
    expect(result).toEqual({
      role: 'pwa',
      id: 'abc123def',
    });
  });

  it('should handle URL-safe base64 characters', () => {
    const result = parseUrl('/agent/abc-123_DEF');
    expect(result).toEqual({
      role: 'agent',
      id: 'abc-123_DEF',
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
      id: '12345678',
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
      id: maxId,
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

  describe('/pwa/key/{publicKey} path', () => {
    it('should parse valid pwa key URL', () => {
      const result = parseUrl('/pwa/key/abc123defghi');
      expect(result).toEqual({
        role: 'pwa',
        id: 'abc123defghi',
        isPwaKey: true,
      });
    });

    it('should accept URL-encoded base64 characters including +, /, =', () => {
      const key = 'abc+def/ghi=jkl';
      const encodedKey = encodeURIComponent(key); // abc%2Bdef%2Fghi%3Djkl
      const result = parseUrl(`/pwa/key/${encodedKey}`);
      expect(result).toEqual({
        role: 'pwa',
        id: key,
        isPwaKey: true,
      });
    });

    it('should accept standard base64 encoded public key', () => {
      // Simulating a base64-encoded 32-byte key
      const key = 'dGVzdGtleWRhdGExMjM0NTY3ODkwYWJjZGVm';
      const result = parseUrl(`/pwa/key/${key}`);
      expect(result).toEqual({
        role: 'pwa',
        id: key,
        isPwaKey: true,
      });
    });

    it('should accept URL-encoded base64 key with padding', () => {
      const key = 'SGVsbG9Xb3JsZA==';
      const encodedKey = encodeURIComponent(key); // SGVsbG9Xb3JsZA%3D%3D
      const result = parseUrl(`/pwa/key/${encodedKey}`);
      expect(result).toEqual({
        role: 'pwa',
        id: key,
        isPwaKey: true,
      });
    });

    it('should reject key that is too short', () => {
      expect(parseUrl('/pwa/key/abc')).toBeNull();
      expect(parseUrl('/pwa/key/1234567')).toBeNull(); // 7 chars
    });

    it('should accept minimum key length (8 chars)', () => {
      const result = parseUrl('/pwa/key/12345678');
      expect(result).toEqual({
        role: 'pwa',
        id: '12345678',
        isPwaKey: true,
      });
    });

    it('should reject key that is too long', () => {
      const longKey = 'a'.repeat(513);
      expect(parseUrl(`/pwa/key/${longKey}`)).toBeNull();
    });

    it('should accept maximum key length (512 chars)', () => {
      const maxKey = 'a'.repeat(512);
      const result = parseUrl(`/pwa/key/${maxKey}`);
      expect(result).toEqual({
        role: 'pwa',
        id: maxKey,
        isPwaKey: true,
      });
    });

    it('should reject empty key', () => {
      expect(parseUrl('/pwa/key/')).toBeNull();
      expect(parseUrl('/pwa/key')).toBeNull();
    });

    it('should not set isPwaKey for legacy pwa URLs', () => {
      const result = parseUrl('/pwa/abc123def');
      expect(result).toEqual({
        role: 'pwa',
        id: 'abc123def',
      });
      expect(result?.isPwaKey).toBeUndefined();
    });

    it('should not set isPwaKey for agent URLs', () => {
      const result = parseUrl('/agent/abc123def');
      expect(result?.isPwaKey).toBeUndefined();
    });

    it('should reject /agent/key/ paths', () => {
      expect(parseUrl('/agent/key/abc123defghi')).toBeNull();
    });
  });
});
