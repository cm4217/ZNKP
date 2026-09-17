// 历史 K 线回填校准样本
// -----------------------------------------------------------------------------
// 思路：线上 predict() 每次预测会调用 accuracy.process() 落盘快照，并在下一根真实
// K 线出现后回溯结算实际涨跌，积累 bias / 幅度比 / 方向命中率 用于自我校正。
// 但冷启动时校准库为空，校正长期不生效。本模块用各品种「真实历史日 K 线」回放模型
// 的技术面核心（computeTechPred，与线上技术因子同源），为每一天生成一个历史预测，
// 再由 settle() 用后续真实涨跌回填实际值，从而把校准样本一次性灌满。
//
// 说明：回填预测仅含技术面核心（实时资金/情绪/新闻等无法取得历史值，留空），
// 与线上多因子预测存在轻微差异；但偏差/幅度/命中率的统计对技术核心高度一致，
// 足以驱动有效的分周期校正。校准会在线上持续被新样本滚动更新。
const ds = require('./data-source');
const accuracy = require('./accuracy');
const predict = require('./predict');

// 回测标的（key 规则与 predict() 一致： index|CODE / crypto|SYM / gold|PAXG / fund|CODE）
const TARGETS = [
    { code: '000001.SH', type: 'index' },
    { code: '000300.SH', type: 'index' },
    { code: '399006.SZ', type: 'index' },
    { code: '000688.SH', type: 'index' },
    { code: 'HSI', type: 'index' },
    { code: 'SPX', type: 'index' },
    { symbol: 'BTC', type: 'crypto' },
    { symbol: 'ETH', type: 'crypto' },
    { code: 'PAXG', type: 'gold' },
    { code: '005827', type: 'fund' },
    { code: '110011', type: 'fund' }
];

const MIN_LOOKBACK = 60;   // 技术因子至少需要约 60 根才有意义
const TAIL_UNSETTLED = 23; // 末尾 23 根（≈1月）保留给线上/未来结算，不回填

// 将 K 线统一规整为 {date, close}；加密/黄金用 openTime 时间戳推导日期
function normDateOf(k) {
    if (k.date != null && k.date !== '') return String(k.date).substring(0, 10);
    if (k.openTime != null) return new Date(Number(k.openTime)).toISOString().substring(0, 10);
    return '';
}

async function fetchHistorical(code, type) {
    if (type === 'index') {
        const r = await ds.getIndexKline(code, '1Y');   // ~250 根日线
        return r && r.data ? r.data : null;
    }
    if (type === 'crypto') {
        const r = await ds.getCryptoKline(code, '1d', 365);
        return r && r.data ? r.data : null;
    }
    if (type === 'gold') {
        // getGoldKline('1Y') 仅返回 52 根周线，不足以回测；改用 PAXG 日线（Binance 源）取约 365 根日 K 线
        const r = await ds.getCryptoKline('PAXG', '1d', 365);
        return r && r.data ? r.data : null;
    }
    if (type === 'fund') {
        const info = await ds.getFundInfo(code);
        return info && info.bars ? info.bars : null;
    }
    return null;
}

async function backfillCode(target) {
    const code = target.symbol || target.code;
    const type = target.type;
    const key = `${type}|${code}`;
    let klines;
    try {
        klines = await fetchHistorical(code, type);
    } catch (e) {
        return { code, type, ok: false, reason: 'fetch failed: ' + e.message };
    }
    if (!Array.isArray(klines) || klines.length < MIN_LOOKBACK + TAIL_UNSETTLED + 1) {
        return { code, type, ok: false, reason: 'insufficient bars (' + (klines ? klines.length : 0) + ')' };
    }

    // 用于结算/落盘的规整序列（带日期）
    const bars = klines.map(k => ({ date: normDateOf(k), close: k.close })).filter(b => b.date && b.close > 0);
    if (bars.length < MIN_LOOKBACK + TAIL_UNSETTLED + 1) {
        return { code, type, ok: false, reason: 'valid bars too few (' + bars.length + ')' };
    }

    let count = 0;
    const end = bars.length - 1 - TAIL_UNSETTLED;
    for (let i = MIN_LOOKBACK; i <= end; i++) {
        const slice = klines.slice(0, i + 1);            // 技术因子只看"当时"可得的 K 线
        const p = predict.computeTechPred(slice, type);
        accuracy.record(key, bars[i].date, bars[i].close, p.predictions, { score: p.score, direction: p.direction });
        count++;
        if (count % 25 === 0) await new Promise(r => setImmediate(r)); // 让出事件循环，避免阻塞
    }
    // 用完整序列回填实际涨跌（未来 bar 已在序列内）
    accuracy.settle(key, bars);
    const st = accuracy.stats(key);
    return { code, type, ok: true, recorded: count, stats: st };
}

async function backfillAll() {
    const results = [];
    for (const t of TARGETS) {
        try {
            results.push(await backfillCode(t));
        } catch (e) {
            results.push({ code: t.symbol || t.code, type: t.type, ok: false, reason: 'error: ' + e.message });
        }
        await new Promise(r => setImmediate(r));
    }
    return results;
}

// 启动自愈：仅在校准库样本不足时执行一次（避免每次重启都重抓上游）
let backfilling = false;
let backfilled = false;
async function ensureBackfilled() {
    if (backfilled || backfilling) return null;
    if (accuracy.totalEntries() > 150) { backfilled = true; return null; }
    backfilling = true;
    try {
        const results = await backfillAll();
        backfilled = true;
        return results;
    } finally {
        backfilling = false;
    }
}

module.exports = { backfillAll, backfillCode, ensureBackfilled, TARGETS };
