interface SyncEntry {
  data: string;
  isTombstone: boolean;
  updatedAt: number;
}

interface SyncStoreConfig {
  maxBlobSize: number; // bytes
}

export class SyncStore {
  private entries = new Map<string, SyncEntry>();
  private config: SyncStoreConfig;

  constructor(config: SyncStoreConfig = { maxBlobSize: 8192 }) {
    this.config = config;
  }

  get(keyHash: string): { type: 'blob' | 'tombstone'; data: string } | null {
    const entry = this.entries.get(keyHash);
    if (!entry) return null;
    return {
      type: entry.isTombstone ? 'tombstone' : 'blob',
      data: entry.data,
    };
  }

  put(keyHash: string, data: string): void {
    const existing = this.entries.get(keyHash);
    if (existing?.isTombstone) {
      throw new Error('Cannot write to key with tombstone');
    }
    if (data.length > this.config.maxBlobSize) {
      throw new Error(`Blob exceeds max size (${this.config.maxBlobSize} bytes)`);
    }
    this.entries.set(keyHash, {
      data,
      isTombstone: false,
      updatedAt: Date.now(),
    });
  }

  putTombstone(keyHash: string, data: string): void {
    const existing = this.entries.get(keyHash);
    if (existing?.isTombstone) {
      throw new Error('Tombstone already exists for this key');
    }
    this.entries.set(keyHash, {
      data,
      isTombstone: true,
      updatedAt: Date.now(),
    });
  }

  get stats() {
    let blobs = 0;
    let tombstones = 0;
    for (const entry of this.entries.values()) {
      if (entry.isTombstone) tombstones++;
      else blobs++;
    }
    return { blobs, tombstones, total: this.entries.size };
  }
}
