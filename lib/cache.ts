import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 高德接口的本地磁盘缓存（服务端 / 离线脚本专用）。
 *
 * 为什么要做：调试取数时同一个请求会反复打高德配额，命中缓存就直接读文件。
 * 缓存键 = sha256(「函数名 + 参数」的 JSON)，缓存文件落在项目根的 .cache/ 下（已进 .gitignore）。
 * 必须在 .gitignore 里，不能提交进仓库。
 *
 * M4.5 3.4：加一层进程内 LRU（上限 500 条），命中就不再读磁盘。
 * 同一对 from→to 的路线在一次行程里可能被多轮/多遍复用（例如用餐修复），这层能直接省掉重复 IO。
 */

const CACHE_DIR = join(process.cwd(), ".cache");

/** 进程内 LRU 上限（M4.5 3.4）。 */
const MEMORY_LIMIT = 500;

const memoryCache = new Map<string, unknown>();

function cacheDigest(fn: string, params: Record<string, string>): string {
  return createHash("sha256")
    .update(JSON.stringify({ fn, params }))
    .digest("hex");
}

function cacheFilePath(fn: string, params: Record<string, string>): string {
  return join(CACHE_DIR, `${cacheDigest(fn, params)}.json`);
}

/** 读内存 LRU；命中后把它移到队尾（最近使用）。 */
function memoryGet<T>(key: string): { hit: true; value: T } | { hit: false } {
  if (!memoryCache.has(key)) return { hit: false };
  const value = memoryCache.get(key) as T;
  memoryCache.delete(key);
  memoryCache.set(key, value);
  return { hit: true, value };
}

function memorySet(key: string, value: unknown): void {
  if (memoryCache.has(key)) memoryCache.delete(key);
  memoryCache.set(key, value);
  if (memoryCache.size > MEMORY_LIMIT) {
    const oldest = memoryCache.keys().next();
    if (!oldest.done) memoryCache.delete(oldest.value);
  }
}

/* ------------------------------------------------------------------ *
 * M4.5 请求计数（只用于自检脚本度量，不影响缓存行为）
 *
 * - memoryHits：进程内 LRU 命中次数；
 * - diskHits：读到磁盘缓存的次数（热缓存时应该等于全部请求数）；
 * - misses：缓存没命中、需要真打接口的次数（重试一次会记两次，和实际网络请求一致）；
 * - uniqueMisses：**唯一请求数** = 没命中的不同缓存键个数（同一请求重试只算 1 条）。
 * ------------------------------------------------------------------ */

export type CacheStats = {
  memoryHits: number;
  diskHits: number;
  misses: number;
  uniqueMisses: number;
};

const stats: { memoryHits: number; diskHits: number; misses: number } = {
  memoryHits: 0,
  diskHits: 0,
  misses: 0,
};
const missedKeys = new Set<string>();

export function resetCacheStats(): void {
  stats.memoryHits = 0;
  stats.diskHits = 0;
  stats.misses = 0;
  missedKeys.clear();
}

export function getCacheStats(): CacheStats {
  return {
    memoryHits: stats.memoryHits,
    diskHits: stats.diskHits,
    misses: stats.misses,
    uniqueMisses: missedKeys.size,
  };
}

function recordMiss(fn: string, params: Record<string, string>): null {
  stats.misses += 1;
  missedKeys.add(cacheDigest(fn, params));
  return null;
}

/** 命中返回缓存内容；没有命中（或文件损坏）返回 null，由调用方重新请求。 */
export function readCache<T>(fn: string, params: Record<string, string>): T | null {
  const key = cacheDigest(fn, params);

  // M4.5 3.4：先查进程内 LRU，命中就不读文件。
  const inMemory = memoryGet<T>(key);
  if (inMemory.hit) {
    stats.memoryHits += 1;
    return inMemory.value;
  }

  let text: string;
  try {
    text = readFileSync(cacheFilePath(fn, params), "utf8");
  } catch {
    return recordMiss(fn, params);
  }
  try {
    const parsed = JSON.parse(text) as T;
    stats.diskHits += 1;
    memorySet(key, parsed);
    return parsed;
  } catch {
    return recordMiss(fn, params);
  }
}

/** 只有成功响应才写缓存，避免一次网络抖动把失败结果固化下来。 */
export function writeCache<T>(fn: string, params: Record<string, string>, value: T): void {
  const key = cacheDigest(fn, params);
  memorySet(key, value);
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cacheFilePath(fn, params), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/* ------------------------------------------------------------------ *
 * 通用进程内 LRU（城市数据加载器等复用；与上面的高德请求缓存互不影响）
 * ------------------------------------------------------------------ */

/** 进程内 LRU 的最小接口：本项目只需要 get / set / has / delete / clear / size。 */
export type MemoryLru<K, V> = {
  readonly size: number;
  /** 命中返回 value 并把它移到队尾（最近使用）；没命中返回 undefined。 */
  get(key: K): V | undefined;
  /** 写入 / 覆盖；超过 limit 时从队头淘汰最旧的键。 */
  set(key: K, value: V): void;
  has(key: K): boolean;
  delete(key: K): boolean;
  clear(): void;
};

/**
 * 造一个进程内 LRU：
 * - get 命中后把该键移到队尾（最近使用）；
 * - set 之后若超过 limit，就从队头淘汰最旧的键（单个 key 只占一个位置，覆盖不算新增）；
 * - limit 必须是 ≥1 的整数，否则直接抛错（不猜一个默认值）。
 */
export function createMemoryLru<K, V>(limit: number): MemoryLru<K, V> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`createMemoryLru：limit 必须是 ≥1 的整数，收到：${String(limit)}`);
  }
  const store = new Map<K, V>();
  return {
    get size(): number {
      return store.size;
    },
    get(key: K): V | undefined {
      if (!store.has(key)) return undefined;
      const value = store.get(key) as V;
      store.delete(key);
      store.set(key, value);
      return value;
    },
    set(key: K, value: V): void {
      if (store.has(key)) store.delete(key);
      store.set(key, value);
      while (store.size > limit) {
        const oldest = store.keys().next();
        if (oldest.done) break;
        store.delete(oldest.value);
      }
    },
    has(key: K): boolean {
      return store.has(key);
    },
    delete(key: K): boolean {
      return store.delete(key);
    },
    clear(): void {
      store.clear();
    },
  };
}
