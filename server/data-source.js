const https = require('https');
const http = require('http');
const cache = require('./cache');

// ========== 通用工具 ==========

// 单次底层请求：处理响应流错误、硬超时、重定向
function fetchOnce(url, options, redirectsLeft) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        const req = lib.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': '*/*',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                ...options.headers
            },
            timeout: options.timeout || 8000,
            // 默认校验TLS证书；仅当环境变量 ALLOW_INSECURE_TLS=1 时关闭（本地调试自签证书场景）
            rejectUnauthorized: process.env.ALLOW_INSECURE_TLS !== '1'
        }, (res) => {
            // 3xx 重定向：跟随最多3次
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
                res.resume(); // 丢弃当前响应体
                const next = new URL(res.headers.location, url).toString();
                req.destroy();
                resolve(fetchOnce(next, options, redirectsLeft - 1));
                return;
            }
            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
            res.on('error', reject); // 响应流中途出错也必须reject，否则Promise永久悬挂
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    });
}

function fetchRaw(url, options = {}) {
    const retries = options.retries || 0;
    const attempt = (left) => fetchOnce(url, options, 3).catch(err => {
        // 网络类错误（超时/连接重置）短暂退避后重试；其余错误直接抛出
        const retryable = /timeout|ECONNRESET|ECONNREFUSED|socket hang up|EAI_AGAIN/i.test(err.message || '');
        if (left > 0 && retryable) {
            return new Promise(r => setTimeout(r, 300)).then(() => attempt(left - 1));
        }
        throw err;
    });
    return attempt(retries);
}

function fetchJson(url, options = {}) {
    return fetchRaw(url, options).then(r => {
        try {
            return JSON.parse(r.body);
        } catch (e) {
            const match = r.body.match(/\{[\s\S]*\}/);
            if (match) return JSON.parse(match[0]);
            const jsonpMatch = r.body.match(/\((\{[\s\S]*\})\)/);
            if (jsonpMatch) return JSON.parse(jsonpMatch[1]);
            throw new Error('JSON parse error: ' + r.body.substring(0, 100));
        }
    });
}

// 安全读取数组指定下标的数值（越界/非数字时返回默认值）
function getPart(parts, index, defaultValue = 0) {
    if (!Array.isArray(parts) || parts.length <= index) return defaultValue;
    const v = parseFloat(parts[index]);
    return isNaN(v) ? defaultValue : v;
}

// ========== 熔断器：连续失败的源暂时跳过，避免每次请求都等超时 ==========
// 连续失败 N 次后熔断 M 秒；期间直接跳过该源，M 秒后放行一次试探
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN = 60000;
const breaker = new Map(); // key -> { fails, openUntil }

function breakerAllow(key) {
    const st = breaker.get(key);
    if (!st) return true;
    if (st.openUntil && Date.now() < st.openUntil) return false;
    return true;
}

function breakerOk(key) {
    breaker.delete(key);
}

function breakerFail(key) {
    const st = breaker.get(key) || { fails: 0, openUntil: 0 };
    st.fails += 1;
    if (st.fails >= BREAKER_THRESHOLD) {
        st.openUntil = Date.now() + BREAKER_COOLDOWN;
        st.fails = 0;
    }
    breaker.set(key, st);
}

// 带熔断的请求包装：成功记ok，失败记fail并抛错
async function guardedFetchJson(key, url, options = {}) {
    if (!breakerAllow(key)) {
        throw new Error(`source ${key} circuit open`);
    }
    try {
        const data = await fetchJson(url, options);
        breakerOk(key);
        return data;
    } catch (e) {
        breakerFail(key);
        throw e;
    }
}

// ========== 指数代码映射表 ==========
// 统一用内部code，映射到各数据源的格式
const INDEX_CONFIG = {
    // A股
    '000001.SH': { name: '上证指数', category: 'china',
        sina: 'sh000001', eastmoney: '1.000001', tencent: 'sh000001', tencentKline: 'sh000001' },
    '399001.SZ': { name: '深证成指', category: 'china',
        sina: 'sz399001', eastmoney: '0.399001', tencent: 'sz399001', tencentKline: 'sz399001' },
    '399006.SZ': { name: '创业板指', category: 'china',
        sina: 'sz399006', eastmoney: '0.399006', tencent: 'sz399006', tencentKline: 'sz399006' },
    '000688.SH': { name: '科创50', category: 'china',
        sina: 'sh000688', eastmoney: '1.000688', tencent: 'sh000688', tencentKline: 'sh000688' },
    '000300.SH': { name: '沪深300', category: 'china',
        sina: 'sh000300', eastmoney: '1.000300', tencent: 'sh000300', tencentKline: 'sh000300' },
    '000905.SH': { name: '中证500', category: 'china',
        sina: 'sh000905', eastmoney: '1.000905', tencent: 'sh000905', tencentKline: 'sh000905' },
    // 港股
    'HSI': { name: '恒生指数', category: 'hongkong',
        sina: 'hkHSI', eastmoney: '100.HSI', tencent: 'hkHSI', tencentKline: 'hkHSI' },
    'HSCEI': { name: '国企指数', category: 'hongkong',
        sina: 'hkHSCEI', eastmoney: '100.HSCEI', tencent: 'hkHSCEI', tencentKline: 'hkHSCEI' },
    // 美股
    'DJI': { name: '道琼斯指数', category: 'us',
        sina: 'int_dji', eastmoney: '100.DJIA', tencent: 'usDJI', tencentKline: 'us.DJI' },
    'IXIC': { name: '纳斯达克', category: 'us',
        sina: 'int_nasdaq', eastmoney: '100.NDX', tencent: 'usIXIC', tencentKline: 'us.IXIC' },
    'SPX': { name: '标普500', category: 'us',
        sina: 'int_sp500', eastmoney: '100.SPX', tencent: 'usSPX', tencentKline: 'us.INX' },
    // 欧洲
    'FTSE': { name: '英国富时100', category: 'europe',
        sina: 'b_FTSE', eastmoney: '100.FTSE', tencent: 'ukFTSE', tencentKline: null },
    'GDAXI': { name: '德国DAX30', category: 'europe',
        sina: 'b_DAX', eastmoney: '100.GDAXI', tencent: 'deGDAXI', tencentKline: null },
    'FCHI': { name: '法国CAC40', category: 'europe',
        sina: 'b_CAC', eastmoney: '100.FCHI', tencent: 'frFCHI', tencentKline: null },
    // 亚太
    'N225': { name: '日经225', category: 'asia',
        sina: 'b_NKY', eastmoney: '100.N225', tencent: 'jpN225', tencentKline: null },
    'KS11': { name: '韩国KOSPI', category: 'asia',
        sina: 'b_KOSPI', eastmoney: '100.KS11', tencent: 'krKS11', tencentKline: null },
    'ASX200': { name: '澳交所200', category: 'asia',
        sina: 'b_AORD', eastmoney: '100.AORD', tencent: 'auASX200', tencentKline: null },
    'TWII': { name: '台湾加权', category: 'asia',
        sina: 'b_TWJQ', eastmoney: '100.TWII', tencent: 'twTWII', tencentKline: null },
    'SENSEX': { name: '印度SENSEX', category: 'asia',
        sina: 'b_SENSEX', eastmoney: '100.SENSEX', tencent: 'inSENSEX', tencentKline: null }
};

// ========== 数据源1: 新浪财经行情 ==========
function getSinaQuote(codes) {
    const sinaCodes = codes.map(c => INDEX_CONFIG[c]?.sina).filter(Boolean);
    if (sinaCodes.length === 0) return Promise.resolve({});

    const url = `https://hq.sinajs.cn/list=${sinaCodes.join(',')}`;
    return fetchRaw(url, {
        headers: {
            'Referer': 'https://finance.sina.com.cn/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 8000,
        retries: 1
    }).then(r => {
        if (r.status !== 200) {
            throw new Error(`Sina quote HTTP ${r.status}`);
        }
        const results = {};
        const lines = r.body.split('\n');

        for (const line of lines) {
            const match = line.match(/var hq_str_([^=]+)="([^"]*)"/);
            if (!match) continue;

            const sinaCode = match[1];
            const raw = match[2];
            if (!raw || raw.length < 3) continue;

            const parts = raw.split(',');

            const internalCode = Object.keys(INDEX_CONFIG).find(k => INDEX_CONFIG[k].sina === sinaCode);
            if (!internalCode) continue;

            const cfg = INDEX_CONFIG[internalCode];
            let result = null;

            if (parts.length >= 30 && cfg.category === 'china') {
                // A股格式: 名称,开盘,昨收,当前,最高,最低,...
                result = {
                    code: internalCode,
                    name: parts[0],
                    price: parseFloat(parts[3]),
                    prevClose: parseFloat(parts[2]),
                    open: parseFloat(parts[1]),
                    high: parseFloat(parts[4]),
                    low: parseFloat(parts[5]),
                    volume: parseFloat(parts[8]) || 0,
                    amount: parseFloat(parts[9]) || 0
                };
            } else if (parts.length >= 15 && cfg.category === 'hongkong') {
                // 港股格式: 英文代码,中文名,昨收,开盘,最高,最低,当前,涨跌额,涨跌幅,...
                result = {
                    code: internalCode,
                    name: parts[1] || cfg.name,
                    price: parseFloat(parts[6]),
                    prevClose: parseFloat(parts[2]),
                    open: parseFloat(parts[3]),
                    high: parseFloat(parts[4]),
                    low: parseFloat(parts[5]),
                    volume: parseFloat(parts[11]) || 0,
                    amount: parseFloat(parts[12]) || 0
                };
            } else if (parts.length >= 10 && (sinaCode.startsWith('b_') || parts.length === 13)) {
                // 全球指数格式(b_前缀): 名称,当前价,涨跌额,涨跌幅%,?,?,日期,时间,开盘,最高,最低,...
                const price = parseFloat(parts[1]);
                const change = parseFloat(parts[2]);
                const changePercent = parseFloat(parts[3]);
                // 日期在第6个字段(index 6)，检查数据是否新鲜（不超过7天）
                const dateStr = parts[6] || '';
                let isFresh = true;
                if (dateStr && dateStr.match(/^\d{4}-\d{2}-\d{2}/)) {
                    const dataDate = new Date(dateStr);
                    const now = new Date();
                    const diffDays = (now - dataDate) / (1000 * 60 * 60 * 24);
                    isFresh = diffDays <= 7; // 7天内算新鲜
                }
                if (price > 10 && isFresh) {
                    result = {
                        code: internalCode,
                        name: parts[0] || cfg.name,
                        price,
                        change,
                        changePercent,
                        prevClose: price - change,
                        open: parseFloat(parts[8]) || 0,
                        high: parseFloat(parts[9]) || 0,
                        low: parseFloat(parts[10]) || 0,
                        volume: 0,
                        amount: 0
                    };
                }
            } else if (parts.length === 4) {
                // 美股简化格式: 名称,当前价,涨跌额,涨跌幅%
                const price = parseFloat(parts[1]);
                const change = parseFloat(parts[2]);
                const changePercent = parseFloat(parts[3]);
                if (price > 10) {
                    result = {
                        code: internalCode,
                        name: parts[0] || cfg.name,
                        price,
                        change,
                        changePercent,
                        prevClose: price - change,
                        open: 0,
                        high: 0,
                        low: 0,
                        volume: 0,
                        amount: 0
                    };
                }
            } else if (parts.length === 6) {
                // 简化格式（6字段）：检查最后一个字段是否是日期
                const price = parseFloat(parts[1]) || parseFloat(parts[0]);
                const lastField = parts[parts.length - 1] || '';
                let isFresh = true;
                if (lastField && lastField.match(/^\d{4}-\d{2}-\d{2}/)) {
                    const dataDate = new Date(lastField);
                    const now = new Date();
                    const diffDays = (now - dataDate) / (1000 * 60 * 60 * 24);
                    isFresh = diffDays <= 7;
                }
                if (price > 10 && isFresh) {
                    result = {
                        code: internalCode,
                        name: parts[0] || cfg.name,
                        price,
                        change: 0,
                        changePercent: 0,
                        prevClose: 0,
                        open: 0,
                        high: 0,
                        low: 0,
                        volume: 0,
                        amount: 0
                    };
                }
            }

            if (result && !isNaN(result.price) && result.price > 10) {
                if (result.change === undefined || isNaN(result.change)) {
                    result.change = result.price - (result.prevClose || 0);
                }
                if (result.changePercent === undefined || isNaN(result.changePercent)) {
                    result.changePercent = result.prevClose ? (result.change / result.prevClose) * 100 : 0;
                }
                results[internalCode] = result;
            }
        }
        return results;
    });
}

// 新浪K线数据（仅A股有效）
function getSinaKline(code, period = 'day', count = 60) {
    const sinaCode = INDEX_CONFIG[code]?.sina;
    if (!sinaCode) return Promise.reject(new Error('Unsupported code'));

    const countMap = { '1D': 1, '1W': 5, '1M': 30, '3M': 90, '1Y': 250 };
    const datalen = countMap[period] || count;

    const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${sinaCode}&scale=240&ma=no&datalen=${datalen}`;

    return fetchJson(url, {
        headers: {
            'Referer': 'https://finance.sina.com.cn/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 12000,
        retries: 1
    }).then(data => {
        if (!Array.isArray(data) || data.length === 0) throw new Error('Invalid kline data');
        return data.map(d => ({
            date: d.day || d.date || '',
            open: parseFloat(d.open),
            high: parseFloat(d.high),
            low: parseFloat(d.low),
            close: parseFloat(d.close),
            volume: parseFloat(d.volume || 0)
        }));
    });
}

// ========== 数据源2: 东方财富行情 ==========
// 注意：该域名在部分网络会被直接重置（socket hang up），带Referer/完整Chrome UA更易被拒，
// 因此使用默认简洁请求头 + 熔断保护，失败时自动退出轮询
function getEastMoneyQuotes() {
    const url = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=1.000001,0.399001,0.399006,100.HSI,100.HSCEI,100.DJIA,100.NDX,100.SPX,100.FTSE,100.GDAXI,100.FCHI,100.N225,100.KS11,100.AORD,100.TWII,100.SENSEX&fields=f2,f3,f4,f5,f6,f7,f12,f14,f17,f18,f15,f16';
    if (!breakerAllow('eastmoney')) return Promise.resolve({});
    return guardedFetchJson('eastmoney', url, { timeout: 5000, retries: 1 }).then(data => {
        const results = {};
        if (data && data.data && Array.isArray(data.data.diff)) {
            const emToInternal = {
                '000001': '000001.SH',
                '399001': '399001.SZ',
                '399006': '399006.SZ',
                'HSI': 'HSI',
                'HSCEI': 'HSCEI',
                'DJIA': 'DJI',
                'NDX': 'IXIC',
                'SPX': 'SPX',
                'FTSE': 'FTSE',
                'GDAXI': 'GDAXI',
                'FCHI': 'FCHI',
                'N225': 'N225',
                'KS11': 'KS11',
                'AORD': 'ASX200',
                'TWII': 'TWII',
                'SENSEX': 'SENSEX'
            };

            data.data.diff.forEach(item => {
                const emCode = item.f12;
                const internalCode = emToInternal[emCode];
                if (!internalCode) return;

                // 全球指数(100.前缀)价格单位就是元，不需要除以100
                // A股指数(1./0.前缀)单位是分，需要除以100
                const isAStock = emCode === '000001' || emCode === '399001' || emCode === '399006';
                const divisor = isAStock ? 100 : 1;

                const price = item.f2 / divisor;
                const change = item.f4 / divisor;
                const prevClose = price - change;

                if (price > 0 && !isNaN(price)) {
                    results[internalCode] = {
                        code: internalCode,
                        name: item.f14,
                        price,
                        changePercent: item.f3 / (isAStock ? 100 : 1),
                        change,
                        volume: item.f5 || 0,
                        amount: item.f6 || 0,
                        amplitude: item.f7 / divisor || 0,
                        open: item.f17 / divisor || 0,
                        prevClose: prevClose || 0,
                        high: item.f15 / divisor || 0,
                        low: item.f16 / divisor || 0
                    };
                }
            });
        }
        return results;
    }).catch(() => ({}));
}

// ========== 数据源3: 腾讯财经行情（主力源，覆盖最广）==========
function getTencentQuotes(codes) {
    // 收集所有可能的腾讯代码（行情代码 + K线代码）
    const codeMap = {}; // tencentCode -> internalCode
    codes.forEach(c => {
        const cfg = INDEX_CONFIG[c];
        if (cfg) {
            if (cfg.tencent) codeMap[cfg.tencent] = c;
            if (cfg.tencentKline) codeMap[cfg.tencentKline] = c;
        }
    });

    const tencentCodes = Object.keys(codeMap);
    if (tencentCodes.length === 0) return Promise.resolve({});

    const url = `https://qt.gtimg.cn/q=${tencentCodes.join(',')}`;
    return fetchRaw(url, {
        headers: {
            'Referer': 'https://gu.qq.com/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 8000,
        retries: 1
    }).then(r => {
        if (r.status !== 200) {
            throw new Error(`Tencent quote HTTP ${r.status}`);
        }
        const results = {};
        const lines = r.body.split('\n');

        for (const line of lines) {
            const match = line.match(/v_([^=]+)="([^"]*)"/);
            if (!match) continue;

            const tencentCode = match[1];
            const parts = match[2].split('~');
            if (parts.length < 5 || !parts[1]) continue;

            const internalCode = codeMap[tencentCode];
            if (!internalCode) continue;

            // 腾讯财经统一格式：
            // [1]名称 [2]代码 [3]当前价 [4]昨收 [5]开盘 [6]成交量 [9]最高 [33]最高 [34]最低
            const price = getPart(parts, 3);
            const prevClose = getPart(parts, 4);
            const open = getPart(parts, 5);
            const volume = getPart(parts, 6);
            const high = getPart(parts, 33) || getPart(parts, 9);
            const low = getPart(parts, 34) || getPart(parts, 10);

            if (!isNaN(price) && price > 10) {
                const result = {
                    code: internalCode,
                    name: parts[1],
                    price,
                    prevClose,
                    open,
                    volume,
                    high,
                    low
                };
                result.change = price - prevClose;
                result.changePercent = prevClose ? (result.change / prevClose) * 100 : 0;

                // 如果已有同名指数，保留数据更完整的
                if (!results[internalCode] || (result.high > 0 && results[internalCode].high === 0)) {
                    results[internalCode] = result;
                }
            }
        }
        return results;
    });
}

// ========== 数据源4: 腾讯财经K线（主力K线源，覆盖最广）==========
function getTencentKline(code, period = '1M') {
    const cfg = INDEX_CONFIG[code];
    const tencentCode = cfg?.tencentKline;
    if (!tencentCode) return Promise.reject(new Error('K-line not available for this index'));

    // 腾讯K线周期映射
    // 1Y/3M 一律用日线（技术因子/校准结算按交易日 OFFSETS=1/5/22，周线不可用）
    const periodMap = {
        '1D': { ktype: 'day', count: 1 },
        '1W': { ktype: 'day', count: 5 },
        '1M': { ktype: 'day', count: 30 },
        '3M': { ktype: 'day', count: 90 },
        '1Y': { ktype: 'day', count: 250 }
    };
    const p = periodMap[period] || periodMap['1M'];

    const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${tencentCode},${p.ktype},,,${p.count},qfq`;

    return fetchJson(url, {
        headers: {
            'Referer': 'https://gu.qq.com/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 12000,
        retries: 1
    }).then(data => {
        if (!data || !data.data || !data.data[tencentCode]) {
            throw new Error('Invalid tencent kline response');
        }

        const d = data.data[tencentCode];
        const kline = d.day || d.qfqday || d.week || d.month || [];

        if (!Array.isArray(kline) || kline.length === 0) {
            throw new Error('Empty kline data');
        }

        return kline.map(k => {
            if (!Array.isArray(k) || k.length < 5) return null;
            return {
                date: k[0] || '',
                open: getPart(k, 1),
                close: getPart(k, 2),
                high: getPart(k, 3),
                low: getPart(k, 4),
                volume: getPart(k, 5)
            };
        }).filter(Boolean);
    });
}

// ========== 聚合行情：多源择优合并 ==========
async function getIndexQuotes(codes) {
    const sources = [
        { name: 'tencent', label: '腾讯财经', fn: () => getTencentQuotes(codes) },
        { name: 'eastmoney', label: '东方财富', fn: () => getEastMoneyQuotes() },
        { name: 'sina', label: '新浪财经', fn: () => getSinaQuote(codes) }
    ];

    // 并行请求所有数据源
    const results = {};
    const sourceResults = {};
    const sourceCounts = {};

    await Promise.allSettled(sources.map(async s => {
        try {
            const data = await s.fn();
            sourceResults[s.name] = data;
            sourceCounts[s.name] = Object.keys(data).length;
        } catch (e) {
            sourceResults[s.name] = {};
            sourceCounts[s.name] = 0;
        }
    }));

    // 按优先级合并：腾讯 > 东方财富 > 新浪
    const priority = ['tencent', 'eastmoney', 'sina'];
    const usedSources = [];

    for (const name of priority) {
        const data = sourceResults[name] || {};
        let added = 0;
        Object.keys(data).forEach(code => {
            if (!results[code]) {
                results[code] = data[code];
                added++;
            }
        });
        if (added > 0) {
            const source = sources.find(s => s.name === name);
            usedSources.push(source?.label || name);
        }
    }

    // 最后兜底：对于完全无实时数据的指数，用估算值
    let estimatedCount = 0;
    codes.forEach(code => {
        if (!results[code]) {
            const est = getEstimatedQuote(code);
            if (est) {
                results[code] = est;
                estimatedCount++;
            }
        }
    });
    if (estimatedCount > 0) {
        usedSources.push('智能估算');
    }

    return {
        data: results,
        source: usedSources.join('+'),
        sourceDetail: sourceCounts,
        estimatedCount,
        count: Object.keys(results).length
    };
}

// 对于无实时行情的指数，提供估算行情兜底
function getEstimatedQuote(code) {
    const cfg = INDEX_CONFIG[code];
    if (!cfg) return null;

    // 2026年8月各指数的大致水平（基于公开数据）
    const estimatedPrices = {
        'ASX200': { price: 9300, changePercent: 0.1, name: '澳交所200' },
    };

    const est = estimatedPrices[code];
    if (!est) return null;

    const change = est.price * est.changePercent / 100;
    const prevClose = est.price - change;

    return {
        code,
        name: est.name || cfg.name,
        price: est.price,
        change,
        changePercent: est.changePercent,
        prevClose,
        open: est.price * 0.998,
        high: est.price * 1.005,
        low: est.price * 0.995,
        volume: 0,
        amount: 0,
        estimated: true,
        note: '暂无实时行情，为估算值'
    };
}

// ========== K线数据：多源 fallback ==========
async function getIndexKline(code, period = '1M') {
    const countMap = { '1D': 1, '1W': 5, '1M': 30, '3M': 90, '1Y': 250 };
    const count = countMap[period] || 30;

    // 1. 优先腾讯财经K线（覆盖A股/港股/美股）
    try {
        const data = await getTencentKline(code, period);
        if (data && data.length > 0) {
            return { data, source: 'tencent' };
        }
    } catch (e) { /* 继续下一个 */ }

    // 2. 新浪K线（A股）
    try {
        const data = await getSinaKline(code, period, count);
        if (data && data.length > 0) {
            return { data, source: 'sina' };
        }
    } catch (e) { /* 继续下一个 */ }

    // 3. 对于没有K线的指数，生成模拟K线（基于行情数据估算）
    try {
        const mockData = await generateMockKline(code, count);
        return { data: mockData, source: 'estimated', note: '该指数暂无K线数据，展示为估算走势' };
    } catch (e) {
        throw new Error('All kline sources failed for ' + code);
    }
}

// 生成模拟K线（基于当前价格和历史波动率估算，作为兜底）
async function generateMockKline(code, count) {
    const cfg = INDEX_CONFIG[code];
    if (!cfg) throw new Error('Unknown index: ' + code);

    // 先尝试获取当前行情
    let currentPrice = null;
    let prevClose = null;
    try {
        const quotesResult = await getIndexQuotes([code]);
        if (quotesResult && quotesResult.data && quotesResult.data[code]) {
            currentPrice = quotesResult.data[code].price;
            prevClose = quotesResult.data[code].prevClose;
        }
    } catch (e) { /* ignore, use fallback price */ }

    // 如果没有行情数据，用一个合理的默认价格（基于2026年市场水平估算）
    if (!currentPrice || isNaN(currentPrice) || currentPrice <= 0) {
        const defaultPrices = {
            'FTSE': 10800, 'GDAXI': 26500, 'FCHI': 8400,
            'N225': 65000, 'KS11': 6700, 'ASX200': 9100,
            'TWII': 46000, 'SENSEX': 77000
        };
        currentPrice = defaultPrices[code] || 1000;
        prevClose = currentPrice * 0.995;
    }

    const kline = [];
    let price = prevClose || currentPrice * 0.99;
    const now = new Date();

    for (let i = count - 1; i >= 0; i--) {
        const date = new Date(now);
        date.setDate(date.getDate() - i);

        // 模拟每日波动：波动率约1-2%
        const volatility = 0.008 + Math.random() * 0.012;
        const direction = Math.random() > 0.48 ? 1 : -1;
        const changePercent = direction * volatility * Math.random();

        const open = price;
        const close = price * (1 + changePercent);
        const high = Math.max(open, close) * (1 + Math.random() * 0.005);
        const low = Math.min(open, close) * (1 - Math.random() * 0.005);
        const volume = Math.floor(Math.random() * 1000000000);

        kline.push({
            date: date.toISOString().split('T')[0],
            open: parseFloat(open.toFixed(2)),
            high: parseFloat(high.toFixed(2)),
            low: parseFloat(low.toFixed(2)),
            close: parseFloat(close.toFixed(2)),
            volume
        });

        price = close;
    }

    // 确保最后一根K线的收盘价接近当前价格
    if (kline.length > 0 && currentPrice) {
        const last = kline[kline.length - 1];
        const ratio = currentPrice / last.close;
        last.close = parseFloat(currentPrice.toFixed(2));
        last.high = parseFloat((last.high * ratio).toFixed(2));
        last.low = parseFloat((last.low * ratio).toFixed(2));
        last.open = parseFloat((last.open * ratio).toFixed(2));
    }

    return kline;
}

// ========== 数字货币：Binance（主源，多域名自动切换） ==========
// api.binance.com 在部分网络被重置；data-api.binance.vision 是币安官方公开行情镜像，可达性更好
const BINANCE_BASES = ['https://data-api.binance.vision', 'https://api.binance.com'];

async function getBinanceTicker(symbols) {
    const pairs = symbols.map(s => s + 'USDT');
    const path = `/api/v3/ticker/24hr?symbols=${encodeURIComponent('["' + pairs.join('","') + '"]')}`;

    const results = {};
    // 逐个域名尝试，5秒超时让降级更快触发
    for (const base of BINANCE_BASES) {
        const key = 'binance:' + base;
        if (!breakerAllow(key)) continue;
        try {
            const data = await fetchJson(base + path, { timeout: 5000 });
            if (Array.isArray(data)) {
                data.forEach(item => {
                    const symbol = item.symbol.replace('USDT', '');
                    const price = parseFloat(item.lastPrice);
                    if (isNaN(price) || price <= 0) return;
                    results[symbol] = {
                        price,
                        priceChange: parseFloat(item.priceChange) || 0,
                        changePercent: parseFloat(item.priceChangePercent) || 0,
                        high: parseFloat(item.highPrice) || price,
                        low: parseFloat(item.lowPrice) || price,
                        open: parseFloat(item.openPrice) || price,
                        prevClose: parseFloat(item.prevClosePrice) || price,
                        volume: parseFloat(item.volume) || 0,
                        quoteVolume: parseFloat(item.quoteVolume) || 0
                    };
                });
                breakerOk(key);
            }
        } catch (e) {
            breakerFail(key);
        }
        if (Object.keys(results).length >= symbols.length) break;
    }
    return results;
}

async function getBinanceKline(symbol, interval = '1d', limit = 60) {
    const path = `/api/v3/klines?symbol=${symbol}USDT&interval=${interval}&limit=${limit}`;
    let lastErr = null;
    for (const base of BINANCE_BASES) {
        const key = 'binance:' + base;
        if (!breakerAllow(key)) continue;
        try {
            const data = await fetchJson(base + path, { timeout: 5000 });
            if (!Array.isArray(data) || data.length === 0) throw new Error('Binance kline empty');
            breakerOk(key);
            return data.map(k => ({
                openTime: k[0],
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
                volume: parseFloat(k[5]),
                closeTime: k[6]
            }));
        } catch (e) {
            breakerFail(key);
            lastErr = e;
        }
    }
    throw new Error('Binance kline failed: ' + (lastErr ? lastErr.message : 'no source available'));
}

// ========== 数字货币：Gate.io（备用源） ==========
async function getGateTicker(symbols) {
    // Gate.io 不支持逗号批量，按币种并行单查
    const results = {};
    if (!breakerAllow('gateio')) return results;
    await Promise.all(symbols.map(async (s) => {
        try {
            const url = `https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${s}_USDT`;
            const data = await fetchJson(url, { timeout: 6000, retries: 1 });
            if (!Array.isArray(data) || data.length === 0) return;
            const t = data[0];
            const price = parseFloat(t.last);
            if (isNaN(price) || price <= 0) return;
            const changePercent = parseFloat(t.change_percentage) || 0;
            results[s] = {
                price,
                priceChange: price * changePercent / (100 + changePercent),
                changePercent,
                high: parseFloat(t.high_24h) || price,
                low: parseFloat(t.low_24h) || price,
                open: price / (1 + changePercent / 100),
                prevClose: price / (1 + changePercent / 100),
                volume: parseFloat(t.base_volume) || 0,
                quoteVolume: parseFloat(t.quote_volume) || 0
            };
        } catch (e) { /* 单币种失败不影响其他 */ }
    }));
    if (Object.keys(results).length > 0) breakerOk('gateio'); else breakerFail('gateio');
    return results;
}

async function getGateKline(symbol, interval = '1d', limit = 60) {
    if (!breakerAllow('gateio')) throw new Error('gateio circuit open');
    const url = `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${symbol}USDT&interval=${interval}&limit=${limit}`;
    const data = await guardedFetchJson('gateio', url, { timeout: 8000, retries: 1 });
    if (!Array.isArray(data) || data.length === 0) throw new Error('Gate.io kline empty');
    // Gate.io 字段: [时间戳(秒), 计价成交量, 开, 高, 低, 收, 基础成交量, 是否收盘]，最新在前需倒序
    return data.slice().reverse().map(k => {
        const ts = Math.floor(parseFloat(k[0]) * 1000);
        return {
            openTime: ts,
            open: parseFloat(k[2]),
            high: parseFloat(k[3]),
            low: parseFloat(k[4]),
            close: parseFloat(k[5]),
            volume: parseFloat(k[6]),
            closeTime: ts
        };
    });
}

// ========== 数字货币统一出口：Binance（镜像→主站）→ Gate.io 自动降级 ==========
async function getCryptoTicker(symbols) {
    const binanceData = await getBinanceTicker(symbols);
    const missing = symbols.filter(s => !binanceData[s]);
    if (missing.length === 0) {
        return { data: binanceData, source: 'binance' };
    }

    // Binance缺数据（超时/被墙/部分币种缺失），用Gate.io补齐
    const gateData = await getGateTicker(missing);
    const results = { ...binanceData, ...gateData };

    const binanceCount = Object.keys(binanceData).length;
    const gateCount = Object.keys(gateData).length;
    let source;
    if (binanceCount === 0 && gateCount === 0) source = 'unavailable';
    else if (binanceCount === 0) source = 'gate.io';
    else if (gateCount === 0) source = 'binance';
    else source = 'binance+gate.io';

    return { data: results, source };
}

async function getCryptoKline(symbol, interval, limit) {
    try {
        const data = await getBinanceKline(symbol, interval, limit);
        return { data, source: 'binance' };
    } catch (e) {
        const data = await getGateKline(symbol, interval, limit);
        return { data, source: 'gate.io' };
    }
}

// ========== 黄金价格 ==========
async function getGoldPrice() {
    // 1. PAXG 实物黄金代币（Binance → Gate.io 自动降级）
    try {
        const { data, source } = await getCryptoTicker(['PAXG']);
        if (data.PAXG && data.PAXG.price > 0) {
            const g = data.PAXG;
            return {
                price: g.price,
                change: g.priceChange,
                changePercent: g.changePercent,
                high: g.high,
                low: g.low,
                open: g.open,
                source: `PAXG (${source})`
            };
        }
    } catch (e) { /* fallback */ }

    // 2. 新浪贵金属
    try {
        const url = 'https://hq.sinajs.cn/list=hf_XAU';
        const r = await fetchRaw(url, {
            headers: { 'Referer': 'https://finance.sina.com.cn/' },
            timeout: 8000
        });
        if (r.status !== 200) throw new Error(`Sina gold HTTP ${r.status}`);
        const match = r.body.match(/var hq_str_hf_XAU="([^"]*)"/);
        if (match) {
            const parts = match[1].split(',');
            // hf_XAU格式: [0]现价 [2]买价 [3]卖价 [4]最高 [5]最低 [7]昨收 [8]开盘
            const price = getPart(parts, 0);
            const prevClose = getPart(parts, 7);
            if (price > 0 && prevClose > 0) {
                const change = price - prevClose;
                return {
                    price,
                    change,
                    changePercent: (change / prevClose) * 100,
                    high: getPart(parts, 4) || price,
                    low: getPart(parts, 5) || price,
                    open: getPart(parts, 8) || price,
                    source: 'Sina Forex'
                };
            }
        }
    } catch (e) { /* fallback */ }

    throw new Error('Gold data unavailable');
}

async function getGoldKline(period = '1M') {
    // 黄金预测/回填需要真实日 K：1Y/3M 用 PAXG 日线（勿用周线×52）
    const intervalMap = {
        '1D': { interval: '1h', count: 24 },
        '1W': { interval: '1d', count: 7 },
        '1M': { interval: '1d', count: 30 },
        '3M': { interval: '1d', count: 90 },
        '1Y': { interval: '1d', count: 250 }
    };
    const p = intervalMap[period] || intervalMap['1M'];

    // 1. PAXG K线（Binance → Gate.io）
    try {
        const { data, source } = await getCryptoKline('PAXG', p.interval, p.count);
        return { data, source: 'PAXG (' + source + ')' };
    } catch (e) { /* 降级到模拟 */ }

    // 2. 兜底：基于当前金价生成估算K线（避免接口直接500）
    try {
        const gold = await getGoldPrice();
        return { data: generateSimpleKline(gold.price, p.count), source: '估算走势' };
    } catch (e) {
        return { data: generateSimpleKline(2000, p.count), source: '估算走势' };
    }
}

// 基于当前价格生成估算K线（黄金兜底用）
function generateSimpleKline(basePrice, count) {
    const kline = [];
    const now = Date.now();
    for (let i = count - 1; i >= 0; i--) {
        const ts = now - i * 86400000;
        const vol = 0.003 + Math.random() * 0.008;
        const open = basePrice * (1 + (Math.random() - 0.5) * vol * 2);
        const close = basePrice * (1 + (Math.random() - 0.5) * vol * 2);
        kline.push({
            openTime: ts,
            closeTime: ts,
            open: parseFloat(open.toFixed(2)),
            high: parseFloat(Math.max(open, close).toFixed(2)),
            low: parseFloat(Math.min(open, close).toFixed(2)),
            close: parseFloat(close.toFixed(2)),
            volume: Math.floor(Math.random() * 10000)
        });
    }
    return kline;
}

// ========== 市场情绪与资金数据（AI预测因子） ==========

// 市场宽度滚动历史（进程内），用于 z-score 而非原始水平打分
const BREADTH_HIST_MAX = 60;
const breadthHistory = [];
function pushBreadthHistory(raw) {
    if (!isFinite(raw)) return null;
    breadthHistory.push(raw);
    while (breadthHistory.length > BREADTH_HIST_MAX) breadthHistory.shift();
    if (breadthHistory.length < 8) return null;
    const n = breadthHistory.length;
    const mean = breadthHistory.reduce((a, b) => a + b, 0) / n;
    const variance = breadthHistory.reduce((s, v) => s + (v - mean) * (v - mean), 0) / n;
    const sd = Math.sqrt(variance);
    if (!(sd > 1e-6)) return 0;
    return (raw - mean) / sd;
}

// A股涨跌家数分布（东方财富 getTopicZDFenBu，全部失败返回null由预测引擎降级）
async function getMarketBreadth() {
    if (!breakerAllow('em-breadth')) return null;
    try {
        const url = 'https://push2ex.eastmoney.com/getTopicZDFenBu?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt';
        const data = await fetchJson(url, { timeout: 6000, retries: 1 });
        const fenbu = data && data.data && Array.isArray(data.data.fenbu) ? data.data.fenbu : [];
        if (fenbu.length === 0) throw new Error('empty fenbu');

        let up = 0, down = 0, flat = 0, limitUp = 0, limitDown = 0;
        fenbu.forEach(bucket => {
            const key = parseInt(Object.keys(bucket)[0], 10);
            const count = parseInt(Object.values(bucket)[0], 10) || 0;
            if (isNaN(key)) return;
            if (key > 0) {
                up += count;
                if (key >= 10) limitUp += count;
            } else if (key < 0) {
                down += count;
                if (key <= -10) limitDown += count;
            } else {
                flat += count;
            }
        });
        const total = up + down + flat;
        if (total < 100) throw new Error('breadth sample too small');
        breakerOk('em-breadth');
        const rawBreadth = (up - down) / total;   // 市场宽度 -1~1
        const z = pushBreadthHistory(rawBreadth);
        return {
            up, down, flat, limitUp, limitDown, total,
            upRatio: up / total,
            breadth: rawBreadth,
            breadthZ: z,                       // 相对自身历史的 z-score（样本不足时为 null）
            date: data.data.qdate
        };
    } catch (e) {
        breakerFail('em-breadth');
        return null;
    }
}

// 北向资金净流入（东方财富 kamt，单位：亿元；返回null表示不可用）
async function getNorthBoundFlow() {
    if (!breakerAllow('em-kamt')) return null;
    try {
        const url = 'https://push2.eastmoney.com/api/qt/kamt/get?fields1=f1,f2,f3,f4&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65';
        const data = await fetchJson(url, { timeout: 6000, retries: 1 });
        const d = data && data.data;
        if (!d || !d.hk2sh) throw new Error('empty kamt');
        // dayNetAmtIn 单位是万元，转亿元
        const shIn = (d.hk2sh.dayNetAmtIn || 0) / 10000;
        const szIn = ((d.hk2sz && d.hk2sz.dayNetAmtIn) || 0) / 10000;
        breakerOk('em-kamt');
        return {
            dayNetIn: shIn + szIn,     // 当日北向合计净流入（亿元）
            shIn, szIn,
            active: shIn + szIn !== 0  // 全为0说明未开盘/未更新，不作为有效因子
        };
    } catch (e) {
        breakerFail('em-kamt');
        return null;
    }
}

// 加密货币恐慌贪婪指数（alternative.me，0=极度恐慌 100=极度贪婪）
async function getFearGreedIndex() {
    if (!breakerAllow('feargreed')) return null;
    try {
        const data = await fetchJson('https://api.alternative.me/fng/?limit=8', { timeout: 8000, retries: 1 });
        const arr = data && Array.isArray(data.data) ? data.data : [];
        if (arr.length === 0) throw new Error('empty fng');
        const current = parseInt(arr[0].value, 10);
        if (isNaN(current)) throw new Error('bad fng value');
        breakerOk('feargreed');
        return {
            value: current,
            classification: arr[0].value_classification,
            // 7日均值用于判断指数边际变化方向
            weekAvg: Math.round(arr.reduce((s, x) => s + parseInt(x.value, 10), 0) / arr.length),
            history: arr.slice(0, 8).reverse().map(x => parseInt(x.value, 10))
        };
    } catch (e) {
        breakerFail('feargreed');
        return null;
    }
}

// VIX恐慌指数（新浪 b_VIX；VIX<14低波动，>28恐慌）
async function getVixIndex() {
    if (!breakerAllow('sina-vix')) return null;
    try {
        const url = 'https://hq.sinajs.cn/list=b_VIX';
        const r = await fetchRaw(url, {
            headers: { 'Referer': 'https://finance.sina.com.cn/' },
            timeout: 6000, retries: 1
        });
        const match = r.body.match(/"([^"]*)"/);
        if (!match) throw new Error('empty vix');
        const parts = match[1].split(',');
        const value = parseFloat(parts[1]);
        const changePct = parseFloat(parts[3]);
        if (isNaN(value) || value <= 0) throw new Error('bad vix');
        breakerOk('sina-vix');
        return { value, changePct: isNaN(changePct) ? 0 : changePct, date: parts[6] || '' };
    } catch (e) {
        breakerFail('sina-vix');
        return null;
    }
}

// 美元指数DXY（新浪 DINIW；黄金/加密货币的反向指标）
async function getDollarIndex() {
    if (!breakerAllow('sina-dxy')) return null;
    try {
        const url = 'https://hq.sinajs.cn/list=DINIW';
        const r = await fetchRaw(url, {
            headers: { 'Referer': 'https://finance.sina.com.cn/' },
            timeout: 6000, retries: 1
        });
        const match = r.body.match(/"([^"]*)"/);
        if (!match) throw new Error('empty dxy');
        const parts = match[1].split(',');
        const price = parseFloat(parts[1]);
        const prevClose = parseFloat(parts[5]);
        if (isNaN(price) || price <= 0) throw new Error('bad dxy');
        const change = price - (prevClose || price);
        breakerOk('sina-dxy');
        return { price, change, changePct: prevClose ? (change / prevClose) * 100 : 0 };
    } catch (e) {
        breakerFail('sina-dxy');
        return null;
    }
}

// 富时中国A50期货（新浪 hf_CHA50CFD；境外交易时段领先A股的信号）
async function getA50Futures() {
    if (!breakerAllow('sina-a50')) return null;
    try {
        const url = 'https://hq.sinajs.cn/list=hf_CHA50CFD';
        const r = await fetchRaw(url, {
            headers: { 'Referer': 'https://finance.sina.com.cn/' },
            timeout: 6000, retries: 1
        });
        const match = r.body.match(/"([^"]*)"/);
        if (!match) throw new Error('empty a50');
        const parts = match[1].split(',');
        const price = parseFloat(parts[0]);
        const prevSettle = parseFloat(parts[7]);
        if (isNaN(price) || price <= 0 || isNaN(prevSettle) || prevSettle <= 0) throw new Error('bad a50');
        const change = price - prevSettle;
        breakerOk('sina-a50');
        return { price, change, changePct: (change / prevSettle) * 100 };
    } catch (e) {
        breakerFail('sina-a50');
        return null;
    }
}

// 融资融券（东方财富datacenter，融资余额+当日融资净买入）
async function getMarginTrading() {
    if (!breakerAllow('em-rzrq')) return null;
    try {
        const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_RZRQ_LSHJ&columns=ALL&sortColumns=dim_date&sortTypes=-1&pageNumber=1&pageSize=2';
        const data = await fetchJson(url, { timeout: 8000, retries: 1 });
        const rows = data && data.result && Array.isArray(data.result.data) ? data.result.data : [];
        if (rows.length === 0) throw new Error('empty rzrq');
        breakerOk('em-rzrq');
        const latest = rows[0];
        return {
            date: String(latest.DIM_DATE || '').substring(0, 10),
            rzye: (latest.RZYE || 0) / 1e8,     // 融资余额（亿元）
            rzjme: (latest.RZJME || 0) / 1e8,   // 当日融资净买入（亿元）
            changePct: latest.ZDF || 0
        };
    } catch (e) {
        breakerFail('em-rzrq');
        return null;
    }
}

// 沪市主力资金流（东方财富分钟累计值；分钟K线最后一行为当日累计主力净流入）
async function getMainFundFlow() {
    if (!breakerAllow('em-fflow')) return null;
    try {
        const url = 'https://push2.eastmoney.com/api/qt/stock/fflow/kline/get?lmt=0&klt=1&secid=1.000001&secid2=1.000001&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56';
        const data = await fetchJson(url, { timeout: 6000, retries: 1 });
        const klines = data && data.data && Array.isArray(data.data.klines) ? data.data.klines : [];
        if (klines.length === 0) throw new Error('empty fflow');
        const last = klines[klines.length - 1].split(',');
        const mainIn = parseFloat(last[1]) / 1e8;         // 主力净流入（亿元）
        const superLarge = parseFloat(last[5]) / 1e8;     // 超大单净流入（亿元）
        if (isNaN(mainIn)) throw new Error('bad fflow');
        breakerOk('em-fflow');
        return { mainIn, superLarge, time: last[0] || '' };
    } catch (e) {
        breakerFail('em-fflow');
        return null;
    }
}

// 离岸人民币（新浪 fx_susdcnh；升值利好A股外资流入）
async function getCnhRate() {
    if (!breakerAllow('sina-cnh')) return null;
    try {
        const url = 'https://hq.sinajs.cn/list=fx_susdcnh';
        const r = await fetchRaw(url, {
            headers: { 'Referer': 'https://finance.sina.com.cn/' },
            timeout: 6000, retries: 1
        });
        const match = r.body.match(/"([^"]*)"/);
        if (!match) throw new Error('empty cnh');
        const parts = match[1].split(',');
        const price = parseFloat(parts[1]);
        const prevClose = parseFloat(parts[5]);
        if (isNaN(price) || price <= 0) throw new Error('bad cnh');
        const change = price - (prevClose || price);
        breakerOk('sina-cnh');
        return { price, change, changePct: prevClose ? (change / prevClose) * 100 : 0 };
    } catch (e) {
        breakerFail('sina-cnh');
        return null;
    }
}

// ========== 基金净值（天天基金pingzhongdata；含完整历史净值序列） ==========
// fundgz实时估值接口在此网络不可用，pingzhongdata提供日频净值（约2000根），足够技术因子计算
// 同时解析：现任基金经理（任期收益/能力评分/星级）、资产配置（股票/债券/现金占比）、业绩评价五维
function parseManagerYears(workTime) {
    if (!workTime) return 0;
    const y = (workTime.match(/(\d+)年/) || [])[1];
    const d = (workTime.match(/(\d+)天/) || [])[1];
    return (y ? +y : 0) + (d ? +d / 365 : 0);
}

async function getFundInfo(code) {
    if (!/^\d{6}$/.test(code)) return null;
    return cache.getOrFetch(`fund_info_${code}`, 3600, async () => {
        if (!breakerAllow('em-fund')) return null;
        try {
            const url = `https://fund.eastmoney.com/pingzhongdata/${code}.js`;
            const r = await fetchRaw(url, {
                headers: { 'Referer': `https://fund.eastmoney.com/${code}.html` },
                timeout: 10000, retries: 1
            });
            const nameMatch = r.body.match(/fS_name\s*=\s*"([^"]+)"/);
            const trendMatch = r.body.match(/Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
            if (!trendMatch) throw new Error('no nav trend');
            const raw = JSON.parse(trendMatch[1]);
            if (!Array.isArray(raw) || raw.length < 30) throw new Error('nav bars too few');
            breakerOk('em-fund');
            // 转为K线风格：{date, close, equityReturn(当日涨跌%)}；末位为最新净值
            const bars = raw.map(b => ({
                date: new Date(b.x).toISOString().substring(0, 10),
                close: b.y,
                equityReturn: b.equityReturn || 0
            }));
            const last = bars[bars.length - 1];
            const prev = bars[bars.length - 2] || last;

            // 资产配置（季报口径：股票/债券/现金占净比 + 净资产）
            let assetAllocation = null;
            const assetMatch = r.body.match(/Data_assetAllocation\s*=\s*(\{[\s\S]*?\})\s*;/);
            if (assetMatch) {
                try {
                    const obj = JSON.parse(assetMatch[1]);
                    const pick = name => {
                        const s = (obj.series || []).find(x => x.name === name);
                        return s && Array.isArray(s.data) ? s.data[s.data.length - 1] : null;
                    };
                    assetAllocation = {
                        date: (obj.categories || []).slice(-1)[0] || null,
                        stockRatio: pick('股票占净比'),
                        bondRatio: pick('债券占净比'),
                        cashRatio: pick('现金占净比'),
                        netAsset: pick('净资产')
                    };
                } catch (e) { /* 忽略该维度 */ }
            }

            // 业绩评价（选证能力/收益率/抗风险/稳定性/择时能力，avr为综合分0-100）
            let performance = null;
            const perfMatch = r.body.match(/Data_performanceEvaluation\s*=\s*(\{[\s\S]*?\})\s*;/);
            if (perfMatch) {
                try {
                    const obj = JSON.parse(perfMatch[1]);
                    performance = {
                        avr: parseFloat(obj.avr) || null,
                        categories: obj.categories || [],
                        data: obj.data || []
                    };
                } catch (e) { /* 忽略该维度 */ }
            }

            // 现任基金经理（多经理时取任职最长者；含任期收益/同类平均/基准对比）
            let manager = null;
            const mgrMatch = r.body.match(/Data_currentFundManager\s*=\s*(\[[\s\S]*?\])\s*;/);
            if (mgrMatch) {
                try {
                    const arr = JSON.parse(mgrMatch[1]);
                    manager = arr.map(m => {
                        const term = (m.profit && m.profit.series && m.profit.series[0] && m.profit.series[0].data) || [];
                        return {
                            name: m.name || '',
                            star: m.star || 0,
                            workTime: m.workTime || '',
                            tenureYears: +parseManagerYears(m.workTime).toFixed(1),
                            fundSize: m.fundSize || '',
                            powerAvr: m.power ? (parseFloat(m.power.avr) || null) : null,
                            termReturn: term[0] ? term[0].y : null,
                            peerAvg: term[1] ? term[1].y : null,
                            benchReturn: term[2] ? term[2].y : null
                        };
                    }).filter(m => m.name)
                        .sort((a, b) => b.tenureYears - a.tenureYears)[0] || null;
                } catch (e) { /* 忽略该维度 */ }
            }

            // 近1月/3月/6月/1年收益率（syl字段；部分基金可能为空串）
            const sylVal = re => {
                const m = r.body.match(re);
                const v = m ? parseFloat(m[1]) : NaN;
                return isFinite(v) ? v : null;
            };
            const returns = {
                ret1M: sylVal(/syl_1y\s*=\s*"(-?[\d.]+)"/),
                ret3M: sylVal(/syl_3y\s*=\s*"(-?[\d.]+)"/),
                ret6M: sylVal(/syl_6y\s*=\s*"(-?[\d.]+)"/),
                ret1Y: sylVal(/syl_1n\s*=\s*"(-?[\d.]+)"/)
            };

            return {
                code,
                name: nameMatch ? nameMatch[1] : code,
                nav: last.close,
                changePercent: last.equityReturn,
                prevNav: prev.close,
                navDate: last.date,
                bars,
                returns,
                assetAllocation,
                performance,
                manager,
                source: 'eastmoney-fund'
            };
        } catch (e) {
            breakerFail('em-fund');
            return null;
        }
    });
}

// ========== 基金前十大重仓股（天天基金F10持仓明细） ==========
// 返回 {holdings:[{market, code, name, weight}], date}；market: 116=港股 1=沪 0=深
// 债基等无股票持仓时 holdings 为空数组（区别于 null=接口失败）
async function getFundHoldings(code) {
    if (!/^\d{6}$/.test(code)) return null;
    return cache.getOrFetch(`fund_holdings_${code}`, 3600, async () => {
        if (!breakerAllow('em-f10')) return null;
        try {
            const url = `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${code}&topline=10`;
            const r = await fetchRaw(url, {
                headers: { 'Referer': `https://fundf10.eastmoney.com/ccmx_${code}.html` },
                timeout: 10000, retries: 1
            });
            const dateMatch = r.body.match(/截止至：[^>]*>([\d-]+)</);
            // F10返回多季度boxitem，只取第一张表（最新季报）的前十大
            // A股基金代码格无class、QDII为class='toc'且href引号后带空格，整行正则难以覆盖，
            // 故按<tr>拆行后逐字段提取：代码取自/r/{market}.{code}链接，名称取自首个非代码链接文本
            const tableEnd = r.body.indexOf('</table>');
            const firstTable = tableEnd > 0 ? r.body.substring(0, tableEnd) : r.body;
            const holdings = [];
            for (const row of firstTable.split(/<tr>/).slice(1)) {
                const cm = row.match(/\/r\/(\d+)\.([\d.]+)/);
                if (!cm) continue;
                const links = [];
                const linkRe = /<a[^>]*>([^<]+)<\/a>/g;
                let lm;
                while ((lm = linkRe.exec(row)) !== null) links.push(lm[1].trim());
                const name = links.find(t => t !== cm[2]) || '';
                const wm = row.match(/>(-?[\d.]+)%</);
                if (!name || !wm) continue;
                holdings.push({ market: cm[1], code: cm[2], name, weight: parseFloat(wm[1]) || 0 });
                if (holdings.length >= 10) break;
            }
            breakerOk('em-f10');
            return { holdings, date: dateMatch ? dateMatch[1] : null, source: 'eastmoney-f10' };
        } catch (e) {
            breakerFail('em-f10');
            return null;
        }
    });
}

// ========== 个股/港股实时行情（腾讯源；GBK编码需按字节解码） ==========
// 用于基金重仓股动向因子；GBK双字节中若第二字节为0x7E(~)，utf8解码会错位字段，故必须用TextDecoder('gbk')
function fetchRawBuffer(url, options = {}) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                ...options.headers
            },
            timeout: options.timeout || 8000
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    });
}

async function getStockQuotes(holdings) {
    const symbols = holdings.map(h => {
        if (h.market === '116') return 'hk' + h.code;   // 港股
        if (h.market === '1') return 'sh' + h.code;     // 沪市
        if (h.market === '0') return 'sz' + h.code;     // 深市
        return null;
    }).filter(Boolean);
    if (symbols.length === 0) return null;
    const key = 'stock_quotes_' + symbols.join(',');
    return cache.getOrFetch(key, 60, async () => {
        try {
            const buf = await fetchRawBuffer(`https://qt.gtimg.cn/q=${symbols.join(',')}`, { timeout: 6000 });
            const text = new TextDecoder('gbk').decode(buf);
            const data = {};
            text.split(';').forEach(seg => {
                const m = seg.match(/v_(?:hk|sh|sz|bj)([\w\d]+)="([^"]*)"/);
                if (!m) return;
                const fields = m[2].split('~');
                if (fields.length < 33) return;
                const price = parseFloat(fields[3]);
                const prev = parseFloat(fields[4]);
                let pct = parseFloat(fields[32]);
                if (!isFinite(pct) && isFinite(price) && isFinite(prev) && prev > 0) {
                    pct = (price - prev) / prev * 100;
                }
                if (!isFinite(pct)) return;
                data[m[1]] = { price: isFinite(price) ? price : null, changePercent: pct };
            });
            if (Object.keys(data).length === 0) return null;
            return data;
        } catch (e) {
            return null;
        }
    });
}

// ========== 财经新闻 ==========
// 按关键词判定新闻影响等级（替代随机数，保证同一条新闻等级稳定）
function classifyNewsImpact(title) {
    if (!title) return 'low';
    const highKeywords = ['央行', '美联储', '降息', '加息', '降准', 'GDP', '国务院', '证监会', '危机', '暴跌', '暴涨', '制裁', '战争', '议息'];
    const mediumKeywords = ['指数', '资金', '板块', '上涨', '下跌', '成交', '北向', '新股', '财报', '净利', '增长', '政策', '改革'];
    if (highKeywords.some(k => title.includes(k))) return 'high';
    if (mediumKeywords.some(k => title.includes(k))) return 'medium';
    return 'low';
}

async function getFinanceNews(category = 'all') {
    const newsSources = [
        async () => {
            const url = `https://feed.mix.sina.com.cn/api/roll/get?pageid=155&lid=1686&num=20&versionNumber=1.2.4&page=1&encode=utf-8`;
            try {
                const data = await fetchJson(url, { timeout: 10000 });
                if (data && data.result && Array.isArray(data.result.data)) {
                    return data.result.data.map(item => ({
                        title: item.title || '',
                        url: item.url || item.link || '',
                        time: item.createtime || item.intime || '',
                        source: item.media_name || '新浪财经',
                        summary: item.intro || item.summary || '',
                        impact: classifyNewsImpact(item.title),
                        category
                    }));
                }
            } catch (e) { /* fallback */ }
            return null;
        },
        async () => generateMockNews(category)
    ];

    for (const source of newsSources) {
        try {
            const result = await source();
            if (result && Array.isArray(result) && result.length > 0) {
                return result;
            }
        } catch (e) { continue; }
    }

    return generateMockNews(category);
}

// 新浪7x24财经直播快讯（实时市场新闻，用于AI新闻情绪分析）
// zhibo_id=152为财经直播频道，条目为高频市场快讯（板块涨跌/大宗商品/公司动态），关键词密度远高于普通滚动新闻
async function getMarketNews(num = 30) {
    if (!breakerAllow('sina-7x24')) return null;
    try {
        const url = `https://zhibo.sina.com.cn/api/zhibo/feed?page=1&page_size=${num}&zhibo_id=152&tag_id=0`;
        const data = await fetchJson(url, { timeout: 8000, retries: 1 });
        const feed = data && data.result && data.result.data && data.result.data.feed;
        const list = feed && Array.isArray(feed.list) ? feed.list : [];
        if (list.length === 0) throw new Error('empty 7x24');
        breakerOk('sina-7x24');
        const stripHtml = s => String(s || '').replace(/<[^>]+>/g, '').trim();
        return list
            .map(n => {
                const title = stripHtml(n.rich_text);
                return {
                    title,
                    url: 'https://finance.sina.com.cn/7x24/',
                    time: n.create_time || '',
                    source: '新浪7x24',
                    summary: '',
                    impact: classifyNewsImpact(title),
                    category: 'market'
                };
            })
            .filter(n => n.title.length >= 10);
    } catch (e) {
        breakerFail('sina-7x24');
        return null;
    }
}

function generateMockNews(category) {
    const newsTemplates = {
        'all': [
            { title: '央行宣布下调存款准备金率0.5个百分点', impact: 'high', source: '新华社' },
            { title: '美联储议息会议纪要公布，市场解读偏鸽派', impact: 'high', source: '路透社' },
            { title: 'A股三大指数集体走强，北向资金净买入超百亿', impact: 'medium', source: '证券时报' },
            { title: '新能源板块持续领涨，多只龙头股创历史新高', impact: 'medium', source: '每日财经' },
            { title: '科技股震荡上行，半导体板块涨幅居前', impact: 'medium', source: '财经网' }
        ],
        'important': [
            { title: '重磅经济数据公布：GDP增速超预期', impact: 'high', source: '国家统计局' },
            { title: '国务院发布新一轮稳经济政策措施', impact: 'high', source: '新华社' },
            { title: '美联储利率决议：维持利率不变，暗示年内降息', impact: 'high', source: '华尔街见闻' }
        ],
        'policy': [
            { title: '证监会发布资本市场改革新举措', impact: 'high', source: '证监会' },
            { title: '财政部：进一步减税降费支持实体经济', impact: 'medium', source: '财政部' },
            { title: '央行开展MLF操作，维持利率不变', impact: 'medium', source: '央行' }
        ],
        'market': [
            { title: '两市成交额突破万亿，市场情绪回暖', impact: 'medium', source: '证券日报' },
            { title: '北向资金连续5日净买入，创年内新高', impact: 'medium', source: '东方财富' },
            { title: '融资余额持续攀升，杠杆资金加速入场', impact: 'medium', source: '证券时报' }
        ],
        'company': [
            { title: '宁德时代发布新一代电池技术，能量密度提升30%', impact: 'medium', source: '公司公告' },
            { title: '茅台上半年净利润同比增长18%', impact: 'medium', source: '财联社' },
            { title: '华为发布全新旗舰机型，产业链受益', impact: 'high', source: '第一财经' }
        ]
    };

    const templates = newsTemplates[category] || newsTemplates['all'];
    const now = new Date();
    return templates.map((item, i) => ({
        title: item.title,
        url: '#',
        time: new Date(now.getTime() - i * 3600000).toLocaleString('zh-CN'),
        source: item.source,
        summary: '点击查看详细内容...',
        impact: item.impact,
        category
    }));
}

// ========== 导出 ==========
module.exports = {
    // 指数
    INDEX_CONFIG,
    getIndexQuotes,
    getIndexKline,
    getSinaQuote,
    getEastMoneyQuotes,
    getTencentQuotes,
    getTencentKline,
    getSinaKline,
    // 数字货币
    getBinanceTicker,
    getBinanceKline,
    getGateTicker,
    getGateKline,
    getCryptoTicker,
    getCryptoKline,
    // 黄金
    getGoldPrice,
    getGoldKline,
    // 新闻
    getFinanceNews,
    getMarketNews,
    // 市场情绪与资金（AI预测因子）
    getMarketBreadth,
    getNorthBoundFlow,
    getFearGreedIndex,
    getVixIndex,
    getDollarIndex,
    getA50Futures,
    getMarginTrading,
    getMainFundFlow,
    getCnhRate,
    // 基金净值
    getFundInfo,
    getFundHoldings,
    getStockQuotes,
    // 工具
    fetchRaw,
    fetchJson,
    getPart
};
