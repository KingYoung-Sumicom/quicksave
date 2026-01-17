interface RateLimitEntry {
  count: number;
  windowStart: number;
}

export class RateLimiter {
  private connections: Map<string, RateLimitEntry> = new Map();
  private windowMs: number;
  private maxConnections: number;

  constructor(windowMs: number, maxConnections: number) {
    this.windowMs = windowMs;
    this.maxConnections = maxConnections;

    // Cleanup old entries periodically
    setInterval(() => this.cleanup(), windowMs);
  }

  checkConnection(ip: string): boolean {
    const now = Date.now();
    const entry = this.connections.get(ip);

    if (!entry) {
      this.connections.set(ip, { count: 1, windowStart: now });
      return true;
    }

    // Reset window if expired
    if (now - entry.windowStart > this.windowMs) {
      this.connections.set(ip, { count: 1, windowStart: now });
      return true;
    }

    // Check if within limit
    if (entry.count >= this.maxConnections) {
      return false;
    }

    // Increment and allow
    entry.count++;
    return true;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [ip, entry] of this.connections) {
      if (now - entry.windowStart > this.windowMs) {
        this.connections.delete(ip);
      }
    }
  }
}
