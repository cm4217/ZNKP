// 预测准确度跟踪与校正模块
// 每次交付预测时落盘快照；下一根真实K线/净值出现后回溯结算实际涨跌，
// 统计偏差(bias)/幅度比(amplitude)/方向命中率(hitRate)，
// 样本越多校正权重越大：偏差修正→收敛系统性高估/低估，幅度校准→匹配真实波动量级，
// 命中率→调节置信度。数据持久化到 accuracy-store.json，重启不丢失。
//
// 改进（v2）：
//  - 多周期回测：1D/1W/1M 三个周期分别结算（原先只结算 1D，中长期预测从未验证）；
//  - 按周期独立做偏差修正与幅度校准；
//  - 绑定 MODEL_VERSION，改模型/权重后旧样本不污染校准；
//  - 落盘改为异步原子写（临时文件 + rename），去除同步 IO 瓶颈与并发竞态。
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'accuracy-store.json');
const MAX_ENTRIES = 80;        // 每个标的最多保留的预测记录数
const STATS_WINDOW = 40;       // 统计窗口（最近N次已结算记录）
const MODEL_VERSION = 2;       // 模型版本：因子权重/映射变更时 +1，旧版本样本不计入校准
const HORIZONS = ['1D', '1W', '1M'];
const OFFSETS = { '1D': 1, '1W': 5, '1M': 22 };  // 回溯的交易日的根数偏移

let store = null;
// 异步原子写的调度状态
let writing = false, writeScheduled = false, writePending = false;

function load() {
    if (store) return store;
    try {
        store = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch (e) { store = null; }
    if (!store || typeof store !== 'object' || !store.records) store = { records: {} };
    if (!store.version) store.version = MODEL_VERSION;
    return store;
}

// 异步原子写：写入临时文件后 rename，避免半截文件与并发覆盖
function save() {
    if (writeScheduled) return;   // 已排期，合并一次
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

// 日期统一归一化为 YYYYMMDD 字符串，兼容 '2026-08-30'/'20260831'/毫秒时间戳等来源
function normDate(d) {
    return String(d).replace(/[-\/\s:T]/g, '').substring(0, 8);
}

// 从K线bar提取日期：指数/基金用date字段，加密/黄金(Binance系)用openTime时间戳
function barDateOf(k) {
    if (k.date != null && k.date !== undefined) return k.date;
    if (k.openTime != null) return new Date(Number(k.openTime)).toISOString().substring(0, 10);
    if (k.time != null) return k.time;
    return '';
}

// 实际涨跌幅（百分点）
function pct(close, base) {
    return +(((close / base) - 1) * 100).toFixed(2);
}

function entries(key) {
    const arr = load().records[key];
    return Array.isArray(arr) ? arr : [];
}

// 在 bars 中定位预测日那根 K 线的下标
function findBarIndex(bars, dateStr) {
    const d = normDate(dateStr);
    for (let i = 0; i < bars.length; i++) {
        if (normDate(bars[i].date) === d) return i;
    }
    return -1;
}

// 结算：遍历所有未完整结算的记录，对"未来 bar 已出现"的周期回填实际涨跌
// 修复原实现只结算最新一条 → 中长期(1W/1M)永远等不到结算的缺陷
function settle(key, bars) {
    const s = load();
    const arr = s.records[key];
    if (!arr || !arr.length || bars.length < 2) return null;
    let changed = false, lastNew = null;
    for (let idx = arr.length - 1; idx >= 0; idx--) {
        const e = arr[idx];
        if (e.v != null && e.v !== MODEL_VERSION) continue;        // 旧版本样本不结算
        const fully = e.actual1D != null && e.actual1W != null && e.actual1M != null;
        if (fully) continue;
        const pi = findBarIndex(bars, e.date);
        if (pi < 0) continue;
        const base = bars[pi].close;
        if (!(base > 0)) continue;
        let c = false;
        if (e.actual1D == null && pi + OFFSETS['1D'] < bars.length) {
            e.actual1D = pct(bars[pi + 1].close, base);
            e.error1D = +(e.pred1D - e.actual1D).toFixed(2);
            e.hit = (e.pred1D >= 0) === (e.actual1D >= 0);
            c = true;
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

// 丢弃长期无法推进结算的陈旧记录。
// 注意：1M 需要约 22 个交易日（≈30–45 个自然日）才能结算；
// 旧实现用「7 天且要求 1D+1W+1M 全齐」会把等待 1M 的样本提前删掉，导致中长期校准永远为空。
function prune(key, arr, s) {
    const now = Date.now();
    const kept = arr.filter(e => {
        const fully = e.actual1D != null && e.actual1W != null && e.actual1M != null;
        if (fully) return true;
        const age = now - (e.ts || 0);
        // 连 1D 都结算不了（停市/无新K线/日期对不上）→ 10 天后丢弃
        if (e.actual1D == null) return age < 10 * 86400e3;
        // 已有短周期结果、仍等 1W/1M → 保留约 45 天（覆盖 22 交易日 + 节假日缓冲）
        return age < 45 * 86400e3;
    });
    if (kept.length !== arr.length) {
        s.records[key] = kept;
        save();
    }
}

// 按周期统计：偏差/幅度比/方向命中率/MAE
function stats(key) {
    const settled = entries(key).filter(e => e.v === MODEL_VERSION && e.actual1D != null).slice(-STATS_WINDOW);
    if (!settled.length) return { samples: 0 };
    const out = { samples: settled.length };
    HORIZONS.forEach(h => {
        const vs = settled.filter(e => e['actual' + h] != null);
        if (!vs.length) return;
        let hits = 0, sumErr = 0, sumAbsErr = 0, sumAbsPred = 0, sumAbsAct = 0;
        vs.forEach(e => {
            if ((e['pred' + h] >= 0) === (e['actual' + h] >= 0)) hits++;
            const err = e['pred' + h] - e['actual' + h];
            sumErr += err; sumAbsErr += Math.abs(err);
            sumAbsPred += Math.abs(e['pred' + h]); sumAbsAct += Math.abs(e['actual' + h]);
        });
        const n = vs.length;
        out[h] = {
            samples: n,
            hitRate: +(hits / n).toFixed(3),
            bias: +(sumErr / n).toFixed(3),               // 正值=系统性高估
            mae: +(sumAbsErr / n).toFixed(2),            // 平均绝对误差（百分点）
            amplitude: sumAbsPred > 0 ? Math.max(0.5, Math.min(2.0, sumAbsAct / sumAbsPred)) : 1
        };
    });
    return out;
}

// 校正：样本不足时不干预；随样本数增大校正强度逐步提高（数据积累→准确度提升）
function correct(key, predictions, confidence) {
    const st = stats(key);
    const adj = { ...predictions };
    const applied = [];
    HORIZONS.forEach(h => {
        const s = st[h];
        if (!s) return;
        // 偏差修正（系统性高估/低估）
        if (s.samples >= 3 && Math.abs(s.bias) > 0.02) {
            const damp = Math.min(1, s.samples / 10) * 0.5;   // 3样本0.15→10样本0.5
            adj[h] = +(adj[h] - s.bias * damp).toFixed(2);
            applied.push(h + '偏差修正' + (s.bias >= 0 ? '-' : '+') + Math.abs(s.bias * damp).toFixed(2) + '%');
        }
        // 幅度校准（匹配真实波动量级）
        if (s.samples >= 5 && Math.abs(s.amplitude - 1) > 0.05) {
            const k = 0.3 * Math.min(1, s.samples / 15);
            const f = 1 + (s.amplitude - 1) * k;
            adj[h] = +(adj[h] * f).toFixed(2);
            applied.push(h + '幅度校准×' + f.toFixed(2));
        }
    });
    // 置信度：历史方向命中率主导（仅 1D 命中率可稳健统计）
    let conf = confidence;
    const h1 = st['1D'];
    if (h1 && h1.samples >= 5) {
        conf = Math.round(Math.max(45, Math.min(95, confidence * (0.7 + 0.6 * h1.hitRate))));
        applied.push('历史命中' + Math.round(h1.hitRate * 100) + '%');
    }
    return { predictions: adj, confidence: conf, applied, st };
}

// 记录当日快照（同一交易日重复预测时覆盖，保证只保留当日最终值）
function record(key, barDate, close, predictions, meta) {
    const s = load();
    if (!s.records[key]) s.records[key] = [];
    const arr = s.records[key];
    const d = normDate(barDate);
    const entry = {
        date: d,
        close: close != null ? +close : null,
        pred1D: predictions['1D'], pred1W: predictions['1W'], pred1M: predictions['1M'],
        score: meta.score, direction: meta.direction,
        v: MODEL_VERSION,
        ts: Date.now()
    };
    const last = arr[arr.length - 1];
    if (last && last.date === d) arr[arr.length - 1] = entry;
    else arr.push(entry);
    while (arr.length > MAX_ENTRIES) arr.shift();
    save();
}

// 主入口：结算昨日 → 统计校正 → 记录今日快照
function process({ key, klines, predictions, confidence, score, direction }) {
    if (!key || !predictions || !Array.isArray(klines) || klines.length < 2) return null;
    const bars = klines.map(k => ({ date: barDateOf(k), close: k.close }));
    const settledEntry = settle(key, bars);
    const { predictions: adj, confidence: conf, applied, st } = correct(key, predictions, confidence);
    const lastBar = bars[bars.length - 1];
    record(key, lastBar.date, lastBar.close, adj, { score, direction });

    const settledList = entries(key).filter(e => e.actual1D != null);
    const lastSettled = settledList[settledList.length - 1] || null;
    return {
        predictions: adj,
        confidence: conf,
        yesterday: lastSettled ? {
            date: lastSettled.date,
            predicted: lastSettled.pred1D,
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

// 融合权重 EMA 持久化（ensemble 模块用于跨请求平滑自适应权重，抑制逐日抖动）
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

// 回测回填专用：直接落盘历史快照 / 基于完整序列回填实际涨跌 / 统计样本总量
function recordBackfill(key, barDate, close, predictions, meta) { record(key, barDate, close, predictions, meta); }
function settleBackfill(key, bars) { return settle(key, bars); }
function totalEntries() {
    const s = load();
    return Object.keys(s.records).reduce((sum, k) => sum + (Array.isArray(s.records[k]) ? s.records[k].length : 0), 0);
}

module.exports = { process, stats, entries, MODEL_VERSION, record: recordBackfill, settle: settleBackfill, totalEntries, getWeightEma, setWeightEma };
