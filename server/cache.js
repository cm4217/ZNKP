// 简易内存缓存
class Cache {
    constructor() {
        this.store = new Map();
        // 进行中的请求（防止缓存击穿：并发miss时只fetch一次）
        this.pending = new Map();
    }

    get(key) {
        const entry = this.store.get(key);
        if (!entry) return null;
        if (Date.now() > entry.expireAt) {
            this.store.delete(key);
            return null;
        }
        return entry.data;
    }

    set(key, data, ttlSeconds) {
        this.store.set(key, {
            data,
            expireAt: Date.now() + ttlSeconds * 1000
        });
    }

    // 异步获取，带缓存；并发miss共享同一fetch
    async getOrFetch(key, ttlSeconds, fetchFn) {
        const cached = this.get(key);
        if (cached !== null) return cached;

        if (this.pending.has(key)) {
            return this.pending.get(key).promise;
        }

        const promise = (async () => {
            try {
                const data = await fetchFn();
                this.set(key, data, ttlSeconds);
                return data;
            } finally {
                this.pending.delete(key);
            }
        })();

        this.pending.set(key, { promise, createdAt: Date.now() });
        return promise;
    }

    // 清理过期缓存
    cleanup() {
        const now = Date.now();
        for (const [key, entry] of this.store.entries()) {
            if (now > entry.expireAt) {
                this.store.delete(key);
            }
        }
        // 只清理超过30秒仍未完成的pending请求；进行中的正常请求不能删，
        // 否则清理后新请求会绕过击穿保护发起重复上游请求
        for (const [key, entry] of this.pending.entries()) {
            if (now - entry.createdAt > 30000) {
                this.pending.delete(key);
            }
        }
    }
}

module.exports = new Cache();
