export interface CachedAudioResponse {
  key: string;
  text: string;
  audioChunks: Int16Array[];
  createdAt: number;
  expiresAt: number;
}

export class AudioResponseCache {
  private readonly entries = new Map<string, CachedAudioResponse>();

  constructor(
    private readonly maxEntries: number = 40,
    private readonly ttlMs: number = 8 * 60 * 1000
  ) {}

  get(key: string): CachedAudioResponse | null {
    this.prune();
    const found = this.entries.get(key);
    if (!found) return null;
    if (found.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return {
      ...found,
      audioChunks: found.audioChunks.map((chunk) => new Int16Array(chunk)),
    };
  }

  set(key: string, text: string, audioChunks: Int16Array[]): void {
    this.prune();
    const now = Date.now();
    this.entries.set(key, {
      key,
      text,
      audioChunks: audioChunks.map((chunk) => new Int16Array(chunk)),
      createdAt: now,
      expiresAt: now + this.ttlMs,
    });
    this.enforceMaxEntries();
  }

  clear(): void {
    this.entries.clear();
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, value] of this.entries) {
      if (value.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }

  private enforceMaxEntries(): void {
    if (this.entries.size <= this.maxEntries) return;
    const sorted = [...this.entries.values()].sort((a, b) => a.createdAt - b.createdAt);
    const overflow = this.entries.size - this.maxEntries;
    for (let i = 0; i < overflow; i++) {
      this.entries.delete(sorted[i].key);
    }
  }
}

