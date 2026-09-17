const express = require('express');
const cors = require('cors');
const path = require('path');
const cache = require('./cache');
const ds = require('./data-source');
const predict = require('./predict');
const backfill = require('./backfill');

const app = express();
const PORT = process.env.PORT || 3000;
// 部署在Render/Railway/Zeabur等反向代理后，req.ip取真实客户端IP（否则限流把所有用户合并成代理IP一个桶）
app.set('trust proxy', 1);

// ===== 简易内存限流（每IP每分钟300次API请求）=====
// 本地前端页面多模块轮询（指数/加密/黄金每15秒+K线切换），多标签页时会叠加，120太容易误伤
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 300;

function rateLimiter(req, res, next) {
    if (!req.path.startsWith('/api/')) return next();
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = rateLimitMap.get(key);
    if (!entry || now - entry.start > RATE_LIMIT_WINDOW) {
        entry = { start: now, count: 0 };
        rateLimitMap.set(key, entry);
    }
    entry.count++;
    if (entry.count > RATE_LIMIT_MAX) {
        return res.status(429).json({ success: false, error: '请求过于频繁，请稍后再试' });
    }
    next();
}

// 定期清理限流记录
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitMap) {
        if (now - entry.start > RATE_LIMIT_WINDOW * 2) rateLimitMap.delete(key);
    }
}, 120000);

// ===== 参数校验 =====
const VALID_PERIODS = ['1D', '1W', '1M', '3M', '1Y'];
const VALID_NEWS_CATEGORIES = ['all', 'important', 'policy', 'market', 'company'];

function validatePeriod(req, res, next) {
    const period = req.query.period || '1M';
    if (!VALID_PERIODS.includes(period)) {
        return res.status(400).json({ success: false, error: `无效的周期参数: ${period}，可选值: ${VALID_PERIODS.join(', ')}` });
    }
    req.period = period;
    next();
}

// 中间件（限流最前置，避免被body解析等中间件短路）
app.use(rateLimiter);
app.use(cors());
app.use(express.json());

// 安全响应头
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer-when-downgrade');
    next();
});

// 静态文件 - 仅暴露前端资源（server/目录含源码与预测数据存储，绝不能对外）
app.use('/assets', express.static(path.join(__dirname, '..', 'assets')));
app.use('/_shared', express.static(path.join(__dirname, '..', '_shared')));

const FRONTEND_PAGE = path.join(__dirname, '..', 'market-dashboard.html');
app.get('/', (req, res) => res.sendFile(FRONTEND_PAGE));
app.get('/market-dashboard.html', (req, res) => res.sendFile(FRONTEND_PAGE));

// 定期清理缓存
setInterval(() => cache.cleanup(), 60000);

// ========== 健康检查 ==========
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        cacheSize: cache.store.size
    });
});

// ========== 指数行情 ==========

// 全部指数聚合（indices与briefing共用同一份缓存，避免重复请求上游）
async function getAllIndicesGrouped() {
    return cache.getOrFetch('indices_all', 15, async () => {
        const allCodes = Object.keys(ds.INDEX_CONFIG);
        const { data, source, count } = await ds.getIndexQuotes(allCodes);

        // 按地区分组
        const grouped = {
            china: {},
            hongkong: {},
            us: {},
            americas: {},
            europe: {},
            asia: {},
            all: data
        };

        Object.keys(data).forEach(code => {
            const cfg = ds.INDEX_CONFIG[code];
            if (cfg && grouped[cfg.category]) {
                grouped[cfg.category][code] = data[code];
            }
            // 同时映射到前端期望的americas组
            if (cfg && cfg.category === 'us') {
                grouped.americas[code] = data[code];
            }
        });

        return { ...grouped, source, count };
    });
}

// 综合行情 - 获取所有主要指数
app.get('/api/indices', async (req, res) => {
    try {
        const result = await getAllIndicesGrouped();
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 单个指数K线
app.get('/api/indices/:code/kline', validatePeriod, async (req, res) => {
    try {
        const code = req.params.code;
        if (!ds.INDEX_CONFIG[code]) {
            return res.status(400).json({ success: false, error: `未知的指数代码: ${code}` });
        }
        const period = req.period;
        const cacheKey = `kline_${code}_${period}`;

        const result = await cache.getOrFetch(cacheKey, 300, async () => {
            return await ds.getIndexKline(code, period);
        });

        res.json({ success: true, ...result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ========== 数字货币 ==========

// 数字货币行情（Binance → Gate.io 自动降级）
app.get('/api/crypto/ticker', async (req, res) => {
    try {
        const symbols = (req.query.symbols || 'BTC,ETH,BNB,SOL').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
        if (symbols.length === 0 || symbols.length > 10) {
            return res.status(400).json({ success: false, error: 'symbols参数无效（1-10个币种）' });
        }
        const cacheKey = 'crypto_ticker_' + symbols.join('_');
        const { data, source } = await cache.getOrFetch(cacheKey, 10, async () => {
            return await ds.getCryptoTicker(symbols);
        });
        if (Object.keys(data).length === 0 && source === 'unavailable') {
            // 全部加密货币源都失败时返回503，让前端保留上一份数据或降级显示
            return res.status(503).json({ success: false, error: '加密货币数据源暂不可用，请稍后重试' });
        }
        res.json({ success: true, data, source });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 数字货币K线（Binance → Gate.io 自动降级）
app.get('/api/crypto/:symbol/kline', validatePeriod, async (req, res) => {
    try {
        const symbol = req.params.symbol.toUpperCase();
        if (!/^[A-Z0-9]{2,10}$/.test(symbol)) {
            return res.status(400).json({ success: false, error: `无效的币种代码: ${symbol}` });
        }
        const period = req.period;
        const intervalMap = {
            '1D': { interval: '1h', count: 24 },
            '1W': { interval: '1d', count: 7 },
            '1M': { interval: '1d', count: 30 },
            '3M': { interval: '1w', count: 12 },
            '1Y': { interval: '1w', count: 52 }
        };
        const p = intervalMap[period] || intervalMap['1M'];

        const cacheKey = `crypto_kline_${symbol}_${period}`;
        const { data, source } = await cache.getOrFetch(cacheKey, 300, async () => {
            return await ds.getCryptoKline(symbol, p.interval, p.count);
        });

        res.json({ success: true, data, source });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ========== 黄金 ==========

// 黄金价格
app.get('/api/gold/price', async (req, res) => {
    try {
        const data = await cache.getOrFetch('gold_price', 60, async () => {
            return await ds.getGoldPrice();
        });
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 黄金K线
app.get('/api/gold/kline', validatePeriod, async (req, res) => {
    try {
        const period = req.period;
        const cacheKey = `gold_kline_${period}`;
        const { data, source } = await cache.getOrFetch(cacheKey, 300, async () => {
            return await ds.getGoldKline(period);
        });
        res.json({ success: true, data, source });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ========== 财经新闻 ==========
app.get('/api/news', async (req, res) => {
    try {
        const category = req.query.category || 'all';
        if (!VALID_NEWS_CATEGORIES.includes(category)) {
            return res.status(400).json({ success: false, error: `无效的新闻类别: ${category}，可选值: ${VALID_NEWS_CATEGORIES.join(', ')}` });
        }
        const cacheKey = `news_${category}`;
        const data = await cache.getOrFetch(cacheKey, 300, async () => {
            return await ds.getFinanceNews(category);
        });
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ========== AI多因子走势预测 ==========
// 注意：标的代码同时支持「路径参数」与「查询参数」两种传法。
// 沪市指数代码后缀 .SH 会被边缘 WAF 误判为 .sh 脚本扩展名而拦截路径，
// 因此前端统一改用查询参数 /api/prediction?code=000001.SH&type=index 规避。
async function handlePrediction(req, res) {
    try {
        const code = req.params.code || req.query.code;
        if (!code) {
            return res.status(400).json({ success: false, error: '缺少 code 参数' });
        }
        const type = ['index', 'crypto', 'gold', 'fund'].includes(req.query.type) ? req.query.type : 'index';
        if (type === 'index' && !ds.INDEX_CONFIG[code]) {
            return res.status(400).json({ success: false, error: `未知的指数代码: ${code}` });
        }
        if (type === 'crypto' && !/^[A-Z0-9]{2,10}$/.test(code)) {
            return res.status(400).json({ success: false, error: `无效的币种代码: ${code}` });
        }
        if (type === 'fund') {
            if (!/^\d{6}$/.test(code)) {
                return res.status(400).json({ success: false, error: `无效的基金代码: ${code}` });
            }
            const fundType = ['index', 'stock', 'hybrid', 'bond'].includes(req.query.fundType) ? req.query.fundType : 'hybrid';
            const result = await predict.predictFundCached(code, fundType);
            if (!result) {
                return res.status(502).json({ success: false, error: `基金数据获取失败: ${code}` });
            }
            return res.json({ success: true, data: result });
        }
        const result = await predict.predictCached(code, type);
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}
app.get('/api/prediction/:code', handlePrediction);
app.get('/api/prediction', handlePrediction);

// 市场情绪总览（涨跌家数/北向资金/恐慌贪婪指数）
app.get('/api/market/sentiment', async (req, res) => {
    try {
        const data = await predict.marketSentimentCached();
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ========== 数据源状态 ==========
app.get('/api/sources/status', async (req, res) => {
    try {
        // 结果缓存30秒：该接口每次会真实探测全部上游，频繁调用代价高
        const results = await cache.getOrFetch('sources_status', 30, async () => {
            const results = {};

            // 快速测试各数据源
            const tests = [
                { key: 'sina', fn: () => ds.getSinaQuote(['000001.SH']) },
                { key: 'eastmoney', fn: () => ds.getEastMoneyQuotes() },
                { key: 'tencent', fn: () => ds.getTencentQuotes(['000001.SH']) },
                { key: 'binance', fn: async () => {
                    const r = await ds.getBinanceTicker(['BTC']);
                    return r;
                } },
                { key: 'gateio', fn: () => ds.getGateTicker(['BTC']) },
                { key: 'gold', fn: () => ds.getGoldPrice() }
            ];

            for (const t of tests) {
                try {
                    const data = await t.fn();
                    results[t.key] = {
                        status: Object.keys(data).length > 0 ? 'ok' : 'empty',
                        dataCount: Object.keys(data).length
                    };
                } catch (e) {
                    results[t.key] = {
                        status: 'fail',
                        error: e.message
                    };
                }
            }
            return results;
        });
        res.json({ success: true, data: results });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ========== 综合简报 ==========
app.get('/api/briefing', async (req, res) => {
    try {
        const data = await cache.getOrFetch('briefing', 15, async () => {
            const [indices, crypto, news] = await Promise.allSettled([
                getAllIndicesGrouped().catch(() => null),
                ds.getCryptoTicker(['BTC', 'ETH', 'BNB', 'SOL']).catch(() => ({ data: {}, source: 'unavailable' })),
                ds.getFinanceNews('important').catch(() => [])
            ]);

            return {
                indices: (indices.status === 'fulfilled' && indices.value) ? indices.value.all : {},
                indicesSource: (indices.status === 'fulfilled' && indices.value) ? indices.value.source : null,
                crypto: crypto.status === 'fulfilled' ? crypto.value.data : {},
                cryptoSource: crypto.status === 'fulfilled' ? crypto.value.source : null,
                topNews: news.status === 'fulfilled' ? news.value.slice(0, 5) : [],
                timestamp: new Date().toISOString()
            };
        });
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ========== 校准样本回填（token 保护，手动触发 / 验证用） ==========
// 沙箱内可访问上游真实历史 K 线，本地 shell 不具备外网，故回填在部署环境内执行。
// 默认 token 仅供个人使用，正式外网部署请通过 BACKFILL_TOKEN 环境变量覆盖。
app.post('/api/admin/backfill', async (req, res) => {
    const token = req.query.token || (req.body && req.body.token);
    const expected = process.env.BACKFILL_TOKEN || 'zhitou-backfill-2026';
    if (token !== expected) {
        return res.status(401).json({ success: false, error: 'unauthorized' });
    }
    try {
        const results = await backfill.backfillAll();
        const ok = results.filter(r => r.ok).length;
        res.json({ success: true, data: { total: results.length, ok, results } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ========== 未匹配的API路由 ==========
app.use('/api', (req, res) => {
    res.status(404).json({ success: false, error: `未找到API路由: ${req.method} ${req.path}` });
});

// 启动服务器
const server = app.listen(PORT, () => {
    console.log('');
    console.log('  ========================================');
    console.log('  智投看盘 - 后端数据代理服务 v2');
    console.log('  ========================================');
    console.log('');
    console.log(`  🚀 服务已启动: http://localhost:${PORT}`);
    console.log(`  🌐 前端页面:  http://localhost:${PORT}/market-dashboard.html`);
    console.log(`  🔍 数据源状态: http://localhost:${PORT}/api/sources/status`);
    console.log('');
    console.log('  📊 数据来源（多源择优+熔断降级）:');
    console.log('     ① 腾讯财经 - A股/港股/美股 行情+K线（主力）');
    console.log('     ② 新浪财经 - 欧洲/亚太/印度/黄金 补充行情');
    console.log('     ③ 东方财富 - 备用行情源（网络受限时自动熔断跳过）');
    console.log('     ④ Binance - 数字货币/黄金PAXG（镜像域名优先，主站备用）');
    console.log('     ⑤ Gate.io - 数字货币/黄金 备用源（自动降级+熔断）');
    console.log('     ⑥ 智能估算 - 澳洲ASX200等无实时源的兜底');
    console.log('');
    console.log('  ⚡ API 接口:');
    console.log('     GET /api/health              - 健康检查');
    console.log('     GET /api/indices             - 全球指数行情（19个）');
    console.log('     GET /api/indices/:code/kline - 指数K线（新浪源）');
    console.log('     GET /api/crypto/ticker       - 数字货币行情');
    console.log('     GET /api/crypto/:symbol/kline- 数字货币K线');
    console.log('     GET /api/gold/price          - 黄金价格');
    console.log('     GET /api/gold/kline          - 黄金K线');
    console.log('     GET /api/news                - 财经新闻');
    console.log('     GET /api/sources/status      - 数据源状态检测');
    console.log('     GET /api/briefing            - 综合简报');
    console.log('     GET /api/prediction/:code    - AI多因子预测（指数/黄金/加密/基金）');
    console.log('     GET /api/market/sentiment    - 市场情绪总览');
    console.log('');
    console.log('  按 Ctrl+C 停止服务');
    console.log('');

    // 启动后自动回填真实历史 K 线校准样本（幂等自愈：仅当校准库样本不足时执行一次）
    backfill.ensureBackfilled()
        .then(r => { if (r) console.log(`  🧮 校准样本回填完成：${r.length} 个标的（样本已灌入 accuracy-store.json）`); })
        .catch(e => console.error('  [校准回填] 失败（不影响主服务）:', e.message));
});

// ===== 优雅关闭 =====
function gracefulShutdown(signal) {
    console.log(`\n  收到 ${signal} 信号，正在关闭服务器...`);
    server.close(() => {
        console.log('  服务器已安全关闭');
        process.exit(0);
    });
    // 5秒后强制退出，避免连接悬挂
    setTimeout(() => {
        console.log('  强制退出（等待超时）');
        process.exit(1);
    }, 5000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// 全局兜底：未捕获的Promise rejection只记日志，不让进程崩溃
process.on('unhandledRejection', (reason) => {
    console.error('[未捕获Rejection]', reason);
});
process.on('uncaughtException', (err) => {
    console.error('[未捕获异常]', err);
});
