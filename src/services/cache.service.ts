import { createClient } from "redis";
import { env } from "../config/env";

export interface CacheService {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  delByPattern(pattern: string): Promise<void>;
}

type CacheEntry = { value: unknown; expiresAt: number | null };
type RedisClient = ReturnType<typeof createClient>;

const redisScanCount = 500;

class MemoryCacheService implements CacheService {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly sweepTimer?: NodeJS.Timeout;

  constructor(
    private readonly maxEntries = env.CACHE_MAX_ENTRIES,
    sweepIntervalSeconds = env.CACHE_SWEEP_INTERVAL_SECONDS,
  ) {
    this.sweepTimer = setInterval(() => this.sweepExpired(), sweepIntervalSeconds * 1000);
    this.sweepTimer.unref();
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const entry = this.entries.get(key);
      if (!entry) return null;
      if (this.isExpired(entry)) {
        this.entries.delete(key);
        return null;
      }
      this.entries.delete(key);
      this.entries.set(key, entry);
      return entry.value as T;
    } catch (error) {
      console.error("Cache get failed", { key, error });
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    try {
      if (ttlSeconds !== undefined && ttlSeconds <= 0) {
        this.entries.delete(key);
        return;
      }
      this.entries.delete(key);
      this.entries.set(key, {
        value,
        expiresAt: ttlSeconds !== undefined ? Date.now() + ttlSeconds * 1000 : null,
      });
      this.enforceMaxEntries();
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
      if (isUnsafePattern(pattern)) {
        console.error("Cache pattern delete skipped because pattern is too broad", { pattern });
        return;
      }
      if (!pattern.includes("*")) {
        this.entries.delete(pattern);
        return;
      }
      const expression = patternToRegExp(pattern);
      for (const key of this.entries.keys()) {
        if (expression.test(key)) this.entries.delete(key);
      }
    } catch (error) {
      console.error("Cache pattern delete failed", { pattern, error });
    }
  }

  private isExpired(entry: CacheEntry) {
    return entry.expiresAt !== null && entry.expiresAt <= Date.now();
  }

  private sweepExpired() {
    try {
      const now = Date.now();
      for (const [key, entry] of this.entries.entries()) {
        if (entry.expiresAt !== null && entry.expiresAt <= now) this.entries.delete(key);
      }
      this.enforceMaxEntries();
    } catch (error) {
      console.error("Cache sweep failed", { error });
    }
  }

  private enforceMaxEntries() {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) return;
      this.entries.delete(oldestKey);
    }
  }
}

class RedisCacheService implements CacheService {
  private readonly client: RedisClient;
  private connectPromise: Promise<RedisClient> | null = null;
  private failureLogged = false;

  constructor() {
    this.client = createClient({
      url: env.REDIS_URL,
      socket: {
        connectTimeout: 1000,
        reconnectStrategy: false,
      },
    });
    this.client.on("error", (error) => {
      console.error("Redis cache error", { error });
    });
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const value = await (await this.connect()).get(key);
      if (value === null) return null;
      try {
        return JSON.parse(value) as T;
      } catch (parseError) {
        console.error("Cache value is invalid JSON; deleting key", { key, error: parseError });
        await this.del(key);
        return null;
      }
    } catch (error) {
      this.logFailure("Cache get failed; returning miss so caller reloads from database", { key, error });
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds !== undefined && ttlSeconds <= 0) {
      await this.del(key);
      return;
    }
    try {
      const serialized = JSON.stringify(value);
      const client = await this.connect();
      if (ttlSeconds !== undefined) {
        await client.set(key, serialized, { EX: ttlSeconds });
      } else {
        await client.set(key, serialized);
      }
    } catch (error) {
      this.logFailure("Cache set failed", { key, error });
    }
  }

  async del(key: string): Promise<void> {
    try {
      await (await this.connect()).del(key);
    } catch (error) {
      this.logFailure("Cache delete failed", { key, error });
    }
  }

  async delByPattern(pattern: string): Promise<void> {
    try {
      if (isUnsafePattern(pattern)) {
        console.error("Cache pattern delete skipped because pattern is too broad", { pattern });
        return;
      }
      if (!pattern.includes("*")) {
        await this.del(pattern);
        return;
      }
      const client = await this.connect();
      for await (const keys of client.scanIterator({ MATCH: pattern, COUNT: redisScanCount })) {
        const batch = Array.isArray(keys) ? keys : [keys];
        if (batch.length > 0) await client.unlink(batch);
      }
    } catch (error) {
      this.logFailure("Cache pattern delete failed", { pattern, error });
    }
  }

  private async connect() {
    if (this.client.isOpen) return this.client;
    this.connectPromise ??= this.client.connect().then(() => this.client).finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private logFailure(message: string, metadata: Record<string, unknown>) {
    if (!this.failureLogged) {
      console.error(message, metadata);
      this.failureLogged = true;
      return;
    }
    console.error(message, { ...metadata, repeated: true });
  }
}

function isUnsafePattern(pattern: string) {
  const normalized = pattern.trim();
  return normalized === "*" || normalized.startsWith("*") || /^[^:]+:\*$/.test(normalized);
}

function patternToRegExp(pattern: string) {
  return new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const memoryCache = new MemoryCacheService();
console.log(env.REDIS_URL ? "Using Redis cache" : "Using memory cache");

export const cacheService: CacheService = env.REDIS_URL
  ? new RedisCacheService()
  : memoryCache;
