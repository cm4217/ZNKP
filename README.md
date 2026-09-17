# 智投看盘 · 市场仪表盘 + AI 多因子预测

> 一个面向 A股 / 港股 / 美股、数字货币、黄金的行情聚合看板，内置 AI 多因子预测（指数 / 黄金 / 加密 / 基金），支持手机 / 平板 / 桌面多端自适应。

## 功能特性

- **全球指数行情**：19 个全球指数（腾讯 / 新浪多源择优 + 东方财富备用 + 熔断降级）。
- **数字货币 & 黄金**：Binance / Gate.io 多源，PAXG 黄金代理报价。
- **财经新闻 / 市场情绪 / 综合简报**：聚合多家源，无实时源时走智能兜底。
- **AI 多因子预测**：双基模型（多因子主模型 + 统计模型）融合，输出带置信度与稳定性评级的预测。
- **K 线与热力图**：基于 ECharts 可视化，多周期切换（1日 / 1周 / 1月 / 3月 / 1年）。
- **响应式布局**：手机 / 平板 / 桌面全适配。


## 预测准确度（校准）

- 在线预测会把 **raw（校准前）** 与 **adj（展示校正后）** 一并落盘；命中率/偏差统计与集成权重学习只用 raw。
- `MODEL_VERSION` 升级后 `server/accuracy-store.json` 会自动重建（见 `DEPLOY.md`）；回填只用真日线。
- 低边际或双模型高分歧时 API 返回 `directionText: 观望` / `abstain: true`。

## 技术栈

- 后端：Node.js + Express（行情代理 + AI 预测 API）
- 前端：原生 HTML + CSS + ECharts（单页 `market-dashboard.html` + `assets/app.js`）
- AI：自研 ensemble 融合层（见下方架构）
- 部署：Docker / 单端口 Node 服务（适配 WorkBuddy / Render / Railway / Zeabur 等反向代理环境）

## 目录结构

```
market-dashboard-package/
├── market-dashboard.html        # 前端单页（入口）
├── assets/
│   └── app.js                   # 前端交互与图表逻辑
├── _shared/
│   ├── js/echarts.min.js        # 本地 ECharts（离线可用，无需 CDN）
│   └── fonts/                   # Instrument Sans / JetBrains Mono
├── server/
│   ├── server.js                # Express 入口（端口 PORT，默认 3000）
│   ├── data-source.js           # 多源行情抓取（熔断 / 重试 / 兜底）
│   ├── predict.js               # AI 预测主流程
│   ├── ensemble.js              # 融合层（权重 / 分歧对冲 / 波动率封顶）
│   ├── accuracy.js              # 在线回测与准确率结算（EMA 权重持久化）
│   ├── cache.js                 # 内存缓存（含 TTL）
│   ├── backfill.js              # 历史回填
│   └── README.md                # 后端说明
├── Dockerfile / .dockerignore   # 容器化
├── DEPLOY.md                    # 部署说明
└── package.json
```

## 快速开始

```bash
# 安装依赖（express + cors）
npm install

# 启动（默认端口 3000，可用环境变量 PORT 覆盖）
npm start

# 浏览器打开
# http://localhost:3000/market-dashboard.html
```

> 首次访问时后端按需抓取行情并写入缓存；若运行环境无外网，相关接口会走兜底逻辑。
> `server/accuracy-store.json` 为运行时状态文件（首次运行自动生成），无需手动创建，已被 `.gitignore` 忽略。

## 环境变量

| 变量 | 说明 | 默认 |
|------|------|------|
| `PORT` | 服务监听端口 | `3000` |
| `ALLOW_INSECURE_TLS` | 设为 `1` 关闭 TLS 证书校验（仅本地自签证书调试用） | 关闭 |

## API 一览

| 接口 | 说明 |
|------|------|
| `GET /api/health` | 健康检查 |
| `GET /api/indices` | 全球指数行情（19 个） |
| `GET /api/indices/:code/kline` | 指数 K 线（新浪源） |
| `GET /api/crypto/ticker` | 数字货币行情 |
| `GET /api/crypto/:symbol/kline` | 数字货币 K 线 |
| `GET /api/gold/price` | 黄金价格 |
| `GET /api/gold/kline` | 黄金 K 线 |
| `GET /api/news` | 财经新闻 |
| `GET /api/sources/status` | 数据源状态检测 |
| `GET /api/briefing` | 综合简报 |
| `GET /api/prediction/:code` | AI 多因子预测（指数 / 黄金 / 加密 / 基金） |
| `GET /api/market/sentiment` | 市场情绪总览 |

## AI 预测架构

预测引擎采用**双基模型 + 融合层（ensemble）**结构；融合层位于已验证的主模型之后，作为"安全增强层"，所有稳定性 / 准确性改进都加在这里，主模型零改动、零风险：

- **融合权重 EMA 平滑**：以 1日 / 1周 综合命中率为目标权重，叠加持久化指数移动平均（新 = 0.7×旧 + 0.3×目标），抑制逐日样本噪声带来的权重跳变。
- **方向分歧对冲**：当多因子主模型与统计模型在某周期方向相悖时，预测向中性收缩、整体置信度按分歧比例折扣，降低"乱出方向"的失误。
- **波动率封顶**：最终预测按单日波动率缩放封顶，抑制离群极端值。
- **稳定性评级**：每次预测返回 `stability`（高 / 中 / 低），前端展示分歧与收缩说明。

历史 K 线用于在线回测与准确率结算（`accuracy.js` / `backfill.js`），EMA 权重跨请求持久化于 `accuracy-store.json`。

## 部署

- **Docker**：`docker build -t market-dashboard . && docker run -p 3000:3000 market-dashboard`
- **平台 / 裸机**：单端口 Node 服务，直接 `npm start`；已设 `app.set('trust proxy', 1)` 适配反向代理取真实客户端 IP。详见 `DEPLOY.md`。

## 许可证

未指定。如需开源，请补充 `LICENSE` 文件。
