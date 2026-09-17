// 历史 K 线回填校准样本
// -----------------------------------------------------------------------------
// 用各品种「真实历史日 K 线」回放模型的技术面核心（computeTechPred），
// 为每一天生成历史预测，再由 settle() 用后续真实涨跌回填。
//
// v3：强制真日线（拒绝周线）；techOnly 标记写入 accuracy，与线上多因子残差分流；
// MODEL_VERSION 变更后 ensureBackfilled 会因样本清空而自动重建。
const ds = require('./data-source');
const accuracy = require('./accuracy');
const predict = require('./predict');

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

const MIN_LOOKBACK = 60;
const TAIL_UNSETTLED = 23;

function normDateOf(k) {
    if (k.date != null && k.date !== '') return String(k.date).substring(0, 10);
    if (k.openTime != null) return new Date(Number(k.openTime)).toISOString().substring(0, 10);
    return '';
}

// 断言近似日频：中位间隔应在 0.5–3 天（拒周线/月线）
function assertDailyBars(bars, label) {
    if (!bars || bars.length < 10) return { ok: false, reason: 'too few bars' };
    const gaps = [];
    for (let i = 1; i < bars.length; i++) {
        const t0 = Date.parse(bars[i - 1].date);
        const t1 = Date.parse(bars[i].date);
        if (!isFinite(t0) || !isFinite(t1)) continue;
        gaps.push((t1 - t0) / 86400000);
    }
    if (gaps.length < 5) return { ok: false, reason: 'cannot measure spacing' };
    gaps.sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)];
    // 周线中位≈7，日线（含周末）中位≈1–1.5
    if (median > 3.5) {
        return { ok: false, reason: `${label} bar spacing median=${median.toFixed(1)}d (weekly/monthly refused for OFFSETS 1/5/22)` };
    }
    if (median < 0.2) {
        return { ok: false, reason: `${label} bar spacing too fine (intraday?)` };
    }
    return { ok: true, median };
}

async function fetchHistorical(code, type) {
    if (type === 'index') {
        // 必须真日线：data-source 1Y 现已映射 day×250
        const r = await ds.getIndexKline(code, '1Y');
        return r && r.data ? r.data : null;
    }
    if (type === 'crypto') {
        const r = await ds.getCryptoKline(code, '1d', 365);
        return r && r.data ? r.data : null;
    }
    if (type === 'gold') {
        // PAXG 日线（Binance），禁止周线
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

    const bars = klines.map(k => ({ date: normDateOf(k), close: k.close })).filter(b => b.date && b.close > 0);
    if (bars.length < MIN_LOOKBACK + TAIL_UNSETTLED + 1) {
        return { code, type, ok: false, reason: 'valid bars too few (' + bars.length + ')' };
    }

    const spacing = assertDailyBars(bars, key);
    if (!spacing.ok) {
        return { code, type, ok: false, reason: spacing.reason };
    }

    let count = 0;
    const end = bars.length - 1 - TAIL_UNSETTLED;
    for (let i = MIN_LOOKBACK; i <= end; i++) {
        const slice = klines.slice(0, i + 1);
        const p = predict.computeTechPred(slice, type);
        accuracy.record(key, bars[i].date, bars[i].close, p.predictions, {
            score: p.score,
            direction: p.direction,
            techOnly: true,
            factorSigns: p.factorSigns || []
        });
        count++;
        if (count % 25 === 0) await new Promise(r => setImmediate(r));
    }
    accuracy.settle(key, bars);
    const st = accuracy.stats(key, { mode: 'tech' });
    return { code, type, ok: true, recorded: count, medianGap: spacing.median, stats: st };
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

let backfilling = false;
let backfilled = false;
async function ensureBackfilled() {
    if (backfilled || backfilling) return null;
    // MODEL_VERSION/schema 变更后 records 会被清空，totalEntries 变小 → 自动重建
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

module.exports = { backfillAll, backfillCode, ensureBackfilled, TARGETS, assertDailyBars };
