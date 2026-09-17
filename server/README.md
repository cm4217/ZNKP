# 智投看盘 - 后端数据代理服务

## 功能说明

后端代理服务用于聚合多个金融数据源，解决浏览器端 CORS 跨域限制，提供统一的 API 接口。

## 数据来源

| 数据源 | 覆盖品种 | 说明 |
|--------|---------|------|
| 东方财富 | A股/港股/全球指数 + K线 | 数据最全，无需API Key |
| Binance | 数字货币（BTC/ETH/BNB/SOL等） + PAXG黄金 | 支持 CORS，免费 |
| 新浪财经 | A股/港股指数（备用） | JSONP 格式 |
| 东方财富新闻 | 财经要闻/政策/市场/公司新闻 | 分类获取 |

## 快速启动

### 方式一：双击启动（推荐）

直接双击 `server/启动服务.bat` 文件即可。

### 方式二：命令行启动

```bash
cd server
npm install   # 首次运行需安装依赖
npm start     # 启动服务
```

## 访问地址

服务启动后：

- **后端服务**: http://localhost:3000
- **前端页面**: http://localhost:3000/market-dashboard.html

## API 接口

| 接口 | 说明 | 缓存时间 |
|------|------|---------|
| `GET /api/health` | 健康检查 | 无 |
| `GET /api/indices` | 全球指数行情（A股+港股+美股+欧股+亚太） | 15秒 |
| `GET /api/indices/:code/kline?period=1M` | 指数K线数据 | 5分钟 |
| `GET /api/crypto/ticker?symbols=BTC,ETH` | 数字货币24h行情 | 10秒 |
| `GET /api/crypto/:symbol/kline?period=1M` | 数字货币K线 | 5分钟 |
| `GET /api/gold/price` | 黄金价格（PAXG） | 60秒 |
| `GET /api/gold/kline?period=1M` | 黄金K线 | 5分钟 |
| `GET /api/news?category=all` | 财经新闻 | 5分钟 |
| `GET /api/briefing` | 综合数据简报 | 15秒 |

### K线周期参数

- `1D` - 1日
- `1W` - 1周
- `1M` - 1月（默认）
- `3M` - 3月
- `1Y` - 1年

### 新闻分类参数

- `all` - 全部
- `important` - 重大消息
- `policy` - 政策动态
- `market` - 市场要闻
- `company` - 公司新闻

## 前端自动适配

前端页面会自动探测后端服务是否可用：

- **后端可用**：状态栏显示「🛰️ 后端实时」，使用后端聚合数据（数据最全）
- **后端不可用**：状态栏显示「实时数据」，使用浏览器直连 API（新浪 + Binance + TerminalFeed）
- **全部失败**：状态栏显示「离线模式」，使用模拟数据兜底

## 项目结构

```
market-dashboard/
├── market-dashboard.html    # 前端页面
├── assets/
│   └── app.js               # 前端逻辑
└── server/
    ├── package.json         # 项目配置
    ├── server.js            # 主服务
    ├── data-source.js       # 数据源模块
    ├── cache.js             # 缓存模块
    └── 启动服务.bat          # Windows启动脚本
```

## 注意事项

1. 首次启动需要运行 `npm install` 安装依赖（启动脚本会自动处理）
2. 服务默认端口 3000，可通过环境变量 PORT 修改
3. 所有 API 响应均设置了内存缓存，避免频繁调用上游 API
4. 如东方财富接口不可用，会自动降级到其他数据源
