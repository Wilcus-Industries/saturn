// In-process TTL cache (server-only). INVARIANT: production is exactly one
// long-lived `next start` process (the Pi's `saturn` systemd service) —
// invalidation is process-local, so these caches must be removed or
// externalized if the app ever runs more than one instance. Dev-HMR module
// resets just empty a cache (a harmless miss + reload).
type Entry<V> = { value: V; expiresAt: number };

export function createTtlCache<V>(ttlMs: number, maxEntries = 1000) {
    const map = new Map<string, Entry<V>>();
    const inflight = new Map<string, Promise<V>>();
    const get = (key: string): V | undefined => {
        const e = map.get(key);
        if (!e) return undefined;
        if (e.expiresAt < Date.now()) {
            map.delete(key);
            return undefined;
        }
        return e.value;
    };
    const set = (key: string, value: V) => {
        if (map.size >= maxEntries && !map.has(key)) {
            const oldest = map.keys().next().value;
            if (oldest !== undefined) map.delete(oldest);
        }
        map.set(key, { value, expiresAt: Date.now() + ttlMs });
    };
    return {
        get,
        set,
        delete: (key: string) => void map.delete(key),
        clear: () => map.clear(),
        // single-flight loader: concurrent misses on one key share one load;
        // only a successful load populates the cache
        async getOrLoad(key: string, load: () => Promise<V>): Promise<V> {
            const hit = get(key);
            if (hit !== undefined) return hit;
            const pending = inflight.get(key);
            if (pending) return pending;
            const p = load().finally(() => inflight.delete(key));
            inflight.set(key, p);
            const value = await p;
            set(key, value);
            return value;
        },
    };
}
