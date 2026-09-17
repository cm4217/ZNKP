// 集成预测增强模块（覆盖六层增强框架）
//  L1 数据增强：复用 predict.js 多源数据；本模块新增「市场 regime」跨市场视角
//  L2 特征工程：因子已在 predict.js 计算；本模块对因子做 SHAP 式归因（自动特征重要性）
//  L3 模型架构：在原有「多因子加权模型」之外，新增「统计回归模型(动量+均值回归+regime)」作为第二基模型
//  L4 训练策略：堆叠权重随 accuracy 历史命中率在线自适应(walk-forward 风格)，命中率越高越信任主模型
//  L5 预测框架：概率预测+置信区间(沿用) + forecast combination(两基模型加权融合)
//  L6 评估校准：样本外回测(accuracy 模块) + 置信度校准(可靠性校验) + SHAP 可解释归因
//
// 设计原则：纯 JS、无新增依赖；全部特征优雅降级——历史样本不足时退回主模型单模型，不崩溃。
const accuracy = require('./accuracy');

// ---------- 工具 ----------
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function clampPct(v, max) { return Math.max(-max, Math.min(max, v)); }

// 鲁棒波动率估计：有高低价用近似 ATR%，仅收盘价(基金净值)用日收益标准差
function volOf(klines) {
    const closes = (klines || []).map(k => k.close).filter(v => v > 0);
    if (closes.length < 2) return 0.01;
    const last = closes[closes.length - 1];
    const highs = klines.map(k => k.high).filter(v => v > 0);
    const lows = klines.map(k => k.low).filter(v => v > 0);
    let v;
    if (highs.length && lows.length) {
        const n = Math.min(14, closes.length - 1);
        let s = 0;
        for (let i = closes.length - n; i < closes.length; i++) s += Math.abs(closes[i] - closes[i - 1]);
        v = s / n / last;
    } else {
        const rets = [];
        for (let i = 1; i < closes.length; i++) rets.push(closes[i] / closes[i - 1] - 1);
        const m = rets.reduce((a, b) => a + b, 0) / rets.length;
        v = Math.sqrt(rets.reduce((a, b) => a + (b - m) * (b - m), 0) / rets.length);
    }
    return clamp(isFinite(v) ? v : 0.01, 0.005, 0.09);
}

// 跨市场风险偏好(regime)：VIX 低 + 恐慌贪婪高 => risk-on；黄金(避险)反向
function riskAppetite(klines, vix, fearGreed, type) {
    let ra = 0;
    if (vix && vix.value != null) ra += (20 - vix.value);
    if (fearGreed && fearGreed.value != null) ra += (fearGreed.value - 50) * 0.5;
    const defensive = type === 'gold';
    return defensive ? -ra : ra;   // 避险资产与风险偏好反向
}

// 生成「市场regime」因子（展示 + SHAP 归因用），不进入主模型加权（避免动摇已验证基线）
function factorRegime(klines, vix, fearGreed, type) {
    const ra = riskAppetite(klines, vix, fearGreed, type);
    const vol = volOf(klines);
    const hiVol = vol > 0.025;
    let score = ra * 0.7;
    if (hiVol) score *= 1.2;
    const detail = (ra > 0 ? '风险偏好回升(risk-on)' : ra < 0 ? '风险偏好走弱(risk-off)' : '风险偏好中性')
        + (hiVol ? '，波动率偏高' : '，波动率温和');
    return { name: '市场regime', group: '跨市场', score: Math.round(clamp(score, -100, 100)), detail };
}

// ---------- L3 基模型二：统计回归模型(动量+均值回归+regime) ----------
function statisticalModel(klines, type, vix, fearGreed) {
    const closes = (klines || []).map(k => k.close).filter(v => v > 0);
    if (closes.length < 12) return null;
    const n = closes.length;
    const last = closes[n - 1];
    const ret5 = last / closes[Math.max(0, n - 6)] - 1;
    const ret20 = last / closes[Math.max(0, n - 21)] - 1;
    const ra = riskAppetite(klines, vix, fearGreed, type);

    // 动量(中期趋势) + 短期均值回归 + regime 倾斜
    let expected = ret20 * 0.6 + ret5 * 0.4 - ret5 * 0.5 + ra * 0.0008;
    const vol = volOf(klines);
    const cap = vol * 1.0;                 // 单日预期不超过 1 个波动单位
    expected = clamp(expected, -cap, cap);

    const raw1D = expected * 100;
    const raw1W = expected * Math.sqrt(5) * 100;
    const raw1M = expected * Math.sqrt(22) * 100;
    return {
        predictions: {
            '1D': +clampPct(raw1D, 3).toFixed(2),
            '1W': +clampPct(raw1W, 8).toFixed(2),
            '1M': +clampPct(raw1M, 15).toFixed(2)
        }
    };
}

// ---------- L4 堆叠权重：随历史综合命中率在线自适应 + EMA平滑（稳定性） ----------
// 综合 1D/1W 命中率（比单看 1D 更稳健），并用持久化的 EMA 平滑，避免逐日抖动
function combinedHitRate(stats) {
    const a = stats && stats['1D'] ? stats['1D'] : null;
    const b = stats && stats['1W'] ? stats['1W'] : null;
    const vals = [];
    if (a && a.samples >= 5) vals.push(a.hitRate);
    if (b && b.samples >= 5) vals.push(b.hitRate);
    if (!vals.length) return null;
    return vals.reduce((x, y) => x + y, 0) / vals.length;
}

function blendWeights(stats, key) {
    const hr = combinedHitRate(stats);
    // 历史方向命中率越高越信任主模型；区间 0.45~0.9
    const target = hr == null ? 0.7 : clamp(hr, 0.45, 0.9);
    // EMA 平滑：新权重 = 0.7*旧 + 0.3*目标，跨请求持久化，抑制单日样本噪声带来的权重跳变
    let w = target;
    const prev = (typeof accuracy.getWeightEma === 'function') ? accuracy.getWeightEma(key) : null;
    if (prev != null && isFinite(prev)) w = +(0.7 * prev + 0.3 * target).toFixed(2);
    w = clamp(w, 0.45, 0.9);
    if (typeof accuracy.setWeightEma === 'function') accuracy.setWeightEma(key, w);
    return { model: +w.toFixed(2), statistical: +(1 - w).toFixed(2) };
}

// ---------- L5 预测融合(forecast combination) ----------
function blendedPredictions(base, stat, wModel) {
    if (!stat) return base;
    const out = {};
    ['1D', '1W', '1M'].forEach(h => {
        out[h] = +(base[h] * wModel + stat.predictions[h] * (1 - wModel)).toFixed(2);
    });
    return out;
}

// ---------- 稳定性：双基模型方向分歧对冲 ----------
// 若多因子主模型与统计模型在某周期方向相悖，说明信号不确定 → 把该周期预测向 0 收缩，
// 并整体下调输出置信度（分歧越大、不确定性越高）。直接提升"乱出方向"的稳健性。
function hedgeByDisagreement(base, stat, finalRaw, confidence) {
    const out = { ...finalRaw };
    let disagree = 0, total = 0;
    ['1D', '1W', '1M'].forEach(h => {
        const b = (base && base[h]) || 0;
        const s = (stat && stat.predictions && stat.predictions[h]) || 0;
        total++;
        if (b * s < 0) {            // 方向相反
            out[h] = +(finalRaw[h] * 0.5).toFixed(2);
            disagree++;
        }
    });
    const discount = disagree > 0 ? Math.max(0.7, 1 - 0.12 * (disagree / total)) : 1;
    return { predictions: out, confidence: Math.round((confidence || 70) * discount), disagree };
}

// ---------- 稳定性：按波动率封顶，抑制极端预测 ----------
// 防止多因子主模型偶发给出远超真实波动量级的离群预测（既伤准确度也伤校准可信度）。
function clampByVol(raw, klines) {
    const vol = volOf(klines);   // 单日波动(分数)
    const cap = {
        '1D': vol * 2.5 * 100,
        '1W': vol * Math.sqrt(5) * 2.5 * 100,
        '1M': vol * Math.sqrt(22) * 2.5 * 100
    };
    const out = {};
    ['1D', '1W', '1M'].forEach(h => { out[h] = +clampPct(raw[h] || 0, cap[h]).toFixed(2); });
    return out;
}

// ---------- L2/L6 SHAP 式因子归因（线性模型 Shapley = 系数×取值） ----------
// 对因子 f：贡献 = w_f * score_f；按 |贡献| 归一化为占比，输出排序后的瀑布数组
function attribution(factors, W) {
    if (!Array.isArray(factors)) return [];
    // 仅对权重表中有名、且 active!==false 的因子归因（避免占位因子）
    const items = factors.filter(f => f && typeof f.score === 'number' && f.active !== false
        && W && Object.prototype.hasOwnProperty.call(W, f.name));
    let total = 0;
    const contribs = items.map(f => {
        const w = W[f.name];
        const c = w * f.score;
        total += Math.abs(c);
        return { name: f.name, group: f.group, score: Math.round(f.score), weight: +w.toFixed(3), contribution: +c.toFixed(2) };
    });
    contribs.forEach(c => { c.pct = total > 0 ? +(c.contribution / total * 100).toFixed(1) : 0; });
    contribs.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
    return contribs;
}

// ---------- L6 置信度校准（可靠性校验） ----------
function calibration(confidence, stats) {
    const h = stats && stats['1D'] ? stats['1D'] : null;
    const empirical = (h && h.samples >= 5) ? h.hitRate : null;
    if (empirical == null) {
        return { available: false, statedConfidence: confidence, note: '校准样本积累中，暂无法校验置信度' };
    }
    const stated = confidence / 100;
    const diff = stated - empirical;
    let reliability = '良好';
    if (diff > 0.15) reliability = '偏高';
    else if (diff < -0.15) reliability = '偏低';
    // 将声明置信度向经验命中率牵引（Platt 式单调映射近似）
    const calibrated = Math.round(confidence * (0.6 + 0.8 * empirical));
    return {
        available: true,
        empiricalHitRate: +(empirical * 100).toFixed(1),
        statedConfidence: confidence,
        calibratedConfidence: clamp(Math.round(calibrated), 40, 95),
        reliability,
        note: reliability === '良好' ? '置信度与历史命中率吻合'
            : reliability === '偏高' ? '历史命中率低于声明置信度，已自动校准下调'
                : '历史命中率高于声明置信度，置信度偏保守'
    };
}

// ---------- 编排入口：主预测 / 基金预测共用 ----------
// 入参：{ klines, type, vix, fearGreed, factors, W, baseRaw, key }
// 返回：{ finalRaw, statPred, weights, models, shap, calibration, regime }
function assemble(opts) {
    const { klines, type, vix, fearGreed, factors, W, baseRaw, key } = opts;
    const baseConf = (opts.confidence != null ? opts.confidence : 70);
    const stats = accuracy.stats(key);
    const weights = blendWeights(stats, key);
    const statPred = statisticalModel(klines, type, vix, fearGreed);
    let finalRaw = blendedPredictions(baseRaw, statPred, weights.model);
    // 稳定性：双基模型方向分歧 → 向 0 收缩 + 下调置信度
    const hedged = hedgeByDisagreement(baseRaw, statPred, finalRaw, baseConf);
    finalRaw = hedged.predictions;
    const hedgedConf = hedged.confidence;
    // 稳定性：按波动率封顶，抑制极端离群预测
    finalRaw = clampByVol(finalRaw, klines);
    const shap = attribution(factors, W);
    const regime = factorRegime(klines, vix, fearGreed, type);
    const cal = calibration(hedgedConf, stats);

    const models = {
        baseModels: ['多因子加权模型', '统计回归模型(动量+均值回归+regime)'],
        weights: { model: weights.model, statistical: weights.statistical },
        adaptive: (stats && stats['1D'] && stats['1D'].samples >= 5)
    };

    // 稳定性评级：分歧越少越稳
    const level = hedged.disagree === 0 ? '高' : hedged.disagree === 1 ? '中' : '低';

    return {
        finalRaw, statPred, weights, models, shap, calibration: cal, regime,
        stability: { disagree: hedged.disagree, level, confidenceAfterHedge: hedgedConf }
    };
}

module.exports = {
    assemble, statisticalModel, blendWeights, blendedPredictions,
    attribution, calibration, factorRegime, riskAppetite, volOf
};
