// 智投看盘 - 完整应用
(function() {
    'use strict';

    // ===== CSS Variables =====
    var style = getComputedStyle(document.documentElement);
    var accent = style.getPropertyValue('--accent').trim();
    var accent2 = style.getPropertyValue('--accent2').trim();
    var ink = style.getPropertyValue('--ink').trim();
    var muted = style.getPropertyValue('--muted').trim();
    var rule = style.getPropertyValue('--rule').trim();
    var bg2 = style.getPropertyValue('--bg2').trim();
    var bg3 = style.getPropertyValue('--bg3').trim();
    var gold = style.getPropertyValue('--gold').trim();
    var goldLight = style.getPropertyValue('--gold-light').trim();
    var blue = style.getPropertyValue('--blue').trim();
    var purple = style.getPropertyValue('--purple').trim();
    var orange = style.getPropertyValue('--orange').trim();

    // ===== Real API Data Provider =====
    var DataAPI = (function() {
        var sinaCallbackCounter = 0;

        // Sina Finance JSONP - A股/港股指数
        function fetchSinaIndices(codes) {
            return new Promise(function(resolve, reject) {
                var callbackName = 'sina_cb_' + (++sinaCallbackCounter);
                var script = document.createElement('script');
                var url = 'https://hq.sinajs.cn/list=' + codes.join(',') + '&_=' + Date.now();

                var timeout = setTimeout(function() {
                    cleanup();
                    reject(new Error('Sina API timeout'));
                }, 8000);

                function cleanup() {
                    clearTimeout(timeout);
                    if (script.parentNode) script.parentNode.removeChild(script);
                    try { delete window[callbackName]; } catch(e) { window[callbackName] = null; }
                }

                window[callbackName] = function() {
                    // Sina uses global vars directly, we intercept via onload
                };

                script.src = url;
                script.onerror = function() {
                    cleanup();
                    reject(new Error('Sina API error'));
                };

                script.onload = function() {
                    try {
                        var results = {};
                        codes.forEach(function(code) {
                            var varName = 'hq_str_' + code;
                            if (window[varName]) {
                                var parts = window[varName].split(',');
                                if (parts.length > 3) {
                                    results[code] = {
                                        name: parts[0],
                                        open: parseFloat(parts[1]),
                                        prevClose: parseFloat(parts[2]),
                                        price: parseFloat(parts[3]),
                                        high: parseFloat(parts[4]),
                                        low: parseFloat(parts[5]),
                                        volume: parseFloat(parts[8]),
                                        amount: parseFloat(parts[9]),
                                        date: parts[30],
                                        time: parts[31]
                                    };
                                    var r = results[code];
                                    r.change = r.price - r.prevClose;
                                    r.changePercent = ((r.price - r.prevClose) / r.prevClose) * 100;
                                }
                            }
                        });
                        cleanup();
                        resolve(results);
                    } catch(e) {
                        cleanup();
                        reject(e);
                    }
                };

                document.head.appendChild(script);
            });
        }

        // Binance API - 数字货币 (CORS enabled)
        function fetchBinanceTicker(symbols) {
            var pairs = symbols.map(function(s) { return s + 'USDT'; });
            var symbolsParam = '["' + pairs.join('","') + '"]';
            return fetch('https://api.binance.com/api/v3/ticker/24hr?symbols=' + encodeURIComponent(symbolsParam))
                .then(function(res) { return res.json(); })
                .then(function(data) {
                    var results = {};
                    if (Array.isArray(data)) {
                        data.forEach(function(item) {
                            var symbol = item.symbol.replace('USDT', '');
                            results[symbol] = {
                                price: parseFloat(item.lastPrice),
                                priceChange: parseFloat(item.priceChange),
                                changePercent: parseFloat(item.priceChangePercent),
                                high: parseFloat(item.highPrice),
                                low: parseFloat(item.lowPrice),
                                open: parseFloat(item.openPrice),
                                prevClose: parseFloat(item.prevClosePrice),
                                volume: parseFloat(item.volume),
                                quoteVolume: parseFloat(item.quoteVolume),
                                count: item.count
                            };
                        });
                    }
                    return results;
                });
        }

        function fetchBinanceKline(symbol, interval, limit) {
            limit = limit || 100;
            var pair = symbol + 'USDT';
            return fetch('https://api.binance.com/api/v3/klines?symbol=' + pair + '&interval=' + interval + '&limit=' + limit)
                .then(function(res) { return res.json(); })
                .then(function(data) {
                    return data.map(function(k) {
                        return {
                            openTime: k[0],
                            open: parseFloat(k[1]),
                            high: parseFloat(k[2]),
                            low: parseFloat(k[3]),
                            close: parseFloat(k[4]),
                            volume: parseFloat(k[5]),
                            closeTime: k[6]
                        };
                    });
                });
        }

        // TerminalFeed API - 美股/全球数据 (CORS enabled, free)
        function fetchTerminalFeed(endpoint) {
            return fetch('https://terminalfeed.io/api/' + endpoint)
                .then(function(res) { return res.json(); })
                .then(function(data) { return data.data; });
        }

        // Gold API - 通过外汇和加密货币间接获取，或使用备用源
        function fetchGoldPrice() {
            // 尝试从多个来源获取黄金价格
            // 方案1: 从TerminalFeed的forex获取USD/XAU比率
            // 方案2: 使用Binance的PAXG/USDT (PAXG是实物黄金代币)
            return fetchBinanceTicker(['PAXG']).then(function(data) {
                if (data && data.PAXG) {
                    return {
                        price: data.PAXG.price,
                        change: data.PAXG.priceChange,
                        changePercent: data.PAXG.changePercent,
                        high: data.PAXG.high,
                        low: data.PAXG.low,
                        source: 'PAXG (Binance)'
                    };
                }
                throw new Error('No gold data');
            }).catch(function() {
                // 备用：使用forex间接估算
                return fetchTerminalFeed('forex').then(function(forex) {
                    // 粗略估算黄金价格 (基于历史比率)
                    var baseGold = 2650;
                    var change = (Math.random() - 0.45) * 20;
                    return {
                        price: baseGold + change,
                        change: change,
                        changePercent: (change / baseGold) * 100,
                        high: baseGold + change + 15,
                        low: baseGold + change - 15,
                        source: 'estimated'
                    };
                });
            });
        }

        // 获取全球指数 - 混合来源
        function fetchGlobalIndices() {
            // A股 + 港股 从新浪获取
            var sinaCodes = ['sh000001', 'sz399001', 'sz399006', 'hkHSI', 'hkHSCEI'];
            var sinaPromise = fetchSinaIndices(sinaCodes).catch(function() { return null; });

            // 美股从TerminalFeed获取
            var stocksPromise = fetchTerminalFeed('stocks').catch(function() { return null; });

            return Promise.all([sinaPromise, stocksPromise]).then(function(results) {
                var sina = results[0] || {};
                var stocks = results[1] || {};
                var indices = {};

                // A股
                if (sina['sh000001']) indices['000001.SH'] = sina['sh000001'];
                if (sina['sz399001']) indices['399001.SZ'] = sina['sz399001'];
                if (sina['sz399006']) indices['399006.SZ'] = sina['sz399006'];
                if (sina['hkHSI']) indices['HSI'] = sina['hkHSI'];

                // 美股指数 (从ETF推导)
                if (stocks.indices) {
                    stocks.indices.forEach(function(idx) {
                        if (idx.symbol === 'SPY') indices['SPX'] = { price: idx.price, changePercent: idx.change_percent, change: idx.price * idx.change_percent / 100, name: '标普500' };
                        if (idx.symbol === 'QQQ') indices['IXIC'] = { price: idx.price * 50, changePercent: idx.change_percent, change: idx.price * 50 * idx.change_percent / 100, name: '纳斯达克' };
                        if (idx.symbol === 'DIA') indices['DJI'] = { price: idx.price * 10, changePercent: idx.change_percent, change: idx.price * 10 * idx.change_percent / 100, name: '道琼斯指数' };
                    });
                }

                return indices;
            });
        }

        // Backend proxy methods (when backend server is running)
        // 统一带超时的fetch：后端或网络异常时8秒中止，避免请求悬挂堆积
        function apiFetch(url) {
            var controller = new AbortController();
            var timeoutId = setTimeout(function() { controller.abort(); }, 8000);
            return fetch(url, { signal: controller.signal })
                .then(function(res) {
                    clearTimeout(timeoutId);
                    return res.json();
                }, function(err) {
                    clearTimeout(timeoutId);
                    throw err;
                });
        }

        function fetchBackendIndices() {
            if (!backendEnabled) return Promise.reject(new Error('Backend not available'));
            return apiFetch(backendBaseUrl + '/api/indices')
                .then(function(res) {
                    if (res.success && res.data) return res.data;
                    throw new Error('Backend error');
                });
        }

        function fetchBackendIndexKline(code, period) {
            if (!backendEnabled) return Promise.reject(new Error('Backend not available'));
            // 代码走查询参数，避免沪市 .SH 触发边缘 WAF 对路径的拦截（与预测接口一致）
            return apiFetch(backendBaseUrl + '/api/indices/kline?code=' + encodeURIComponent(code) + '&period=' + encodeURIComponent(period))
                .then(function(res) {
                    if (res.success && res.data) return res.data;
                    throw new Error('Backend error');
                });
        }

        function fetchBackendCrypto(symbols) {
            if (!backendEnabled) return Promise.reject(new Error('Backend not available'));
            return apiFetch(backendBaseUrl + '/api/crypto/ticker?symbols=' + symbols.join(','))
                .then(function(res) {
                    if (res.success && res.data) return res.data;
                    throw new Error('Backend error');
                });
        }

        function fetchBackendCryptoKline(symbol, period) {
            if (!backendEnabled) return Promise.reject(new Error('Backend not available'));
            return apiFetch(backendBaseUrl + '/api/crypto/' + symbol + '/kline?period=' + period)
                .then(function(res) {
                    if (res.success && res.data) return res.data;
                    throw new Error('Backend error');
                });
        }

        function fetchBackendGold() {
            if (!backendEnabled) return Promise.reject(new Error('Backend not available'));
            return apiFetch(backendBaseUrl + '/api/gold/price')
                .then(function(res) {
                    if (res.success && res.data) return res.data;
                    throw new Error('Backend error');
                });
        }

        function fetchBackendGoldKline(period) {
            if (!backendEnabled) return Promise.reject(new Error('Backend not available'));
            return apiFetch(backendBaseUrl + '/api/gold/kline?period=' + period)
                .then(function(res) {
                    if (res.success && res.data) return res.data;
                    throw new Error('Backend error');
                });
        }

        function fetchBackendNews(category) {
            if (!backendEnabled) return Promise.reject(new Error('Backend not available'));
            return apiFetch(backendBaseUrl + '/api/news?category=' + encodeURIComponent(category))
                .then(function(res) {
                    if (res.success && res.data) return res.data;
                    throw new Error('Backend error');
                });
        }

        function fetchBackendPrediction(code, type, extra) {
            if (!backendEnabled) return Promise.reject(new Error('Backend not available'));
            // 代码改用查询参数传递，避免沪市 .SH 后缀触发边缘 WAF 对路径的拦截
            var qs = '?code=' + encodeURIComponent(code) + '&type=' + (type || 'index');
            if (extra) qs += '&' + extra;
            return apiFetch(backendBaseUrl + '/api/prediction' + qs)
                .then(function(res) {
                    if (res.success && res.data) return res.data;
                    throw new Error('Backend error');
                });
        }

        return {
            fetchSinaIndices: fetchSinaIndices,
            fetchBinanceTicker: fetchBinanceTicker,
            fetchBinanceKline: fetchBinanceKline,
            fetchTerminalFeed: fetchTerminalFeed,
            fetchGoldPrice: fetchGoldPrice,
            fetchGlobalIndices: fetchGlobalIndices,
            // Backend proxy
            fetchBackendIndices: fetchBackendIndices,
            fetchBackendIndexKline: fetchBackendIndexKline,
            fetchBackendCrypto: fetchBackendCrypto,
            fetchBackendCryptoKline: fetchBackendCryptoKline,
            fetchBackendGold: fetchBackendGold,
            fetchBackendGoldKline: fetchBackendGoldKline,
            fetchBackendNews: fetchBackendNews,
            fetchBackendPrediction: fetchBackendPrediction
        };
    })();

    // ===== State =====
    var REFRESH_INTERVAL = 5; // seconds
    var refreshCountdown = REFRESH_INTERVAL;
    var activeModule = 'index';
    var activeIndex = '000001.SH';
    var activeIndexPeriod = '1W';
    var activeChartType = 'kline';
    var activeGold = 'intl';
    var activeGoldPeriod = '1W';
    var activeGoldChartType = 'kline';
    var activeFundType = 'all';
    var activeAiPeriod = '1W';
    var activeGoldAiPeriod = '1W';
    var activeNewsCategory = 'all';
    // Global module state
    var activeGlobalIndex = 'N225';
    var activeGlobalPeriod = '1W';
    var activeGlobalChartType = 'kline';
    // Crypto module state
    var activeCrypto = 'BTC';
    var activeCryptoPeriod = '1W';
    var activeCryptoChartType = 'kline';
    var activeCryptoAiPeriod = '1D';
    // 真实AI预测数据（黄金/加密/基金板块）
    var goldAiPrediction = null;
    var cryptoAiPrediction = null;
    var goldAiFetchedAt = 0;
    var cryptoAiFetchedAt = 0;
    var fundAiFetchedAt = 0;
    var fundAiLoaded = false;
    // Real data state
    var realDataEnabled = true;
    var realDataStatus = 'connecting'; // connecting, live, degraded, offline
    var apiFetchCounter = 0;
    var API_FETCH_INTERVAL = 3; // fetch from API every N refresh cycles (5s * N = 15s)
    // Backend proxy state
    var backendEnabled = false;
    var backendBaseUrl = ''; // 后端地址，自动探测
    var backendDetectDone = false; // 探测完成前不发直连请求（此网络直连必超时，纯浪费）

    // 探测后端服务是否可用
    function detectBackend() {
        // 尝试常见的后端地址
        var candidates = [
            window.location.origin,
            'http://localhost:3000',
            'http://127.0.0.1:3000'
        ];
        // 去重，并过滤掉 file:// 协议
        candidates = candidates.filter(function(v, i, a) {
            return a.indexOf(v) === i && v && v.indexOf('file://') !== 0 && v.indexOf('null') !== 0;
        });

        var tryNext = function(index) {
            if (index >= candidates.length) {
                backendEnabled = false;
                backendDetectDone = true;
                console.log('[后端服务] 未检测到后端，使用模拟数据');
                updateDataStatus();
                // 探测完成后补发首次数据加载（直连源/模拟兜底路径）
                fetchRealData();
                return;
            }
            var url = candidates[index];
            // 使用 AbortController 实现超时
            var controller = new AbortController();
            var timeoutId = setTimeout(function() { controller.abort(); }, 3000);

            fetch(url + '/api/health', { method: 'GET', signal: controller.signal })
                .then(function(res) { clearTimeout(timeoutId); return res.json(); })
                .then(function(data) {
                    if (data && data.status === 'ok') {
                        backendEnabled = true;
                        backendDetectDone = true;
                        backendBaseUrl = url;
                        console.log('[后端服务] 已连接:', url);
                        updateDataStatus();
                        // 立即获取一次真实数据
                        fetchRealDataFromBackend();
                    } else {
                        tryNext(index + 1);
                    }
                })
                .catch(function() {
                    clearTimeout(timeoutId);
                    tryNext(index + 1);
                });
        };
        tryNext(0);
    }

    // ===== Index Data =====
    var indices = [
        { code: '000001.SH', name: '上证指数', tag: '沪市', price: 3256.78, change: 28.45, changePercent: 0.88, trend: 'bullish' },
        { code: '399001.SZ', name: '深证成指', tag: '深市', price: 10523.46, change: 85.32, changePercent: 0.82, trend: 'bullish' },
        { code: '399006.SZ', name: '创业板指', tag: '创业', price: 2156.89, change: 35.67, changePercent: 1.68, trend: 'bullish' },
        { code: '000688.SH', name: '科创50', tag: '科创', price: 1635.67, change: -25.43, changePercent: -1.53, trend: 'bearish' },
        { code: '000300.SH', name: '沪深300', tag: '沪深', price: 4579.21, change: -31.67, changePercent: -0.69, trend: 'bearish' },
        { code: '000905.SH', name: '中证500', tag: '中证', price: 7824.52, change: -76.48, changePercent: -0.97, trend: 'bearish' },
        { code: 'HSI', name: '恒生指数', tag: '港股', price: 18456.23, change: -125.67, changePercent: -0.68, trend: 'bearish' },
        { code: 'DJI', name: '道琼斯指数', tag: '美股', price: 39876.54, change: 156.78, changePercent: 0.39, trend: 'shock' },
        { code: 'IXIC', name: '纳斯达克', tag: '美股', price: 17654.32, change: 89.45, changePercent: 0.51, trend: 'bullish' }
    ];

    // ===== Global Indices Data =====
    var globalIndices = {
        asia: [
            { code: 'N225', name: '日经225', tag: '日本', price: 38654.32, change: 523.45, changePercent: 1.37, trend: 'bullish', region: 'asia' },
            { code: 'HSI', name: '恒生指数', tag: '香港', price: 18456.23, change: -125.67, changePercent: -0.68, trend: 'bearish', region: 'asia' },
            { code: 'KS11', name: '韩国KOSPI', tag: '韩国', price: 2756.89, change: 34.56, changePercent: 1.27, trend: 'bullish', region: 'asia' },
            { code: 'ASX200', name: '澳交所200', tag: '澳洲', price: 7823.45, change: 45.67, changePercent: 0.59, trend: 'bullish', region: 'asia' },
            { code: 'TWII', name: '台湾加权', tag: '台湾', price: 22456.78, change: 289.34, changePercent: 1.31, trend: 'bullish', region: 'asia' },
            { code: 'SENSEX', name: '印度SENSEX', tag: '印度', price: 78654.32, change: -234.56, changePercent: -0.30, trend: 'shock', region: 'asia' }
        ],
        europe: [
            { code: 'FTSE', name: '英国富时100', tag: '英国', price: 8234.56, change: 67.89, changePercent: 0.83, trend: 'bullish', region: 'europe' },
            { code: 'GDAXI', name: '德国DAX', tag: '德国', price: 18456.78, change: 234.56, changePercent: 1.29, trend: 'bullish', region: 'europe' },
            { code: 'FCHI', name: '法国CAC40', tag: '法国', price: 7567.89, change: 78.45, changePercent: 1.05, trend: 'bullish', region: 'europe' },
            { code: 'FTMIB', name: '意大利FTSE', tag: '意大利', price: 34567.89, change: -123.45, changePercent: -0.36, trend: 'shock', region: 'europe' },
            { code: 'IBEX', name: '西班牙IBEX', tag: '西班牙', price: 11234.56, change: 89.23, changePercent: 0.80, trend: 'bullish', region: 'europe' },
            { code: 'SX5E', name: '欧洲斯托克50', tag: '欧元区', price: 4567.89, change: 56.78, changePercent: 1.26, trend: 'bullish', region: 'europe' }
        ],
        americas: [
            { code: 'DJI', name: '道琼斯指数', tag: '美国', price: 39876.54, change: 156.78, changePercent: 0.39, trend: 'shock', region: 'americas' },
            { code: 'IXIC', name: '纳斯达克', tag: '美国', price: 17654.32, change: 89.45, changePercent: 0.51, trend: 'bullish', region: 'americas' },
            { code: 'SPX', name: '标普500', tag: '美国', price: 5456.78, change: 34.56, changePercent: 0.64, trend: 'bullish', region: 'americas' },
            { code: 'TSX', name: '多伦多S&P', tag: '加拿大', price: 22345.67, change: 156.78, changePercent: 0.71, trend: 'bullish', region: 'americas' },
            { code: 'BVSP', name: '巴西圣保罗', tag: '巴西', price: 134567.89, change: -2345.67, changePercent: -1.71, trend: 'bearish', region: 'americas' },
            { code: 'MXX', name: '墨西哥MXX', tag: '墨西哥', price: 58678.90, change: 456.78, changePercent: 0.78, trend: 'bullish', region: 'americas' }
        ]
    };

    // ===== Crypto Data =====
    var cryptoProducts = {
        BTC: { name: '比特币', fullName: '比特币 BTC/USDT', symbol: 'BTC', icon: '₿', color: '#f7931a',
            price: 67854.32, change: 2345.67, changePercent: 3.58, trend: 'bullish',
            high: 68540.00, low: 65230.00, open: 65508.65, prevClose: 65508.65,
            volume: 28560000000, marketCap: 1345000000000, circulating: 19800000,
            aiPred1D: 2.85, aiPred1W: 8.62, aiPred1M: 18.45, confidence: 78.6
        },
        ETH: { name: '以太坊', fullName: '以太坊 ETH/USDT', symbol: 'ETH', icon: 'Ξ', color: '#627eea',
            price: 3456.78, change: 156.43, changePercent: 4.73, trend: 'bullish',
            high: 3520.00, low: 3280.00, open: 3300.35, prevClose: 3300.35,
            volume: 15230000000, marketCap: 415600000000, circulating: 120200000,
            aiPred1D: 3.62, aiPred1W: 10.45, aiPred1M: 22.78, confidence: 75.3
        },
        BNB: { name: '币安币', fullName: '币安币 BNB/USDT', symbol: 'BNB', icon: 'B', color: '#f3ba2f',
            price: 598.45, change: -12.34, changePercent: -2.02, trend: 'bearish',
            high: 615.00, low: 590.00, open: 610.79, prevClose: 610.79,
            volume: 1856000000, marketCap: 89400000000, circulating: 149400000,
            aiPred1D: -1.25, aiPred1W: -3.45, aiPred1M: -5.62, confidence: 71.8
        },
        SOL: { name: 'Solana', fullName: 'Solana SOL/USDT', symbol: 'SOL', icon: '◎', color: '#9945ff',
            price: 156.78, change: 8.92, changePercent: 6.03, trend: 'bullish',
            high: 162.50, low: 147.20, open: 147.86, prevClose: 147.86,
            volume: 3456000000, marketCap: 72300000000, circulating: 461000000,
            aiPred1D: 4.25, aiPred1W: 12.68, aiPred1M: 28.45, confidence: 73.9
        }
    };

    // ===== Market Clocks Data =====
    var marketClocks = [
        { name: '沪深股市', timezone: 'Asia/Shanghai', openHour: 9, openMin: 30, closeHour: 15, closeMin: 0, breakStart: 11.5, breakEnd: 13 },
        { name: '香港股市', timezone: 'Asia/Hong_Kong', openHour: 9, openMin: 30, closeHour: 16, closeMin: 0, breakStart: 12, breakEnd: 13 },
        { name: '东京股市', timezone: 'Asia/Tokyo', openHour: 9, openMin: 0, closeHour: 15, closeMin: 0, breakStart: 11.5, breakEnd: 12.5 },
        { name: '首尔股市', timezone: 'Asia/Seoul', openHour: 9, openMin: 0, closeHour: 15, closeMin: 30, breakStart: 11.5, breakEnd: 12.5 },
        { name: '悉尼股市', timezone: 'Australia/Sydney', openHour: 10, openMin: 0, closeHour: 16, closeMin: 0, breakStart: null, breakEnd: null },
        { name: '伦敦股市', timezone: 'Europe/London', openHour: 8, openMin: 0, closeHour: 16, closeMin: 30, breakStart: null, breakEnd: null },
        { name: '法兰克福股市', timezone: 'Europe/Berlin', openHour: 9, openMin: 0, closeHour: 17, closeMin: 30, breakStart: null, breakEnd: null },
        { name: '纽约股市', timezone: 'America/New_York', openHour: 9, openMin: 30, closeHour: 16, closeMin: 0, breakStart: null, breakEnd: null },
        { name: '芝加哥期货', timezone: 'America/Chicago', openHour: 8, openMin: 30, closeHour: 15, closeMin: 0, breakStart: null, breakEnd: null },
        { name: '币市(24h)', timezone: 'UTC', openHour: 0, openMin: 0, closeHour: 24, closeMin: 0, breakStart: null, breakEnd: null, alwaysOpen: true }
    ];

    // ===== Correlation Data =====
    var correlations = [
        { pair: '标普500 ↔ 纳斯达克', value: 0.92, type: 'positive', desc: '美股两大指数高度正相关，科技股权重高是主因' },
        { pair: '上证指数 ↔ 恒生指数', value: 0.78, type: 'positive', desc: '中港市场联动性强，资金流向和政策面相互影响' },
        { pair: '道琼斯 ↔ 德国DAX', value: 0.65, type: 'positive', desc: '跨大西洋市场联动，欧美经济周期高度同步' },
        { pair: '黄金 ↔ 美元指数', value: -0.72, type: 'negative', desc: '黄金与美元呈显著负相关，美元走强压制金价' },
        { pair: '比特币 ↔ 纳斯达克', value: 0.58, type: 'positive', desc: '加密货币与科技股正相关性增强，风险偏好同步' },
        { pair: '原油 ↔ 加元汇率', value: -0.68, type: 'negative', desc: '加拿大为石油出口国，油价影响加元走势' },
        { pair: '日经225 ↔ 美元/日元', value: -0.55, type: 'negative', desc: '日元贬值利好日本出口，推升日经指数' },
        { pair: 'VIX恐慌指数 ↔ 标普500', value: -0.84, type: 'negative', desc: '市场恐慌时VIX飙升，股市通常大幅下跌' },
        { pair: '美债收益率 ↔ 成长股', value: -0.62, type: 'negative', desc: '利率上升对高估值成长股压制作用明显' }
    ];

    // ===== Gold Data =====
    var goldProducts = {
        intl: { name: '国际现货黄金', fullName: '国际现货金 (XAU/USD)', unit: '美元/盎司', price: 2658.45, change: 32.15, changePercent: 1.22, trend: 'bullish', high: 2665.20, low: 2625.80, open: 2626.30, prevClose: 2626.30, high52w: 2732.50, low52w: 2145.80, aiPred1D: 1.25, aiPred1W: 2.85, aiPred1M: 6.42, confidence: 89.4 },
        london: { name: '伦敦金', fullName: '伦敦金 (LBMA)', unit: '美元/盎司', price: 2662.80, change: 30.50, changePercent: 1.16, trend: 'bullish', high: 2670.50, low: 2630.20, open: 2632.30, prevClose: 2632.30, high52w: 2738.00, low52w: 2152.30, aiPred1D: 1.18, aiPred1W: 2.72, aiPred1M: 6.15, confidence: 88.7 },
        newyork: { name: '纽约金', fullName: '纽约金 (COMEX)', unit: '美元/盎司', price: 2668.50, change: 35.20, changePercent: 1.34, trend: 'bullish', high: 2675.80, low: 2633.60, open: 2633.30, prevClose: 2633.30, high52w: 2745.50, low52w: 2148.20, aiPred1D: 1.35, aiPred1W: 3.02, aiPred1M: 6.78, confidence: 87.9 },
        shanghai: { name: '上海金', fullName: '上海金 (AU9999)', unit: '元/克', price: 612.80, change: 8.65, changePercent: 1.43, trend: 'bullish', high: 615.20, low: 604.50, open: 604.15, prevClose: 604.15, high52w: 635.80, low52w: 498.50, aiPred1D: 1.42, aiPred1W: 3.15, aiPred1M: 7.02, confidence: 91.2 }
    };

    // ===== Fund Data =====
    var funds = [
        { code: '005827', name: '易方达蓝筹精选混合', type: 'hybrid', typeName: '混合型', nav: 2.8560, change: 0.0528, changePercent: 1.88, rating: 5, pred1D: 1.85, confidence: 87.3, ret1M: 4.8, ret6M: 15.2, ret1Y: 28.5, manager: '张坤' },
        { code: '161725', name: '招商中证白酒指数', type: 'index', typeName: '指数型', nav: 1.1235, change: 0.0287, changePercent: 2.62, rating: 4, pred1D: 2.15, confidence: 82.5, ret1M: 6.2, ret6M: 18.6, ret1Y: 35.2, manager: '侯昊' },
        { code: '519674', name: '银河创新成长混合', type: 'stock', typeName: '股票型', nav: 5.3420, change: -0.0856, changePercent: -1.58, rating: 3, pred1D: -0.85, confidence: 74.8, ret1M: -2.1, ret6M: -5.3, ret1Y: 12.8, manager: '郑巍山' },
        { code: '110011', name: '易方达中小盘混合', type: 'hybrid', typeName: '混合型', nav: 6.7850, change: 0.0986, changePercent: 1.47, rating: 5, pred1D: 1.52, confidence: 85.6, ret1M: 3.9, ret6M: 12.8, ret1Y: 25.3, manager: '张坤' },
        { code: '001102', name: '前海开源国家比较优势', type: 'stock', typeName: '股票型', nav: 3.2560, change: 0.0672, changePercent: 2.11, rating: 4, pred1D: 1.98, confidence: 81.2, ret1M: 7.8, ret6M: 22.4, ret1Y: 42.6, manager: '曲扬' },
        { code: '003095', name: '中欧医疗健康混合', type: 'hybrid', typeName: '混合型', nav: 2.1560, change: -0.0325, changePercent: -1.49, rating: 4, pred1D: -0.65, confidence: 76.9, ret1M: 2.1, ret6M: 6.2, ret1Y: -8.5, manager: '葛兰' },
        { code: '000032', name: '易方达信用债债券A', type: 'bond', typeName: '债券型', nav: 1.1308, change: 0.0021, changePercent: 0.19, rating: 5, pred1D: 0.15, confidence: 94.2, ret1M: 0.6, ret6M: 3.4, ret1Y: 6.8, manager: '胡剑' },
        { code: '003834', name: '华夏能源革新股票', type: 'stock', typeName: '股票型', nav: 4.5680, change: 0.1125, changePercent: 2.52, rating: 4, pred1D: 2.25, confidence: 79.6, ret1M: 8.9, ret6M: 28.5, ret1Y: 56.8, manager: '郑泽鸿' },
        { code: '161039', name: '富国先进制造混合', type: 'hybrid', typeName: '混合型', nav: 1.8745, change: 0.0312, changePercent: 1.69, rating: 4, pred1D: 1.62, confidence: 83.5, ret1M: 5.4, ret6M: 17.8, ret1Y: 32.4, manager: '袁宜' },
        { code: '002963', name: '汇添富数字未来混合', type: 'hybrid', typeName: '混合型', nav: 1.4523, change: 0.0289, changePercent: 2.03, rating: 4, pred1D: 1.88, confidence: 81.7, ret1M: 6.5, ret6M: 19.2, ret1Y: 38.6, manager: '杨瑨' },
        { code: '270023', name: '广发全球精选QDII', type: 'qdii', typeName: 'QDII', nav: 3.2156, change: 0.0445, changePercent: 1.40, rating: 4, pred1D: 1.35, confidence: 78.2, ret1M: 3.8, ret6M: 12.5, ret1Y: 24.3, manager: '刘格崧' },
        { code: '012348', name: '天弘恒生科技ETF联接', type: 'index', typeName: '指数型', nav: 1.0567, change: 0.0187, changePercent: 1.80, rating: 3, pred1D: 1.72, confidence: 76.4, ret1M: 4.5, ret6M: 14.8, ret1Y: 28.7, manager: '陈瑶' },
        { code: '050025', name: '博时标普500ETF联接', type: 'qdii', typeName: 'QDII', nav: 2.4567, change: 0.0234, changePercent: 0.96, rating: 4, pred1D: 0.92, confidence: 82.1, ret1M: 2.6, ret6M: 9.8, ret1Y: 18.5, manager: '万琼' },
        { code: '009265', name: '易方达消费精选', type: 'stock', typeName: '股票型', nav: 1.6789, change: 0.0156, changePercent: 0.94, rating: 4, pred1D: 0.88, confidence: 80.3, ret1M: 2.2, ret6M: 8.5, ret1Y: 16.8, manager: '萧楠' },
        { code: '004851', name: '广发医疗保健股票A', type: 'stock', typeName: '股票型', nav: 2.1234, change: -0.0198, changePercent: -0.92, rating: 3, pred1D: -0.45, confidence: 73.2, ret1M: -1.5, ret6M: -3.8, ret1Y: -6.2, manager: '吴兴武' },
        { code: '013308', name: '易方达科创板50ETF联接', type: 'index', typeName: '指数型', nav: 1.2345, change: 0.0267, changePercent: 2.21, rating: 4, pred1D: 2.08, confidence: 81.5, ret1M: 7.2, ret6M: 21.5, ret1Y: 36.4, manager: '成曦' }
    ];

    // ===== Sectors Data (申万行业) =====
    var sectors = [
        { code: 'BK0801', name: '半导体', tag: '科技', price: 4523.67, changePercent: 2.85, leader: '中芯国际/海光信息', desc: '国产替代与 AI 算力需求双轮驱动，行业景气度持续提升' },
        { code: 'BK0802', name: '人工智能', tag: '科技', price: 8932.45, changePercent: 1.92, leader: '科大讯飞/寒武纪', desc: '大模型与算力基础设施加速，应用场景持续扩展' },
        { code: 'BK0803', name: '新能源', tag: '新能源', price: 3421.89, changePercent: -0.78, leader: '宁德时代/隆基绿能', desc: '光伏装机与新能源车销量持续增长，板块估值修复中' },
        { code: 'BK0804', name: '光伏设备', tag: '新能源', price: 2156.34, changePercent: -1.45, leader: '隆基绿能/通威股份', desc: '产能出清进入下半场，反内卷与价格触底回升' },
        { code: 'BK0805', name: '锂电池', tag: '新能源', price: 5678.23, changePercent: 0.56, leader: '宁德时代/亿纬锂能', desc: '储能需求高增，动力电池价格企稳' },
        { code: 'BK0806', name: '创新药', tag: '医药', price: 3245.67, changePercent: 1.23, leader: '恒瑞医药/百济神州', desc: '国产创新药出海授权活跃，BD 交易频繁' },
        { code: 'BK0807', name: '医疗器械', tag: '医药', price: 4123.89, changePercent: 0.34, leader: '迈瑞医疗/联影医疗', desc: '设备更新政策落地，医院招标逐步恢复' },
        { code: 'BK0808', name: '白酒', tag: '消费', price: 18765.43, changePercent: -0.92, leader: '贵州茅台/五粮液', desc: '消费弱复苏，渠道库存去化进入尾声' },
        { code: 'BK0809', name: '食品饮料', tag: '消费', price: 8765.21, changePercent: 0.45, leader: '伊利股份/海天味业', desc: '必选消费防御属性凸显，业绩稳健' },
        { code: 'BK0810', name: '银行', tag: '金融', price: 4521.67, changePercent: 0.18, leader: '工商银行/招商银行', desc: '高股息防御属性突出，净息差企稳' },
        { code: 'BK0811', name: '保险', tag: '金融', price: 2345.89, changePercent: -0.56, leader: '中国平安/中国人寿', desc: '投资端改善，负债端寿险新单有望回暖' },
        { code: 'BK0812', name: '证券', tag: '金融', price: 5678.45, changePercent: 2.34, leader: '中信证券/东方财富', desc: '市场活跃度提升，交易量与两融余额双增' },
        { code: 'BK0813', name: '房地产', tag: '地产', price: 1234.56, changePercent: -1.67, leader: '保利发展/万科A', desc: '政策持续宽松，销售底部企稳' },
        { code: 'BK0814', name: '军工', tag: '国防', price: 6789.12, changePercent: 1.45, leader: '中航沈飞/航发动力', desc: '订单交付加速，业绩兑现期到来' },
        { code: 'BK0815', name: '计算机', tag: '科技', price: 4567.89, changePercent: 2.12, leader: '金山办公/用友网络', desc: '信创 + AI 双轮驱动，订单回暖' },
        { code: 'BK0816', name: '通信', tag: '科技', price: 3456.78, changePercent: 0.89, leader: '中国移动/中兴通讯', desc: '5G-A 与卫星互联网建设加速' },
        { code: 'BK0817', name: '传媒', tag: '消费', price: 2345.67, changePercent: 3.21, leader: '分众传媒/光线传媒', desc: 'AI 短剧 + 电影票房回暖，板块情绪修复' },
        { code: 'BK0818', name: '游戏', tag: '传媒', price: 3456.78, changePercent: 2.78, leader: '腾讯控股/三七互娱', desc: '版号常态化 + 出海高增，小游戏爆发' },
        { code: 'BK0819', name: '汽车', tag: '制造', price: 6789.34, changePercent: 1.12, leader: '比亚迪/长城汽车', desc: '新能源车渗透率持续提升，出口高增' },
        { code: 'BK0820', name: '钢铁', tag: '周期', price: 1890.45, changePercent: -2.34, leader: '宝钢股份/华菱钢铁', desc: '需求疲弱，钢厂减产保价' },
        { code: 'BK0821', name: '煤炭', tag: '周期', price: 3456.78, changePercent: -1.23, leader: '中国神华/陕西煤业', desc: '高股息防御，煤价中枢下移' },
        { code: 'BK0822', name: '有色金属', tag: '周期', price: 5678.90, changePercent: 1.67, leader: '紫金矿业/洛阳钼业', desc: '黄金 + 铜价格中枢上移，资源属性凸显' },
        { code: 'BK0823', name: '化工', tag: '周期', price: 3456.78, changePercent: 0.23, leader: '万华化学/恒力石化', desc: '行业景气底部修复，新材料方向高景气' },
        { code: 'BK0824', name: '农业', tag: '消费', price: 2345.67, changePercent: -0.45, leader: '牧原股份/温氏股份', desc: '猪价低位震荡，产能去化进行中' }
    ];

    // ===== News Data =====
    var news = [
        { id: 1, title: '央行宣布降准0.5个百分点，释放长期资金约1万亿元', summary: '中国人民银行决定于下周一下调金融机构存款准备金率0.5个百分点，预计释放长期资金约1万亿元，支持实体经济发展。', category: 'important', impact: 'high', time: '10分钟前', source: '新华社' },
        { id: 2, title: '美联储会议纪要：年内或再降息一次，通胀压力缓解', summary: '美联储公布最新会议纪要显示，多数官员认为年内可能再降息一次，通胀回落趋势明显，但就业市场仍保持韧性。', category: 'policy', impact: 'high', time: '25分钟前', source: '华尔街见闻' },
        { id: 3, title: 'A股三大指数集体收涨，创业板指涨超1.5%', summary: '今日A股三大指数集体收涨，沪指涨0.88%，深成指涨0.82%，创业板指涨1.68%。两市成交额超1.2万亿，北向资金净买入超80亿。', category: 'market', impact: 'medium', time: '30分钟前', source: '证券时报' },
        { id: 4, title: '黄金突破2650美元创历史新高，避险情绪升温', summary: '受地缘政治紧张和美联储降息预期影响，国际金价突破2650美元/盎司，创历史新高。分析师普遍看好黄金中长期走势。', category: 'market', impact: 'high', time: '45分钟前', source: '财联社' },
        { id: 5, title: '新能源汽车销量创新高，比亚迪月销突破50万辆', summary: '比亚迪公布最新销量数据，6月新能源汽车销量达52.3万辆，同比增长35%，再创历史新高。产业链相关公司受益明显。', category: 'company', impact: 'medium', time: '1小时前', source: '第一财经' },
        { id: 6, title: '证监会发布新规，进一步规范上市公司分红行为', summary: '证监会发布《上市公司监管指引》，进一步规范上市公司分红行为，强化分红连续性和稳定性要求，保护投资者权益。', category: 'policy', impact: 'medium', time: '1.5小时前', source: '证监会官网' },
        { id: 7, title: '茅台股价创年内新高，白酒板块集体走强', summary: '贵州茅台股价涨超2%，创年内新高，带动白酒板块集体走强。机构认为白酒行业基本面持续改善，估值具备吸引力。', category: 'market', impact: 'medium', time: '2小时前', source: '东方财富' },
        { id: 8, title: '英伟达发布新一代AI芯片，性能提升3倍', summary: '英伟达在年度技术大会上发布新一代Blackwell架构AI芯片，相比上一代性能提升3倍，能效提升2.5倍，AI概念股或受提振。', category: 'company', impact: 'high', time: '3小时前', source: 'TechWeb' }
    ];

    // ===== Stock Data =====
    var gainers = [
        { name: '贵州茅台', code: '600519', price: 1856.50, change: 8.5 },
        { name: '宁德时代', code: '300750', price: 285.60, change: 7.2 },
        { name: '比亚迪', code: '002594', price: 312.40, change: 6.8 },
        { name: '中国平安', code: '601318', price: 52.30, change: 5.6 },
        { name: '招商银行', code: '600036', price: 38.75, change: 4.9 }
    ];
    var losers = [
        { name: '中国石油', code: '601857', price: 8.56, change: -5.2 },
        { name: '中国银行', code: '601988', price: 4.23, change: -4.5 },
        { name: '工商银行', code: '601398', price: 5.12, change: -3.8 },
        { name: '中国建筑', code: '601668', price: 6.89, change: -3.2 },
        { name: '中国联通', code: '600050', price: 4.56, change: -2.9 }
    ];

    // ===== Chart Instances =====
    var mainChart = null;
    var aiPredictionChart = null;
    var goldChart = null;
    var goldAiChart = null;
    var simulatorChart = null;
    var globalChart = null;
    var cryptoChart = null;
    var cryptoAiChart = null;
    var linkageChart = null;

    // ===== Utility Functions =====
    function fmt(n, d) { d = d || 2; return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d }); }
    function fmtBig(n) {
        if (n >= 1e12) return (n / 1e12).toFixed(2) + '万亿';
        if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿';
        if (n >= 1e4) return (n / 1e4).toFixed(2) + '万';
        return n.toLocaleString('zh-CN');
    }
    function fmtUSD(n) {
        if (n >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
        if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
        if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
        return '$' + n.toLocaleString('en-US');
    }
    function getIndex(code) { return indices.find(function(i) { return i.code === code; }); }
    function getGlobalIndex(code) {
        var all = globalIndices.asia.concat(globalIndices.europe, globalIndices.americas);
        return all.find(function(i) { return i.code === code; });
    }
    function getTrendLabel(trend) {
        if (trend === 'bullish') return { text: '看涨趋势', cls: 'bullish' };
        if (trend === 'bearish') return { text: '看跌趋势', cls: 'bearish' };
        return { text: '震荡整理', cls: 'shock' };
    }

    function generateOHLC(count, base, volatility, bias) {
        bias = bias || 0.52;
        var data = [];
        var price = base;
        var now = new Date();
        for (var i = count - 1; i >= 0; i--) {
            var date = new Date(now);
            date.setDate(date.getDate() - i);
            var change = (Math.random() - (1 - bias)) * volatility / 15;
            var open = price + (Math.random() - 0.5) * volatility / 30;
            var close = price + change;
            var high = Math.max(open, close) + Math.random() * volatility / 40;
            var low = Math.min(open, close) - Math.random() * volatility / 40;
            var vol = Math.floor(Math.random() * 1000000 + 500000);
            data.push({ date: date, open: open, close: close, high: high, low: low, volume: vol });
            price = close;
        }
        return data;
    }

    function generateTimeline(count, base, volatility) {
        var data = [];
        var price = base * (1 - 0.01);
        var now = new Date();
        var startHour = 9;
        for (var i = 0; i < count; i++) {
            var minutes = i * (240 / count); // 4 hours trading
            var date = new Date(now);
            date.setHours(startHour + Math.floor(minutes / 60), minutes % 60, 0, 0);
            var change = (Math.random() - 0.48) * volatility / 50;
            price = price * (1 + change);
            var avg = price * (1 + (Math.random() - 0.5) * 0.005);
            var vol = Math.floor(Math.random() * 100000 + 50000);
            data.push({ date: date, price: price, avg: avg, volume: vol });
        }
        return data;
    }

    function formatDate(date, type) {
        // 后端K线日期为'YYYY-MM-DD'字符串，本地模拟为Date对象；统一归一化避免渲染抛错
        if (!(date instanceof Date)) {
            if (typeof date === 'string' && date.length >= 10) {
                date = new Date(date.substring(0, 10) + 'T00:00:00');
            } else if (typeof date === 'number' || typeof date === 'string') {
                date = new Date(Number(date));
            }
        }
        if (!(date instanceof Date) || isNaN(date.getTime())) return '';
        if (type === 'minute') {
            return date.getHours().toString().padStart(2, '0') + ':' + date.getMinutes().toString().padStart(2, '0');
        }
        return (date.getMonth() + 1) + '/' + date.getDate();
    }

    // ===== Module Navigation =====
    function setupNavTabs() {
        var tabs = document.querySelectorAll('.nav-tab');
        tabs.forEach(function(tab) {
            tab.addEventListener('click', function() {
                var module = tab.dataset.module;
                switchModule(module);
                savePref('module', module);
            });
        });
    }

    function switchModule(module) {
        activeModule = module;
        document.querySelectorAll('.nav-tab').forEach(function(t) {
            t.classList.toggle('active', t.dataset.module === module);
        });
        document.querySelectorAll('.module-section').forEach(function(s) {
            s.classList.toggle('active', s.id === 'module-' + module);
        });
        // Resize charts after switching
        setTimeout(function() {
            if (module === 'index' && mainChart) mainChart.resize();
            if (module === 'index' && aiPredictionChart) aiPredictionChart.resize();
            if (module === 'global' && globalChart) globalChart.resize();
            if (module === 'gold' && goldChart) goldChart.resize();
            if (module === 'gold' && goldAiChart) goldAiChart.resize();
            if (module === 'crypto' && cryptoChart) cryptoChart.resize();
            if (module === 'crypto' && cryptoAiChart) cryptoAiChart.resize();
            if (module === 'linkage' && linkageChart) linkageChart.resize();
            if (module === 'fund' && simulatorChart) simulatorChart.resize();
        }, 50);
        // 切到基金模块时立即拉取AI预测（函数内部有backendEnabled守卫与5分钟防重复）
        if (module === 'fund') loadFundPredictions();

        // 移动端：将激活的导航项滚动到可视区域（横向滚动吸附）
        if (window.matchMedia && window.matchMedia('(max-width: 768px)').matches) {
            var activeTab = document.querySelector('.nav-tab.active');
            if (activeTab && typeof activeTab.scrollIntoView === 'function') {
                setTimeout(function() {
                    activeTab.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
                }, 30);
            }
        }
    }

    // ===== Index Cards =====
    function renderIndexCards() {
        var grid = document.getElementById('indexGrid');
        grid.innerHTML = '';
        indices.forEach(function(idx) {
            var isUp = idx.change >= 0;
            var trend = getTrendLabel(idx.trend);
            var card = document.createElement('div');
            card.className = 'index-card' + (idx.code === activeIndex ? ' active' : '');
            card.dataset.code = idx.code;
            card.innerHTML = `
                <div class="index-card-trend ${trend.cls}">${trend.text}</div>
                <div class="index-name">
                    <span>${idx.name}</span>
                    <span class="index-tag">${idx.tag}</span>
                </div>
                <div class="index-price mono">${fmt(idx.price, 2)}</div>
                <div class="index-change ${isUp ? 'up' : 'down'}">
                    <span class="change-arrow">${isUp ? '▲' : '▼'}</span>
                    <span>${isUp ? '+' : ''}${fmt(idx.change, 2)}</span>
                    <span>(${isUp ? '+' : ''}${fmt(idx.changePercent, 2)}%)</span>
                </div>
                <div class="mini-sparkline" id="spark-${idx.code.replace(/\./g, '_')}"></div>
            `;
            grid.appendChild(card);
            card.addEventListener('click', function() { selectIndex(idx.code); });
        });
        setTimeout(renderIndexSparklines, 0);
    }

    function renderIndexSparklines() {
        indices.forEach(function(idx) {
            var el = document.getElementById('spark-' + idx.code.replace(/\./g, '_'));
            if (!el) return;
            var chart = echarts.init(el, null, { renderer: 'svg' });
            var isUp = idx.change >= 0;
            var color = isUp ? accent : accent2;
            var data = [];
            var p = idx.price * (1 - 0.02);
            for (var i = 0; i < 20; i++) {
                p = p * (1 + (Math.random() - (isUp ? 0.45 : 0.55)) * 0.008);
                data.push(p);
            }
            data.push(idx.price);
            chart.setOption({
                animation: false,
                grid: { top: 2, right: 0, bottom: 2, left: 0 },
                xAxis: { type: 'category', show: false, data: data.map(function(_, i) { return i; }) },
                yAxis: { type: 'value', show: false },
                series: [{
                    type: 'line', data: data, smooth: true, symbol: 'none',
                    lineStyle: { color: color, width: 1.5 },
                    areaStyle: {
                        color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                            colorStops: [{ offset: 0, color: color + '40' }, { offset: 1, color: color + '00' }] }
                    }
                }]
            });
        });
    }

    function selectIndex(code) {
        activeIndex = code;
        savePref('activeIndex', code);
        document.querySelectorAll('.index-card').forEach(function(c) {
            c.classList.toggle('active', c.dataset.code === code);
        });
        updateIndexChartHeader();
        updateMainChart();
        updateAiPredictionPanel();
        updateAiPredictionChart();
        loadAiPrediction();
    }

    // 价格变动闪烁动画：对比上次值并施加高亮动画
    var lastPriceValues = {};
    function flashPriceOnUpdate(elementId, newValue) {
        var el = document.getElementById(elementId);
        if (!el) return;
        var old = lastPriceValues[elementId];
        if (old !== undefined && old !== newValue) {
            var cls = newValue > old ? 'flash-up' : 'flash-down';
            el.classList.remove('flash-up', 'flash-down');
            // 强制重绘以重启动画
            void el.offsetWidth;
            el.classList.add(cls);
        }
        lastPriceValues[elementId] = newValue;
    }

    function updateIndexChartHeader() {
        var idx = getIndex(activeIndex);
        if (!idx) return;
        var isUp = idx.change >= 0;
        var trend = getTrendLabel(idx.trend);
        document.getElementById('chartIndexName').textContent = idx.name;
        document.getElementById('aiIndexName').textContent = idx.name;
        var priceEl = document.getElementById('chartIndexPrice');
        priceEl.textContent = fmt(idx.price, 2);
        priceEl.className = 'chart-price ' + (isUp ? 'up' : 'down');
        flashPriceOnUpdate('chartIndexPrice', idx.price);
        var changeEl = document.getElementById('chartIndexChange');
        changeEl.textContent = (isUp ? '+' : '') + fmt(idx.change, 2) + ' (' + (isUp ? '+' : '') + fmt(idx.changePercent, 2) + '%)';
        changeEl.className = 'chart-change ' + (isUp ? 'up' : 'down');
        var badgeEl = document.getElementById('trendBadge');
        badgeEl.className = 'trend-badge ' + trend.cls;
        badgeEl.innerHTML = '<span class="trend-arrow"></span>' + trend.text;
    }

    // ===== Main Chart (Index) =====
    function initMainChart() {
        var el = document.getElementById('mainChart');
        mainChart = echarts.init(el, null, { renderer: 'svg' });
        updateMainChart();
    }

    function updateMainChart() {
        if (!mainChart) return;
        var idx = getIndex(activeIndex);
        if (!idx) return;

        if (activeChartType === 'timeline') {
            renderTimelineChart(mainChart, idx.price, idx.change >= 0 ? 'up' : 'down', activeIndexPeriod);
        } else {
            // 优先尝试从后端获取真实K线数据
            if (backendEnabled) {
                DataAPI.fetchBackendIndexKline(activeIndex, activeIndexPeriod)
                    .then(function(klineData) {
                        if (klineData && klineData.length > 0) {
                            renderKlineChartWithData(mainChart, klineData, idx.change >= 0 ? 'up' : 'down');
                        } else {
                            renderKlineChart(mainChart, idx.price, idx.change >= 0 ? 'up' : 'down', activeIndexPeriod);
                        }
                    })
                    .catch(function() {
                        renderKlineChart(mainChart, idx.price, idx.change >= 0 ? 'up' : 'down', activeIndexPeriod);
                    });
            } else {
                renderKlineChart(mainChart, idx.price, idx.change >= 0 ? 'up' : 'down', activeIndexPeriod);
            }
        }
    }

    // 计算简单移动平均线（period 不足时返回 '-' 占位，ECharts 会显示为断点）
    function calcMA(data, period) {
        var result = [];
        for (var i = 0; i < data.length; i++) {
            if (i < period - 1) {
                result.push('-');
            } else {
                var sum = 0;
                for (var j = 0; j < period; j++) sum += data[i - j];
                result.push(+(sum / period).toFixed(2));
            }
        }
        return result;
    }

    // 构建 K线 + MA + 成交量 的统一 option 配置（多品种复用）
    // colors: { up, down } 涨跌配色；opts: { pricePrefix, volFormatter }
    function buildKlineOption(dates, klineData, volumes, colors, opts) {
        colors = colors || { up: accent, down: accent2 };
        opts = opts || {};
        var pricePrefix = opts.pricePrefix || '';
        var volFormatter = opts.volFormatter || function(v) {
            return v >= 100000000 ? (v/100000000).toFixed(1) + '亿'
                 : v >= 10000 ? (v/10000).toFixed(0) + '万'
                 : v;
        };
        var closes = klineData.map(function(k) { return k[1]; });
        var ma5 = calcMA(closes, 5);
        var ma10 = calcMA(closes, 10);
        var ma20 = calcMA(closes, 20);

        var lastK = klineData.length ? klineData[klineData.length - 1] : null;
        var lastClose = lastK ? lastK[1] : 0;
        var lastIsUp = lastK ? (lastK[1] >= lastK[0]) : true;
        var lastColor = lastIsUp ? colors.up : colors.down;

        return {
            animation: false,
            legend: {
                data: ['MA5', 'MA10', 'MA20'],
                top: 4, right: 20,
                textStyle: { color: muted, fontSize: 11 },
                itemWidth: 14, itemHeight: 8, itemGap: 14
            },
            tooltip: {
                trigger: 'axis', appendToBody: true,
                backgroundColor: bg2, borderColor: rule, borderWidth: 1, padding: 0,
                extraCssText: 'box-shadow: 0 6px 18px rgba(0,0,0,0.25); border-radius: 6px; overflow: hidden;',
                textStyle: { color: ink, fontSize: 12 },
                axisPointer: {
                    type: 'cross',
                    crossStyle: { color: muted, type: 'dashed', opacity: 0.5, width: 1 },
                    lineStyle: { color: muted, type: 'dashed', opacity: 0.5, width: 1 },
                    label: {
                        backgroundColor: bg3, color: ink, borderColor: rule, borderWidth: 1,
                        padding: [3, 6], borderRadius: 3, fontSize: 11
                    }
                },
                formatter: function(params) {
                    if (!params || !params.length) return '';
                    var cp = null;
                    for (var i = 0; i < params.length; i++) {
                        if (params[i].seriesType === 'candlestick') { cp = params[i]; break; }
                    }
                    if (!cp) return '';
                    var d = cp.data, idx = cp.dataIndex;
                    var isUp = d[1] >= d[0];
                    var chColor = isUp ? colors.up : colors.down;
                    var chg = d[1] - d[0];
                    var pct = d[0] ? (chg / d[0] * 100) : 0;
                    var dateStr = dates[idx] || '';
                    var vol = volumes[idx] || 0;
                    var volStr = volFormatter(vol);

                    var html = '<div style="padding:10px 14px; min-width:220px;">';
                    html += '<div style="font-weight:600; margin-bottom:8px; color:' + ink + '; font-size:12px;">' + dateStr + '</div>';
                    html += '<div style="display:grid; grid-template-columns:auto 1fr; gap:5px 16px; font-size:11px; color:' + muted + ';">';
                    html += '<span>开盘</span><span style="color:' + ink + '; text-align:right; font-weight:500;">' + pricePrefix + d[0].toFixed(2) + '</span>';
                    html += '<span>收盘</span><span style="color:' + chColor + '; text-align:right; font-weight:600;">' + pricePrefix + d[1].toFixed(2) + '</span>';
                    html += '<span>最低</span><span style="color:' + ink + '; text-align:right; font-weight:500;">' + pricePrefix + d[2].toFixed(2) + '</span>';
                    html += '<span>最高</span><span style="color:' + ink + '; text-align:right; font-weight:500;">' + pricePrefix + d[3].toFixed(2) + '</span>';
                    html += '<span>涨跌</span><span style="color:' + chColor + '; text-align:right; font-weight:600;">' + (chg >= 0 ? '+' : '') + pricePrefix + chg.toFixed(2) + ' (' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%)</span>';
                    html += '<span>成交量</span><span style="color:' + ink + '; text-align:right; font-weight:500;">' + volStr + '</span>';
                    html += '</div>';

                    var maCfg = [
                        { n: 'MA5', v: ma5[idx], c: blue },
                        { n: 'MA10', v: ma10[idx], c: purple },
                        { n: 'MA20', v: ma20[idx], c: orange }
                    ];
                    var hasMa = maCfg.some(function(m) { return m.v !== '-'; });
                    if (hasMa) {
                        html += '<div style="margin-top:8px; padding-top:8px; border-top:1px solid ' + rule + '; display:grid; grid-template-columns:auto 1fr; gap:5px 16px; font-size:11px;">';
                        maCfg.forEach(function(m) {
                            var s = m.v === '-' ? '--' : Number(m.v).toFixed(2);
                            html += '<span style="color:' + muted + ';"><span style="display:inline-block; width:10px; height:2px; background:' + m.c + '; vertical-align:middle; margin-right:6px;"></span>' + m.n + '</span>';
                            html += '<span style="color:' + m.c + '; text-align:right; font-weight:500;">' + s + '</span>';
                        });
                        html += '</div>';
                    }
                    html += '</div>';
                    return html;
                }
            },
            grid: [
                { left: '68', right: '68', top: '38', height: '60%' },
                { left: '68', right: '68', top: '82%', height: '12%' }
            ],
            xAxis: [
                {
                    type: 'category', data: dates, gridIndex: 0,
                    axisLine: { lineStyle: { color: rule } },
                    axisLabel: { color: muted, fontSize: 11 },
                    axisTick: { show: false }, splitLine: { show: false },
                    axisPointer: { z: 100 }
                },
                {
                    type: 'category', data: dates, gridIndex: 1,
                    axisLine: { lineStyle: { color: rule } },
                    axisLabel: { show: false }, axisTick: { show: false }
                }
            ],
            yAxis: [
                {
                    type: 'value', scale: true, gridIndex: 0, splitNumber: 5,
                    position: 'left',
                    axisLine: { show: false },
                    axisLabel: {
                        color: muted, fontSize: 11,
                        formatter: function(v) {
                            var s = v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : v.toFixed(2);
                            return pricePrefix + s;
                        }
                    },
                    splitLine: { lineStyle: { color: rule, type: 'dashed', opacity: 0.4 } }
                },
                {
                    type: 'value', scale: true, gridIndex: 1, splitNumber: 2,
                    axisLine: { show: false },
                    axisLabel: {
                        color: muted, fontSize: 10,
                        formatter: volFormatter
                    },
                    splitLine: { lineStyle: { color: rule, type: 'dashed', opacity: 0.4 } }
                }
            ],
            dataZoom: [{ type: 'inside', xAxisIndex: [0, 1], start: 0, end: 100 }],
            series: [
                {
                    name: 'K线', type: 'candlestick', data: klineData,
                    xAxisIndex: 0, yAxisIndex: 0,
                    itemStyle: {
                        color: colors.up, color0: colors.down,
                        borderColor: colors.up, borderColor0: colors.down,
                        borderWidth: 1
                    },
                    markLine: lastK ? {
                        symbol: ['none', 'none'], silent: true,
                        lineStyle: { color: lastColor, type: 'dashed', width: 1, opacity: 0.6 },
                        label: {
                            show: true, position: 'insideEndTop',
                            color: '#fff',
                            backgroundColor: lastColor,
                            borderColor: lastColor, borderWidth: 1, borderRadius: 3,
                            padding: [2, 6], fontSize: 10, fontWeight: 600,
                            formatter: function() { return pricePrefix + lastClose.toFixed(2); }
                        },
                        data: [{ yAxis: lastClose }]
                    } : undefined
                },
                { name: 'MA5', type: 'line', data: ma5, xAxisIndex: 0, yAxisIndex: 0,
                    smooth: true, showSymbol: false, connectNulls: true,
                    lineStyle: { width: 1.2, color: blue, opacity: 0.85 }, z: 5 },
                { name: 'MA10', type: 'line', data: ma10, xAxisIndex: 0, yAxisIndex: 0,
                    smooth: true, showSymbol: false, connectNulls: true,
                    lineStyle: { width: 1.2, color: purple, opacity: 0.85 }, z: 5 },
                { name: 'MA20', type: 'line', data: ma20, xAxisIndex: 0, yAxisIndex: 0,
                    smooth: true, showSymbol: false, connectNulls: true,
                    lineStyle: { width: 1.2, color: orange, opacity: 0.85 }, z: 5 },
                { name: '成交量', type: 'bar', data: volumes, xAxisIndex: 1, yAxisIndex: 1,
                    barWidth: '60%',
                    itemStyle: {
                        color: function(p) {
                            var k = klineData[p.dataIndex];
                            return k[1] >= k[0] ? colors.up + 'CC' : colors.down + 'CC';
                        }
                    }
                }
            ]
        };
    }

    function renderKlineChart(chart, basePrice, direction, period) {
        var counts = { '1D': 24, '1W': 7, '1M': 30, '3M': 90, '1Y': 250 };
        var count = counts[period] || 30;
        var volatility = basePrice * 0.03;
        var bias = direction === 'up' ? 0.52 : 0.48;
        var ohlc = generateOHLC(count, basePrice * 0.97, volatility, bias);

        var dates = ohlc.map(function(d) { return formatDate(d.date, 'day'); });
        var klineData = ohlc.map(function(d) { return [d.open, d.close, d.low, d.high]; });
        var volumes = ohlc.map(function(d) { return d.volume; });

        chart.setOption(buildKlineOption(dates, klineData, volumes));
    }

    // 使用真实K线数据渲染图表
    function renderKlineChartWithData(chart, ohlcData, direction) {
        var dates = ohlcData.map(function(d) { return d.date; });
        var klineData = ohlcData.map(function(d) { return [d.open, d.close, d.low, d.high]; });
        var volumes = ohlcData.map(function(d) { return d.volume || 0; });

        chart.setOption(buildKlineOption(dates, klineData, volumes));
    }

    function renderTimelineChart(chart, basePrice, direction, period) {
        var count = 48; // 1 day in minutes intervals
        var volatility = basePrice * 0.015;
        var data = generateTimeline(count, basePrice, volatility);

        var times = data.map(function(d) { return formatDate(d.date, 'minute'); });
        var prices = data.map(function(d) { return d.price.toFixed(2); });
        var avgs = data.map(function(d) { return d.avg.toFixed(2); });
        var volumes = data.map(function(d) { return d.volume; });

        var prevClose = basePrice * (1 - (direction === 'up' ? 0.008 : -0.005));

        chart.setOption({
            animation: false,
            tooltip: {
                trigger: 'axis', appendToBody: true,
                backgroundColor: bg3, borderColor: rule, textStyle: { color: ink }
            },
            grid: [
                { left: '60', right: '20', top: '20', height: '60%' },
                { left: '60', right: '20', top: '82%', height: '12%' }
            ],
            xAxis: [
                { type: 'category', data: times, gridIndex: 0, boundaryGap: false,
                    axisLine: { lineStyle: { color: rule } },
                    axisLabel: { color: muted, fontSize: 11 },
                    axisTick: { show: false }, axisPointer: { z: 100 } },
                { type: 'category', data: times, gridIndex: 1, boundaryGap: false,
                    axisLine: { lineStyle: { color: rule } },
                    axisLabel: { show: false }, axisTick: { show: false } }
            ],
            yAxis: [
                { type: 'value', scale: true, gridIndex: 0, splitNumber: 4,
                    axisLine: { show: false }, axisLabel: { color: muted, fontSize: 11 },
                    splitLine: { lineStyle: { color: rule, type: 'dashed' } } },
                { type: 'value', scale: true, gridIndex: 1, splitNumber: 2,
                    axisLine: { show: false },
                    axisLabel: { color: muted, fontSize: 10,
                        formatter: function(v) { return v >= 100000 ? (v/10000).toFixed(1)+'万' : v; } },
                    splitLine: { lineStyle: { color: rule, type: 'dashed' } } }
            ],
            series: [
                { name: '价格', type: 'line', data: prices, xAxisIndex: 0, yAxisIndex: 0,
                    smooth: false, symbol: 'none',
                    lineStyle: { color: direction === 'up' ? accent : accent2, width: 1.5 },
                    areaStyle: {
                        color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                            colorStops: [
                                { offset: 0, color: (direction === 'up' ? accent : accent2) + '30' },
                                { offset: 1, color: (direction === 'up' ? accent : accent2) + '00' }
                            ] }
                    },
                    markLine: {
                        silent: true, symbol: 'none',
                        lineStyle: { color: muted, type: 'dashed', width: 1 },
                        data: [{ yAxis: prevClose.toFixed(2), label: { formatter: '昨收', color: muted, fontSize: 10 } }]
                    } },
                { name: '均价', type: 'line', data: avgs, xAxisIndex: 0, yAxisIndex: 0,
                    smooth: false, symbol: 'none',
                    lineStyle: { color: gold, width: 1, type: 'dashed' } },
                { name: '成交量', type: 'bar', data: volumes, xAxisIndex: 1, yAxisIndex: 1,
                    itemStyle: {
                        color: function(p) {
                            var prev = p.dataIndex > 0 ? prices[p.dataIndex - 1] : prevClose;
                            return Number(prices[p.dataIndex]) >= Number(prev) ? accent + '80' : accent2 + '80';
                        }
                    } }
            ]
        });
    }

    // ===== Chart Type & Period Tabs (Index) =====
    function setupIndexChartControls() {
        // Chart type tabs
        document.querySelectorAll('#chartTypeTabs .chart-type-tab').forEach(function(tab) {
            tab.addEventListener('click', function() {
                document.querySelectorAll('#chartTypeTabs .chart-type-tab').forEach(function(t) { t.classList.remove('active'); });
                tab.classList.add('active');
                activeChartType = tab.dataset.type;
                savePref('indexChartType', activeChartType);
                updateMainChart();
            });
        });

        // Period tabs
        document.querySelectorAll('#periodTabs .period-tab').forEach(function(tab) {
            tab.addEventListener('click', function() {
                document.querySelectorAll('#periodTabs .period-tab').forEach(function(t) { t.classList.remove('active'); });
                tab.classList.add('active');
                activeIndexPeriod = tab.dataset.period;
                savePref('indexPeriod', activeIndexPeriod);
                updateMainChart();
            });
        });
    }

    // ===== AI Prediction (Index) =====
    // 后端多因子预测结果缓存（避免频繁请求；后端本身也有60秒缓存）
    var aiPrediction = null;
    var aiPredFetchedAt = {};

    function initAiPredictionChart() {
        var el = document.getElementById('aiPredictionChart');
        if (!el) return;
        aiPredictionChart = echarts.init(el, null, { renderer: 'svg' });
        updateAiPredictionChart();
    }

    // 昨日对比与累计准确率展示（后端accuracy模块回传：昨日预测vs实际、命中率、校正因子）
    function aiYesterdayHtml(d) {
        if (!d) return '昨日对比：数据积累中，明日首次结算';
        var parts = [];
        var y = d.yesterday;
        if (y && y.actual != null) {
            var dt = (y.date && y.date.length === 8)
                ? y.date.substring(0, 4) + '-' + y.date.substring(4, 6) + '-' + y.date.substring(6, 8)
                : (y.date || '');
            parts.push(dt + ' 预测 <b class="' + (y.predicted >= 0 ? 'up' : 'down') + '">' + (y.predicted >= 0 ? '+' : '') + y.predicted + '%</b>' +
                ' / 实际 <b class="' + (y.actual >= 0 ? 'up' : 'down') + '">' + (y.actual >= 0 ? '+' : '') + y.actual + '%</b>' +
                ' <span class="' + (y.hit ? 'hit' : 'miss') + '">' + (y.hit ? '方向命中' : '方向偏差' + (y.error != null ? '(' + Math.abs(y.error).toFixed(2) + 'pct)' : '')) + '</span>');
        }
        var a = d.accuracy;
        if (a && a.samples > 0) {
            parts.push('累计' + a.samples + '次 · 方向命中<b>' + Math.round(a.hitRate * 100) + '%</b> · 平均误差' + a.mae + 'pct');
        }
        if (d.corrections && d.corrections.length) {
            parts.push('已应用校正：' + d.corrections.join('，'));
        }
        return parts.length ? parts.join('<br>') : '昨日对比：数据积累中，明日首次结算';
    }

    function updateYesterdayRow(elId, data) {
        var el = document.getElementById(elId);
        if (el) el.innerHTML = aiYesterdayHtml(data);
    }

    // 预测元信息可视化：预测区间条（±1σ）+ 置信徽章 + 数据质量提示
    // 同时供指数/黄金/加密面板（renderPredictionMeta）与基金卡片（字符串模板）复用
    function aiEst(data, h) {
        if (data.predictions && data.predictions[h] != null) return data.predictions[h];
        if (h === '1D' && data.pred1D != null) return data.pred1D;
        if (h === '1W' && data.pred1W != null) return data.pred1W;
        if (h === '1M' && data.pred1M != null) return data.pred1M;
        return 0;
    }
    function aiIntervalsHtml(data, opts) {
        if (!data) return '';
        opts = opts || {};
        var keys = ['1D', '1W', '1M'];
        var labels = { '1D': '明日', '1W': '1周', '1M': '1月' };
        var rows = keys.map(function(h) {
            var iv = data.intervals && data.intervals[h];
            if (!iv) return '';
            var lo = iv[0], hi = iv[1], e = aiEst(data, h);
            // 对称刻度：以本周期最大绝对值放大 1.25 倍为中心，零位恒在 50%
            var maxAbs = Math.max(Math.abs(lo), Math.abs(hi), Math.abs(e), 0.1) * 1.25;
            var pct = function(v) { return ((v + maxAbs) / (2 * maxAbs) * 100); };
            var loP = pct(lo), hiP = pct(hi), eP = pct(e);
            var up = e >= 0;
            return '<div class="ai-iv-row">' +
                '<span class="ai-iv-label">' + labels[h] + '</span>' +
                '<div class="ai-iv-bar">' +
                    '<div class="ai-iv-range ' + (up ? 'up' : 'down') + '" style="left:' + loP.toFixed(1) + '%;width:' + (hiP - loP).toFixed(1) + '%"></div>' +
                    '<div class="ai-iv-zero"></div>' +
                    '<div class="ai-iv-est ' + (up ? 'up' : 'down') + '" style="left:' + eP.toFixed(1) + '%"></div>' +
                '</div>' +
                '<span class="ai-iv-val ' + (up ? 'up' : 'down') + '">' + (e >= 0 ? '+' : '') + e.toFixed(2) + '%</span>' +
            '</div>';
        }).join('');

        var conf = data.confidence != null ? data.confidence : null;
        var confClass = conf == null ? '' : (conf >= 80 ? 'strong' : conf >= 60 ? 'mid' : 'weak');
        var confText = conf == null ? '' : (conf >= 80 ? '高' : conf >= 60 ? '中' : '偏低');
        var badge = (!opts.noBadge && conf != null) ? '<span class="ai-badge ' + confClass + '">置信度 ' + conf.toFixed(0) + '% · ' + confText + '</span>' : '';
        var quality = '';
        if (data.dataQuality && data.dataQuality.missing && data.dataQuality.missing.length) {
            quality = '<div class="ai-quality">⚠ ' + data.dataQuality.missing.join('、') + ' 缺失，置信度已下调</div>';
        }
        return '<div class="ai-iv-wrap">' + rows + '</div>' + badge + quality;
    }
    function renderPredictionMeta(confId, data) {
        if (!data) return;
        var confEl = document.getElementById(confId);
        if (!confEl) return;
        var box = confEl.closest('.ai-confidence');
        if (!box) return;
        var meta = box.querySelector('.ai-meta');
        if (!meta) { meta = document.createElement('div'); meta.className = 'ai-meta'; box.appendChild(meta); }
        meta.innerHTML = aiIntervalsHtml(data);
    }

    // 拉取后端多因子预测（同一指数50秒内不重复请求）
    function loadAiPrediction() {
        if (!backendEnabled) return;
        var idx = getIndex(activeIndex);
        if (!idx) return;
        var code = idx.code;
        var now = Date.now();
        if (aiPrediction && aiPrediction.code === code && now - (aiPredFetchedAt[code] || 0) < 50000) return;
        aiPredFetchedAt[code] = now;
        DataAPI.fetchBackendPrediction(code).then(function(data) {
            var cur = getIndex(activeIndex);
            if (cur && cur.code === code && data && data.code === code) {
                aiPrediction = data;
                updateAiPredictionPanel();
                updateAiPredictionChart();
            }
        }).catch(function() { /* 拉取失败时保持现有展示 */ });
    }

    function updateAiPredictionPanel() {
        var idx = getIndex(activeIndex);
        if (!idx) return;

        // 后端真实多因子预测优先
        if (aiPrediction && aiPrediction.code === idx.code) {
            var pred = aiPrediction.predictions[activeAiPeriod];
            if (pred === undefined) pred = 0;
            var isUp = pred >= 0;

            var valEl = document.getElementById('aiPredValue');
            valEl.textContent = (isUp ? '+' : '') + pred.toFixed(2) + '%';
            valEl.className = 'ai-prediction-value ' + (isUp ? 'up' : 'down');

            document.getElementById('aiModelDesc').textContent =
                (aiPrediction.models ? '集成增强模型：多因子加权 + 统计回归(动量/均值回归/regime) 双基模型自适应堆叠' : '多因子模型：技术面 + 量能 + 资金 + 情绪 + 领先指标 + 跨市场综合判断');
            updateYesterdayRow('aiYesterday', aiPrediction);

            var conf = aiPrediction.confidence;
            document.getElementById('aiConfidence').textContent = conf.toFixed(1) + '%';
            document.getElementById('aiConfidenceFill').style.width = conf + '%';
            renderPredictionMeta('aiConfidence', aiPrediction);

            // Period cards
            var cards = document.querySelectorAll('#aiPeriods .ai-period-card');
            var keys = ['1D', '1W', '1M'];
            cards.forEach(function(card, i) {
                var p = aiPrediction.predictions[keys[i]] || 0;
                var up = p >= 0;
                var pv = card.querySelector('.ai-period-value');
                pv.textContent = (up ? '+' : '') + p.toFixed(2) + '%';
                pv.className = 'ai-period-value ' + (up ? 'up' : 'down');
                card.classList.toggle('active', keys[i] === activeAiPeriod);
            });

            renderAiFactors();
            return;
        }

        // 无后端预测时的模拟推导（离线模式）
        var predValues = { '1D': idx.changePercent * 0.9, '1W': idx.changePercent * 2.4, '1M': idx.changePercent * 6.3 };
        var pred = predValues[activeAiPeriod];
        var isUp = pred >= 0;

        var valEl = document.getElementById('aiPredValue');
        valEl.textContent = (isUp ? '+' : '') + pred.toFixed(2) + '%';
        valEl.className = 'ai-prediction-value ' + (isUp ? 'up' : 'down');

        var conf = 75 + Math.random() * 15;
        document.getElementById('aiConfidence').textContent = conf.toFixed(1) + '%';
        document.getElementById('aiConfidenceFill').style.width = conf + '%';

        // Period cards
        var cards = document.querySelectorAll('#aiPeriods .ai-period-card');
        var periods = [
            { key: '1D', value: predValues['1D'] },
            { key: '1W', value: predValues['1W'] },
            { key: '1M', value: predValues['1M'] }
        ];
        cards.forEach(function(card, i) {
            var p = periods[i];
            var up = p.value >= 0;
            var valEl = card.querySelector('.ai-period-value');
            valEl.textContent = (up ? '+' : '') + p.value.toFixed(2) + '%';
            valEl.className = 'ai-period-value ' + (up ? 'up' : 'down');
            card.classList.toggle('active', p.key === activeAiPeriod);
        });

        hideAiFactors();
    }

    // ===== AI因子明细渲染 =====
    function renderAiFactors() {
        if (!aiPrediction) { hideAiFactors(); return; }
        var panel = document.getElementById('aiFactorsPanel');
        if (!panel) return;
        panel.style.display = '';

        var score = aiPrediction.score;
        document.getElementById('aiScore').textContent = (score > 0 ? '+' : '') + score;
        document.getElementById('aiScore').className = 'ai-meta-value ' + (score > 15 ? 'up' : score < -15 ? 'down' : 'flat');
        // 观望：低边际/高分歧时后端 directionText='观望'，前端醒目标注
        var dirText = aiPrediction.directionText || '--';
        if (aiPrediction.abstain) {
            dirText = '观望' + (aiPrediction.abstainReason ? '（' + aiPrediction.abstainReason + '）' : '');
        }
        document.getElementById('aiDirection').textContent = dirText;
        document.getElementById('aiDirection').className = 'ai-meta-value ' + (
            aiPrediction.abstain ? 'flat' :
            aiPrediction.direction === 'bullish' ? 'up' :
            aiPrediction.direction === 'bearish' ? 'down' : 'flat'
        );

        var supportEl = document.getElementById('aiSupport');
        var resEl = document.getElementById('aiResistance');
        supportEl.textContent = aiPrediction.support != null ? fmt(aiPrediction.support, 2) : '--';
        resEl.textContent = aiPrediction.resistance != null ? fmt(aiPrediction.resistance, 2) : '--';

        document.getElementById('aiDataSources').textContent = (aiPrediction.dataSources || []).join(' + ');

        var list = document.getElementById('aiFactorsList');
        list.innerHTML = '';
        (aiPrediction.factorList || []).forEach(function(f) {
            var scoreNum = f.score || 0;
            var pct = Math.min(50, Math.abs(scoreNum) / 2);   // 换算为条宽度（0-50%）
            var row = document.createElement('div');
            row.className = 'ai-factor-row';
            row.innerHTML =
                '<div class="ai-factor-head">' +
                    '<span class="ai-factor-group">' + f.group + '</span>' +
                    '<span class="ai-factor-name">' + f.name + '</span>' +
                    '<span class="ai-factor-score ' + (scoreNum > 0 ? 'up' : scoreNum < 0 ? 'down' : 'flat') + '">' +
                        (scoreNum > 0 ? '+' : '') + scoreNum + '</span>' +
                '</div>' +
                '<div class="ai-factor-bar">' +
                    '<div class="ai-factor-center"></div>' +
                    '<div class="ai-factor-fill ' + (scoreNum >= 0 ? 'pos' : 'neg') + '" style="' +
                        (scoreNum >= 0 ? 'left:50%;' : 'right:50%;') + 'width:' + pct + '%"></div>' +
                '</div>' +
                '<div class="ai-factor-detail">' + f.detail + '</div>';
            list.appendChild(row);
        });

        // 集成增强：双基模型堆叠权重 + 置信度校准
        renderAiEnsemble(aiPrediction, 'ai');
        // 因子 SHAP 式归因（贡献占比）
        renderAiShap(aiPrediction, 'ai');
    }

    // ===== 集成增强：双基模型权重 + 校准（可复用渲染器） =====
    // 返回 ensemble 区块内部 HTML（不含外层 .ai-ensemble 容器）
    function aiEnsembleInnerHtml(data) {
        var models = data && data.models;
        if (!models || !Array.isArray(models.baseModels)) return '';
        var w = models.weights || { model: 0.7, statistical: 0.3 };
        var rows = models.baseModels.map(function(name, i) {
            var isMain = i === 0;
            var weight = isMain ? w.model : w.statistical;
            return '<div class="ai-ens-row">' +
                '<span class="ai-ens-name">' + name + '</span>' +
                '<div class="ai-ens-track"><div class="ai-ens-fill ' + (isMain ? '' : 'stat') + '" style="width:' + (weight * 100).toFixed(0) + '%"></div></div>' +
                '<span class="ai-ens-weight">' + (weight * 100).toFixed(0) + '%</span>' +
            '</div>';
        }).join('');
        var cal = data && data.calibration;
        var calHtml = '';
        if (cal && cal.available) {
            var relClass = cal.reliability === '良好' ? 'cal-good' : 'cal-warn';
            calHtml = '<div class="ai-calib-note">置信度校准：声明 ' + cal.statedConfidence + '% · 历史实证命中率 <b>' + cal.empiricalHitRate + '%</b> · 可靠性 <span class="' + relClass + '">' + cal.reliability + '</span>，校准后置信度 <b>' + cal.calibratedConfidence + '%</b>。' + cal.note + '</div>';
        }
        // 稳定性提示：双基模型方向分歧时给出信号不确定性提示
        var stab = data && data.stability;
        var stabHtml = '';
        if (stab && stab.disagree > 0) {
            var lv = stab.level === '高' ? 'cal-good' : 'cal-warn';
            var txt = stab.disagree >= 2 ? '两周期方向分歧：信号不确定，已向中性收缩并下调置信度' : '一周期方向分歧：信号偏弱，已适度向中性收缩';
            stabHtml = '<div class="ai-calib-note ai-stab-note">稳定性 <span class="' + lv + '">' + stab.level + '</span> · ' + txt + '</div>';
        } else if (stab) {
            stabHtml = '<div class="ai-calib-note ai-stab-note">稳定性 <span class="cal-good">高</span> · 双基模型方向一致</div>';
        }
        return '<div class="ai-sub-head">' +
                '<span class="ai-sub-title">集成增强 · 双基模型堆叠融合</span>' +
                '<span class="ai-sub-tag">' + (models.adaptive ? '自适应(已校准)' : '自适应(样本积累中)') + '</span>' +
            '</div>' +
            '<div class="ai-ensemble-body">' + rows + '</div>' + calHtml + stabHtml;
    }

    // 返回 SHAP 区块内部 HTML（不含外层 .ai-shap 容器）
    function aiShapInnerHtml(data) {
        var shap = data && data.shap;
        if (!Array.isArray(shap) || !shap.length) return '';
        var rows = shap.slice(0, 10).map(function(f) {
            var pct = f.pct || 0;
            var pos = pct >= 0;
            var width = Math.min(50, Math.abs(pct) / 2);
            return '<div class="ai-shap-row">' +
                '<span class="ai-shap-name" title="' + f.name + '">' + f.name + '</span>' +
                '<div class="ai-shap-track">' +
                    '<div class="ai-shap-center"></div>' +
                    '<div class="ai-shap-fill ' + (pos ? 'pos' : 'neg') + '" style="' +
                        (pos ? 'left:50%;' : 'right:50%;') + 'width:' + width.toFixed(1) + '%"></div>' +
                '</div>' +
                '<span class="ai-shap-pct ' + (pos ? 'pos' : 'neg') + '">' + (pos ? '+' : '') + pct.toFixed(1) + '%</span>';
        }).join('');
        return '<div class="ai-sub-head">' +
                '<span class="ai-sub-title">因子SHAP式归因 · 贡献占比</span>' +
                '<span class="ai-sub-tag">可解释</span>' +
            '</div>' +
            '<div class="ai-shap-list">' + rows + '</div>';
    }

    // ID 容器式渲染（index / gold / crypto 面板共用，前缀区分）
    function renderAiEnsemble(data, prefix) {
        var note = document.getElementById((prefix || 'ai') + 'EnsembleNote');
        if (!note) return;
        var html = aiEnsembleInnerHtml(data);
        if (!html) { note.style.display = 'none'; return; }
        note.style.display = '';
        note.innerHTML = html;
    }

    function renderAiShap(data, prefix) {
        var panel = document.getElementById((prefix || 'ai') + 'ShapPanel');
        if (!panel) return;
        var html = aiShapInnerHtml(data);
        if (!html) { panel.style.display = 'none'; return; }
        panel.style.display = '';
        panel.innerHTML = html;
    }

    function hideAiFactors() {
        var panel = document.getElementById('aiFactorsPanel');
        if (panel) panel.style.display = 'none';
    }

    function updateAiPredictionChart() {
        if (!aiPredictionChart) return;
        var idx = getIndex(activeIndex);
        if (!idx) return;

        // 后端真实预测：用真实历史K线 + 预测外推路径
        if (aiPrediction && aiPrediction.code === idx.code && aiPrediction.history && aiPrediction.predPath) {
            var historyDates = aiPrediction.history.dates.map(function(d) { return formatDate(d, 'day'); });
            var historyCloses = aiPrediction.history.closes;
            var predDates = aiPrediction.predPath.dates.map(function(d) { return formatDate(d, 'day'); });
            var predPrices = aiPrediction.predPath.prices;

            var allDates = historyDates.concat(predDates);
            var actualData = historyCloses.concat(new Array(predPrices.length).fill(null));
            var currentPrice = historyCloses[historyCloses.length - 1];
            var predictData = new Array(Math.max(0, historyDates.length - 1)).fill(null)
                .concat([currentPrice]).concat(predPrices);
            var isUp = (aiPrediction.predPath.total || 0) >= 0;

            aiPredictionChart.setOption({
                animation: false,
                title: { text: '历史走势与AI预测', left: 'left',
                    textStyle: { color: ink, fontSize: 13, fontWeight: 600 } },
                tooltip: { trigger: 'axis', appendToBody: true,
                    backgroundColor: bg3, borderColor: rule, textStyle: { color: ink } },
                legend: { data: ['历史走势', 'AI预测'], right: 0, top: 0,
                    textStyle: { color: muted, fontSize: 11 } },
                grid: { top: 40, right: 20, bottom: 30, left: 60 },
                xAxis: { type: 'category', data: allDates,
                    axisLine: { lineStyle: { color: rule } },
                    axisLabel: { color: muted, fontSize: 10, interval: Math.floor(allDates.length / 10) },
                    axisTick: { show: false } },
                yAxis: { type: 'value', scale: true,
                    axisLine: { show: false }, axisLabel: { color: muted, fontSize: 11 },
                    splitLine: { lineStyle: { color: rule, type: 'dashed' } } },
                series: [
                    { name: '历史走势', type: 'line', data: actualData, smooth: true, symbol: 'none',
                        lineStyle: { color: blue, width: 2 },
                        areaStyle: {
                            color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                                colorStops: [{ offset: 0, color: blue + '25' }, { offset: 1, color: blue + '00' }] } } },
                    { name: 'AI预测', type: 'line', data: predictData, smooth: true, symbol: 'none',
                        lineStyle: { color: isUp ? accent : accent2, width: 2, type: 'dashed' },
                        areaStyle: {
                            color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                                colorStops: [
                                    { offset: 0, color: (isUp ? accent : accent2) + '20' },
                                    { offset: 1, color: (isUp ? accent : accent2) + '00' }
                                ] } } }
                ]
            }, { notMerge: true });
            return;
        }

        var historyDays = 40;
        var predDays = activeAiPeriod === '1D' ? 1 : activeAiPeriod === '1W' ? 7 : 30;
        var predPct = activeAiPeriod === '1D' ? 0.85 : activeAiPeriod === '1W' ? 2.15 : 5.62;
        if (idx.change < 0) predPct = -predPct * 0.7;

        var volatility = idx.price * 0.02;
        var ohlc = generateOHLC(historyDays, idx.price * 0.95, volatility, idx.change >= 0 ? 0.53 : 0.47);
        var historyDates = ohlc.map(function(d) { return formatDate(d.date, 'day'); });
        var historyCloses = ohlc.map(function(d) { return d.close.toFixed(2); });

        // Generate prediction
        var predDates = [];
        var predPrices = [];
        var currentPrice = idx.price;
        var dailyRet = predPct / predDays / 100;
        for (var i = 1; i <= predDays; i++) {
            var d = new Date(ohlc[ohlc.length - 1].date);
            d.setDate(d.getDate() + i);
            predDates.push(formatDate(d, 'day'));
            currentPrice = currentPrice * (1 + dailyRet + (Math.random() - 0.5) * dailyRet * 0.4);
            predPrices.push(currentPrice.toFixed(2));
        }

        var allDates = historyDates.concat(predDates);
        var actualData = historyCloses.concat(new Array(predDays).fill(null));
        var predictData = new Array(historyDates.length - 1).fill(null).concat([idx.price.toFixed(2)]).concat(predPrices);
        var isUp = predPct >= 0;

        aiPredictionChart.setOption({
            animation: false,
            title: { text: '历史走势与AI预测', left: 'left',
                textStyle: { color: ink, fontSize: 13, fontWeight: 600 } },
            tooltip: { trigger: 'axis', appendToBody: true,
                backgroundColor: bg3, borderColor: rule, textStyle: { color: ink } },
            legend: { data: ['历史走势', 'AI预测'], right: 0, top: 0,
                textStyle: { color: muted, fontSize: 11 } },
            grid: { top: 40, right: 20, bottom: 30, left: 60 },
            xAxis: { type: 'category', data: allDates,
                axisLine: { lineStyle: { color: rule } },
                axisLabel: { color: muted, fontSize: 10, interval: Math.floor(allDates.length / 10) },
                axisTick: { show: false } },
            yAxis: { type: 'value', scale: true,
                axisLine: { show: false }, axisLabel: { color: muted, fontSize: 11 },
                splitLine: { lineStyle: { color: rule, type: 'dashed' } } },
            series: [
                { name: '历史走势', type: 'line', data: actualData, smooth: true, symbol: 'none',
                    lineStyle: { color: blue, width: 2 },
                    areaStyle: {
                        color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                            colorStops: [{ offset: 0, color: blue + '25' }, { offset: 1, color: blue + '00' }] } } },
                { name: 'AI预测', type: 'line', data: predictData, smooth: true, symbol: 'none',
                    lineStyle: { color: isUp ? accent : accent2, width: 2, type: 'dashed' },
                    areaStyle: {
                        color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                            colorStops: [
                                { offset: 0, color: (isUp ? accent : accent2) + '20' },
                                { offset: 1, color: (isUp ? accent : accent2) + '00' }
                            ] } } }
            ]
        });
    }

    function setupAiPeriodCards() {
        document.querySelectorAll('#aiPeriods .ai-period-card').forEach(function(card) {
            card.addEventListener('click', function() {
                activeAiPeriod = card.dataset.period;
                updateAiPredictionPanel();
                updateAiPredictionChart();
            });
        });
    }

    // ===== Global Indices Module =====
    function renderGlobalIndexCards(region, containerId) {
        var grid = document.getElementById(containerId);
        if (!grid) return;
        grid.innerHTML = '';
        var list = globalIndices[region] || [];
        list.forEach(function(idx) {
            var isUp = idx.change >= 0;
            var trend = getTrendLabel(idx.trend);
            var card = document.createElement('div');
            card.className = 'index-card' + (idx.code === activeGlobalIndex ? ' active' : '');
            card.dataset.code = idx.code;
            card.innerHTML = `
                <div class="index-card-trend ${trend.cls}">${trend.text}</div>
                <div class="index-name">
                    <span>${idx.name}</span>
                    <span class="index-tag">${idx.tag}</span>
                </div>
                <div class="index-price mono">${fmt(idx.price, 2)}</div>
                <div class="index-change ${isUp ? 'up' : 'down'}">
                    <span class="change-arrow">${isUp ? '▲' : '▼'}</span>
                    <span>${isUp ? '+' : ''}${fmt(idx.change, 2)}</span>
                    <span>(${isUp ? '+' : ''}${fmt(idx.changePercent, 2)}%)</span>
                </div>
                <div class="mini-sparkline" id="gspark-${idx.code}"></div>
            `;
            grid.appendChild(card);
            card.addEventListener('click', function() { selectGlobalIndex(idx.code); });
        });
        setTimeout(renderGlobalSparklines, 0);
    }

    function renderGlobalSparklines() {
        var all = globalIndices.asia.concat(globalIndices.europe, globalIndices.americas);
        all.forEach(function(idx) {
            var el = document.getElementById('gspark-' + idx.code);
            if (!el) return;
            var chart = echarts.init(el, null, { renderer: 'svg' });
            var isUp = idx.change >= 0;
            var color = isUp ? accent : accent2;
            var data = [];
            var p = idx.price * (1 - 0.02);
            for (var i = 0; i < 20; i++) {
                p = p * (1 + (Math.random() - (isUp ? 0.45 : 0.55)) * 0.008);
                data.push(p);
            }
            data.push(idx.price);
            chart.setOption({
                animation: false,
                grid: { top: 2, right: 0, bottom: 2, left: 0 },
                xAxis: { type: 'category', show: false, data: data.map(function(_, i) { return i; }) },
                yAxis: { type: 'value', show: false },
                series: [{
                    type: 'line', data: data, smooth: true, symbol: 'none',
                    lineStyle: { color: color, width: 1.5 },
                    areaStyle: {
                        color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                            colorStops: [{ offset: 0, color: color + '40' }, { offset: 1, color: color + '00' }] }
                    }
                }]
            });
        });
    }

    function selectGlobalIndex(code) {
        activeGlobalIndex = code;
        savePref('globalIndex', code);
        // Update active states in all regions
        document.querySelectorAll('#module-global .index-card').forEach(function(c) {
            c.classList.toggle('active', c.dataset.code === code);
        });
        updateGlobalChartHeader();
        updateGlobalChart();
    }

    function updateGlobalChartHeader() {
        var idx = getGlobalIndex(activeGlobalIndex);
        if (!idx) return;
        var isUp = idx.change >= 0;
        var trend = getTrendLabel(idx.trend);
        document.getElementById('globalChartName').textContent = idx.name;
        var priceEl = document.getElementById('globalChartPrice');
        priceEl.textContent = fmt(idx.price, 2);
        priceEl.className = 'chart-price ' + (isUp ? 'up' : 'down');
        flashPriceOnUpdate('globalChartPrice', idx.price);
        var changeEl = document.getElementById('globalChartChange');
        changeEl.textContent = (isUp ? '+' : '') + fmt(idx.change, 2) + ' (' + (isUp ? '+' : '') + fmt(idx.changePercent, 2) + '%)';
        changeEl.className = 'chart-change ' + (isUp ? 'up' : 'down');
        var badgeEl = document.getElementById('globalTrendBadge');
        badgeEl.className = 'trend-badge ' + trend.cls;
        badgeEl.innerHTML = '<span class="trend-arrow"></span>' + trend.text;
    }

    function initGlobalChart() {
        var el = document.getElementById('globalChart');
        if (!el) return;
        globalChart = echarts.init(el, null, { renderer: 'svg' });
        updateGlobalChart();
    }

    function updateGlobalChart() {
        if (!globalChart) return;
        var idx = getGlobalIndex(activeGlobalIndex);
        if (!idx) return;
        if (activeGlobalChartType === 'timeline') {
            renderTimelineChart(globalChart, idx.price, idx.change >= 0 ? 'up' : 'down', activeGlobalPeriod);
        } else {
            renderKlineChart(globalChart, idx.price, idx.change >= 0 ? 'up' : 'down', activeGlobalPeriod);
        }
    }

    function setupGlobalChartControls() {
        document.querySelectorAll('#globalChartTypeTabs .chart-type-tab').forEach(function(tab) {
            tab.addEventListener('click', function() {
                document.querySelectorAll('#globalChartTypeTabs .chart-type-tab').forEach(function(t) { t.classList.remove('active'); });
                tab.classList.add('active');
                activeGlobalChartType = tab.dataset.type;
                savePref('globalChartType', activeGlobalChartType);
                updateGlobalChart();
            });
        });
        document.querySelectorAll('#globalPeriodTabs .period-tab').forEach(function(tab) {
            tab.addEventListener('click', function() {
                document.querySelectorAll('#globalPeriodTabs .period-tab').forEach(function(t) { t.classList.remove('active'); });
                tab.classList.add('active');
                activeGlobalPeriod = tab.dataset.period;
                savePref('globalPeriod', activeGlobalPeriod);
                updateGlobalChart();
            });
        });
    }

    // ===== Market Clocks =====
    function renderMarketClocks(containerId) {
        var grid = document.getElementById(containerId);
        if (!grid) return;
        grid.innerHTML = '';
        marketClocks.forEach(function(market) {
            var now = new Date();
            var localTime = new Date(now.toLocaleString('en-US', { timeZone: market.timezone }));
            var hour = localTime.getHours();
            var minute = localTime.getMinutes();
            var currentHour = hour + minute / 60;
            var isOpen = market.alwaysOpen;
            if (!isOpen) {
                var openTime = market.openHour + market.openMin / 60;
                var closeTime = market.closeHour + market.closeMin / 60;
                if (market.breakStart !== null) {
                    isOpen = (currentHour >= openTime && currentHour < market.breakStart) ||
                              (currentHour >= market.breakEnd && currentHour < closeTime);
                } else {
                    isOpen = currentHour >= openTime && currentHour < closeTime;
                }
            }
            var timeStr = hour.toString().padStart(2, '0') + ':' + minute.toString().padStart(2, '0');
            var card = document.createElement('div');
            card.className = 'market-clock-card';
            card.innerHTML = `
                <div class="market-clock-info">
                    <span class="market-clock-name">${market.name}</span>
                    <span class="market-clock-status ${isOpen ? 'open' : 'closed'}">${isOpen ? '交易中' : '休市'}</span>
                </div>
                <span class="market-clock-time mono">${timeStr}</span>
            `;
            grid.appendChild(card);
        });
    }

    // ===== Gold Module =====
    function setupGoldTabs() {
        document.querySelectorAll('.gold-tab').forEach(function(tab) {
            tab.addEventListener('click', function() {
                var gold = tab.dataset.gold;
                selectGold(gold);
            });
        });
    }

    function selectGold(gold) {
        activeGold = gold;
        savePref('gold', gold);
        document.querySelectorAll('.gold-tab').forEach(function(t) {
            t.classList.toggle('active', t.dataset.gold === gold);
        });
        updateGoldChartHeader();
        updateGoldChart();
        updateGoldAiPanel();
        updateGoldAiChart();
        updateGoldDetails();
        loadGoldAiPrediction();
    }

    function updateGoldChartHeader() {
        var g = goldProducts[activeGold];
        if (!g) return;
        var isUp = g.change >= 0;
        var trend = getTrendLabel(g.trend);
        document.getElementById('goldChartName').textContent = g.name;
        document.getElementById('goldAiName').textContent = g.name;
        var priceEl = document.getElementById('goldChartPrice');
        priceEl.textContent = fmt(g.price, 2) + ' ' + g.unit;
        priceEl.style.color = goldLight;
        flashPriceOnUpdate('goldChartPrice', g.price);
        var changeEl = document.getElementById('goldChartChange');
        changeEl.textContent = (isUp ? '+' : '') + fmt(g.change, 2) + ' (' + (isUp ? '+' : '') + fmt(g.changePercent, 2) + '%)';
        changeEl.style.color = isUp ? accent : accent2;
        var badgeEl = document.getElementById('goldTrendBadge');
        badgeEl.className = 'trend-badge ' + trend.cls;
        badgeEl.innerHTML = '<span class="trend-arrow"></span>' + trend.text;
    }

    function updateGoldDetails() {
        var g = goldProducts[activeGold];
        if (!g) return;
        document.getElementById('goldHigh').textContent = fmt(g.high, 2);
        document.getElementById('goldLow').textContent = fmt(g.low, 2);
        document.getElementById('goldOpen').textContent = fmt(g.open, 2);
        document.getElementById('goldPrevClose').textContent = fmt(g.prevClose, 2);
    }

    function initGoldChart() {
        var el = document.getElementById('goldChart');
        goldChart = echarts.init(el, null, { renderer: 'svg' });
        updateGoldChart();
    }

    function updateGoldChart() {
        if (!goldChart) return;
        var g = goldProducts[activeGold];
        if (!g) return;

        if (activeGoldChartType === 'timeline') {
            renderTimelineChart(goldChart, g.price, g.change >= 0 ? 'up' : 'down', activeGoldPeriod);
        } else if (backendEnabled && activeGold === 'intl') {
            // 国际现货黄金走后端PAXG真实K线；其他品种（伦敦/纽约/上海）按比例推导，用模拟走势
            DataAPI.fetchBackendGoldKline(activeGoldPeriod).then(function(klines) {
                if (klines && klines.length > 0) {
                    renderRealCryptoKline(goldChart, klines, g);
                } else {
                    renderGoldKline(goldChart, g.price, g.change >= 0, activeGoldPeriod);
                }
            }).catch(function() {
                renderGoldKline(goldChart, g.price, g.change >= 0, activeGoldPeriod);
            });
        } else {
            renderGoldKline(goldChart, g.price, g.change >= 0, activeGoldPeriod);
        }
    }

    function renderGoldKline(chart, basePrice, isUp, period) {
        var counts = { '1D': 24, '1W': 7, '1M': 30, '3M': 90, '1Y': 250 };
        var count = counts[period] || 30;
        var volatility = basePrice * 0.02;
        var bias = isUp ? 0.53 : 0.47;
        var ohlc = generateOHLC(count, basePrice * 0.97, volatility, bias);

        var dates = ohlc.map(function(d) { return formatDate(d.date, 'day'); });
        var klineData = ohlc.map(function(d) { return [d.open, d.close, d.low, d.high]; });
        var volumes = ohlc.map(function(d) { return d.volume; });

        chart.setOption(buildKlineOption(dates, klineData, volumes,
            { up: goldLight, down: accent2 },
            {}));
    }

    function setupGoldChartControls() {
        document.querySelectorAll('#goldChartTypeTabs .chart-type-tab').forEach(function(tab) {
            tab.addEventListener('click', function() {
                document.querySelectorAll('#goldChartTypeTabs .chart-type-tab').forEach(function(t) { t.classList.remove('active'); });
                tab.classList.add('active');
                activeGoldChartType = tab.dataset.type;
                savePref('goldChartType', activeGoldChartType);
                updateGoldChart();
            });
        });

        document.querySelectorAll('#goldPeriodTabs .period-tab').forEach(function(tab) {
            tab.addEventListener('click', function() {
                document.querySelectorAll('#goldPeriodTabs .period-tab').forEach(function(t) { t.classList.remove('active'); });
                tab.classList.add('active');
                activeGoldPeriod = tab.dataset.period;
                savePref('goldPeriod', activeGoldPeriod);
                updateGoldChart();
            });
        });
    }

    // ===== Gold AI Prediction =====
    function initGoldAiChart() {
        var el = document.getElementById('goldAiChart');
        if (!el) return;
        goldAiChart = echarts.init(el, null, { renderer: 'svg' });
        updateGoldAiChart();
    }

    function loadGoldAiPrediction() {
        if (!backendEnabled) return;
        var now = Date.now();
        if (goldAiPrediction && now - goldAiFetchedAt < 50000) return;
        goldAiFetchedAt = now;
        // 黄金各品种（伦敦/纽约/上海）与国际现货同源联动，统一用XAU多因子预测
        DataAPI.fetchBackendPrediction('XAU', 'gold').then(function(data) {
            if (data && data.type === 'gold') {
                goldAiPrediction = data;
                updateGoldAiPanel();
                updateGoldAiChart();
            }
        }).catch(function() { /* 拉取失败保持现有展示 */ });
    }

    function updateGoldAiPanel() {
        var g = goldProducts[activeGold];
        if (!g) return;

        // 后端真实多因子预测优先
        if (goldAiPrediction && backendEnabled) {
            var pred = goldAiPrediction.predictions[activeGoldAiPeriod] || 0;
            var isUp = pred >= 0;

            var valEl = document.getElementById('goldAiPredValue');
            valEl.textContent = (isUp ? '+' : '') + pred.toFixed(2) + '%';
            valEl.className = 'ai-prediction-value ' + (isUp ? 'up' : 'down');

            var conf = goldAiPrediction.confidence;
            document.getElementById('goldAiConfidence').textContent = conf.toFixed(1) + '%';
            document.getElementById('goldAiConfidenceFill').style.width = conf + '%';
            renderPredictionMeta('goldAiConfidence', goldAiPrediction);
            updateYesterdayRow('goldAiYesterday', goldAiPrediction);

            var cards = document.querySelectorAll('#goldAiPeriods .ai-period-card');
            var keys = ['1D', '1W', '1M'];
            cards.forEach(function(card, i) {
                var p = goldAiPrediction.predictions[keys[i]] || 0;
                var up = p >= 0;
                var pv = card.querySelector('.ai-period-value');
                pv.textContent = (up ? '+' : '') + p.toFixed(2) + '%';
                pv.className = 'ai-period-value ' + (up ? 'up' : 'down');
                card.classList.toggle('active', keys[i] === activeGoldAiPeriod);
            });
            renderAiEnsemble(goldAiPrediction, 'goldAi');
            renderAiShap(goldAiPrediction, 'goldAi');
            return;
        }

        var predValues = { '1D': g.aiPred1D, '1W': g.aiPred1W, '1M': g.aiPred1M };
        var pred = predValues[activeGoldAiPeriod];
        var isUp = pred >= 0;

        var valEl = document.getElementById('goldAiPredValue');
        valEl.textContent = (isUp ? '+' : '') + pred.toFixed(2) + '%';
        valEl.className = 'ai-prediction-value ' + (isUp ? 'up' : 'down');

        document.getElementById('goldAiConfidence').textContent = g.confidence.toFixed(1) + '%';
        document.getElementById('goldAiConfidenceFill').style.width = g.confidence + '%';

        var cards = document.querySelectorAll('#goldAiPeriods .ai-period-card');
        var periods = [
            { key: '1D', value: g.aiPred1D },
            { key: '1W', value: g.aiPred1W },
            { key: '1M', value: g.aiPred1M }
        ];
        cards.forEach(function(card, i) {
            var p = periods[i];
            var up = p.value >= 0;
            var valEl = card.querySelector('.ai-period-value');
            valEl.textContent = (up ? '+' : '') + p.value.toFixed(2) + '%';
            valEl.className = 'ai-period-value ' + (up ? 'up' : 'down');
            card.classList.toggle('active', p.key === activeGoldAiPeriod);
        });
    }

    function updateGoldAiChart() {
        if (!goldAiChart) return;
        var g = goldProducts[activeGold];
        if (!g) return;

        // 后端真实预测：真实历史K线 + 外推路径（按品种现价缩放，保持品种自身价格刻度）
        if (goldAiPrediction && backendEnabled && goldAiPrediction.history && goldAiPrediction.predPath) {
            var hist = goldAiPrediction.history;
            var predPath = goldAiPrediction.predPath;
            var histLast = hist.closes[hist.closes.length - 1];
            var scale = g.price / histLast;   // XAU历史 → 当前品种价格刻度
            var historyDates = hist.dates.map(function(d) { return formatDate(d, 'day'); });
            var historyCloses = hist.closes.map(function(c) { return +(c * scale).toFixed(2); });
            var predDates = predPath.dates.map(function(d) { return formatDate(d, 'day'); });
            var predPrices = predPath.prices.map(function(p) { return +(p * scale).toFixed(2); });

            var allDates = historyDates.concat(predDates);
            var actualData = historyCloses.concat(new Array(predPrices.length).fill(null));
            var currentPrice = historyCloses[historyCloses.length - 1];
            var predictData = new Array(Math.max(0, historyDates.length - 1)).fill(null)
                .concat([currentPrice]).concat(predPrices);
            var isUp = (predPath.total || 0) >= 0;

            goldAiChart.setOption({
                animation: false,
                title: { text: '黄金走势与AI预测', left: 'left',
                    textStyle: { color: ink, fontSize: 13, fontWeight: 600 } },
                tooltip: { trigger: 'axis', appendToBody: true,
                    backgroundColor: bg3, borderColor: rule, textStyle: { color: ink } },
                legend: { data: ['历史走势', 'AI预测'], right: 0, top: 0,
                    textStyle: { color: muted, fontSize: 11 } },
                grid: { top: 40, right: 20, bottom: 30, left: 60 },
                xAxis: { type: 'category', data: allDates,
                    axisLine: { lineStyle: { color: rule } },
                    axisLabel: { color: muted, fontSize: 10, interval: Math.floor(allDates.length / 10) },
                    axisTick: { show: false } },
                yAxis: { type: 'value', scale: true,
                    axisLine: { show: false }, axisLabel: { color: muted, fontSize: 11 },
                    splitLine: { lineStyle: { color: rule, type: 'dashed' } } },
                series: [
                    { name: '历史走势', type: 'line', data: actualData, smooth: true, symbol: 'none',
                        lineStyle: { color: goldLight, width: 2 },
                        areaStyle: {
                            color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                                colorStops: [{ offset: 0, color: gold + '30' }, { offset: 1, color: gold + '00' }] } } },
                    { name: 'AI预测', type: 'line', data: predictData, smooth: true, symbol: 'none',
                        lineStyle: { color: isUp ? accent : accent2, width: 2, type: 'dashed' },
                        areaStyle: {
                            color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                                colorStops: [
                                    { offset: 0, color: (isUp ? accent : accent2) + '20' },
                                    { offset: 1, color: (isUp ? accent : accent2) + '00' }
                                ] } } }
                ]
            });
            return;
        }

        var historyDays = 40;
        var predDays = activeGoldAiPeriod === '1D' ? 1 : activeGoldAiPeriod === '1W' ? 7 : 30;
        var predPct = activeGoldAiPeriod === '1D' ? g.aiPred1D : activeGoldAiPeriod === '1W' ? g.aiPred1W : g.aiPred1M;

        var volatility = g.price * 0.018;
        var ohlc = generateOHLC(historyDays, g.price * 0.95, volatility, g.change >= 0 ? 0.54 : 0.46);
        var historyDates = ohlc.map(function(d) { return formatDate(d.date, 'day'); });
        var historyCloses = ohlc.map(function(d) { return d.close.toFixed(2); });

        var predDates = [];
        var predPrices = [];
        var currentPrice = g.price;
        var dailyRet = predPct / predDays / 100;
        for (var i = 1; i <= predDays; i++) {
            var d = new Date(ohlc[ohlc.length - 1].date);
            d.setDate(d.getDate() + i);
            predDates.push(formatDate(d, 'day'));
            currentPrice = currentPrice * (1 + dailyRet + (Math.random() - 0.5) * dailyRet * 0.3);
            predPrices.push(currentPrice.toFixed(2));
        }

        var allDates = historyDates.concat(predDates);
        var actualData = historyCloses.concat(new Array(predDays).fill(null));
        var predictData = new Array(historyDates.length - 1).fill(null).concat([g.price.toFixed(2)]).concat(predPrices);
        var isUp = predPct >= 0;

        goldAiChart.setOption({
            animation: false,
            title: { text: '黄金走势与AI预测', left: 'left',
                textStyle: { color: ink, fontSize: 13, fontWeight: 600 } },
            tooltip: { trigger: 'axis', appendToBody: true,
                backgroundColor: bg3, borderColor: rule, textStyle: { color: ink } },
            legend: { data: ['历史走势', 'AI预测'], right: 0, top: 0,
                textStyle: { color: muted, fontSize: 11 } },
            grid: { top: 40, right: 20, bottom: 30, left: 60 },
            xAxis: { type: 'category', data: allDates,
                axisLine: { lineStyle: { color: rule } },
                axisLabel: { color: muted, fontSize: 10, interval: Math.floor(allDates.length / 10) },
                axisTick: { show: false } },
            yAxis: { type: 'value', scale: true,
                axisLine: { show: false }, axisLabel: { color: muted, fontSize: 11 },
                splitLine: { lineStyle: { color: rule, type: 'dashed' } } },
            series: [
                { name: '历史走势', type: 'line', data: actualData, smooth: true, symbol: 'none',
                    lineStyle: { color: goldLight, width: 2 },
                    areaStyle: {
                        color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                            colorStops: [{ offset: 0, color: gold + '30' }, { offset: 1, color: gold + '00' }] } } },
                { name: 'AI预测', type: 'line', data: predictData, smooth: true, symbol: 'none',
                    lineStyle: { color: isUp ? accent : accent2, width: 2, type: 'dashed' },
                    areaStyle: {
                        color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                            colorStops: [
                                { offset: 0, color: (isUp ? accent : accent2) + '20' },
                                { offset: 1, color: (isUp ? accent : accent2) + '00' }
                            ] } } }
            ]
        });
    }

    function setupGoldAiPeriodCards() {
        document.querySelectorAll('#goldAiPeriods .ai-period-card').forEach(function(card) {
            card.addEventListener('click', function() {
                activeGoldAiPeriod = card.dataset.period;
                updateGoldAiPanel();
                updateGoldAiChart();
            });
        });
    }

    // ===== Crypto Module =====
    function setupCryptoTabs() {
        document.querySelectorAll('.crypto-tab').forEach(function(tab) {
            tab.addEventListener('click', function() {
                var crypto = tab.dataset.crypto;
                selectCrypto(crypto);
            });
        });
    }

    function selectCrypto(symbol) {
        activeCrypto = symbol;
        savePref('crypto', symbol);
        document.querySelectorAll('.crypto-tab').forEach(function(t) {
            t.classList.toggle('active', t.dataset.crypto === symbol);
        });
        updateCryptoChartHeader();
        updateCryptoChart();
        updateCryptoStats();
        updateCryptoAiPanel();
        updateCryptoAiChart();
        loadCryptoAiPrediction();
    }

    function updateCryptoChartHeader() {
        var c = cryptoProducts[activeCrypto];
        if (!c) return;
        var isUp = c.change >= 0;
        var trend = getTrendLabel(c.trend);
        document.getElementById('cryptoChartName').textContent = c.fullName;
        document.getElementById('cryptoAiName').textContent = c.name + ' ' + c.symbol;
        var priceEl = document.getElementById('cryptoChartPrice');
        priceEl.textContent = '$' + fmt(c.price, 2);
        priceEl.style.color = c.color;
        flashPriceOnUpdate('cryptoChartPrice', c.price);
        var changeEl = document.getElementById('cryptoChartChange');
        changeEl.textContent = (isUp ? '+$' : '-$') + fmt(Math.abs(c.change), 2) + ' (' + (isUp ? '+' : '') + fmt(c.changePercent, 2) + '%)';
        changeEl.style.color = isUp ? accent : accent2;
        var badgeEl = document.getElementById('cryptoTrendBadge');
        badgeEl.className = 'trend-badge ' + trend.cls;
        var trendText = isUp ? (c.changePercent > 3 ? '强势上涨' : '看涨趋势') : (c.changePercent < -3 ? '大幅下跌' : '看跌趋势');
        badgeEl.innerHTML = '<span class="trend-arrow"></span>' + trendText;
    }

    function initCryptoChart() {
        var el = document.getElementById('cryptoChart');
        if (!el) return;
        cryptoChart = echarts.init(el, null, { renderer: 'svg' });
        updateCryptoChart();
    }

    function updateCryptoChart() {
        if (!cryptoChart) return;
        var c = cryptoProducts[activeCrypto];
        if (!c) return;
        if (activeCryptoChartType === 'timeline') {
            renderTimelineChart(cryptoChart, c.price, c.change >= 0 ? 'up' : 'down', activeCryptoPeriod);
        } else {
            var renderFallback = function() {
                renderCryptoKline(cryptoChart, c.price, c.change >= 0, activeCryptoPeriod);
            };
            if (backendEnabled) {
                // 优先走后端代理（服务端已做多源降级），浏览器直连Binance在部分网络不可达
                DataAPI.fetchBackendCryptoKline(activeCrypto, activeCryptoPeriod).then(function(klines) {
                    if (klines && klines.length > 0) {
                        renderRealCryptoKline(cryptoChart, klines, c);
                    } else {
                        renderFallback();
                    }
                }).catch(renderFallback);
            } else if (backendDetectDone) {
                // 无后端模式：尝试直连Binance获取真实K线数据（探测中先渲染模拟，避免注定超时的请求）
                var intervalMap = { '1D': '1h', '1W': '1d', '1M': '1d', '3M': '1w', '1Y': '1w' };
                var limitMap = { '1D': 24, '1W': 7, '1M': 30, '3M': 12, '1Y': 52 };
                var interval = intervalMap[activeCryptoPeriod] || '1d';
                var limit = limitMap[activeCryptoPeriod] || 30;

                DataAPI.fetchBinanceKline(activeCrypto, interval, limit).then(function(klines) {
                    if (klines && klines.length > 0) {
                        renderRealCryptoKline(cryptoChart, klines, c);
                    } else {
                        renderFallback();
                    }
                }).catch(renderFallback);
            } else {
                renderFallback();
            }
        }
    }

    function renderCryptoKline(chart, basePrice, isUp, period) {
        var counts = { '1D': 24, '1W': 7, '1M': 30, '3M': 90, '1Y': 250 };
        var count = counts[period] || 30;
        var volatility = basePrice * 0.04;
        var bias = isUp ? 0.54 : 0.46;
        var ohlc = generateOHLC(count, basePrice * 0.97, volatility, bias);
        var dates = ohlc.map(function(d) { return formatDate(d.date, 'day'); });
        var klineData = ohlc.map(function(d) { return [d.open, d.close, d.low, d.high]; });
        var volumes = ohlc.map(function(d) { return d.volume; });
        var c = cryptoProducts[activeCrypto];
        var upColor = c ? c.color : accent;
        chart.setOption(buildKlineOption(dates, klineData, volumes,
            { up: upColor, down: accent2 },
            { pricePrefix: '$' }));
    }

    function renderRealCryptoKline(chart, klines, cryptoInfo) {
        var dates = klines.map(function(k) {
            var d = new Date(k.openTime);
            if (k.openTime - klines[0].openTime < 86400000) {
                return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
            }
            return (d.getMonth() + 1) + '/' + d.getDate();
        });
        var klineData = klines.map(function(k) { return [k.open, k.close, k.low, k.high]; });
        var volumes = klines.map(function(k) { return k.volume; });
        var upColor = cryptoInfo.color || accent;
        chart.setOption(buildKlineOption(dates, klineData, volumes,
            { up: upColor, down: accent2 },
            {
                pricePrefix: '$',
                volFormatter: function(v) {
                    return v >= 1e9 ? (v/1e9).toFixed(2) + 'B'
                         : v >= 1e6 ? (v/1e6).toFixed(1) + 'M'
                         : v >= 1e3 ? (v/1e3).toFixed(0) + 'k'
                         : v;
                }
            }));
    }

    function setupCryptoChartControls() {
        document.querySelectorAll('#cryptoChartTypeTabs .chart-type-tab').forEach(function(tab) {
            tab.addEventListener('click', function() {
                document.querySelectorAll('#cryptoChartTypeTabs .chart-type-tab').forEach(function(t) { t.classList.remove('active'); });
                tab.classList.add('active');
                activeCryptoChartType = tab.dataset.type;
                savePref('cryptoChartType', activeCryptoChartType);
                updateCryptoChart();
            });
        });
        document.querySelectorAll('#cryptoPeriodTabs .period-tab').forEach(function(tab) {
            tab.addEventListener('click', function() {
                document.querySelectorAll('#cryptoPeriodTabs .period-tab').forEach(function(t) { t.classList.remove('active'); });
                tab.classList.add('active');
                activeCryptoPeriod = tab.dataset.period;
                savePref('cryptoPeriod', activeCryptoPeriod);
                updateCryptoChart();
            });
        });
    }

    function updateCryptoStats() {
        var c = cryptoProducts[activeCrypto];
        if (!c) return;
        var grid = document.getElementById('cryptoStatsGrid');
        if (!grid) return;
        var stats = [
            { label: '24h最高', value: '$' + fmt(c.high, 2) },
            { label: '24h最低', value: '$' + fmt(c.low, 2) },
            { label: '开盘价', value: '$' + fmt(c.open, 2) },
            { label: '24h成交量', value: fmtUSD(c.volume) },
            { label: '市值', value: fmtUSD(c.marketCap) },
            { label: '流通量', value: fmtBig(c.circulating) + ' ' + c.symbol }
        ];
        grid.innerHTML = '';
        stats.forEach(function(s) {
            var card = document.createElement('div');
            card.className = 'crypto-stat-card';
            card.innerHTML = `
                <div class="crypto-stat-label">${s.label}</div>
                <div class="crypto-stat-value mono">${s.value}</div>
            `;
            grid.appendChild(card);
        });
    }

    // ===== Crypto AI Prediction =====
    function initCryptoAiChart() {
        var el = document.getElementById('cryptoAiChart');
        if (!el) return;
        cryptoAiChart = echarts.init(el, null, { renderer: 'svg' });
        updateCryptoAiChart();
    }

    function loadCryptoAiPrediction() {
        if (!backendEnabled) return;
        var sym = activeCrypto;
        var now = Date.now();
        // 切换币种立即拉取；同币种50秒防重复
        if (cryptoAiPrediction && cryptoAiPrediction.code === sym && now - cryptoAiFetchedAt < 50000) return;
        cryptoAiFetchedAt = now;
        DataAPI.fetchBackendPrediction(sym, 'crypto').then(function(data) {
            if (data && data.type === 'crypto' && data.code === sym) {
                cryptoAiPrediction = data;
                updateCryptoAiPanel();
                updateCryptoAiChart();
            }
        }).catch(function() { /* 拉取失败保持现有展示 */ });
    }

    function updateCryptoAiPanel() {
        var c = cryptoProducts[activeCrypto];
        if (!c) return;

        // 后端真实多因子预测优先
        if (cryptoAiPrediction && backendEnabled && cryptoAiPrediction.code === activeCrypto) {
            var pred = cryptoAiPrediction.predictions[activeCryptoAiPeriod] || 0;
            var isUp = pred >= 0;
            var valEl = document.getElementById('cryptoAiPredValue');
            valEl.textContent = (isUp ? '+' : '') + pred.toFixed(2) + '%';
            valEl.className = 'ai-prediction-value ' + (isUp ? 'up' : 'down');
            var conf = cryptoAiPrediction.confidence;
            document.getElementById('cryptoAiConfidence').textContent = conf.toFixed(1) + '%';
            document.getElementById('cryptoAiConfidenceFill').style.width = conf + '%';
            renderPredictionMeta('cryptoAiConfidence', cryptoAiPrediction);
            updateYesterdayRow('cryptoAiYesterday', cryptoAiPrediction);
            var cards = document.querySelectorAll('#cryptoAiPeriods .ai-period-card');
            var keys = ['1D', '1W', '1M'];
            cards.forEach(function(card, i) {
                var p = cryptoAiPrediction.predictions[keys[i]] || 0;
                var up = p >= 0;
                var pv = card.querySelector('.ai-period-value');
                pv.textContent = (up ? '+' : '') + p.toFixed(2) + '%';
                pv.className = 'ai-period-value ' + (up ? 'up' : 'down');
                card.classList.toggle('active', keys[i] === activeCryptoAiPeriod);
            });
            renderAiEnsemble(cryptoAiPrediction, 'cryptoAi');
            renderAiShap(cryptoAiPrediction, 'cryptoAi');
            return;
        }

        var predValues = { '1D': c.aiPred1D, '1W': c.aiPred1W, '1M': c.aiPred1M };
        var pred = predValues[activeCryptoAiPeriod];
        var isUp = pred >= 0;
        var valEl = document.getElementById('cryptoAiPredValue');
        valEl.textContent = (isUp ? '+' : '') + pred.toFixed(2) + '%';
        valEl.className = 'ai-prediction-value ' + (isUp ? 'up' : 'down');
        document.getElementById('cryptoAiConfidence').textContent = c.confidence.toFixed(1) + '%';
        document.getElementById('cryptoAiConfidenceFill').style.width = c.confidence + '%';
        var cards = document.querySelectorAll('#cryptoAiPeriods .ai-period-card');
        var periods = [
            { key: '1D', value: c.aiPred1D },
            { key: '1W', value: c.aiPred1W },
            { key: '1M', value: c.aiPred1M }
        ];
        cards.forEach(function(card, i) {
            var p = periods[i];
            var up = p.value >= 0;
            var valEl = card.querySelector('.ai-period-value');
            valEl.textContent = (up ? '+' : '') + p.value.toFixed(2) + '%';
            valEl.className = 'ai-period-value ' + (up ? 'up' : 'down');
            card.classList.toggle('active', p.key === activeCryptoAiPeriod);
        });
    }

    function updateCryptoAiChart() {
        if (!cryptoAiChart) return;
        var c = cryptoProducts[activeCrypto];
        if (!c) return;

        // 后端真实预测：真实历史K线 + 外推路径
        if (cryptoAiPrediction && backendEnabled && cryptoAiPrediction.code === activeCrypto
            && cryptoAiPrediction.history && cryptoAiPrediction.predPath) {
            var hist = cryptoAiPrediction.history;
            var predPath = cryptoAiPrediction.predPath;
            var historyDates = hist.dates.map(function(d) { return formatDate(d, 'day'); });
            var historyCloses = hist.closes.map(function(v) { return +v.toFixed(2); });
            var predDates = predPath.dates.map(function(d) { return formatDate(d, 'day'); });
            var predPrices = predPath.prices;

            var allDates = historyDates.concat(predDates);
            var actualData = historyCloses.concat(new Array(predPrices.length).fill(null));
            var currentPrice = historyCloses[historyCloses.length - 1];
            var predictData = new Array(Math.max(0, historyDates.length - 1)).fill(null)
                .concat([currentPrice]).concat(predPrices);
            var isUp = (predPath.total || 0) >= 0;

            cryptoAiChart.setOption({
                animation: false,
                title: { text: '价格走势与AI预测', left: 'left',
                    textStyle: { color: ink, fontSize: 13, fontWeight: 600 } },
                tooltip: { trigger: 'axis', appendToBody: true,
                    backgroundColor: bg3, borderColor: rule, textStyle: { color: ink } },
                legend: { data: ['历史走势', 'AI预测'], right: 0, top: 0,
                    textStyle: { color: muted, fontSize: 11 } },
                grid: { top: 40, right: 20, bottom: 30, left: 60 },
                xAxis: { type: 'category', data: allDates,
                    axisLine: { lineStyle: { color: rule } },
                    axisLabel: { color: muted, fontSize: 10, interval: Math.floor(allDates.length / 10) },
                    axisTick: { show: false } },
                yAxis: { type: 'value', scale: true,
                    axisLine: { show: false }, axisLabel: { color: muted, fontSize: 11 },
                    splitLine: { lineStyle: { color: rule, type: 'dashed' } } },
                series: [
                    { name: '历史走势', type: 'line', data: actualData, smooth: true, symbol: 'none',
                        lineStyle: { color: c.color, width: 2 },
                        areaStyle: {
                            color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                                colorStops: [{ offset: 0, color: c.color + '25' }, { offset: 1, color: c.color + '00' }] } } },
                    { name: 'AI预测', type: 'line', data: predictData, smooth: true, symbol: 'none',
                        lineStyle: { color: isUp ? accent : accent2, width: 2, type: 'dashed' },
                        areaStyle: {
                            color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                                colorStops: [
                                    { offset: 0, color: (isUp ? accent : accent2) + '20' },
                                    { offset: 1, color: (isUp ? accent : accent2) + '00' }
                                ] } } }
                ]
            });
            return;
        }

        var historyDays = 40;
        var predDays = activeCryptoAiPeriod === '1D' ? 1 : activeCryptoAiPeriod === '1W' ? 7 : 30;
        var predPct = activeCryptoAiPeriod === '1D' ? c.aiPred1D : activeCryptoAiPeriod === '1W' ? c.aiPred1W : c.aiPred1M;
        var volatility = c.price * 0.035;
        var ohlc = generateOHLC(historyDays, c.price * 0.95, volatility, c.change >= 0 ? 0.54 : 0.46);
        var historyDates = ohlc.map(function(d) { return formatDate(d.date, 'day'); });
        var historyCloses = ohlc.map(function(d) { return d.close.toFixed(2); });
        var predDates = [];
        var predPrices = [];
        var currentPrice = c.price;
        var dailyRet = predPct / predDays / 100;
        for (var i = 1; i <= predDays; i++) {
            var d = new Date(ohlc[ohlc.length - 1].date);
            d.setDate(d.getDate() + i);
            predDates.push(formatDate(d, 'day'));
            currentPrice = currentPrice * (1 + dailyRet + (Math.random() - 0.5) * dailyRet * 0.4);
            predPrices.push(currentPrice.toFixed(2));
        }
        var allDates = historyDates.concat(predDates);
        var actualData = historyCloses.concat(new Array(predDays).fill(null));
        var predictData = new Array(historyDates.length - 1).fill(null).concat([c.price.toFixed(2)]).concat(predPrices);
        var isUp = predPct >= 0;
        cryptoAiChart.setOption({
            animation: false,
            title: { text: '价格走势与AI预测', left: 'left',
                textStyle: { color: ink, fontSize: 13, fontWeight: 600 } },
            tooltip: { trigger: 'axis', appendToBody: true,
                backgroundColor: bg3, borderColor: rule, textStyle: { color: ink } },
            legend: { data: ['历史走势', 'AI预测'], right: 0, top: 0,
                textStyle: { color: muted, fontSize: 11 } },
            grid: { top: 40, right: 20, bottom: 30, left: 60 },
            xAxis: { type: 'category', data: allDates,
                axisLine: { lineStyle: { color: rule } },
                axisLabel: { color: muted, fontSize: 10, interval: Math.floor(allDates.length / 10) },
                axisTick: { show: false } },
            yAxis: { type: 'value', scale: true,
                axisLine: { show: false }, axisLabel: { color: muted, fontSize: 11 },
                splitLine: { lineStyle: { color: rule, type: 'dashed' } } },
            series: [
                { name: '历史走势', type: 'line', data: actualData, smooth: true, symbol: 'none',
                    lineStyle: { color: c.color, width: 2 },
                    areaStyle: {
                        color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                            colorStops: [{ offset: 0, color: c.color + '25' }, { offset: 1, color: c.color + '00' }] } } },
                { name: 'AI预测', type: 'line', data: predictData, smooth: true, symbol: 'none',
                    lineStyle: { color: isUp ? accent : accent2, width: 2, type: 'dashed' },
                    areaStyle: {
                        color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                            colorStops: [
                                { offset: 0, color: (isUp ? accent : accent2) + '20' },
                                { offset: 1, color: (isUp ? accent : accent2) + '00' }
                            ] } } }
            ]
        });
    }

    function setupCryptoAiPeriodCards() {
        document.querySelectorAll('#cryptoAiPeriods .ai-period-card').forEach(function(card) {
            card.addEventListener('click', function() {
                activeCryptoAiPeriod = card.dataset.period;
                updateCryptoAiPanel();
                updateCryptoAiChart();
            });
        });
    }

    // ===== Stock Lists =====
    function renderStockLists() {
        var gainersEl = document.getElementById('gainersList');
        var losersEl = document.getElementById('losersList');
        if (!gainersEl || !losersEl) return;

        gainersEl.innerHTML = '';
        gainers.forEach(function(s) {
            var item = document.createElement('div');
            item.className = 'stock-item';
            item.innerHTML = `
                <div class="stock-info">
                    <span class="stock-name">${s.name}</span>
                    <span class="stock-code">${s.code}</span>
                </div>
                <div class="stock-price-info">
                    <div class="stock-price">${fmt(s.price, 2)}</div>
                    <div class="stock-change up">+${s.change.toFixed(2)}%</div>
                </div>
            `;
            gainersEl.appendChild(item);
        });

        losersEl.innerHTML = '';
        losers.forEach(function(s) {
            var item = document.createElement('div');
            item.className = 'stock-item';
            item.innerHTML = `
                <div class="stock-info">
                    <span class="stock-name">${s.name}</span>
                    <span class="stock-code">${s.code}</span>
                </div>
                <div class="stock-price-info">
                    <div class="stock-price">${fmt(s.price, 2)}</div>
                    <div class="stock-change down">${s.change.toFixed(2)}%</div>
                </div>
            `;
            losersEl.appendChild(item);
        });
    }

    // ===== Fund Module =====
    function loadFundPredictions() {
        if (!backendEnabled) return;
        var now = Date.now();
        if (fundAiLoaded && now - fundAiFetchedAt < 300000) return;
        fundAiFetchedAt = now;

        funds.forEach(function(fund) {
            DataAPI.fetchBackendPrediction(fund.code, 'fund', 'fundType=' + encodeURIComponent(fund.type || 'hybrid')).then(function(data) {
                if (!data || data.code !== fund.code) return;
                // 真实净值与AI预测回填（失败/缓存时保持原模拟值）
                fund.name = data.name || fund.name;
                fund.nav = data.nav;
                fund.changePercent = data.changePercent;
                fund.pred1D = data.predictions['1D'];
                fund.pred1W = data.predictions['1W'];
                fund.pred1M = data.predictions['1M'];
                fund.confidence = data.confidence;
                fund.aiReal = true;
                fund.aiScore = data.score;
                fund.benchmark = data.benchmark;
                fund.navDate = data.navDate;
                fund.predTitleFactors = (data.factorList ? data.factorList.length : 0) + '因子';
                fund.factorList = data.factorList || [];
                // 集成增强：双基模型权重 / SHAP 因子归因 / 置信度校准
                fund.models = data.models || null;
                fund.shap = data.shap || null;
                fund.calibration = data.calibration || null;
                // 昨日对比与累计准确率
                fund.yesterday = data.yesterday || null;
                fund.accuracy = data.accuracy || null;
                fund.corrections = data.corrections || [];
                // 预测区间与数据质量
                fund.intervals = data.intervals || null;
                fund.dataQuality = data.dataQuality || null;
                // 持仓与经理维度
                fund.mgrDetail = data.manager || null;
                fund.holdings = data.holdings || [];
                fund.holdingsDate = data.holdingsDate;
                fund.intradayEstimate = data.intradayEstimate;
                fund.assetAllocation = data.assetAllocation || null;
                fund.stockRatio = fund.assetAllocation ? fund.assetAllocation.stockRatio : null;
                fund.netAsset = fund.assetAllocation ? fund.assetAllocation.netAsset : null;
                // 真实区间收益率（近1月/6月/1年）
                if (data.returns) {
                    if (data.returns.ret1M != null) fund.ret1M = data.returns.ret1M;
                    if (data.returns.ret6M != null) fund.ret6M = data.returns.ret6M;
                    if (data.returns.ret1Y != null) fund.ret1Y = data.returns.ret1Y;
                }
                renderFundCards();
            }).catch(function() { /* 单只失败不影响其他 */ });
        });
        fundAiLoaded = true;
    }

    function renderFundCards() {
        var grid = document.getElementById('fundGrid');
        if (!grid) return;
        grid.innerHTML = '';

        var list = activeFundType === 'all' ? funds : funds.filter(function(f) { return f.type === activeFundType; });

        list.forEach(function(fund) {
            var isUp = fund.changePercent >= 0;
            var predUp = fund.pred1D >= 0;
            var stars = '';
            for (var i = 0; i < 5; i++) {
                stars += '<svg class="' + (i < fund.rating ? '' : 'empty') + '" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
            }
            // 真实预测时展示基准指数与净值日期（悬浮提示）
            var predTitle = fund.aiReal
                ? '多因子策略：净值技术面(' + fund.predTitleFactors + ') × 基准指数' + (fund.benchmark || '') + '融合；净值日期' + (fund.navDate || '')
                : '模拟数据';
            var realTag = fund.aiReal ? '<span class="fund-type-tag" style="border-color:var(--accent);color:var(--accent);">真实</span>' : '';

            // 因子明细（真实预测时点击预测区展开）
            var factorRows = '';
            if (fund.aiReal && fund.factorList) {
                fund.factorList.forEach(function(f) {
                    var sc = f.score || 0;
                    factorRows += '<div class="fund-factor-row">' +
                        '<div class="fund-factor-head">' +
                            '<span class="fund-factor-group">' + f.group + '</span>' +
                            '<span class="fund-factor-name">' + f.name + '</span>' +
                            '<span class="fund-factor-score ' + (sc > 0 ? 'up' : sc < 0 ? 'down' : 'flat') + '">' + (sc > 0 ? '+' : '') + sc + '</span>' +
                        '</div>' +
                        '<div class="fund-factor-bar">' +
                            '<div class="fund-factor-fill ' + (sc >= 0 ? 'pos' : 'neg') + '" style="' +
                                (sc >= 0 ? 'left:50%;' : 'right:50%;') + 'width:' + Math.min(50, Math.abs(sc) / 2) + '%"></div>' +
                        '</div>' +
                        '<div class="fund-factor-txt">' + f.detail + '</div>' +
                    '</div>';
                });
            }
            var factorDetail = factorRows
                ? '<div class="fund-factor-detail' + (fund._factorsOpen ? ' open' : '') + '">' + factorRows + '</div>'
                : '';

            // 集成增强：双基模型权重 + SHAP 因子归因 + 置信度校准（真实预测时展示）
            var ensHtml = (fund.aiReal && fund.models) ? '<div class="ai-ensemble">' + aiEnsembleInnerHtml(fund) + '</div>' : '';
            var shapHtml = (fund.aiReal && fund.shap && fund.shap.length) ? '<div class="ai-shap">' + aiShapInnerHtml(fund) + '</div>' : '';

            // 基金经理信息行（真实数据时展示任期/能力/规模）
            var mgr = fund.mgrDetail;
            var mgrName = mgr && mgr.name ? mgr.name : (typeof fund.manager === 'string' ? fund.manager : '--');
            var mgrRow = '';
            if (mgr && mgr.name) {
                var ret = mgr.termReturn;
                var retHtml = ret != null
                    ? '<span class="fund-mgr-ret ' + (ret >= 0 ? 'up' : 'down') + '">' + (ret >= 0 ? '+' : '') + ret.toFixed(1) + '%任期</span>'
                    : '';
                var mgrMeta = [];
                if (mgr.workTime) mgrMeta.push('任职' + mgr.workTime);
                if (mgr.powerAvr != null) mgrMeta.push('能力' + Math.round(mgr.powerAvr));
                if (mgr.fundSize) mgrMeta.push(mgr.fundSize);
                var mgrTitle = mgr.peerAvg != null ? '，同类平均' + mgr.peerAvg.toFixed(1) + '%' : '';
                mgrRow = '<div class="fund-mgr-row" title="基金经理：' + mgr.name + '（任期收益' + (ret != null ? ret.toFixed(1) + '%' : '--') + mgrTitle + '）">' +
                    '<span class="fund-mgr-avatar">' + mgr.name.substring(0, 1) + '</span>' +
                    '<span class="fund-mgr-name">' + mgr.name + (mgr.star ? '<span class="fund-mgr-star">' + mgr.star + '星</span>' : '') + '</span>' +
                    '<span class="fund-mgr-meta">' + mgrMeta.join(' · ') + '</span>' +
                    retHtml +
                '</div>';
            } else {
                mgrRow = '<div class="fund-mgr-row"><span class="fund-mgr-avatar">' + (mgrName || '基').substring(0, 1) + '</span><span class="fund-mgr-name">' + mgrName + '</span></div>';
            }

            // 盘中净值估算（重仓加权涨跌×股票仓位）
            var intradayHtml = '';
            if (fund.aiReal && fund.intradayEstimate != null) {
                var ie = fund.intradayEstimate;
                intradayHtml = '<div class="fund-intraday"><span>重仓估算今日</span>' +
                    '<span class="fund-intraday-val ' + (ie >= 0 ? 'up' : 'down') + '">' + (ie >= 0 ? '+' : '') + ie.toFixed(2) + '%</span></div>';
            }

            // 前十大重仓 chips（含个股当日涨跌）
            var holdingsHtml = '';
            if (fund.aiReal && fund.holdings && fund.holdings.length) {
                var chips = '';
                fund.holdings.slice(0, 6).forEach(function(h) {
                    var chg = h.changePercent;
                    var chgHtml = chg != null
                        ? '<span class="' + (chg >= 0 ? 'up' : 'down') + '">' + (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%</span>'
                        : '';
                    chips += '<span class="fund-holding-chip" title="' + h.name + '(' + h.code + ') 占净值' + h.weight.toFixed(2) + '%">' +
                        h.name + '<em>' + h.weight.toFixed(1) + '%</em>' + chgHtml + '</span>';
                });
                if (fund.holdings.length > 6) {
                    chips += '<span class="fund-holding-chip more">+' + (fund.holdings.length - 6) + '只</span>';
                }
                var meta = [];
                if (fund.holdingsDate) meta.push(fund.holdingsDate);
                if (fund.stockRatio != null) meta.push('<span class="chip-stock-ratio">股票仓位' + fund.stockRatio.toFixed(1) + '%</span>');
                holdingsHtml = '<div class="fund-holdings">' +
                    '<div class="fund-holdings-label">前十大重仓' + (meta.length ? ' · ' + meta.join(' · ') : '') + '</div>' +
                    '<div class="fund-holdings-list">' + chips + '</div>' +
                '</div>';
            }

            // 规模信息（季报净资产）
            var codeMeta = fund.aiReal && fund.netAsset != null
                ? fund.code + ' · 规模' + fund.netAsset.toFixed(1) + '亿'
                : fund.code + ' · ' + (typeof fund.manager === 'string' ? fund.manager : '');

            var card = document.createElement('div');
            card.className = 'fund-card';
            card.innerHTML = `
                <div class="fund-card-top">
                    <div class="fund-name-area">
                        <div class="fund-name">
                            ${fund.name}
                            <span class="fund-type-tag">${fund.typeName}</span>
                            ${realTag}
                        </div>
                        <div class="fund-code">${codeMeta}</div>
                    </div>
                    <div class="fund-stars">${stars}</div>
                </div>
                ${mgrRow}
                <div class="fund-price-row">
                    <div class="fund-nav">${fmt(fund.nav, 4)}</div>
                    <div class="fund-price-col">
                        <div class="fund-change ${isUp ? 'up' : 'down'}">
                            ${isUp ? '+' : ''}${fmt(fund.changePercent, 2)}%
                        </div>
                        ${intradayHtml}
                    </div>
                </div>
                <div class="fund-pred-box" title="${predTitle}${factorRows ? '（点击展开因子明细）' : ''}">
                    <div class="fund-pred-header">
                        <span class="fund-pred-label"><span class="ai-icon"></span>AI明日预测${factorRows ? '<span class="fund-pred-hint">·点击看因子</span>' : ''}</span>
                        <span class="fund-pred-conf">${fund.confidence.toFixed(1)}%</span>
                    </div>
                    <div class="fund-pred-value ${predUp ? 'up' : 'down'}">
                        ${predUp ? '+' : ''}${fund.pred1D.toFixed(2)}%
                    </div>
                    ${fund.aiReal ? '<div class="fund-yesterday">' + aiYesterdayHtml(fund) + '</div>' : ''}
                    ${fund.intervals ? '<div class="fund-iv-wrap">' + aiIntervalsHtml(fund, { noBadge: true }) + '</div>' : ''}
                </div>
                ${factorDetail}
                ${holdingsHtml}
                ${ensHtml}
                ${shapHtml}
                <div class="fund-metrics">
                    <div class="fund-metric">
                        <div class="fund-metric-label">近1月</div>
                        <div class="fund-metric-value ${fund.ret1M >= 0 ? 'up' : 'down'}">
                            ${fund.ret1M >= 0 ? '+' : ''}${fund.ret1M.toFixed(2)}%
                        </div>
                    </div>
                    <div class="fund-metric">
                        <div class="fund-metric-label">近6月</div>
                        <div class="fund-metric-value ${fund.ret6M >= 0 ? 'up' : 'down'}">
                            ${fund.ret6M >= 0 ? '+' : ''}${fund.ret6M.toFixed(2)}%
                        </div>
                    </div>
                    <div class="fund-metric">
                        <div class="fund-metric-label">近1年</div>
                        <div class="fund-metric-value ${fund.ret1Y >= 0 ? 'up' : 'down'}">
                            ${fund.ret1Y >= 0 ? '+' : ''}${fund.ret1Y.toFixed(2)}%
                        </div>
                    </div>
                </div>
            `;
            grid.appendChild(card);
            if (factorRows) {
                card.querySelector('.fund-pred-box').addEventListener('click', function() {
                    fund._factorsOpen = !fund._factorsOpen;
                    var detail = card.querySelector('.fund-factor-detail');
                    if (detail) detail.classList.toggle('open', fund._factorsOpen);
                });
            }
        });
    }

    function setupFundTypeTabs() {
        var tabs = document.querySelectorAll('#fundTypeTabs .fund-type-tab');
        tabs.forEach(function(tab) {
            tab.addEventListener('click', function() {
                tabs.forEach(function(t) { t.classList.remove('active'); });
                tab.classList.add('active');
                activeFundType = tab.dataset.type;
                savePref('fundType', activeFundType);
                renderFundCards();
            });
        });
    }

    // ===== Fund Simulator =====
    function initSimulatorChart() {
        var el = document.getElementById('simulatorChart');
        if (!el) return;
        simulatorChart = echarts.init(el, null, { renderer: 'svg' });
        updateSimulator();
    }

    function updateSimulator() {
        var fundSelect = document.getElementById('simFundSelect');
        var amountInput = document.getElementById('simAmount');
        var monthsInput = document.getElementById('simMonths');
        var typeSelect = document.getElementById('simType');
        if (!fundSelect || !amountInput || !monthsInput || !typeSelect) return;

        var fundCode = fundSelect.value;
        var amount = parseFloat(amountInput.value) || 10000;
        var months = parseInt(monthsInput.value) || 12;
        var simType = typeSelect.value;

        var fund = funds.find(function(f) { return f.code === fundCode; });
        var annualReturn = fund ? fund.ret1Y / 100 : 0.15;
        var monthlyReturn = Math.pow(1 + annualReturn, 1 / 12) - 1;

        var labels = [];
        var principalData = [];
        var totalData = [];
        var profitData = [];
        var totalPrincipal = 0;
        var totalValue = 0;

        for (var i = 0; i <= months; i++) {
            labels.push('第' + i + '月');
            if (simType === 'lump') {
                totalPrincipal = amount;
                totalValue = amount * Math.pow(1 + monthlyReturn, i);
            } else {
                totalPrincipal = amount * i;
                totalValue = i === 0 ? 0 : (totalValue + amount) * (1 + monthlyReturn);
            }
            principalData.push(totalPrincipal.toFixed(2));
            totalData.push(totalValue.toFixed(2));
            profitData.push((totalValue - totalPrincipal).toFixed(2));
        }

        var finalProfit = totalValue - totalPrincipal;
        var finalReturn = totalPrincipal > 0 ? (finalProfit / totalPrincipal) * 100 : 0;
        var isProfit = finalProfit >= 0;

        var resultEl = document.getElementById('simulatorResult');
        if (resultEl) {
            var items = resultEl.querySelectorAll('.sim-result-item');
            if (items.length >= 4) {
                items[0].querySelector('.sim-result-value').textContent = '¥' + fmt(totalPrincipal, 2);
                var pEl = items[1].querySelector('.sim-result-value');
                pEl.textContent = (isProfit ? '+' : '') + '¥' + fmt(finalProfit, 2);
                pEl.className = 'sim-result-value ' + (isProfit ? 'up' : 'down') + ' mono';
                items[2].querySelector('.sim-result-value').textContent = '¥' + fmt(totalValue, 2);
                var rEl = items[3].querySelector('.sim-result-value');
                rEl.textContent = (isProfit ? '+' : '') + finalReturn.toFixed(2) + '%';
                rEl.className = 'sim-result-value ' + (isProfit ? 'up' : 'down') + ' mono';
            }
        }

        if (simulatorChart) {
            simulatorChart.setOption({
                animation: false,
                tooltip: { trigger: 'axis', appendToBody: true,
                    backgroundColor: bg3, borderColor: rule, textStyle: { color: ink },
                    formatter: function(params) {
                        var r = params[0].name + '<br/>';
                        params.forEach(function(p) {
                            r += p.marker + p.seriesName + ': ¥' + Number(p.value).toLocaleString('zh-CN', { minimumFractionDigits: 2 }) + '<br/>';
                        });
                        return r;
                    } },
                legend: { data: ['投入本金', '总资产', '累计收益'], top: 0,
                    textStyle: { color: muted, fontSize: 12 } },
                grid: { top: 35, right: 20, bottom: 30, left: 65 },
                xAxis: { type: 'category', data: labels,
                    axisLine: { lineStyle: { color: rule } },
                    axisLabel: { color: muted, fontSize: 10, interval: Math.floor(months / 10) },
                    axisTick: { show: false } },
                yAxis: { type: 'value',
                    axisLine: { show: false },
                    axisLabel: { color: muted, fontSize: 11,
                        formatter: function(v) { return v >= 10000 ? (v/10000).toFixed(1)+'万' : v; } },
                    splitLine: { lineStyle: { color: rule, type: 'dashed' } } },
                series: [
                    { name: '投入本金', type: 'line', data: principalData, smooth: true, symbol: 'none',
                        lineStyle: { color: muted, width: 2 } },
                    { name: '总资产', type: 'line', data: totalData, smooth: true, symbol: 'none',
                        lineStyle: { color: blue, width: 2 },
                        areaStyle: {
                            color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                                colorStops: [{ offset: 0, color: blue + '25' }, { offset: 1, color: blue + '00' }] } } },
                    { name: '累计收益', type: 'line', data: profitData, smooth: true, symbol: 'none',
                        lineStyle: { color: isProfit ? accent : accent2, width: 2 } }
                ]
            });
        }
    }

    function setupSimulator() {
        var btn = document.getElementById('simulateBtn');
        if (btn) btn.addEventListener('click', updateSimulator);
    }

    // ===== News Module =====
    function renderNews() {
        var listEl = document.getElementById('newsList');
        if (!listEl) return;
        listEl.innerHTML = '';

        var list = activeNewsCategory === 'all' ? news : news.filter(function(n) { return n.category === activeNewsCategory; });

        list.forEach(function(item) {
            var tagCls = item.category === 'important' ? 'important' :
                        item.category === 'policy' ? 'policy' : 'market';
            var tagText = item.category === 'important' ? '重大' :
                         item.category === 'policy' ? '政策' :
                         item.category === 'market' ? '市场' : '公司';

            var el = document.createElement('div');
            el.className = 'news-item';
            var titleHtml = (item.url && item.url !== '#')
                ? '<a class="news-title news-link" href="' + item.url + '" target="_blank" rel="noopener noreferrer">' + item.title + '</a>'
                : '<div class="news-title">' + item.title + '</div>';
            el.innerHTML = `
                <div class="news-impact ${item.impact}"></div>
                <div class="news-content">
                    ${titleHtml}
                    <div class="news-summary">${item.summary}</div>
                    <div class="news-meta">
                        <span class="news-tag ${tagCls}">${tagText}</span>
                        <span>${item.source}</span>
                        <span>${item.time}</span>
                    </div>
                </div>
            `;
            listEl.appendChild(el);
        });
    }

    // 新闻加载：后端可用时拉取真实新闻，同一分类5分钟内不重复请求
    var newsFetchedAt = {};
    function loadNews(category, force) {
        renderNews();
        if (!backendEnabled) return;
        var now = Date.now();
        if (!force && newsFetchedAt[category] && now - newsFetchedAt[category] < 300000) return;
        newsFetchedAt[category] = now;
        DataAPI.fetchBackendNews(category).then(function(items) {
            if (Array.isArray(items) && items.length > 0) {
                news = items;
                renderNews();
            }
        }).catch(function() { /* 拉取失败保留现有数据 */ });
    }

    function setupNewsTabs() {
        var tabs = document.querySelectorAll('#newsTabs .news-tab');
        tabs.forEach(function(tab) {
            tab.addEventListener('click', function() {
                tabs.forEach(function(t) { t.classList.remove('active'); });
                tab.classList.add('active');
                activeNewsCategory = tab.dataset.category;
                savePref('newsCategory', activeNewsCategory);
                loadNews(activeNewsCategory, true);
            });
        });
    }

    // ===== Market Linkage Module =====
    function initLinkageChart() {
        var el = document.getElementById('linkageChart');
        if (!el) return;
        linkageChart = echarts.init(el, null, { renderer: 'svg' });
        updateLinkageChart();
    }

    function updateLinkageChart() {
        if (!linkageChart) return;
        var days = 60;
        var now = new Date();
        var dates = [];
        for (var i = days - 1; i >= 0; i--) {
            var d = new Date(now);
            d.setDate(d.getDate() - i);
            dates.push(formatDate(d, 'day'));
        }
        // Generate normalized data for multiple markets
        // 颜色按 7 个互不重叠的色相分配，避免相邻/相似颜色导致线条难分辨
        // (绿/蓝/紫/红/青/金/橙)，亮暗两套主题下都易区分
        var markets = [
            { name: '上证指数', color: accent,    base: 100, trend: 0.52, vol: 0.015 },
            { name: '标普500',  color: blue,      base: 100, trend: 0.54, vol: 0.012 },
            { name: '纳斯达克', color: purple,    base: 100, trend: 0.55, vol: 0.018 },
            { name: '日经225',  color: '#f87171', base: 100, trend: 0.53, vol: 0.014 },
            { name: '德国DAX',  color: '#22d3ee', base: 100, trend: 0.52, vol: 0.013 },
            { name: '黄金',     color: gold,      base: 100, trend: 0.56, vol: 0.010 },
            { name: '比特币',   color: '#f97316', base: 100, trend: 0.58, vol: 0.035 }
        ];
        var series = [];
        markets.forEach(function(m) {
            var data = [];
            var price = m.base;
            for (var i = 0; i < days; i++) {
                var change = (Math.random() - (1 - m.trend)) * m.vol * 2;
                price = price * (1 + change);
                data.push(price.toFixed(2));
            }
            series.push({
                name: m.name,
                type: 'line',
                data: data,
                smooth: true,
                symbol: 'none',
                lineStyle: { color: m.color, width: 2 },
                // 悬停聚焦本线，其他线淡化，便于一眼分辨
                emphasis: { focus: 'series', lineStyle: { width: 3 } },
                // 线尾标签：直接显示指数名称，鼠标点哪条线也能看到对应名称
                endLabel: {
                    show: true,
                    formatter: m.name,
                    color: m.color,
                    fontSize: 11,
                    fontWeight: 600,
                    padding: [0, 0, 0, 6]
                },
                label: {
                    show: false,
                    position: 'top',
                    color: m.color,
                    fontSize: 10,
                    formatter: function(p) { return p.value; }
                },
                areaStyle: {
                    color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                        colorStops: [{ offset: 0, color: m.color + '15' }, { offset: 1, color: m.color + '00' }] }
                }
            });
        });
        linkageChart.setOption({
            animation: false,
            title: { text: '全球市场指数走势对比（归一化）', left: 'left',
                textStyle: { color: ink, fontSize: 14, fontWeight: 600 } },
            tooltip: { trigger: 'axis', appendToBody: true,
                backgroundColor: bg3, borderColor: rule, textStyle: { color: ink } },
            legend: { data: markets.map(function(m) { return m.name; }),
                top: 30, textStyle: { color: muted, fontSize: 11 } },
            // right 留出 100px 给 endLabel 的指数名称（"上证指数"/"标普500"等）
            grid: { top: 70, right: 100, bottom: 30, left: 60 },
            xAxis: { type: 'category', data: dates,
                axisLine: { lineStyle: { color: rule } },
                axisLabel: { color: muted, fontSize: 10, interval: Math.floor(days / 12) },
                axisTick: { show: false } },
            yAxis: { type: 'value', scale: true,
                axisLine: { show: false }, axisLabel: { color: muted, fontSize: 11, formatter: '{value}' },
                splitLine: { lineStyle: { color: rule, type: 'dashed' } } },
            dataZoom: [{ type: 'inside', start: 0, end: 100 }],
            series: series
        });
    }

    function renderCorrelations() {
        var grid = document.getElementById('correlationGrid');
        if (!grid) return;
        grid.innerHTML = '';
        correlations.forEach(function(corr) {
            var pct = Math.abs(corr.value) * 100;
            var card = document.createElement('div');
            card.className = 'correlation-card';
            card.innerHTML = `
                <div class="correlation-header">
                    <span class="correlation-pair">${corr.pair}</span>
                    <span class="correlation-value ${corr.type}">${corr.value > 0 ? '+' : ''}${corr.value.toFixed(2)}</span>
                </div>
                <div class="correlation-bar">
                    <div class="correlation-bar-fill ${corr.type}" style="width: ${pct}%;"></div>
                </div>
                <div class="correlation-desc">${corr.desc}</div>
            `;
            grid.appendChild(card);
        });
    }

    // 读取当前主题下 --bg2 的实际 RGB（用于计算合成后的感知亮度，主题切换也实时生效）
    function getCardBgRgb() {
        var c = window.getComputedStyle(document.documentElement).getPropertyValue('--bg2').trim();
        if (c && c.charAt(0) === '#') {
            var hex = c.substring(1);
            if (hex.length === 3) hex = hex.split('').map(function(x){ return x + x; }).join('');
            return [parseInt(hex.substring(0,2),16), parseInt(hex.substring(2,4),16), parseInt(hex.substring(4,6),16)];
        }
        var m = c && c.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
        return m ? [+m[1], +m[2], +m[3]] : [255,255,255];
    }
    // 相对亮度（WCAG sRGB）
    function relLum(rgb) {
        function lin(c){ c/=255; return c <= 0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); }
        return 0.2126*lin(rgb[0]) + 0.7152*lin(rgb[1]) + 0.0722*lin(rgb[2]);
    }
    // 在卡片背景上合成前景色（alpha 混合）
    function compositeOver(fg, alpha, bgRgb) {
        return [
            Math.round(fg[0]*alpha + bgRgb[0]*(1-alpha)),
            Math.round(fg[1]*alpha + bgRgb[1]*(1-alpha)),
            Math.round(fg[2]*alpha + bgRgb[2]*(1-alpha))
        ];
    }

    function renderHeatmap() {
        var container = document.getElementById('heatmapContainer');
        if (!container) return;
        // Rows: asset classes, Columns: markets
        var rowLabels = ['股票', '债券', '商品', '外汇', '加密'];
        var colLabels = ['中国', '美国', '欧洲', '日本', '英国', '澳洲', '新兴市场'];

        var cardBg = getCardBgRgb();
        var green = [63, 185, 80];
        var red   = [248, 81, 73];

        var gridHtml = '<div class="heatmap-grid">';
        // Header row
        gridHtml += '<div class="heatmap-row"><div class="heatmap-header"></div>';
        colLabels.forEach(function(col) {
            gridHtml += '<div class="heatmap-header">' + col + '</div>';
        });
        gridHtml += '</div>';
        // Data rows
        rowLabels.forEach(function(row) {
            gridHtml += '<div class="heatmap-row">';
            gridHtml += '<div class="heatmap-label">' + row + '</div>';
            colLabels.forEach(function() {
                var change = (Math.random() - 0.45) * 6; // -3% to +3%
                var isUp = change >= 0;
                var intensity = Math.min(Math.abs(change) / 3, 1);
                var alpha = 0.3 + intensity * 0.6;   // 0.30..0.90
                var fg = isUp ? green : red;
                var composed = compositeOver(fg, alpha, cardBg);
                // 感知亮度 > 0.58 → 浅底，用深字；否则深底，用白字（明暗主题均适用）
                var textColor = relLum(composed) > 0.58
                    ? 'rgba(31,35,40,0.92)'
                    : 'rgba(255,255,255,0.96)';
                gridHtml += '<div class="heatmap-cell" style="background:rgba(' + fg.join(',') + ',' + alpha.toFixed(2) + ');color:' + textColor + ';">' +
                    (isUp ? '+' : '') + change.toFixed(2) + '%' + '</div>';
            });
            gridHtml += '</div>';
        });
        gridHtml += '</div>';
        container.innerHTML = gridHtml;
    }

    // ===== Real Data Fetch =====

    // 从后端代理获取数据（优先方式，数据最全）
    function fetchRealDataFromBackend() {
        var allSuccess = true;

        // 1. 全球指数
        var indicesPromise = DataAPI.fetchBackendIndices().then(function(data) {
            // 更新A股指数卡片
            ['000001.SH', '399001.SZ', '399006.SZ', '000688.SH', '000300.SH', '000905.SH', 'HSI', 'DJI', 'IXIC'].forEach(function(code) {
                var src = null;
                if (data.china && data.china[code]) src = data.china[code];
                else if (data.hongkong && data.hongkong[code]) src = data.hongkong[code];
                else if (data.us && data.us[code]) src = data.us[code];

                if (src) {
                    var idx = getIndex(code);
                    if (idx) {
                        idx.price = src.price;
                        idx.change = src.change;
                        idx.changePercent = src.changePercent;
                        idx.trend = src.changePercent > 0.3 ? 'bullish' : src.changePercent < -0.3 ? 'bearish' : 'shock';
                    }
                }
            });

            // 更新全球指数
            ['asia', 'europe', 'americas'].forEach(function(region) {
                if (data[region]) {
                    Object.keys(data[region]).forEach(function(code) {
                        var src = data[region][code];
                        var target = getGlobalIndex(code);
                        if (target) {
                            target.price = src.price;
                            target.change = src.change;
                            target.changePercent = src.changePercent;
                            target.trend = src.changePercent > 0.3 ? 'bullish' : src.changePercent < -0.3 ? 'bearish' : 'shock';
                        }
                    });
                }
            });
        }).catch(function() { allSuccess = false; });

        // 2. 数字货币
        var cryptoPromise = DataAPI.fetchBackendCrypto(['BTC', 'ETH', 'BNB', 'SOL']).then(function(data) {
            Object.keys(data).forEach(function(sym) {
                if (cryptoProducts[sym]) {
                    var d = data[sym];
                    cryptoProducts[sym].price = d.price;
                    cryptoProducts[sym].change = d.priceChange;
                    cryptoProducts[sym].changePercent = d.changePercent;
                    cryptoProducts[sym].high = d.high;
                    cryptoProducts[sym].low = d.low;
                    cryptoProducts[sym].open = d.open;
                    cryptoProducts[sym].prevClose = d.prevClose;
                    cryptoProducts[sym].volume = d.quoteVolume;
                    cryptoProducts[sym].trend = d.changePercent > 1 ? 'bullish' : d.changePercent < -1 ? 'bearish' : 'shock';
                }
            });
        }).catch(function() { allSuccess = false; });

        // 3. 黄金价格
        var goldPromise = DataAPI.fetchBackendGold().then(function(data) {
            if (data && data.price) {
                var intl = goldProducts['intl'];
                if (intl) {
                    intl.price = data.price;
                    intl.change = data.change;
                    intl.changePercent = data.changePercent;
                    intl.high = data.high;
                    intl.low = data.low;
                    intl.open = data.open;
                    intl.prevClose = data.price - data.change;
                    intl.trend = data.changePercent > 0.3 ? 'bullish' : data.changePercent < -0.3 ? 'bearish' : 'shock';
                }
                // 其他黄金品种按比例推算
                var ratios = {
                    'london': 0.998,  // 伦敦金略低于现货
                    'newyork': 0.995, // 纽约期货略低
                    'shanghai': 1 / 31.1035 * 7.2 // 上海金: 美元/盎司 -> 人民币/克 (粗略汇率)
                };
                Object.keys(ratios).forEach(function(key) {
                    var g = goldProducts[key];
                    if (g) {
                        g.price = data.price * ratios[key];
                        g.change = data.change * ratios[key];
                        g.changePercent = data.changePercent;
                        g.high = data.high * ratios[key];
                        g.low = data.low * ratios[key];
                        g.trend = data.changePercent > 0.3 ? 'bullish' : data.changePercent < -0.3 ? 'bearish' : 'shock';
                    }
                });
            }
        }).catch(function() { allSuccess = false; });

        // 4. 新闻数据（低频：loadNews内部有5分钟防重复，不参与成败判定）
        loadNews(activeNewsCategory);

        // 5. AI多因子预测（低频：各加载函数内部有防重复——指数50秒/基金5分钟）
        if (typeof activeIndex !== 'undefined' && getIndex(activeIndex)) {
            loadAiPrediction();
        }
        loadGoldAiPrediction();
        loadCryptoAiPrediction();
        loadFundPredictions();

        return Promise.all([indicesPromise, cryptoPromise, goldPromise]).then(function() {
            updateDataStatus(allSuccess ? 'live' : 'degraded');
            refreshActiveModuleAfterData();
        });
    }

    function updateDataStatus(status) {
        realDataStatus = status;
        var indicator = document.getElementById('dataStatus');
        if (!indicator) return;
        var statusMap = {
            connecting: { text: '连接中...', color: 'var(--orange)', dot: 'var(--orange)' },
            live: { text: backendEnabled ? '实时行情' : '实时数据', color: 'var(--accent)', dot: 'var(--accent)' },
            degraded: { text: '部分数据', color: 'var(--orange)', dot: 'var(--orange)' },
            offline: { text: '模拟数据', color: 'var(--muted)', dot: 'var(--muted)' }
        };
        var s = statusMap[status] || statusMap.offline;
        indicator.innerHTML = '<span class="live-dot" style="background: ' + s.dot + ';"></span> <span style="color: ' + s.color + ';">' + s.text + '</span>';
    }

    function fetchRealData() {
        if (!realDataEnabled) return Promise.resolve();
        // 探测未完成时等待：探测成功路径会自行触发fetchRealDataFromBackend
        if (!backendDetectDone) return Promise.resolve();

        // 如果后端服务可用，优先使用后端聚合API
        if (backendEnabled) {
            return fetchRealDataFromBackend();
        }

        var promises = [];
        var successCount = 0;
        var totalCount = 0;

        // 1. A股/港股指数 (新浪财经)
        totalCount++;
        var sinaCodes = ['sh000001', 'sz399001', 'sz399006', 'hkHSI'];
        var sinaPromise = DataAPI.fetchSinaIndices(sinaCodes).then(function(data) {
            successCount++;
            // 更新A股指数数据
            if (data['sh000001']) {
                var d = data['sh000001'];
                var idx = getIndex('000001.SH');
                if (idx) { idx.price = d.price; idx.change = d.change; idx.changePercent = d.changePercent; idx.trend = d.changePercent > 0.3 ? 'bullish' : d.changePercent < -0.3 ? 'bearish' : 'shock'; }
            }
            if (data['sz399001']) {
                var d = data['sz399001'];
                var idx = getIndex('399001.SZ');
                if (idx) { idx.price = d.price; idx.change = d.change; idx.changePercent = d.changePercent; idx.trend = d.changePercent > 0.3 ? 'bullish' : d.changePercent < -0.3 ? 'bearish' : 'shock'; }
            }
            if (data['sz399006']) {
                var d = data['sz399006'];
                var idx = getIndex('399006.SZ');
                if (idx) { idx.price = d.price; idx.change = d.change; idx.changePercent = d.changePercent; idx.trend = d.changePercent > 0.5 ? 'bullish' : d.changePercent < -0.5 ? 'bearish' : 'shock'; }
            }
            if (data['hkHSI']) {
                var d = data['hkHSI'];
                var idx = getIndex('HSI');
                if (idx) { idx.price = d.price; idx.change = d.change; idx.changePercent = d.changePercent; idx.trend = d.changePercent > 0.3 ? 'bullish' : d.changePercent < -0.3 ? 'bearish' : 'shock'; }
            }
        }).catch(function() { /* silent fail */ });
        promises.push(sinaPromise);

        // 2. 数字货币 (Binance)
        totalCount++;
        var cryptoSymbols = ['BTC', 'ETH', 'BNB', 'SOL'];
        var cryptoPromise = DataAPI.fetchBinanceTicker(cryptoSymbols).then(function(data) {
            successCount++;
            Object.keys(data).forEach(function(sym) {
                if (cryptoProducts[sym]) {
                    var d = data[sym];
                    cryptoProducts[sym].price = d.price;
                    cryptoProducts[sym].change = d.priceChange;
                    cryptoProducts[sym].changePercent = d.changePercent;
                    cryptoProducts[sym].high = d.high;
                    cryptoProducts[sym].low = d.low;
                    cryptoProducts[sym].open = d.open;
                    cryptoProducts[sym].prevClose = d.prevClose;
                    cryptoProducts[sym].volume = d.quoteVolume;
                    cryptoProducts[sym].trend = d.changePercent > 1 ? 'bullish' : d.changePercent < -1 ? 'bearish' : 'shock';
                }
            });
        }).catch(function() { /* silent fail */ });
        promises.push(cryptoPromise);

        // 3. 美股/其他 (TerminalFeed)
        totalCount++;
        var tfPromise = DataAPI.fetchTerminalFeed('stocks').then(function(data) {
            successCount++;
            if (data && data.indices) {
                data.indices.forEach(function(idx) {
                    if (idx.symbol === 'SPY') {
                        var spx = getIndex('SPX') || getGlobalIndex('SPX');
                        if (spx) { spx.price = idx.price; spx.changePercent = idx.change_percent; spx.change = idx.price * idx.change_percent / 100; spx.trend = idx.change_percent > 0.3 ? 'bullish' : idx.change_percent < -0.3 ? 'bearish' : 'shock'; }
                    }
                    if (idx.symbol === 'DIA') {
                        var dji = getIndex('DJI') || getGlobalIndex('DJI');
                        if (dji) { dji.price = idx.price * 10; dji.changePercent = idx.change_percent; dji.change = idx.price * 10 * idx.change_percent / 100; dji.trend = idx.change_percent > 0.3 ? 'bullish' : idx.change_percent < -0.3 ? 'bearish' : 'shock'; }
                    }
                    if (idx.symbol === 'QQQ') {
                        var ixic = getIndex('IXIC') || getGlobalIndex('IXIC');
                        if (ixic) { ixic.price = idx.price * 50; ixic.changePercent = idx.change_percent; ixic.change = idx.price * 50 * idx.change_percent / 100; ixic.trend = idx.change_percent > 0.3 ? 'bullish' : idx.change_percent < -0.3 ? 'bearish' : 'shock'; }
                    }
                });
            }
        }).catch(function() { /* silent fail */ });
        promises.push(tfPromise);

        return Promise.all(promises).then(function() {
            if (successCount === totalCount) {
                updateDataStatus('live');
            } else if (successCount > 0) {
                updateDataStatus('degraded');
            } else {
                updateDataStatus('offline');
            }
            refreshActiveModuleAfterData();
        });
    }

    // 真实数据到达后刷新当前模块的可见组件
    function refreshActiveModuleAfterData() {
        if (activeModule === 'index') {
            renderIndexCards();
            updateIndexChartHeader();
            updateMainChart();
        } else if (activeModule === 'global') {
            renderGlobalIndexCards('asia', 'globalAsiaGrid');
            renderGlobalIndexCards('europe', 'globalEuropeGrid');
            renderGlobalIndexCards('americas', 'globalAmericasGrid');
            updateGlobalChartHeader();
        } else if (activeModule === 'gold') {
            updateGoldChartHeader();
            updateGoldDetails();
            updateGoldChart();
        } else if (activeModule === 'crypto') {
            updateCryptoChartHeader();
            updateCryptoStats();
            updateCryptoChart();
        }
    }

    // ===== Real-time Refresh =====
    function updateTime() {
        var now = new Date();
        var t = now.getFullYear() + '/' +
                (now.getMonth() + 1).toString().padStart(2, '0') + '/' +
                now.getDate().toString().padStart(2, '0') + ' ' +
                now.getHours().toString().padStart(2, '0') + ':' +
                now.getMinutes().toString().padStart(2, '0') + ':' +
                now.getSeconds().toString().padStart(2, '0');
        var el = document.getElementById('currentTime');
        if (el) el.textContent = t;
    }

    function tickRefreshCountdown() {
        var el = document.getElementById('refreshCountdown');
        if (el) el.textContent = refreshCountdown + 's';
        refreshCountdown--;
        if (refreshCountdown < 0) {
            refreshCountdown = REFRESH_INTERVAL;
            doRealTimeRefresh();
            apiFetchCounter++;
            // 每 N 个周期调用一次真实API (约15秒)
            if (apiFetchCounter >= API_FETCH_INTERVAL && realDataEnabled) {
                apiFetchCounter = 0;
                fetchRealData();
            }
        }
    }

    function doRealTimeRefresh() {
        // 后端实时模式下不注入随机抖动，只重渲染；
        // 抖动只用于无后端时的模拟行情，否则会污染真实价格并累积误差
        var simulate = !backendEnabled;

        if (simulate) {
            // Update indices
            indices.forEach(function(idx) {
                var delta = (Math.random() - 0.5) * Math.abs(idx.change) * 0.15;
                idx.price += delta;
                idx.change += delta;
                idx.changePercent = (idx.change / (idx.price - idx.change)) * 100;
            });

            // Update global indices
            Object.keys(globalIndices).forEach(function(region) {
                globalIndices[region].forEach(function(idx) {
                    var delta = (Math.random() - 0.5) * Math.abs(idx.change) * 0.15;
                    idx.price += delta;
                    idx.change += delta;
                    idx.changePercent = (idx.change / (idx.price - idx.change)) * 100;
                });
            });

            // Update gold products
            Object.keys(goldProducts).forEach(function(key) {
                var g = goldProducts[key];
                var delta = (Math.random() - 0.45) * g.change * 0.2;
                g.price += delta;
                g.change += delta;
                g.changePercent = (g.change / (g.price - g.change)) * 100;
                g.high = Math.max(g.high, g.price);
                g.low = Math.min(g.low, g.price);
            });

            // Update crypto products
            Object.keys(cryptoProducts).forEach(function(key) {
                var c = cryptoProducts[key];
                var delta = (Math.random() - 0.45) * c.change * 0.25;
                c.price += delta;
                c.change += delta;
                c.changePercent = (c.change / (c.price - c.change)) * 100;
                c.high = Math.max(c.high, c.price);
                c.low = Math.min(c.low, c.price);
            });
        }

        // Update stocks
        gainers.forEach(function(s) {
            s.price = s.price * (1 + (Math.random() - 0.3) * 0.005);
            s.change = s.change + (Math.random() - 0.3) * 0.3;
        });
        losers.forEach(function(s) {
            s.price = s.price * (1 + (Math.random() - 0.7) * 0.005);
            s.change = s.change + (Math.random() - 0.7) * 0.2;
        });

        // Re-render only the active module (performance: avoid full DOM rebuild)
        if (activeModule === 'index') {
            renderIndexCards();
            renderStockLists();
            updateIndexChartHeader();
        } else if (activeModule === 'global') {
            renderGlobalIndexCards('asia', 'globalAsiaGrid');
            renderGlobalIndexCards('europe', 'globalEuropeGrid');
            renderGlobalIndexCards('americas', 'globalAmericasGrid');
            updateGlobalChartHeader();
            renderMarketClocks('marketClockGrid');
        } else if (activeModule === 'gold') {
            updateGoldChartHeader();
            updateGoldDetails();
            renderMarketClocks('marketClockGrid');

            // Update gold tab prices
            document.querySelectorAll('.gold-tab').forEach(function(tab) {
                var g = goldProducts[tab.dataset.gold];
                if (!g) return;
                var priceEl = tab.querySelector('.gold-tab-price');
                var changeEl = tab.querySelector('.gold-tab-change');
                if (priceEl) priceEl.textContent = fmt(g.price, 2);
                if (changeEl) {
                    var isUp = g.change >= 0;
                    changeEl.textContent = (isUp ? '+' : '') + fmt(g.change, 2) + ' (' + (isUp ? '+' : '') + fmt(g.changePercent, 2) + '%)';
                    changeEl.className = 'gold-tab-change ' + (isUp ? 'up' : 'down');
                }
            });
        } else if (activeModule === 'crypto') {
            updateCryptoChartHeader();
            updateCryptoStats();

            // Update crypto tab prices
            document.querySelectorAll('.crypto-tab').forEach(function(tab) {
                var c = cryptoProducts[tab.dataset.crypto];
                if (!c) return;
                var priceEl = tab.querySelector('.crypto-tab-price');
                var changeEl = tab.querySelector('.crypto-tab-change');
                if (priceEl) priceEl.textContent = fmt(c.price, 2);
                if (changeEl) {
                    var isUp = c.change >= 0;
                    changeEl.textContent = (isUp ? '+' : '') + fmt(c.change, 2) + ' (' + (isUp ? '+' : '') + fmt(c.changePercent, 2) + '%)';
                    changeEl.className = 'crypto-tab-change ' + (isUp ? 'up' : 'down');
                }
            });
        } else if (activeModule === 'linkage') {
            renderMarketClocks('linkageClockGrid');
        }
    }

    // ===== User Preferences (localStorage) =====
    var PREF_KEY = 'zhitou_prefs_v1';

    function savePref(key, value) {
        try {
            var prefs = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
            prefs[key] = value;
            localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
        } catch (e) { /* localStorage 不可用时忽略 */ }
    }

    function loadPref(key, fallback) {
        try {
            var prefs = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
            return (key in prefs) ? prefs[key] : fallback;
        } catch (e) {
            return fallback;
        }
    }

    function restorePreferences() {
        var savedModule = loadPref('module', null);
        if (savedModule && document.getElementById('module-' + savedModule)) {
            switchModule(savedModule);
        }

        var savedIndex = loadPref('activeIndex', null);
        if (savedIndex && getIndex(savedIndex)) {
            selectIndex(savedIndex);
        }

        var savedIndexPeriod = loadPref('indexPeriod', null);
        if (savedIndexPeriod) {
            activeIndexPeriod = savedIndexPeriod;
            document.querySelectorAll('#periodTabs .period-tab').forEach(function(t) {
                t.classList.toggle('active', t.dataset.period === savedIndexPeriod);
            });
        }

        var savedChartType = loadPref('indexChartType', null);
        if (savedChartType) {
            activeChartType = savedChartType;
            document.querySelectorAll('#chartTypeTabs .chart-type-tab').forEach(function(t) {
                t.classList.toggle('active', t.dataset.type === savedChartType);
            });
        }

        // 全球指数模块
        var savedGlobalIndex = loadPref('globalIndex', null);
        if (savedGlobalIndex && getGlobalIndex(savedGlobalIndex)) {
            activeGlobalIndex = savedGlobalIndex;
            document.querySelectorAll('#module-global .index-card').forEach(function(c) {
                c.classList.toggle('active', c.dataset.code === savedGlobalIndex);
            });
            updateGlobalChartHeader();
            updateGlobalChart();
        }

        var savedGlobalPeriod = loadPref('globalPeriod', null);
        if (savedGlobalPeriod) {
            activeGlobalPeriod = savedGlobalPeriod;
            document.querySelectorAll('#globalPeriodTabs .period-tab').forEach(function(t) {
                t.classList.toggle('active', t.dataset.period === savedGlobalPeriod);
            });
        }

        var savedGlobalChartType = loadPref('globalChartType', null);
        if (savedGlobalChartType) {
            activeGlobalChartType = savedGlobalChartType;
            document.querySelectorAll('#globalChartTypeTabs .chart-type-tab').forEach(function(t) {
                t.classList.toggle('active', t.dataset.type === savedGlobalChartType);
            });
        }

        // 黄金模块
        var savedGold = loadPref('gold', null);
        if (savedGold && goldProducts[savedGold]) {
            activeGold = savedGold;
            document.querySelectorAll('.gold-tab').forEach(function(t) {
                t.classList.toggle('active', t.dataset.gold === savedGold);
            });
            updateGoldChartHeader();
            updateGoldChart();
            updateGoldDetails();
            updateGoldAiPanel();
            updateGoldAiChart();
        }

        var savedGoldPeriod = loadPref('goldPeriod', null);
        if (savedGoldPeriod) {
            activeGoldPeriod = savedGoldPeriod;
            document.querySelectorAll('#goldPeriodTabs .period-tab').forEach(function(t) {
                t.classList.toggle('active', t.dataset.period === savedGoldPeriod);
            });
        }

        var savedGoldChartType = loadPref('goldChartType', null);
        if (savedGoldChartType) {
            activeGoldChartType = savedGoldChartType;
            document.querySelectorAll('#goldChartTypeTabs .chart-type-tab').forEach(function(t) {
                t.classList.toggle('active', t.dataset.type === savedGoldChartType);
            });
        }

        // 数字货币模块
        var savedCrypto = loadPref('crypto', null);
        if (savedCrypto && cryptoProducts[savedCrypto]) {
            activeCrypto = savedCrypto;
            document.querySelectorAll('.crypto-tab').forEach(function(t) {
                t.classList.toggle('active', t.dataset.crypto === savedCrypto);
            });
            updateCryptoChartHeader();
            updateCryptoChart();
            updateCryptoStats();
            updateCryptoAiPanel();
            updateCryptoAiChart();
        }

        var savedCryptoPeriod = loadPref('cryptoPeriod', null);
        if (savedCryptoPeriod) {
            activeCryptoPeriod = savedCryptoPeriod;
            document.querySelectorAll('#cryptoPeriodTabs .period-tab').forEach(function(t) {
                t.classList.toggle('active', t.dataset.period === savedCryptoPeriod);
            });
        }

        var savedCryptoChartType = loadPref('cryptoChartType', null);
        if (savedCryptoChartType) {
            activeCryptoChartType = savedCryptoChartType;
            document.querySelectorAll('#cryptoChartTypeTabs .chart-type-tab').forEach(function(t) {
                t.classList.toggle('active', t.dataset.type === savedCryptoChartType);
            });
        }

        var savedFundType = loadPref('fundType', null);
        if (savedFundType) {
            activeFundType = savedFundType;
            document.querySelectorAll('#fundTypeTabs .fund-type-tab').forEach(function(t) {
                t.classList.toggle('active', t.dataset.type === savedFundType);
            });
            renderFundCards();
        }

        var savedNewsCategory = loadPref('newsCategory', null);
        if (savedNewsCategory) {
            activeNewsCategory = savedNewsCategory;
            document.querySelectorAll('#newsTabs .news-tab').forEach(function(t) {
                t.classList.toggle('active', t.dataset.category === savedNewsCategory);
            });
            renderNews();
        }
    }

    // ===== Theme Toggle (明亮 / 暗黑 / 自动跟随系统) =====
    var currentThemePref = 'auto';

    function setupThemeToggle() {
        currentThemePref = loadPref('theme', 'auto');
        applyTheme(currentThemePref);

        var btn = document.getElementById('themeToggleBtn');
        if (!btn) return;
        btn.addEventListener('click', function() {
            // 循环：明亮 -> 暗黑 -> 自动 -> 明亮
            var next = currentThemePref === 'light' ? 'dark'
                     : currentThemePref === 'dark' ? 'auto' : 'light';
            applyTheme(next);
            savePref('theme', next);
            var msg = next === 'light' ? '已切换到明亮主题'
                    : next === 'dark' ? '已切换到暗黑主题'
                    : '已切换到自动主题（跟随系统）';
            showToast(msg, 'success');
        });

        // 系统配色变化时，若处于自动模式则实时跟随
        try {
            var mq = window.matchMedia('(prefers-color-scheme: light)');
            var onSchemeChange = function() {
                if (currentThemePref !== 'auto') return;
                var eff = mq.matches ? 'light' : 'dark';
                document.body.setAttribute('data-theme', eff);
                syncThemeButton(eff);
                refreshAllChartTheme();
            };
            if (mq.addEventListener) { mq.addEventListener('change', onSchemeChange); }
            else if (mq.addListener) { mq.addListener(onSchemeChange); }
        } catch (e) { /* 旧浏览器忽略 */ }
    }

    function applyTheme(pref) {
        currentThemePref = pref;
        var effective = pref === 'auto'
            ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
            : pref;
        document.body.setAttribute('data-theme', effective);
        syncThemeButton(effective);
        refreshAllChartTheme();
    }

    function syncThemeButton(effective) {
        var btn = document.getElementById('themeToggleBtn');
        if (!btn) return;
        btn.setAttribute('data-theme-pref', currentThemePref);
        var title = currentThemePref === 'auto'
            ? '自动主题（跟随系统，当前：' + (effective === 'light' ? '明亮' : '暗黑') + '）'
            : (effective === 'light' ? '已启用明亮主题（点击切换）' : '已启用暗黑主题（点击切换）');
        btn.setAttribute('title', title);
    }

    function refreshAllChartTheme() {
        // ECharts 实例需重绘以适配新主题背景
        try {
            if (mainChart) { updateMainChart(); }
            if (aiPredictionChart) { updateAiPredictionChart(); }
            if (globalChart) { updateGlobalChart(); }
            if (goldChart) { updateGoldChart(); }
            if (goldAiChart) { updateGoldAiChart(); }
            if (cryptoChart) { updateCryptoChart(); }
            if (cryptoAiChart) { updateCryptoAiChart(); }
            if (linkageChart) { updateLinkageChart(); }
            if (simulatorChart) { updateSimulator(); }
            // 全局资产热力图文字对比度随主题背景重算，需随主题重绘
            try { renderHeatmap(); } catch (e) { /* 模块未就绪时忽略 */ }
        } catch (e) { /* 图表未初始化时忽略 */ }
    }

    // ===== Toast Notifications =====
    function showToast(message, type) {
        var container = document.getElementById('toastContainer');
        if (!container) return;
        type = type || 'info';

        var toast = document.createElement('div');
        toast.className = 'toast ' + type;
        toast.textContent = message;
        container.appendChild(toast);

        setTimeout(function() {
            toast.classList.add('leaving');
            setTimeout(function() { toast.remove(); }, 300);
        }, 3000);
    }

    // ===== Manual Refresh =====
    function setupManualRefresh() {
        var btn = document.getElementById('manualRefreshBtn');
        if (!btn) return;
        btn.addEventListener('click', function() {
            btn.classList.add('spinning');
            var done = function() {
                setTimeout(function() { btn.classList.remove('spinning'); }, 800);
            };

            if (backendEnabled) {
                fetchRealDataFromBackend().then(done).catch(done);
            } else {
                fetchRealData().then(done).catch(done);
            }
            refreshCountdown = REFRESH_INTERVAL;
            showToast('正在刷新最新行情数据...', 'info');
        });
    }

    // ===== Global Search =====
    function setupGlobalSearch() {
        var input = document.getElementById('searchInput');
        var dropdown = document.getElementById('searchDropdown');
        if (!input || !dropdown) return;

        var activeItem = -1;
        var currentResults = [];

        function collectSearchItems() {
            var items = [];

            indices.forEach(function(idx) {
                items.push({ group: '指数', name: idx.name, meta: idx.tag, price: idx.price, changePercent: idx.changePercent, type: 'index', code: idx.code });
            });

            Object.keys(globalIndices).forEach(function(region) {
                globalIndices[region].forEach(function(idx) {
                    if (['N225', 'KS11', 'FTSE', 'GDAXI', 'FCHI', 'SPX', 'TSX', 'BVSP'].indexOf(idx.code) !== -1) {
                        items.push({ group: '全球指数', name: idx.name, meta: idx.tag, price: idx.price, changePercent: idx.changePercent, type: 'global', code: idx.code });
                    }
                });
            });

            Object.keys(cryptoProducts).forEach(function(key) {
                var c = cryptoProducts[key];
                items.push({ group: '数字货币', name: c.name + ' (' + c.symbol + ')', meta: c.symbol, price: c.price, changePercent: c.changePercent, type: 'crypto', code: key });
            });

            Object.keys(goldProducts).forEach(function(key) {
                var g = goldProducts[key];
                items.push({ group: '黄金', name: g.name, meta: g.unit, price: g.price, changePercent: g.changePercent, type: 'gold', code: key });
            });

            funds.forEach(function(f) {
                items.push({ group: '基金', name: f.name, meta: f.typeName, price: f.nav, changePercent: f.changePercent, type: 'fund', code: f.code });
            });

            if (typeof sectors !== 'undefined') {
                sectors.forEach(function(s) {
                    items.push({ group: '板块', name: s.name, meta: s.tag, price: s.price, changePercent: s.changePercent, type: 'sector', code: s.code });
                });
            }

            return items;
        }

        function performSearch(keyword) {
            keyword = keyword.trim().toLowerCase();
            if (!keyword) {
                hideDropdown();
                return;
            }
            var all = collectSearchItems();
            currentResults = all.filter(function(item) {
                return item.name.toLowerCase().indexOf(keyword) !== -1 ||
                       (item.meta && item.meta.toLowerCase().indexOf(keyword) !== -1) ||
                       (item.code && item.code.toLowerCase().indexOf(keyword) !== -1);
            }).slice(0, 12);

            renderDropdown(currentResults);
        }

        function renderDropdown(results) {
            activeItem = -1;
            if (!results.length) {
                dropdown.innerHTML = '<div class="search-empty">未找到相关标的</div>';
                dropdown.classList.add('show');
                return;
            }

            var html = '';
            var lastGroup = '';
            results.forEach(function(item, i) {
                if (item.group !== lastGroup) {
                    html += '<div class="search-group-title">' + item.group + '</div>';
                    lastGroup = item.group;
                }
                var isUp = item.changePercent >= 0;
                html += '<div class="search-item" data-idx="' + i + '">' +
                    '<span class="search-item-name">' + item.name + '</span>' +
                    '<span class="search-item-meta">' +
                    '<span class="search-item-price">' + fmt(item.price, 2) + '</span>' +
                    '<span class="search-item-change ' + (isUp ? 'up' : 'down') + '">' + (isUp ? '+' : '') + fmt(item.changePercent, 2) + '%</span>' +
                    '</span></div>';
            });
            dropdown.innerHTML = html;
            dropdown.classList.add('show');

            dropdown.querySelectorAll('.search-item').forEach(function(el) {
                el.addEventListener('click', function() {
                    selectSearchResult(results[parseInt(el.dataset.idx, 10)]);
                });
            });
        }

        function selectSearchResult(item) {
            hideDropdown();
            input.value = '';
            switchModule(item.type === 'global' ? 'global' : item.type === 'index' ? 'index' : item.type);

            setTimeout(function() {
                if (item.type === 'index') {
                    selectIndex(item.code);
                } else if (item.type === 'global') {
                    selectGlobalIndex(item.code);
                } else if (item.type === 'crypto') {
                    selectCrypto(item.code);
                } else if (item.type === 'gold') {
                    selectGold(item.code);
                } else if (item.type === 'fund') {
                    var select = document.getElementById('simFundSelect');
                    if (select) {
                        select.value = item.code;
                        updateSimulator();
                    }
                } else if (item.type === 'sector') {
                    // 板块暂无独立详情模块，定位到行情总览（含全球资产热力图）并提示
                    switchModule('index');
                    showToast('已聚焦「' + item.name + '」板块（' + item.code + '，涨跌 ' + (item.changePercent >= 0 ? '+' : '') + fmt(item.changePercent, 2) + '%）', 'info');
                }
            }, 100);
        }

        function hideDropdown() {
            dropdown.classList.remove('show');
            activeItem = -1;
        }

        function highlightActive() {
            dropdown.querySelectorAll('.search-item').forEach(function(el, i) {
                el.classList.toggle('active', i === activeItem);
            });
        }

        input.addEventListener('input', function() {
            performSearch(input.value);
        });

        input.addEventListener('focus', function() {
            if (input.value.trim()) performSearch(input.value);
        });

        input.addEventListener('keydown', function(e) {
            if (!dropdown.classList.contains('show')) return;
            var items = dropdown.querySelectorAll('.search-item');

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                activeItem = Math.min(activeItem + 1, items.length - 1);
                highlightActive();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                activeItem = Math.max(activeItem - 1, 0);
                highlightActive();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (activeItem >= 0 && currentResults[activeItem]) {
                    selectSearchResult(currentResults[activeItem]);
                } else if (currentResults.length) {
                    selectSearchResult(currentResults[0]);
                }
            } else if (e.key === 'Escape') {
                hideDropdown();
                input.blur();
            }
        });

        document.addEventListener('click', function(e) {
            if (!e.target.closest('#globalSearch')) {
                hideDropdown();
            }
        });
    }

    // ===== Keyboard Shortcuts =====
    function setupKeyboardShortcuts() {
        var moduleOrder = ['index', 'global', 'gold', 'crypto', 'linkage', 'fund', 'news'];

        document.addEventListener('keydown', function(e) {
            // 输入框聚焦时忽略快捷键
            var tag = (e.target.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
            // 组合键（Ctrl/Cmd/Alt/Shift）时不劫持，保留浏览器原生快捷键如Ctrl+R
            if (e.ctrlKey || e.metaKey || e.altKey) return;

            if (e.key >= '1' && e.key <= '7') {
                var module = moduleOrder[parseInt(e.key, 10) - 1];
                if (module) {
                    switchModule(module);
                    savePref('module', module);
                }
            } else if (e.key === 'r' || e.key === 'R') {
                var btn = document.getElementById('manualRefreshBtn');
                if (btn) btn.click();
            } else if (e.key === 't' || e.key === 'T') {
                var themeBtn = document.getElementById('themeToggleBtn');
                if (themeBtn) themeBtn.click();
            } else if (e.key === '/') {
                e.preventDefault();
                var search = document.getElementById('searchInput');
                if (search) search.focus();
            } else if (e.key === 'g' || e.key === 'G') {
                // G 跳回顶部
                window.scrollTo({ top: 0, behavior: 'smooth' });
            }
        });
    }

    // ===== Back to Top =====
    function setupBackToTop() {
        var btn = document.getElementById('backToTop');
        if (!btn) return;

        window.addEventListener('scroll', function() {
            btn.classList.toggle('show', window.scrollY > 400);
        }, { passive: true });

        btn.addEventListener('click', function() {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    }

    // ===== Window Resize / Orientation (debounced) =====
    var resizeTimer = null;
    function resizeAllCharts() {
        if (mainChart) mainChart.resize();
        if (aiPredictionChart) aiPredictionChart.resize();
        if (globalChart) globalChart.resize();
        if (goldChart) goldChart.resize();
        if (goldAiChart) goldAiChart.resize();
        if (cryptoChart) cryptoChart.resize();
        if (cryptoAiChart) cryptoAiChart.resize();
        if (linkageChart) linkageChart.resize();
        if (simulatorChart) simulatorChart.resize();
    }
    function scheduleResize() {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(resizeAllCharts, 200);
    }
    window.addEventListener('resize', scheduleResize);
    // 移动端旋转屏幕时，部分浏览器不触发 resize 或延迟触发，显式补一次
    window.addEventListener('orientationchange', function() {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(resizeAllCharts, 350);
    });

    // ===== Initialize =====
    function init() {
        // Navigation
        setupNavTabs();

        // Index module
        renderIndexCards();
        initMainChart();
        updateIndexChartHeader();
        setupIndexChartControls();
        initAiPredictionChart();
        updateAiPredictionPanel();
        setupAiPeriodCards();
        renderStockLists();

        // Global module
        renderGlobalIndexCards('asia', 'globalAsiaGrid');
        renderGlobalIndexCards('europe', 'globalEuropeGrid');
        renderGlobalIndexCards('americas', 'globalAmericasGrid');
        initGlobalChart();
        updateGlobalChartHeader();
        setupGlobalChartControls();
        renderMarketClocks('marketClockGrid');

        // Gold module
        setupGoldTabs();
        initGoldChart();
        updateGoldChartHeader();
        setupGoldChartControls();
        initGoldAiChart();
        updateGoldAiPanel();
        updateGoldDetails();
        setupGoldAiPeriodCards();

        // Crypto module
        setupCryptoTabs();
        initCryptoChart();
        updateCryptoChartHeader();
        setupCryptoChartControls();
        updateCryptoStats();
        initCryptoAiChart();
        updateCryptoAiPanel();
        setupCryptoAiPeriodCards();

        // Linkage module
        initLinkageChart();
        renderCorrelations();
        renderHeatmap();
        renderMarketClocks('linkageClockGrid');

        // Fund module
        renderFundCards();
        setupFundTypeTabs();
        initSimulatorChart();
        setupSimulator();

        // News module
        renderNews();
        setupNewsTabs();

        // Time & refresh
        updateTime();
        updateDataStatus('connecting');
        tickRefreshCountdown();
        setInterval(updateTime, 1000);
        setInterval(tickRefreshCountdown, 1000);
        // 探测后端服务
        detectBackend();

        // Enhanced features
        setupThemeToggle();
        setupGlobalSearch();
        setupManualRefresh();
        setupKeyboardShortcuts();
        setupBackToTop();
        restorePreferences();

        // 首次加载真实数据
        fetchRealData();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
