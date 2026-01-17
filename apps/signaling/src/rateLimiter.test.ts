import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { RateLimiter } from './rateLimiter.js';

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should allow first connection from IP', () => {
    const limiter = new RateLimiter(60000, 10);
    expect(limiter.checkConnection('192.168.1.1')).toBe(true);
  });

  it('should allow connections up to the limit', () => {
    const limiter = new RateLimiter(60000, 5);
    const ip = '192.168.1.1';

    for (let i = 0; i < 5; i++) {
      expect(limiter.checkConnection(ip)).toBe(true);
    }
  });

  it('should block connections over the limit', () => {
    const limiter = new RateLimiter(60000, 3);
    const ip = '192.168.1.1';

    expect(limiter.checkConnection(ip)).toBe(true);
    expect(limiter.checkConnection(ip)).toBe(true);
    expect(limiter.checkConnection(ip)).toBe(true);
    expect(limiter.checkConnection(ip)).toBe(false);
    expect(limiter.checkConnection(ip)).toBe(false);
  });

  it('should track different IPs independently', () => {
    const limiter = new RateLimiter(60000, 2);

    expect(limiter.checkConnection('192.168.1.1')).toBe(true);
    expect(limiter.checkConnection('192.168.1.1')).toBe(true);
    expect(limiter.checkConnection('192.168.1.1')).toBe(false);

    expect(limiter.checkConnection('192.168.1.2')).toBe(true);
    expect(limiter.checkConnection('192.168.1.2')).toBe(true);
    expect(limiter.checkConnection('192.168.1.2')).toBe(false);
  });

  it('should reset count after window expires', () => {
    const windowMs = 60000;
    const limiter = new RateLimiter(windowMs, 2);
    const ip = '192.168.1.1';

    expect(limiter.checkConnection(ip)).toBe(true);
    expect(limiter.checkConnection(ip)).toBe(true);
    expect(limiter.checkConnection(ip)).toBe(false);

    // Advance time past the window
    vi.advanceTimersByTime(windowMs + 1);

    expect(limiter.checkConnection(ip)).toBe(true);
    expect(limiter.checkConnection(ip)).toBe(true);
    expect(limiter.checkConnection(ip)).toBe(false);
  });

  it('should not reset count before window expires', () => {
    const windowMs = 60000;
    const limiter = new RateLimiter(windowMs, 2);
    const ip = '192.168.1.1';

    expect(limiter.checkConnection(ip)).toBe(true);
    expect(limiter.checkConnection(ip)).toBe(true);
    expect(limiter.checkConnection(ip)).toBe(false);

    // Advance time but not past the window
    vi.advanceTimersByTime(windowMs - 1000);

    expect(limiter.checkConnection(ip)).toBe(false);
  });

  it('should handle high volume of different IPs', () => {
    const limiter = new RateLimiter(60000, 5);

    for (let i = 0; i < 100; i++) {
      const ip = `192.168.1.${i}`;
      expect(limiter.checkConnection(ip)).toBe(true);
    }
  });
});
