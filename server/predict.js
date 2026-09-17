// AI多因子走势预测引擎
// 综合因子：技术面（趋势/动量/RSI/MACD/布林带/KDJ）+ 量能 + 资金面（北向/两融/主力资金）
// + 情绪面（涨跌家数/恐慌贪婪/VIX/新闻情绪）+ 领先指标（A50期货）+ 跨市场（美元指数/人民币汇率）
// 所有因子打分区间 [-100, +100]，加权合成为综合评分，再映射为分周期预测涨跌幅
const ds = require('./data-source');
const cache = require('./cache');
const accuracy = require('./accuracy');
const ensemble = require('./ensemble');

// ========== 技术指标计算 ==========

// K线日期标签：腾讯K线/基金净值为date字符串，Binance系(加密/黄金PAXG)为openTime毫秒时间戳
function klineDateLabel(k) {
    if (k.date) return k.date;
    if (k.openTime != null) return new Date(Number(k.openTime)).toISOString().substring(0, 10);
    return null;
}

function sma(closes, n) {
    if (closes.length < n) return null;
    let sum = 0;
    for (let i = closes.length - n; i < closes.length; i++) sum += closes[i];
    return sum / n;
}

function rsi(closes, period = 14) {
    if (closes.length < period + 1) return null;
    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff > 0) gains += diff; else losses -= diff;
    }
    if (gains + losses === 0) return 50;
    const rs = (gains / period) / (losses / period);
    return 100 - 100 / (1 + rs);
}

function macd(closes) {
    if (closes.length < 30) return null;
    const ema = (data, n) => {
        const k = 2 / (n + 1);
        let e = data[0];
        for (let i = 1; i < data.length; i++) e = data[i] * k + e * (1 - k);
        return e;
    };
    // 用后30根计算，保证近期权重
    const data = closes.slice(-30);
    const dif = ema(data, 12) - ema(data, 26);
    const difPrev = ema(data.slice(0, -1), 12) - ema(data.slice(0, -1), 26);
    const deaNow = ema(data, 9);
    return { dif, difPrev, dea: deaNow, hist: dif - deaNow };
}

function atrPct(klines, n = 14) {
    if (klines.length < n + 1) return 0.02;
    let sum = 0;
    for (let i = klines.length - n; i < klines.length; i++) {
        const prevClose = klines[i - 1].close;
        const tr = Math.max(
            klines[i].high - klines[i].low,
            Math.abs(klines[i].high - prevClose),
            Math.abs(klines[i].low - prevClose)
        );
        sum += tr;
    }
    return (sum / n) / klines[klines.length - 1].close;   // 日均真实波幅占比
}

// ========== 因子打分（每项 score∈[-100,100]） ==========

// 因子1：均线趋势（多头排列→正分）
function factorTrend(klines) {
    const closes = klines.map(k => k.close);
    const price = closes[closes.length - 1];
    const ma5 = sma(closes, 5);
    const ma20 = sma(closes, 20);
    const ma60 = sma(closes, 60);
    if (!ma20 || closes.length < 20) return { name: '均线趋势', group: '技术面', score: 0, detail: '数据不足，不参与评分' };

    let score = 0;
    const parts = [];
    if (ma5 && ma20) {
        const gap = (ma5 - ma20) / ma20 * 100;
        score += Math.max(-50, Math.min(50, gap * 40));
        parts.push(gap >= 0 ? 'MA5在MA20上方' : 'MA5在MA20下方');
    }
    if (ma60) {
        const above = price > ma60;
        score += above ? 25 : -25;
        parts.push(above ? '价格站上60日线' : '价格低于60日线');
    }
    return {
        name: '均线趋势', group: '技术面',
        score: Math.max(-100, Math.min(100, score)),
        detail: parts.join('，')
    };
}

// 因子2：动量（近5/20日涨跌幅，强者恒强+短期过度延伸惩罚）
function factorMomentum(klines) {
    const closes = klines.map(k => k.close);
    if (closes.length < 21) return { name: '短期动量', group: '技术面', score: 0, detail: '数据不足' };
    const price = closes[closes.length - 1];
    const ret5 = (price / closes[closes.length - 6] - 1) * 100;
    const ret20 = (price / closes[closes.length - 21] - 1) * 100;

    let score = ret5 * 12 + ret20 * 4;
    // 短期涨跌过猛（>6%或<-6%）叠加均值回归惩罚
    if (ret5 > 6) score -= 25;
    if (ret5 < -6) score += 20;
    return {
        name: '短期动量', group: '技术面',
        score: Math.max(-100, Math.min(100, score)),
        detail: `近5日${ret5.toFixed(2)}%，近20日${ret20.toFixed(2)}%`
    };
}

// 因子3：RSI（超买回调压力/超卖反弹动力，属反向因子）
function factorRsi(klines) {
    const closes = klines.map(k => k.close);
    const r = rsi(closes, 14);
    if (r === null) return { name: 'RSI强弱', group: '技术面', score: 0, detail: '数据不足' };
    // RSI>70超买→负分；<30超卖→正分；40-60中性
    let score;
    if (r >= 70) score = -(r - 70) * 4 - 10;
    else if (r <= 30) score = (30 - r) * 4 + 10;
    else score = (r - 50) * 1.2;   // 中性区轻微跟随
    return {
        name: 'RSI强弱', group: '技术面',
        score: Math.max(-100, Math.min(100, score)),
        detail: `RSI14=${r.toFixed(1)}` + (r >= 70 ? '（超买，回调风险）' : r <= 30 ? '（超卖，反弹动能）' : '')
    };
}

// 因子4：MACD（金叉/死叉 + 动能柱）
function factorMacd(klines) {
    const closes = klines.map(k => k.close);
    const m = macd(closes);
    if (!m) return { name: 'MACD动能', group: '技术面', score: 0, detail: '数据不足' };
    let score = 0;
    const parts = [];
    if (m.dif > m.dea) { score += 30; parts.push('DIF在DEA上方（多头）'); }
    else { score -= 30; parts.push('DIF在DEA下方（空头）'); }
    if (m.dif > m.difPrev) { score += 20; parts.push('动能增强'); }
    else { score -= 20; parts.push('动能减弱'); }
    return {
        name: 'MACD动能', group: '技术面',
        score: Math.max(-100, Math.min(100, score)),
        detail: parts.join('，')
    };
}

// 因子5：量能（量比+量价配合）
function factorVolume(klines) {
    const vols = klines.map(k => k.volume || 0).filter(v => v > 0);
    if (vols.length < 25) return { name: '量能配合', group: '量能', score: 0, detail: '成交量数据不足' };
    const recent5 = vols.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const base20 = vols.slice(-20).reduce((a, b) => a + b, 0) / 20;
    if (base20 === 0) return { name: '量能配合', group: '量能', score: 0, detail: '成交量数据不足' };

    const volRatio = recent5 / base20;
    const closes = klines.map(k => k.close);
    const ret5 = closes.length >= 6 ? (closes[closes.length - 1] / closes[closes.length - 6] - 1) : 0;

    let score = 0;
    const parts = [`5日均量/20日均量=${volRatio.toFixed(2)}`];
    if (volRatio > 1.15) {
        // 放量：上涨放量=资金进场；下跌放量=恐慌抛售
        score += ret5 >= 0 ? 45 : -45;
        parts.push(ret5 >= 0 ? '上涨放量，资金进场' : '下跌放量，抛压明显');
    } else if (volRatio < 0.85) {
        // 缩量：上涨缩量=动力不足；下跌缩量=抛压衰竭
        score += ret5 >= 0 ? -15 : 25;
        parts.push(ret5 >= 0 ? '上涨缩量，追高意愿弱' : '下跌缩量，抛压衰竭');
    } else {
        score += ret5 >= 0 ? 10 : -10;
        parts.push('量能温和');
    }
    return {
        name: '量能配合', group: '量能',
        score: Math.max(-100, Math.min(100, score)),
        detail: parts.join('，')
    };
}

// 因子6：市场宽度（A股涨跌家数，仅A股指数使用）
function factorBreadth(breadth) {
    if (!breadth) return null;
    let score = breadth.breadth * 120;
    let detail = `上涨${breadth.up}家/下跌${breadth.down}家`;
    if (breadth.limitUp > breadth.limitDown * 2) { score += 15; detail += `，涨停${breadth.limitUp}家`; }
    if (breadth.limitDown > breadth.limitUp * 2) { score -= 15; detail += `，跌停${breadth.limitDown}家`; }
    return {
        name: '市场宽度', group: '情绪面',
        score: Math.max(-100, Math.min(100, score)),
        detail
    };
}

// 因子7：北向资金（仅A股指数使用，机构风向标）
function factorNorthBound(nb) {
    if (!nb || !nb.active) return null;
    // 单日净流入通常±100亿内：净流入50亿→+55分，净流出50亿→-55分
    const score = Math.max(-100, Math.min(100, nb.dayNetIn * 1.1));
    return {
        name: '北向资金', group: '资金面',
        score,
        detail: `当日北向净流入${nb.dayNetIn.toFixed(1)}亿元`
    };
}

// 因子8：恐慌贪婪指数（反向指标，主要服务加密货币/黄金）
function factorFearGreed(fg) {
    if (!fg) return null;
    // >70极度贪婪→逆向看空；<30恐慌→逆向看多；中间跟随
    let score;
    let tag = '';
    if (fg.value >= 70) { score = -(fg.value - 70) * 2.2 - 10; tag = '市场贪婪，警惕回调'; }
    else if (fg.value <= 30) { score = (30 - fg.value) * 2.2 + 10; tag = '市场恐慌，存在反弹机会'; }
    else { score = (fg.value - 50) * 0.9; }
    return {
        name: '恐慌贪婪指数', group: '情绪面',
        score: Math.max(-100, Math.min(100, score)),
        detail: `当前${fg.value}（${fg.classification}）` + (tag ? '，' + tag : '')
    };
}

// 因子9：标的自身涨跌幅均值回归（当日涨跌过猛时的反向修正）
function factorMeanReversion(quote) {
    if (!quote || quote.changePercent === undefined) return null;
    const chg = quote.changePercent;
    if (Math.abs(chg) < 0.8) return null;   // 波动不大时不计分
    const score = -chg * 14;
    return {
        name: '乖离修正', group: '情绪面',
        score: Math.max(-100, Math.min(100, score)),
        detail: `当日${chg >= 0 ? '涨' : '跌'}${Math.abs(chg).toFixed(2)}%，短期存在${chg >= 0 ? '回吐' : '修复'}需求`
    };
}

// 因子10：布林带位置（上轨外超买回调/下轨外超卖反弹）
function factorBollinger(klines) {
    const closes = klines.map(k => k.close);
    if (closes.length < 20) return { name: '布林带位置', group: '技术面', score: 0, detail: '数据不足' };
    const data = closes.slice(-20);
    const mid = data.reduce((a, b) => a + b, 0) / 20;
    const std = Math.sqrt(data.reduce((s, c) => s + (c - mid) * (c - mid), 0) / 20);
    if (std === 0) return { name: '布林带位置', group: '技术面', score: 0, detail: '波动为零' };
    const price = data[data.length - 1];
    const pos = (price - mid) / (2 * std);   // -1下轨 ~ +1上轨
    let score;
    if (pos >= 1) { score = -40 - Math.min(30, (pos - 1) * 30); }
    else if (pos <= -1) { score = 40 + Math.min(30, (-pos - 1) * 30); }
    else { score = pos * 18; }
    const zone = pos >= 1 ? '上轨外' : pos <= -1 ? '下轨外' : pos > 0 ? '中轨上方' : '中轨下方';
    return {
        name: '布林带位置', group: '技术面',
        score: Math.max(-100, Math.min(100, score)),
        detail: `价格处于布林带${zone}（位置${pos.toFixed(2)}）` + (pos >= 1 ? '，超买回调压力' : pos <= -1 ? '，超卖反弹动能' : '')
    };
}

// 因子11：KDJ随机指标（金叉死叉+超买超卖）
function factorKdj(klines) {
    const closes = klines.map(k => k.close);
    if (klines.length < 12) return { name: 'KDJ随机', group: '技术面', score: 0, detail: '数据不足' };
    let prevK = 50, prevD = 50, k = 50, d = 50;
    for (let i = 8; i < klines.length; i++) {
        const win = klines.slice(i - 8, i + 1);
        const hh = Math.max(...win.map(w => w.high));
        const ll = Math.min(...win.map(w => w.low));
        const rsv = hh === ll ? 50 : (closes[i] - ll) / (hh - ll) * 100;
        prevK = k; prevD = d;
        k = rsv / 3 + prevK * 2 / 3;
        d = k / 3 + prevD * 2 / 3;
    }
    let score = 0;
    const parts = [];
    if (k > 80) { score -= 35; parts.push('超买'); }
    else if (k < 20) { score += 35; parts.push('超卖'); }
    if (k > d && prevK <= prevD) { score += 25; parts.push('金叉'); }
    else if (k < d && prevK >= prevD) { score -= 25; parts.push('死叉'); }
    else { score += k > d ? 10 : -10; parts.push(k > d ? 'K在D上方' : 'K在D下方'); }
    return {
        name: 'KDJ随机', group: '技术面',
        score: Math.max(-100, Math.min(100, score)),
        detail: parts.join('，') + `（K=${k.toFixed(0)}, D=${d.toFixed(0)}）`
    };
}

// 因子12：A50期货动量（境外交易的A股领先指标）
function factorA50(a50) {
    if (!a50) return null;
    const score = Math.max(-100, Math.min(100, a50.changePct * 30));
    return {
        name: 'A50期货', group: '领先指标', score,
        detail: `富时A50期货${a50.changePct >= 0 ? '涨' : '跌'}${Math.abs(a50.changePct).toFixed(2)}%`
    };
}

// 因子13：两融杠杆资金（融资净买入为顺周期放大器）
function factorMargin(mt) {
    if (!mt) return null;
    // 融资净买入日常波动±60亿，极端日±200亿；系数1.2使-80亿≈-96分，-61亿≈-73分
    const score = Math.max(-100, Math.min(100, mt.rzjme * 1.2));
    return {
        name: '两融杠杆', group: '资金面', score,
        detail: `最新融资净买入${mt.rzjme.toFixed(1)}亿元（${mt.date}）`
    };
}

// 因子14：主力资金流（沪市大单实时净流入）
function factorMainFlow(mf) {
    if (!mf) return null;
    const score = Math.max(-100, Math.min(100, mf.mainIn * 0.45));
    // 东财分钟线时间形如"2026-08-31 14:55"，稳健提取时分
    const tm = String(mf.time || '').match(/(\d{2}):(\d{2})/);
    const timeStr = tm ? tm[1] + ':' + tm[2] : '';
    return {
        name: '主力资金', group: '资金面', score,
        detail: `沪市主力净流入${mf.mainIn.toFixed(1)}亿元` + (timeStr ? `（截至${timeStr}）` : '')
    };
}

// 因子15：VIX波动率（全球风险偏好；黄金为避险资产反向受益）
function factorVix(vix, type) {
    if (!vix) return null;
    let score, detail;
    if (vix.value >= 28) {
        detail = `VIX=${vix.value}（恐慌区间），风险资产承压`;
        score = type === 'gold' ? (vix.value - 28) * 2 + 15 : -(vix.value - 28) * 3 - 10;
        if (type === 'gold') detail += '，避险买盘利好黄金';
    } else if (vix.value <= 14) {
        detail = `VIX=${vix.value}（低波动），风险偏好回暖`;
        score = type === 'gold' ? -(14 - vix.value) * 1.2 - 5 : (14 - vix.value) * 2 + 8;
        if (type === 'gold') detail += '，避险需求减弱';
    } else {
        score = (20 - vix.value) * 1.5;
        detail = `VIX=${vix.value}（中性区间）`;
    }
    return { name: 'VIX波动率', group: '情绪面', score: Math.max(-100, Math.min(100, score)), detail };
}

// 因子16：美元指数（黄金/加密以美元计价，强美元为反向压力）
function factorDollar(dxy, type) {
    if (!dxy || (type !== 'gold' && type !== 'crypto')) return null;
    const score = Math.max(-100, Math.min(100, -dxy.changePct * 60));
    return {
        name: '美元指数', group: '跨市场', score,
        detail: `美元指数${dxy.changePct >= 0 ? '涨' : '跌'}${Math.abs(dxy.changePct).toFixed(2)}%`
    };
}

// 因子17：离岸人民币（升值→外资流入偏好A股）
function factorCnh(cnh) {
    if (!cnh) return null;
    // 报价下跌=人民币升值 → 正分
    const score = Math.max(-100, Math.min(100, -cnh.changePct * 120));
    return {
        name: '人民币汇率', group: '跨市场', score,
        detail: `离岸人民币${cnh.changePct <= 0 ? '升值' : '贬值'}${Math.abs(cnh.changePct).toFixed(2)}%`
    };
}

// 因子18：新闻情绪（标题关键词NLP情感分析；只用真实新闻，过滤模拟数据）
const NEWS_POS_WORDS = ['上涨', '涨', '升', '新高', '突破', '利好', '增长', '获批', '回购', '增持', '牛市', '反弹', '宽松', '降息', '降准', '减税', '回暖', '盈利', '超预期', '改革', '刺激', '纾困', '企稳', '复苏', '净买入', '流入', '涨停', '封板', '拉升', '冲高', '走高', '大涨', '飙升', '走强', '跟涨', '领涨', '反攻', '抢筹'];
const NEWS_NEG_WORDS = ['下跌', '跌', '新低', '跌破', '利空', '下滑', '违约', '危机', '风险', '熊市', '暴跌', '亏损', '减持', '收紧', '加息', '贸易战', '制裁', '警告', '担忧', '熔断', '退市', '调查', '处罚', '抛售', '流出', '崩', '跌停', '跳水', '大跌', '下挫', '走低', '回落', '走弱', '杀跌', '重挫', '净卖出', '撤离', '破发'];

function factorNewsSentiment(news) {
    if (!Array.isArray(news)) return null;
    // 只统计真实新闻（模拟新闻url为'#'）
    const realNews = news.filter(n => n && n.title && n.url && n.url !== '#');
    if (realNews.length === 0) return null;

    // 否定词检测：关键词前 3 字内出现否定词则翻转情感（"不涨"/"未突破"/"无利好"等）
    const NEG_PREFIX = ['不', '未', '无', '没', '非', '否', '难', '缺乏', '放缓', '回落'];
    function scoreTitle(title) {
        let total = 0;
        const scan = (words, sign) => {
            words.forEach(w => {
                let idx = title.indexOf(w);
                while (idx >= 0) {
                    const before = title.substring(Math.max(0, idx - 3), idx);
                    const negated = NEG_PREFIX.some(nw => before.includes(nw));
                    total += negated ? -sign : sign;
                    idx = title.indexOf(w, idx + w.length);
                }
            });
        };
        scan(NEWS_POS_WORDS, 1);
        scan(NEWS_NEG_WORDS, -1);
        return total;
    }

    let posScore = 0, negScore = 0;
    realNews.forEach(n => {
        const weight = n.impact === 'high' ? 2 : 1;
        const s = scoreTitle(n.title);
        if (s > 0) posScore += weight;
        else if (s < 0) negScore += weight;
    });
    const total = posScore + negScore;
    if (total === 0) {
        return { name: '新闻情绪', group: '情绪面', score: 0, detail: `分析${realNews.length}条真实新闻，情绪中性` };
    }
    const score = Math.round((posScore - negScore) / total * 60);
    return {
        name: '新闻情绪', group: '情绪面', score,
        detail: `分析${realNews.length}条新闻：利好${posScore}/利空${negScore}，情绪${score > 0 ? '偏多' : score < 0 ? '偏空' : '中性'}`
    };
}

// ========== 支撑/压力位（近20根K线高低点） ==========

function keyLevels(klines) {
    const recent = klines.slice(-20);
    if (recent.length === 0) return { support: null, resistance: null };
    const closes = recent.map(k => k.close);
    const price = closes[closes.length - 1];
    const lows = recent.map(k => k.low).filter(v => v > 0);
    const highs = recent.map(k => k.high).filter(v => v > 0);
    const maxHigh = Math.max(...highs);
    const minLow = Math.min(...lows);
    return {
        support: +Math.min(minLow, price).toFixed(2),
        resistance: +Math.max(maxHigh, price).toFixed(2)
    };
}

// ========== 综合预测 ==========

const FACTOR_WEIGHTS = {
    // 技术面
    '均线趋势': 0.12,
    '短期动量': 0.10,
    'RSI强弱': 0.06,
    'MACD动能': 0.08,
    '布林带位置': 0.05,
    'KDJ随机': 0.05,
    // 量能
    '量能配合': 0.10,
    // 资金面
    '北向资金': 0.08,
    '两融杠杆': 0.05,
    '主力资金': 0.07,
    // 情绪面
    '市场宽度': 0.08,
    '恐慌贪婪指数': 0.06,
    'VIX波动率': 0.04,
    '新闻情绪': 0.06,
    // 领先指标
    'A50期货': 0.07,
    // 跨市场
    '美元指数': 0.04,
    '人民币汇率': 0.04,
    // 修正项
    '乖离修正': 0.04,
    // 基金维度（仅fund类型使用）
    '重仓股动向': 0.14,
    '持仓集中度': 0.05,
    '基金经理': 0.07,
    '基金质地': 0.05
};

// 分类型权重：指数/基金沿用基础权重；加密/黄金按资产特性重新平衡
// （加密更吃动量/量能/恐慌贪婪；黄金更吃 VIX/美元/恐慌贪婪，趋势权重略降）
const TYPE_WEIGHTS = {
    crypto: Object.assign({}, FACTOR_WEIGHTS, {
        '短期动量': 0.12, 'MACD动能': 0.10, '量能配合': 0.12, '布林带位置': 0.06,
        'KDJ随机': 0.06, '恐慌贪婪指数': 0.10
    }),
    gold: Object.assign({}, FACTOR_WEIGHTS, {
        'VIX波动率': 0.07, '美元指数': 0.07, '恐慌贪婪指数': 0.09,
        '均线趋势': 0.10, '短期动量': 0.08, 'RSI强弱': 0.05
    })
};
function getWeights(type) {
    if (type === 'crypto') return TYPE_WEIGHTS.crypto;
    if (type === 'gold') return TYPE_WEIGHTS.gold;
    return FACTOR_WEIGHTS;   // index / fund
}

// 预测区间（±1σ）：基于波动率按周期缩放
function buildIntervals(preds, vol) {
    const scale = { '1D': 0.9, '1W': 1.1 * Math.sqrt(5), '1M': 1.2 * Math.sqrt(22) };
    const out = {};
    ['1D', '1W', '1M'].forEach(h => {
        const sd = vol * scale[h] * 100;
        const p = preds[h];
        out[h] = [+(p - sd).toFixed(2), +(p + sd).toFixed(2)];
    });
    return out;
}

async function predict(code, type = 'index', opts = {}) {
    // 分类型权重
    const W = getWeights(type);
    // 1. K线：日线优先（因子需≥20根），不足时用周线，估算K线不算技术因子
    let klines = [];
    let klineSources = [];
    const tryKline = async (fetcher, tag) => {
        try {
            const r = await fetcher();
            if (r && r.data && r.data.length >= 20) {
                klines = r.data;
                klineSources.push(tag || r.source);
                return true;
            }
        } catch (e) { /* 降级 */ }
        return false;
    };
    if (type === 'crypto') {
        await tryKline(() => ds.getCryptoKline(code, '1d', 90));
    } else if (type === 'gold') {
        if (!await tryKline(() => ds.getGoldKline('1M'))) {
            await tryKline(() => ds.getGoldKline('1Y'));
        }
    } else {
        if (!await tryKline(() => ds.getIndexKline(code, '1M'))) {
            await tryKline(() => ds.getIndexKline(code, '1Y'), 'tencent(周线)');
        }
    }
    const isEstimatedKline = klineSources.some(s => /estimated|估算/.test(s));

    // 2. 实时行情
    let quote = null;
    try {
        if (type === 'crypto') {
            const { data } = await ds.getCryptoTicker([code]);
            if (data && data[code]) quote = { price: data[code].price, changePercent: data[code].changePercent, volume: data[code].quoteVolume };
        } else if (type === 'gold') {
            const g = await ds.getGoldPrice();
            quote = { price: g.price, changePercent: g.changePercent, volume: 0 };
        } else {
            const { data } = await ds.getIndexQuotes([code]);
            if (data && data[code]) quote = data[code];
        }
    } catch (e) { /* ignore */ }

    // 3. 市场情绪与资金数据（A股指数用涨跌家数+北向；加密/黄金用恐慌贪婪指数）
    const isChinaRelated = type === 'index' && (code.endsWith('.SH') || code.endsWith('.SZ'));
    const [breadth, northBound, fearGreed] = await Promise.all([
        isChinaRelated ? ds.getMarketBreadth().catch(() => null) : Promise.resolve(null),
        isChinaRelated ? ds.getNorthBoundFlow().catch(() => null) : Promise.resolve(null),
        (type === 'crypto' || type === 'gold') ? ds.getFearGreedIndex().catch(() => null) : Promise.resolve(null)
    ]);

    // 3.5 新增因子数据：领先指标（A50）+ 杠杆/主力资金 + 跨市场（VIX/美元/人民币）+ 新闻
    // 新闻优先用新浪7x24市场快讯（关键词密度高），失败再退回普通财经滚动新闻；均为5分钟缓存
    const [a50, margin, flow, vix, dxy, cnh, marketNews, rollNews] = await Promise.all([
        isChinaRelated ? ds.getA50Futures().catch(() => null) : Promise.resolve(null),
        isChinaRelated ? ds.getMarginTrading().catch(() => null) : Promise.resolve(null),
        isChinaRelated ? ds.getMainFundFlow().catch(() => null) : Promise.resolve(null),
        ds.getVixIndex().catch(() => null),
        (type === 'gold' || type === 'crypto') ? ds.getDollarIndex().catch(() => null) : Promise.resolve(null),
        isChinaRelated ? ds.getCnhRate().catch(() => null) : Promise.resolve(null),
        cache.getOrFetch('market_news_7x24', 300, () => ds.getMarketNews(30)).catch(() => null),
        cache.getOrFetch('news_all', 300, () => ds.getFinanceNews('all')).catch(() => null)
    ]);
    const news = (marketNews && marketNews.length > 0) ? marketNews : rollNews;

    // 4. 因子计算（估算K线是随机模拟，技术因子无意义则跳过）
    const factors = [];
    if (klines.length >= 20 && !isEstimatedKline) {
        factors.push(factorTrend(klines));
        factors.push(factorMomentum(klines));
        factors.push(factorRsi(klines));
        factors.push(factorMacd(klines));
        factors.push(factorVolume(klines));
        factors.push(factorBollinger(klines));
        factors.push(factorKdj(klines));
    } else {
        factors.push({ name: '技术因子', group: '技术面', score: 0, detail: isEstimatedKline ? '暂无真实K线，技术面不评分' : 'K线数据不足，技术面暂不评分' });
    }
    const fb = factorBreadth(breadth); if (fb) factors.push(fb);
    const fnb = factorNorthBound(northBound); if (fnb) factors.push(fnb);
    // 北向资金接口返回但当日未更新（收盘后/停市）时给出说明，保证资金面维度可见
    if (northBound && !northBound.active && isChinaRelated) {
        factors.push({ name: '北向资金', group: '资金面', score: 0, detail: '北向资金当日数据未更新，暂不计分' });
    }
    const ffg = factorFearGreed(fearGreed); if (ffg) factors.push(ffg);
    const fmr = factorMeanReversion(quote); if (fmr) factors.push(fmr);
    const fa50 = factorA50(a50); if (fa50) factors.push(fa50);
    const fmargin = factorMargin(margin); if (fmargin) factors.push(fmargin);
    const fflow = factorMainFlow(flow); if (fflow) factors.push(fflow);
    const fvix = factorVix(vix, type); if (fvix) factors.push(fvix);
    const fdxy = factorDollar(dxy, type); if (fdxy) factors.push(fdxy);
    const fcnh = factorCnh(cnh); if (fcnh) factors.push(fcnh);
    const fnews = factorNewsSentiment(news); if (fnews) factors.push(fnews);

    // 4.5 数据质量：识别因数据源不可用而整组缺失的因子（海外沙箱东财被墙时，A股资金面整组失效）
    const hasCapital = !!(fnb || fmargin || fflow);
    const hasBreadth = !!fb;
    const hasSentiment = !!ffg;
    const missingGroups = [];
    if (isChinaRelated) {
        if (!hasCapital) missingGroups.push('资金面(北向/两融/主力)');
        if (!hasBreadth) missingGroups.push('市场宽度(涨跌家数)');
    }
    if ((type === 'crypto' || type === 'gold') && !hasSentiment) missingGroups.push('情绪面(恐慌贪婪)');

    // 5. 加权综合（缺失因子自动权重归一化）
    let weightedSum = 0;
    let weightSum = 0;
    factors.forEach(f => {
        const w = W[f.name] || 0.05;
        weightedSum += f.score * w;
        weightSum += w;
    });
    const score = weightSum > 0 ? Math.round(weightedSum / weightSum) : 0;

    // 6. 方向与置信度
    const direction = score > 15 ? 'bullish' : score < -15 ? 'bearish' : 'shock';
    const directionText = direction === 'bullish' ? '看涨' : direction === 'bearish' ? '看跌' : '震荡';
    // 置信度 = 因子方向一致度(0-60) + 数据维度完整度(0-40)
    const signedFactors = factors.filter(f => Math.abs(f.score) > 1);
    let agree = 0;
    signedFactors.forEach(f => { if (Math.sign(f.score) === Math.sign(score)) agree += W[f.name] || 0.05; });
    const totalWeight = signedFactors.reduce((s, f) => s + (W[f.name] || 0.05), 0);
    const consistency = totalWeight > 0 ? agree / totalWeight : 0.5;
    // 数据维度完整度：K线/宽度/北向/恐慌贪婪/行情 + 新增（A50/两融/主力/VIX/美元/人民币/新闻）
    const dims = (klines.length >= 25 ? 1 : 0) + (breadth ? 1 : 0) + (northBound && northBound.active ? 1 : 0) + (fearGreed ? 1 : 0) + (quote ? 1 : 0)
        + (a50 ? 1 : 0) + (margin ? 1 : 0) + (flow ? 1 : 0) + (vix ? 1 : 0) + (dxy ? 1 : 0) + (cnh ? 1 : 0) + (fnews ? 1 : 0);
    const confidence = Math.round(Math.min(92, 40 + consistency * 45 + Math.min(28, dims * 3)));
    const dataQuality = { missing: missingGroups, note: missingGroups.length ? '部分因子因数据源不可用而缺失，预测置信度已相应下调' : '因子数据完整' };

    // 7. 分周期预测涨跌幅（基于评分×波动率；评分经 tanh 压缩，避免极端值线性放大给出生硬大涨大跌）
    const vol = Math.max(0.006, Math.min(0.09, atrPct(klines, 14)));
    const sComp = Math.tanh(score / 100);
    const raw1D = sComp * vol * 0.9 * 100;
    const raw1W = sComp * vol * Math.sqrt(5) * 1.1 * 100;
    const raw1M = sComp * vol * Math.sqrt(22) * 1.2 * 100;
    let predictions = {
        '1D': +clampPct(raw1D, 3).toFixed(2),
        '1W': +clampPct(raw1W, 8).toFixed(2),
        '1M': +clampPct(raw1M, 15).toFixed(2)
    };

    // 7.4 集成增强（六层框架）：堆叠第二基模型(统计回归) + 自适应权重融合 + SHAP 归因 + 置信度校准
    const ensembleResult = ensemble.assemble({
        klines, type, vix, fearGreed, factors, W,
        baseRaw: predictions, confidence, key: `${type}|${code}`
    });
    // 市场regime因子并入因子列表（展示 + SHAP 归因），不进入主模型加权以免动摇已验证基线
    factors.push(ensembleResult.regime);
    predictions = ensembleResult.finalRaw;

    // 7.5 昨日对比 + 累计数据校正（仅真实K线参与结算，估算K线无结算意义）
    let accResult = null;
    let finalConfidence = confidence;
    if (klines.length >= 2 && !isEstimatedKline && !opts.noCalibrate) {
        accResult = accuracy.process({
            key: `${type}|${code}`,
            klines: klines.slice(-90),
            predictions, confidence, score, direction
        });
        if (accResult) {
            predictions['1D'] = +clampPct(accResult.predictions['1D'], 3).toFixed(2);
            predictions['1W'] = +clampPct(accResult.predictions['1W'], 8).toFixed(2);
            predictions['1M'] = +clampPct(accResult.predictions['1M'], 15).toFixed(2);
            finalConfidence = accResult.confidence;
        }
    }
    // 缺失整组因子 → 置信度惩罚性下调（最多15分），保证诚实
    if (missingGroups.length) finalConfidence = Math.max(30, finalConfidence - Math.min(15, missingGroups.length * 5));
    // 集成增强：双基模型方向分歧 → 按同一折扣比例下调置信度（与 predictions 的向0收缩一致）
    if (ensembleResult.stability && ensembleResult.stability.disagree > 0 && confidence > 0) {
        const disc = ensembleResult.stability.confidenceAfterHedge / confidence;
        if (isFinite(disc) && disc > 0) finalConfidence = Math.round(finalConfidence * disc);
    }

    // 7.6 预测区间（±1σ，基于波动率按周期缩放）
    const intervals = buildIntervals(predictions, vol);

    // 8. 支撑压力位 + 数据来源
    const levels = klines.length > 0 ? keyLevels(klines) : { support: null, resistance: null };
    const dataSources = [];
    const klineSrc = klineSources.join(',');
    if (/tencent/.test(klineSrc)) dataSources.push('腾讯财经');
    if (/sina/.test(klineSrc)) dataSources.push('新浪财经');
    if (/binance|gate\.io|PAXG/i.test(klineSrc)) dataSources.push('Binance/Gate.io');
    if (/estimated|估算/.test(klineSrc)) dataSources.push('历史行情估算');
    if (breadth) dataSources.push('东方财富(涨跌家数)');
    if (northBound && northBound.active) dataSources.push('东方财富(北向资金)');
    if (fearGreed) dataSources.push('Alternative.me(恐慌贪婪)');
    if (a50) dataSources.push('新浪财经(A50期货)');
    if (margin) dataSources.push('东方财富(两融数据)');
    if (flow) dataSources.push('东方财富(主力资金)');
    if (vix) dataSources.push('新浪财经(VIX)');
    if (dxy) dataSources.push('新浪财经(美元指数)');
    if (cnh) dataSources.push('新浪财经(离岸人民币)');
    if (fnews) dataSources.push(marketNews && marketNews.length > 0 ? '新浪7x24(新闻情绪)' : '新浪财经(新闻情绪)');
    if (dataSources.length === 0) dataSources.push('实时行情');

    // 9. 预测路径（前端画图用：历史收盘+外推价格）
    const historyCloses = klines.slice(-40).map(k => k.close);
    const historyDates = klines.slice(-40).map(klineDateLabel);
    let lastPrice = quote ? quote.price : (historyCloses.length ? historyCloses[historyCloses.length - 1] : null);
    let predPath = null;
    if (lastPrice) {
        // 用1M预测涨跌幅平滑外推
        const totalChange = predictions['1M'] / 100;
        const dates = [];
        const prices = [];
        const now = new Date();
        for (let i = 1; i <= 12; i++) {
            prices.push(+(lastPrice * (1 + totalChange * i / 12)).toFixed(2));
            const d = new Date(now);
            d.setDate(d.getDate() + i * 2);
            dates.push(d.toISOString().substring(0, 10));
        }
        predPath = { dates, prices, total: predictions['1M'] };
        lastPrice = +lastPrice.toFixed(2);
    }

    // 因子分组汇总（前端雷达/条形展示）
    const groups = {};
    factors.forEach(f => {
        if (!groups[f.group]) groups[f.group] = { score: 0, weight: 0, items: [] };
        const w = W[f.name] || 0.05;
        groups[f.group].score += f.score * w;
        groups[f.group].weight += w;
        groups[f.group].items.push({ name: f.name, score: +f.score.toFixed(0), detail: f.detail });
    });
    Object.keys(groups).forEach(g => {
        groups[g].score = Math.round(groups[g].score / groups[g].weight);
    });

    return {
        code, type,
        name: type === 'index' ? (ds.INDEX_CONFIG[code] ? ds.INDEX_CONFIG[code].name : code) : code,
        price: lastPrice,
        changePercent: quote && quote.changePercent != null ? +quote.changePercent.toFixed(2) : null,
        score, direction, directionText,
        confidence: finalConfidence,
        predictions,
        intervals,
        dataQuality,
        yesterday: accResult ? accResult.yesterday : null,
        accuracy: accResult ? accResult.accuracy : null,
        corrections: accResult ? accResult.corrections : [],
        support: levels.support,
        resistance: levels.resistance,
        volatility: +(vol * 100).toFixed(2),
        factors: groups,
        factorList: factors.map(f => ({ name: f.name, group: f.group, score: +f.score.toFixed(0), detail: f.detail })),
        // 集成增强产出：堆叠模型权重 / SHAP 因子归因 / 置信度校准 / 稳定性
        models: ensembleResult.models,
        shap: ensembleResult.shap,
        calibration: ensembleResult.calibration,
        stability: ensembleResult.stability,
        history: { dates: historyDates, closes: historyCloses.map(c => +c.toFixed(2)) },
        predPath,
        dataSources,
        sentiment: {
            breadth: breadth ? { up: breadth.up, down: breadth.down, limitUp: breadth.limitUp, limitDown: breadth.limitDown, upRatio: +(breadth.upRatio * 100).toFixed(1) } : null,
            northBound: northBound ? { dayNetIn: +northBound.dayNetIn.toFixed(1), active: northBound.active } : null,
            fearGreed: fearGreed ? { value: fearGreed.value, classification: fearGreed.classification } : null,
            vix: vix ? { value: vix.value, changePct: vix.changePct } : null,
            dollarIndex: dxy ? { price: +dxy.price.toFixed(2), changePct: +dxy.changePct.toFixed(2) } : null,
            cnh: cnh ? { price: +cnh.price.toFixed(4), changePct: +cnh.changePct.toFixed(2) } : null,
            a50: a50 ? { price: +a50.price.toFixed(0), changePct: +a50.changePct.toFixed(2) } : null,
            margin: margin ? { date: margin.date, rzye: +margin.rzye.toFixed(0), rzjme: +margin.rzjme.toFixed(1) } : null,
            mainFlow: flow ? { mainIn: +flow.mainIn.toFixed(1), superLarge: +flow.superLarge.toFixed(1) } : null
        },
        generatedAt: new Date().toISOString()
    };
}

function clampPct(v, max) {
    return Math.max(-max, Math.min(max, v));
}

// ========== 历史回测专用：技术面核心预测（不含实时资金/情绪/新闻因子） ==========
// 用于 backfill 在历史 K 线上"重放"模型：给定截至某日的 K 线切片，复现模型的技术因子评分，
// 并用与线上完全一致（tanh 压缩 + 波动率缩放）映射为 1D/1W/1M 预测。
// 这样校准样本来自真实历史走势，且评分逻辑与线上技术核心同源，校准才有意义。
function computeTechPred(klines, type) {
    const W = getWeights(type);
    if (!Array.isArray(klines) || klines.length < 20) {
        return { predictions: { '1D': 0, '1W': 0, '1M': 0 }, score: 0, direction: 'shock', confidence: 50, vol: 0.01 };
    }
    const factors = [
        factorTrend(klines), factorMomentum(klines), factorRsi(klines), factorMacd(klines),
        factorVolume(klines), factorBollinger(klines), factorKdj(klines)
    ];
    let weightedSum = 0, weightSum = 0;
    factors.forEach(f => { const w = W[f.name] || 0.05; weightedSum += f.score * w; weightSum += w; });
    const score = weightSum > 0 ? Math.round(weightedSum / weightSum) : 0;

    // 波动率：优先用真实高低价 ATR；仅有收盘价（基金净值）时用日收益率标准差
    let vol;
    const last = klines[klines.length - 1];
    if (last.high == null || last.low == null) {
        const rets = [];
        for (let i = 1; i < klines.length; i++) rets.push(klines[i].close / klines[i - 1].close - 1);
        const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
        const v = Math.sqrt(rets.reduce((s, r) => s + (r - mean) * (r - mean), 0) / rets.length);
        vol = Math.max(0.002, Math.min(0.05, isFinite(v) ? v : 0.01));
    } else {
        vol = Math.max(0.006, Math.min(0.09, atrPct(klines, 14)));
    }

    const sComp = Math.tanh(score / 100);
    const raw1D = sComp * vol * 0.9 * 100;
    const raw1W = sComp * vol * Math.sqrt(5) * 1.1 * 100;
    const raw1M = sComp * vol * Math.sqrt(22) * 1.2 * 100;
    const predictions = {
        '1D': +clampPct(raw1D, 3).toFixed(2),
        '1W': +clampPct(raw1W, 8).toFixed(2),
        '1M': +clampPct(raw1M, 15).toFixed(2)
    };
    const direction = score > 15 ? 'bullish' : score < -15 ? 'bearish' : 'shock';
    return { predictions, score, direction, confidence: 70, vol };
}

// ========== 基金预测：净值技术面 + 基准指数多因子融合 ==========
// 基金净值是日频数据（无盘中高低价），技术因子用收盘序列推导；
// 资金/情绪/领先指标无法直接作用于单只基金，由其基准指数的预测因子代理

// 基金→基准指数映射（宽基/主题基金跟踪对应指数）
const FUND_BENCHMARKS = {
    '005827': '000300.SH',
    '161725': '000300.SH',
    '519674': '399006.SZ',
    '110011': 'HSI',
    '001102': '000300.SH',
    '003095': '399006.SZ',
    '000032': '000300.SH',
    '003834': '000300.SH'
};

// 基金类型→融合权重（指数型与基准同步度高，债基基本独立于股市）
const FUND_TYPE_BLENDS = {
    index: { nav: 0.45, bench: 0.55 },   // 指数型：紧密跟踪基准
    stock: { nav: 0.60, bench: 0.40 },   // 股票型：经理风格有偏离
    hybrid: { nav: 0.65, bench: 0.35 },  // 混合型：仓位灵活，独立性更强
    bond: { nav: 0.90, bench: 0.10 }     // 债券型：主要看自身净值趋势
};

function fundNavKlines(fundInfo) {
    // 净值序列 → K线结构（用收盘价近似高低，动量/均线/RSI/MACD均可用）
    return fundInfo.bars.map(b => ({
        date: b.date,
        open: b.close, high: b.close, low: b.close, close: b.close,
        volume: 0
    }));
}

function fundVolatility(bars, n = 20) {
    // 近n日日收益率标准差（年化前的日频值）
    if (bars.length < n + 1) return 0.008;
    const rets = [];
    for (let i = bars.length - n; i < bars.length; i++) {
        rets.push(bars[i].close / bars[i - 1].close - 1);
    }
    const mean = rets.reduce((a, b) => a + b, 0) / n;
    const varr = rets.reduce((s, r) => s + (r - mean) * (r - mean), 0) / n;
    return Math.max(0.0005, Math.sqrt(varr));
}

async function predictFund(code, fundType) {
    const fundInfo = await ds.getFundInfo(code);
    if (!fundInfo) return null;

    const W = getWeights('fund');
    const klines = fundNavKlines(fundInfo);
    const benchmark = FUND_BENCHMARKS[code] || '000300.SH';
    const blends = FUND_TYPE_BLENDS[fundType] || FUND_TYPE_BLENDS.hybrid;

    // 1. 净值技术面因子
    const factors = [];
    factors.push(factorTrend(klines));
    factors.push(factorMomentum(klines));
    factors.push(factorRsi(klines));
    factors.push(factorMacd(klines));
    factors.push(factorBollinger(klines));

    // 2. 基准指数预测（拿它的评分+因子做代理）——只读，不写盘，避免污染基准指数自身的校准数据
    const benchResult = await predict(benchmark, 'index', { noCalibrate: true }).catch(() => null);

    // 3. 持仓维度：前十大重仓实时动向 + 持仓集中度（净值滞后，重仓今日涨跌直接驱动下一净值）
    const holdingsInfo = await ds.getFundHoldings(code).catch(() => null);
    const holdings = (holdingsInfo && Array.isArray(holdingsInfo.holdings)) ? holdingsInfo.holdings : [];
    const stockRatio = fundInfo.assetAllocation ? fundInfo.assetAllocation.stockRatio : null;
    let holdingsFactor = null, intradayEstimate = null, quotes = null;
    if (holdings.length >= 3 && (stockRatio == null || stockRatio > 15)) {
        quotes = await ds.getStockQuotes(holdings).catch(() => null);
        if (quotes) {
            let wsum = 0, wchg = 0, up = 0, down = 0;
            holdings.forEach(h => {
                const q = quotes[h.code];
                if (q && isFinite(q.changePercent)) {
                    wchg += q.changePercent * h.weight;
                    wsum += h.weight;
                    q.changePercent >= 0 ? up++ : down++;
                }
            });
            if (wsum >= 10) {
                const weighted = wchg / wsum;
                holdingsFactor = {
                    name: '重仓股动向', group: '持仓分析',
                    score: Math.round(Math.max(-60, Math.min(60, weighted * 20))),
                    detail: `前十大重仓（合计${wsum.toFixed(1)}%仓位）今日加权${weighted >= 0 ? '涨' : '跌'}${Math.abs(weighted).toFixed(2)}%：涨${up}家/跌${down}家`
                };
                // 盘中净值估算 = 重仓加权涨跌 × 股票仓位（估算基金下一公布净值的当日方向）
                intradayEstimate = +(weighted * ((stockRatio || wsum) / 100)).toFixed(2);
            }
        }
    }
    if (holdingsFactor) factors.push(holdingsFactor);

    if (holdings.length >= 3) {
        const top10 = holdings.reduce((s, h) => s + h.weight, 0);
        const benchChg = benchResult ? benchResult.changePercent : null;
        const amplified = top10 >= 50;
        factors.push({
            name: '持仓集中度', group: '持仓分析',
            score: benchChg != null ? Math.round(Math.max(-40, Math.min(40, benchChg * (amplified ? 8 : 4)))) : 0,
            detail: `前十大合计${top10.toFixed(1)}%${amplified ? '，集中度高，随市场波动放大' : '，持仓分散均衡'}${benchChg != null ? `；基准今日${benchChg >= 0 ? '+' : ''}${benchChg}%` : ''}（${holdingsInfo.date || '最新季报'}）`
        });
    }

    // 4. 基金经理维度：任期收益相对同类超额 + 能力评分 + 星级
    const mgr = fundInfo.manager;
    if (mgr && (mgr.termReturn != null || mgr.powerAvr != null)) {
        const excess = (mgr.termReturn != null && mgr.peerAvg != null) ? mgr.termReturn - mgr.peerAvg : null;
        let mgrScore = 0;
        if (mgr.powerAvr != null) mgrScore += (mgr.powerAvr - 60) * 0.5;
        mgrScore += (mgr.star - 3) * 5;
        if (excess != null) mgrScore += excess / 8;
        factors.push({
            name: '基金经理', group: '基金经理',
            score: Math.round(Math.max(-40, Math.min(40, mgrScore))),
            detail: `${mgr.name}任职${mgr.workTime}${mgr.termReturn != null ? `，任期收益${mgr.termReturn.toFixed(1)}%` : ''}${mgr.peerAvg != null ? `（同类平均${mgr.peerAvg.toFixed(1)}%）` : ''}；管理规模${mgr.fundSize}${mgr.powerAvr != null ? `，能力评分${mgr.powerAvr}` : ''}`
        });
    }

    // 5. 基金质地：业绩评价五维（选证能力/收益率/抗风险/稳定性/择时能力）
    const perf = fundInfo.performance;
    if (perf && perf.avr != null) {
        factors.push({
            name: '基金质地', group: '基金经理',
            score: Math.round(Math.max(-30, Math.min(30, (perf.avr - 60) * 0.8))),
            detail: `业绩评价综合${perf.avr}分（50为同类中位）${perf.categories.length ? '：' + perf.categories.map((c, i) => `${c}${perf.data[i] != null ? Math.round(perf.data[i]) : '--'}`).join('/') : ''}`
        });
    }

    // 6. 加权：净值/持仓/经理等基金自身因子按原权重×navWeight，基准因子整体×benchWeight
    let weightedSum = 0;
    let weightSum = 0;
    factors.forEach(f => {
        const w = (W[f.name] || 0.05) * blends.nav * 2;
        weightedSum += f.score * w;
        weightSum += w;
    });
    if (benchResult) {
        // 基准评分贡献（基准各因子已加权为其score）
        weightedSum += benchResult.score * blends.bench * 2;
        weightSum += blends.bench * 2;
    }
    const score = weightSum > 0 ? Math.round(weightedSum / weightSum) : 0;

    // 7. 方向/置信度：基金自身维度 + 基准维度一致度 + 持仓/经理覆盖度
    const direction = score > 15 ? 'bullish' : score < -15 ? 'bearish' : 'shock';
    const directionText = direction === 'bullish' ? '看涨' : direction === 'bearish' ? '看跌' : '震荡';
    const navScore = (() => {
        let s = 0, w = 0;
        factors.forEach(f => { const fw = W[f.name] || 0.05; s += f.score * fw; w += fw; });
        return w > 0 ? s / w : 0;
    })();
    const navAgree = Math.sign(navScore) === Math.sign(score) && Math.abs(score) > 5;
    const cover = (holdingsFactor ? 1 : 0) + (mgr ? 1 : 0) + (perf && perf.avr != null ? 1 : 0);
    const confidence = Math.round(Math.min(92,
        45 + (navAgree ? 20 : 8) + (benchResult ? 15 : 0) + Math.min(10, factors.length) + cover));

    // 8. 分周期预测：评分 × 基金自身波动率（债基波动小→预测幅度天然收窄）
    const vol = Math.min(0.03, fundVolatility(fundInfo.bars));
    const sComp = Math.tanh(score / 100);
    const raw1D = sComp * vol * 0.9 * 100;
    const raw1W = sComp * vol * Math.sqrt(5) * 1.1 * 100;
    const raw1M = sComp * vol * Math.sqrt(22) * 1.2 * 100;
    let predictions = {
        '1D': +clampPct(raw1D, 2).toFixed(2),
        '1W': +clampPct(raw1W, 6).toFixed(2),
        '1M': +clampPct(raw1M, 12).toFixed(2)
    };
    // 有持仓实时数据时，1D预测融合盘中估算（净值滞后1-2个交易日，重仓动向是最直接的近端信号）
    if (intradayEstimate != null) {
        predictions['1D'] = +clampPct(predictions['1D'] * 0.4 + intradayEstimate * 0.6, 2).toFixed(2);
    }
    // 集成增强（六层框架）：堆叠第二基模型 + 自适应权重融合 + SHAP 归因 + 置信度校准
    const ensembleResult = ensemble.assemble({
        klines: fundInfo.bars, type: 'fund', vix: undefined, fearGreed: undefined,
        factors, W, baseRaw: predictions, confidence, key: `fund|${code}`
    });
    factors.push(ensembleResult.regime);
    predictions = ensembleResult.finalRaw;

    // 昨日对比 + 累计数据校正（按净值序列结算：新净值出现时结算上一条预测）
    let accResult = null;
    let finalConfidence = confidence;
    if (fundInfo.bars && fundInfo.bars.length >= 2) {
        accResult = accuracy.process({
            key: `fund|${code}`,
            klines: fundInfo.bars.slice(-90),
            predictions, confidence, score, direction
        });
        if (accResult) {
            predictions['1D'] = +clampPct(accResult.predictions['1D'], 2).toFixed(2);
            predictions['1W'] = +clampPct(accResult.predictions['1W'], 6).toFixed(2);
            predictions['1M'] = +clampPct(accResult.predictions['1M'], 12).toFixed(2);
            finalConfidence = accResult.confidence;
        }
    }
    // 集成增强：双基模型方向分歧 → 按同一折扣比例下调置信度
    if (ensembleResult.stability && ensembleResult.stability.disagree > 0 && confidence > 0) {
        const disc = ensembleResult.stability.confidenceAfterHedge / confidence;
        if (isFinite(disc) && disc > 0) finalConfidence = Math.round(finalConfidence * disc);
    }

    // 预测区间（±1σ，基于基金自身波动率）
    const intervals = buildIntervals(predictions, vol);
    const dataQuality = { missing: [], note: '基金因子数据完整' };

    // 9. 预测路径（历史净值+外推）
    const historyCloses = fundInfo.bars.slice(-40).map(b => b.close);
    const historyDates = fundInfo.bars.slice(-40).map(b => b.date);
    let predPath = null;
    if (historyCloses.length > 0) {
        const totalChange = predictions['1M'] / 100;
        const lastNav = historyCloses[historyCloses.length - 1];
        const dates = [], prices = [];
        const now = new Date();
        for (let i = 1; i <= 12; i++) {
            prices.push(+(lastNav * (1 + totalChange * i / 12)).toFixed(4));
            const d = new Date(now);
            d.setDate(d.getDate() + i * 2);
            dates.push(d.toISOString().substring(0, 10));
        }
        predPath = { dates, prices, total: predictions['1M'] };
    }

    // 10. 因子列表（净值/持仓/经理因子 + 基准代理因子摘要）
    const factorList = factors.map(f => ({
        name: f.name, group: f.group,
        score: +f.score.toFixed(0), detail: f.detail
    }));
    if (benchResult) {
        const benchName = ds.INDEX_CONFIG[benchmark] ? ds.INDEX_CONFIG[benchmark].name : benchmark;
        factorList.push({
            name: '基准指数', group: '关联市场',
            score: benchResult.score,
            detail: `${benchName}多因子评分${benchResult.score > 0 ? '+' : ''}${benchResult.score}（${benchResult.directionText}），${benchResult.factorList.length}个因子代理`
        });
    }

    return {
        code, type: 'fund',
        name: fundInfo.name,
        nav: fundInfo.nav,
        changePercent: fundInfo.changePercent,
        navDate: fundInfo.navDate,
        benchmark,
        score, direction, directionText,
        confidence: finalConfidence,
        predictions,
        intervals,
        dataQuality,
        intradayEstimate,
        yesterday: accResult ? accResult.yesterday : null,
        accuracy: accResult ? accResult.accuracy : null,
        corrections: accResult ? accResult.corrections : [],
        factorList,
        // 集成增强产出：堆叠模型权重 / SHAP 因子归因 / 置信度校准
        models: ensembleResult.models,
        shap: ensembleResult.shap,
        calibration: ensembleResult.calibration,
        stability: ensembleResult.stability,
        holdings: holdings.map(h => ({
            code: h.code, name: h.name, weight: h.weight,
            changePercent: quotes && quotes[h.code] ? +quotes[h.code].changePercent.toFixed(2) : null
        })),
        holdingsDate: holdingsInfo ? holdingsInfo.date : null,
        manager: mgr,
        assetAllocation: fundInfo.assetAllocation,
        performance: fundInfo.performance,
        returns: fundInfo.returns,
        history: { dates: historyDates, closes: historyCloses },
        predPath,
        dataSources: [
            '天天基金(净值)',
            holdings.length ? '天天基金F10(重仓)' : '',
            quotes ? '腾讯财经(个股行情)' : '',
            benchResult ? '基准指数(' + (ds.INDEX_CONFIG[benchmark] ? ds.INDEX_CONFIG[benchmark].name : benchmark) + ')' : ''
        ].filter(Boolean),
        generatedAt: new Date().toISOString()
    };
}

function predictFundCached(code, fundType) {
    const key = `predict_fund_${code}_${fundType || 'hybrid'}`;
    return cache.getOrFetch(key, 300, () => predictFund(code, fundType));
}

// 带缓存的预测出口
function predictCached(code, type) {
    const key = `predict_${type}_${code}`;
    return cache.getOrFetch(key, 60, () => predict(code, type));
}

// 市场情绪总览
async function marketSentiment() {
    const [breadth, northBound, fearGreed] = await Promise.all([
        ds.getMarketBreadth().catch(() => null),
        ds.getNorthBoundFlow().catch(() => null),
        ds.getFearGreedIndex().catch(() => null)
    ]);
    return { breadth, northBound, fearGreed, generatedAt: new Date().toISOString() };
}

function marketSentimentCached() {
    return cache.getOrFetch('market_sentiment', 30, marketSentiment);
}

module.exports = { predict, predictCached, predictFund, predictFundCached, marketSentimentCached, computeTechPred };
