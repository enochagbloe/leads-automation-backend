export interface CacheService {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  delByPattern(pattern: string): Promise<void>;
}

type CacheEntry = { value: unknown; expiresAt: number | null };

class MemoryCacheService implements CacheService {
  private readonly entries = new Map<string, CacheEntry>();

  async get<T>(key: string): Promise<T | null> {
    try {
      const entry = this.entries.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
        this.entries.delete(key);
        return null;
      }
      return entry.value as T;
    } catch (error) {
      console.error("Cache get failed", { key, error });
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    try {
      this.entries.set(key, {
        value,
        expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
      });
    } catch (error) {
      console.error("Cache set failed", { key, error });
    }
  }

  async del(key: string): Promise<void> {
    try {
      this.entries.delete(key);
    } catch (error) {
      console.error("Cache delete failed", { key, error });
    }
  }

  async delByPattern(pattern: string): Promise<void> {
    try {
      const expression = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
      for (const key of this.entries.keys()) {
        if (expression.test(key)) this.entries.delete(key);
      }
    } catch (error) {
      console.error("Cache pattern delete failed", { pattern, error });
    }
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const cacheService: CacheService = new MemoryCacheService();
