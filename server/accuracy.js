// 预测准确度跟踪与校正模块
// 每次交付预测时落盘快照；下一根真实K线/净值出现后回溯结算实际涨跌，
// 统计偏差(bias)/幅度比(amplitude)/方向命中率(hitRate)，
// 样本越多校正权重越大：偏差修正→收敛系统性高估/低估，幅度校准→匹配真实波动量级，
// 命中率→调节置信度。数据持久化到 accuracy-store.json，重启不丢失。
//
// v3 改进：
//  - 多周期回测：1D/1W/1M 分别结算；绑定 MODEL_VERSION；
//  - 同时记录 predRaw*（校准前）与 predAdj*（展示用校正后）；stats/融合权重用 raw；
//  - 残差分流：techOnly 样本只校正 techResidual，live 多因子用 soft 残差，避免技术回填污染软因子；
//  - 分因子权重 EMA 学习（≥15 样本 + 强收缩）；schema 不兼容时清空重建。
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'accuracy-store.json');
const MAX_ENTRIES = 80;
const STATS_WINDOW = 40;
const MODEL_VERSION = 3;       // v3：raw/adj 分离 + 残差分流 + 因子权重学习；旧库需重建
const STORE_SCHEMA = 3;
const HORIZONS = ['1D', '1W', '1M'];
const OFFSETS = { '1D': 1, '1W': 5, '1M': 22 };

let store = null;
let writing = false, writeScheduled = false, writePending = false;

function emptyStore() {
    return {
        schema: STORE_SCHEMA,
        version: MODEL_VERSION,
        records: {},
        weightEma: {},
        factorWeightEma: {},
        note: 'MODEL_VERSION/schema 变更后由 backfill.ensureBackfilled 重建'
    };
}

function load() {
    if (store) return store;
    try {
        store = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch (e) { store = null; }
    if (!store || typeof store !== 'object' || !store.records) {
        store = emptyStore();
        return store;
    }
    // schema / MODEL_VERSION 不兼容 → 清空重建（避免旧 pred 字段/周线结算污染）
    if (store.schema !== STORE_SCHEMA || store.version !== MODEL_VERSION) {
        store = emptyStore();
        save();
        return store;
    }
    if (!store.weightEma) store.weightEma = {};
    if (!store.factorWeightEma) store.factorWeightEma = {};
    return store;
}

function save() {
    if (writeScheduled) return;
    writeScheduled = true;
    setImmediate(() => {
        writeScheduled = false;
        if (writing) { writePending = true; return; }
        writing = true;
        const tmp = FILE + '.tmp';
        fs.promises.writeFile(tmp, JSON.stringify(store))
            .then(() => fs.promises.rename(tmp, FILE))
            .catch(() => { /* 磁盘失败仅内存生效 */ })
            .finally(() => {
                writing = false;
                if (writePending) { writePending = false; save(); }
            });
    });
}

function normDate(d) {
    return String(d).replace(/[-\/\s:T]/g, '').substring(0, 8);
}

function barDateOf(k) {
    if (k.date != null && k.date !== undefined) return k.date;
    if (k.openTime != null) return new Date(Number(k.openTime)).toISOString().substring(0, 10);
    if (k.time != null) return k.time;
    return '';
}

function pct(close, base) {
    return +(((close / base) - 1) * 100).toFixed(2);
}

function entries(key) {
    const arr = load().records[key];
    return Array.isArray(arr) ? arr : [];
}

function findBarIndex(bars, dateStr) {
    const d = normDate(dateStr);
    for (let i = 0; i < bars.length; i++) {
        if (normDate(bars[i].date) === d) return i;
    }
    return -1;
}

// 取用于校准/命中统计的预测值：优先 raw，兼容旧字段 pred*
function predOf(e, h) {
    const raw = e['predRaw' + h];
    if (raw != null && isFinite(raw)) return raw;
    const p = e['pred' + h];
    return p != null && isFinite(p) ? p : null;
}

function settle(key, bars) {
    const s = load();
    const arr = s.records[key];
    if (!arr || !arr.length || bars.length < 2) return null;
    let changed = false, lastNew = null;
    for (let idx = arr.length - 1; idx >= 0; idx--) {
        const e = arr[idx];
        if (e.v != null && e.v !== MODEL_VERSION) continue;
        const fully = e.actual1D != null && e.actual1W != null && e.actual1M != null;
        if (fully) continue;
        const pi = findBarIndex(bars, e.date);
        if (pi < 0) continue;
        const base = bars[pi].close;
        if (!(base > 0)) continue;
        let c = false;
        if (e.actual1D == null && pi + OFFSETS['1D'] < bars.length) {
            e.actual1D = pct(bars[pi + 1].close, base);
            const pr = predOf(e, '1D');
            e.error1D = pr != null ? +(pr - e.actual1D).toFixed(2) : null;
            e.hit = pr != null ? (pr >= 0) === (e.actual1D >= 0) : null;
            c = true;
            // 分因子方向学习（仅 1D 结算时更新一次）
            learnFactorWeights(key, e, e.actual1D);
        }
        if (e.actual1W == null && pi + OFFSETS['1W'] < bars.length) {
            e.actual1W = pct(bars[pi + 5].close, base);
            c = true;
        }
        if (e.actual1M == null && pi + OFFSETS['1M'] < bars.length) {
            e.actual1M = pct(bars[pi + 22].close, base);
            c = true;
        }
        if (c) { changed = true; lastNew = e; }
    }
    prune(key, arr, s);
    if (changed) save();
    return lastNew;
}

function prune(key, arr, s) {
    const now = Date.now();
    const kept = arr.filter(e => {
        const fully = e.actual1D != null && e.actual1W != null && e.actual1M != null;
        if (fully) return true;
        const age = now - (e.ts || 0);
        if (e.actual1D == null) return age < 10 * 86400e3;
        return age < 45 * 86400e3;
    });
    if (kept.length !== arr.length) {
        s.records[key] = kept;
        save();
    }
}

// ---------- 分因子权重学习 ----------
function learnFactorWeights(key, entry, actual1D) {
    if (!entry || !Array.isArray(entry.factorSigns) || !entry.factorSigns.length) return;
    if (actual1D == null || !isFinite(actual1D) || Math.abs(actual1D) < 0.01) return;
    const actSign = actual1D >= 0 ? 1 : -1;
    const typeKey = key.split('|')[0] || key;
    const s = load();
    if (!s.factorWeightEma) s.factorWeightEma = {};
    if (!s.factorWeightEma[typeKey]) s.factorWeightEma[typeKey] = { n: 0, scores: {} };
    const bucket = s.factorWeightEma[typeKey];
    bucket.n = (bucket.n || 0) + 1;
    entry.factorSigns.forEach(fs => {
        if (!fs || !fs.name) return;
        const hit = (fs.sign === actSign) ? 1 : -1;   // 同向+1 / 反向-1
        const prev = bucket.scores[fs.name];
        const base = prev != null ? prev : 0;
        // 强收缩 EMA：α=0.08，避免小样本过拟合
        bucket.scores[fs.name] = +(base * 0.92 + hit * 0.08).toFixed(4);
    });
}

// 基于学习到的因子命中分数，返回相对基础权重的乘数（夹紧），样本不足则返回 null
function getLearnedWeightMultipliers(typeOrKey) {
    const typeKey = String(typeOrKey).includes('|') ? String(typeOrKey).split('|')[0] : String(typeOrKey);
    const s = load();
    const bucket = s.factorWeightEma && s.factorWeightEma[typeKey];
    if (!bucket || !(bucket.n >= 15)) return null;
    const out = {};
    Object.keys(bucket.scores || {}).forEach(name => {
        const sc = bucket.scores[name]; // ≈ [-1,1]
        // 乘数范围 0.6~1.4，强收缩：score*0.25
        out[name] = Math.max(0.6, Math.min(1.4, 1 + sc * 0.25));
    });
    return out;
}

// 按周期统计：默认用 raw 预测；可按 techOnly / live 分流
function stats(key, opts) {
    opts = opts || {};
    const mode = opts.mode || 'all'; // all | tech | live
    let settled = entries(key).filter(e => e.v === MODEL_VERSION && e.actual1D != null);
    if (mode === 'tech') settled = settled.filter(e => e.techOnly);
    else if (mode === 'live') settled = settled.filter(e => !e.techOnly);
    settled = settled.slice(-STATS_WINDOW);
    if (!settled.length) return { samples: 0, mode };
    const out = { samples: settled.length, mode };
    HORIZONS.forEach(h => {
        const vs = settled.filter(e => e['actual' + h] != null && predOf(e, h) != null);
        if (!vs.length) return;
        let hits = 0, sumErr = 0, sumAbsErr = 0, sumAbsPred = 0, sumAbsAct = 0;
        vs.forEach(e => {
            const pr = predOf(e, h);
            if ((pr >= 0) === (e['actual' + h] >= 0)) hits++;
            const err = pr - e['actual' + h];
            sumErr += err; sumAbsErr += Math.abs(err);
            sumAbsPred += Math.abs(pr); sumAbsAct += Math.abs(e['actual' + h]);
        });
        const n = vs.length;
        out[h] = {
            samples: n,
            hitRate: +(hits / n).toFixed(3),
            bias: +(sumErr / n).toFixed(3),
            mae: +(sumAbsErr / n).toFixed(2),
            amplitude: sumAbsPred > 0 ? Math.max(0.5, Math.min(2.0, sumAbsAct / sumAbsPred)) : 1
        };
    });
    return out;
}

// 残差分流校正：优先用 live 样本；不足时用 tech 样本但折扣；最终校正只作用于 adj 展示
function correct(key, predictions, confidence, opts) {
    opts = opts || {};
    const techOnlyPred = !!opts.techOnlyPred; // 当前预测是否技术核（回填路径一般不走这里）
    const stLive = stats(key, { mode: 'live' });
    const stTech = stats(key, { mode: 'tech' });
    const stAll = stats(key, { mode: 'all' });
    // 融合统计：live 足够用 live；否则用 tech 但 damp 减半（避免 tech-only 偏差硬套多因子）
    const pick = (h) => {
        const L = stLive[h], T = stTech[h];
        if (L && L.samples >= 5) return { s: L, dampScale: 1 };
        if (T && T.samples >= 5) return { s: T, dampScale: techOnlyPred ? 1 : 0.4 };
        const A = stAll[h];
        if (A && A.samples >= 3) return { s: A, dampScale: 0.5 };
        return null;
    };
    const adj = { ...predictions };
    const applied = [];
    HORIZONS.forEach(h => {
        const picked = pick(h);
        if (!picked) return;
        const s = picked.s;
        const scale = picked.dampScale;
        if (s.samples >= 3 && Math.abs(s.bias) > 0.02) {
            const damp = Math.min(1, s.samples / 10) * 0.5 * scale;
            adj[h] = +(adj[h] - s.bias * damp).toFixed(2);
            applied.push(h + '偏差修正' + (s.bias >= 0 ? '-' : '+') + Math.abs(s.bias * damp).toFixed(2) + '%' + (scale < 1 ? '(残差折扣)' : ''));
        }
        if (s.samples >= 5 && Math.abs(s.amplitude - 1) > 0.05) {
            const k = 0.3 * Math.min(1, s.samples / 15) * scale;
            const f = 1 + (s.amplitude - 1) * k;
            adj[h] = +(adj[h] * f).toFixed(2);
            applied.push(h + '幅度校准×' + f.toFixed(2));
        }
    });
    let conf = confidence;
    const h1 = (stLive['1D'] && stLive['1D'].samples >= 5) ? stLive['1D']
        : (stAll['1D'] && stAll['1D'].samples >= 5) ? stAll['1D'] : null;
    if (h1) {
        conf = Math.round(Math.max(45, Math.min(95, confidence * (0.7 + 0.6 * h1.hitRate))));
        applied.push('历史命中' + Math.round(h1.hitRate * 100) + '%');
    }
    return { predictions: adj, confidence: conf, applied, st: stAll, stLive, stTech };
}

function record(key, barDate, close, predictions, meta) {
    meta = meta || {};
    const s = load();
    if (!s.records[key]) s.records[key] = [];
    const arr = s.records[key];
    const d = normDate(barDate);
    const raw = meta.rawPredictions || predictions;
    const adj = predictions;
    const entry = {
        date: d,
        close: close != null ? +close : null,
        // 兼容旧读取：pred* = raw（校准环用 raw）
        pred1D: raw['1D'], pred1W: raw['1W'], pred1M: raw['1M'],
        predRaw1D: raw['1D'], predRaw1W: raw['1W'], predRaw1M: raw['1M'],
        predAdj1D: adj['1D'], predAdj1W: adj['1W'], predAdj1M: adj['1M'],
        score: meta.score, direction: meta.direction,
        techOnly: !!meta.techOnly,
        factorSigns: Array.isArray(meta.factorSigns) ? meta.factorSigns : undefined,
        v: MODEL_VERSION,
        ts: Date.now()
    };
    const last = arr[arr.length - 1];
    if (last && last.date === d) arr[arr.length - 1] = entry;
    else arr.push(entry);
    while (arr.length > MAX_ENTRIES) arr.shift();
    save();
}

function process({ key, klines, predictions, confidence, score, direction, rawPredictions, techOnly, factorSigns }) {
    if (!key || !predictions || !Array.isArray(klines) || klines.length < 2) return null;
    const bars = klines.map(k => ({ date: barDateOf(k), close: k.close }));
    const settledEntry = settle(key, bars);
    const raw = rawPredictions || predictions;
    const { predictions: adj, confidence: conf, applied, st } = correct(key, predictions, confidence, { techOnlyPred: !!techOnly });
    const lastBar = bars[bars.length - 1];
    record(key, lastBar.date, lastBar.close, adj, {
        score, direction, rawPredictions: raw, techOnly: !!techOnly, factorSigns
    });

    const settledList = entries(key).filter(e => e.actual1D != null);
    const lastSettled = settledList[settledList.length - 1] || null;
    return {
        predictions: adj,
        rawPredictions: raw,
        confidence: conf,
        yesterday: lastSettled ? {
            date: lastSettled.date,
            predicted: predOf(lastSettled, '1D'),
            predictedAdj: lastSettled.predAdj1D != null ? lastSettled.predAdj1D : lastSettled.pred1D,
            actual: lastSettled.actual1D,
            error: lastSettled.error1D,
            hit: lastSettled.hit,
            actual1W: lastSettled.actual1W != null ? lastSettled.actual1W : null,
            actual1M: lastSettled.actual1M != null ? lastSettled.actual1M : null
        } : null,
        accuracy: st.samples > 0 ? {
            samples: st.samples,
            hitRate: st['1D'] ? st['1D'].hitRate : null,
            bias: st['1D'] ? st['1D'].bias : null,
            mae: st['1D'] ? st['1D'].mae : null,
            perHorizon: st
        } : { samples: 0 },
        corrections: applied
    };
}

function getWeightEma(key) {
    const s = load();
    return (s.weightEma && s.weightEma[key] != null) ? s.weightEma[key] : null;
}
function setWeightEma(key, w) {
    const s = load();
    if (!s.weightEma) s.weightEma = {};
    s.weightEma[key] = w;
    save();
}

function recordBackfill(key, barDate, close, predictions, meta) {
    record(key, barDate, close, predictions, Object.assign({ techOnly: true, rawPredictions: predictions }, meta || {}));
}
function settleBackfill(key, bars) { return settle(key, bars); }
function totalEntries() {
    const s = load();
    return Object.keys(s.records).reduce((sum, k) => sum + (Array.isArray(s.records[k]) ? s.records[k].length : 0), 0);
}

// 强制清空（ops / MODEL_VERSION 迁移）；ensureBackfilled 会重建
function resetStore() {
    store = emptyStore();
    save();
}

module.exports = {
    process, stats, entries, MODEL_VERSION, STORE_SCHEMA,
    record: recordBackfill, settle: settleBackfill, totalEntries,
    getWeightEma, setWeightEma, getLearnedWeightMultipliers, resetStore, predOf
};
