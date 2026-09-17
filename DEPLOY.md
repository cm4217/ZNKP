# 智投看盘 - 在线部署指南

本项目是一个 Node.js 应用（前端页面 + 数据代理/预测 API 同源部署），**不能**只做静态托管（GitHub Pages / 对象存储），因为行情数据必须由后端服务器转发（浏览器直连腾讯/新浪/东财/币安接口会被 CORS 拦截）。

改造已完成，直接按下面任一方案部署即可，无需改代码：
- `PORT` 从环境变量读取（平台自动注入）
- 前端自动探测同源后端（部署后打开域名即可用，地址栏无 localhost 依赖）
- 静态目录已收敛到 `assets/`、`_shared/`、页面本体（`server/` 目录不再对外暴露，含源码和预测数据存储）
- 已启用 `trust proxy`（反向代理后限流按真实客户端 IP 计数）
- 健康检查端点：`/api/health`

---

## 方案一：Zeabur（推荐 - 国内可直连，有免费额度）

适合：想免费快速上线，且在国内无梯子直接访问。

1. 把项目推到 GitHub 仓库（`market-dashboard/` 目录为仓库根，或整个目录入库后注意下面的 Root Directory）
2. 注册 [zeabur.com](https://zeabur.com)，控制台 → 新建项目 → Region 选 **香港**（国内直连延迟低）
3. 服务 → Git 部署，选择仓库：
   - **Root Directory**：`market-dashboard`（若仓库根就是 market-dashboard 则填 `.`）
   - **Build Command**：`cd server && npm install`
   - **Start Command**：`node server/server.js`
   - Node 版本选 18 或以上
4. 在 Networking 里绑定域名：用平台赠送的 `*.zeabur.app` 域名即可直接访问；也可绑自己的域名
5. 部署完成后打开域名，页面顶部数据状态显示绿色（腾讯财经+东方财富+...）即成功

## 方案二：Render（海外免费平台）

适合：海外访问或配合自定义域名。注意：`*.onrender.com` 默认域名在国内基本无法直连。

1. 推 GitHub 仓库
2. [render.com](https://render.com) → New → **Web Service**，选择仓库
3. 配置：
   - Root Directory：`market-dashboard`
   - Environment：Node
   - Build Command：`cd server && npm install`
   - Start Command：`node server/server.js`
   - Health Check Path：`/api/health`
4. 免费版注意：15 分钟无访问会休眠，再次访问冷启动约 30~50 秒；实例重启后 `accuracy-store.json`（预测准确度积累数据）会清空，自动重新积累，不影响功能

## 方案三：自有服务器 / 国内云（最稳定）

适合：腾讯云/阿里云轻量服务器（约 ¥50~100/月，新用户常有优惠），访问最快、数据可长期积累。

### Docker 方式（已提供 Dockerfile）

```bash
# 上传项目后在 market-dashboard/ 目录执行
docker build -t market-dashboard .
docker run -d --name market-dashboard \
  -p 80:3000 \
  -v /opt/market-data/accuracy-store.json:/app/server/accuracy-store.json \
  --restart unless-stopped \
  market-dashboard
```

### pm2 方式（无 Docker）

```bash
cd market-dashboard/server
npm install
npm i -g pm2
pm2 start server.js --name market-dashboard
pm2 save && pm2 startup
# 用 nginx 反代 3000 端口到 80/443，或直接放行 3000 端口访问
```

### 数据持久化（可选）

预测准确度数据默认写在 `server/accuracy-store.json`。要长期积累：
- Docker：把宿主机目录挂到 `/app/server`（注意同时覆盖代码，推荐挂载单独数据目录后软链）
- pm2：文件本来就在磁盘上，天然持久

---

## 数据源网络说明（部署在哪个区域都可用）

| 数据源 | 用途 | 海外服务器 | 国内服务器 |
|---|---|---|---|
| 腾讯财经 | 指数/个股行情 | 正常 | 正常 |
| 新浪财经 | 全球指数/VIX/新闻 | 正常 | 正常 |
| 东方财富 | 涨跌家数/两融/主力资金 | 偶发抖动（有熔断降级） | 正常 |
| data-api.binance.vision | 加密货币/黄金 PAXG | 正常（更稳） | 被墙，自动降级 Gate.io |
| Alternative.me | 加密恐慌贪婪指数 | 正常 | 基本正常 |
| 天天基金 | 基金净值/持仓/经理 | 正常 | 正常 |

所有不稳定源都已内置熔断器（3 次失败跳 60 秒）与多源降级，任何区域部署都能跑，只是各数据维度的"实源/估算"占比略有差异。

## 常见问题

- **页面打开是模拟数据（灰色状态）**：后端没起来，看平台日志；确认 Start Command 在 `market-dashboard` 根目录下执行的是 `node server/server.js`
- **限流 429**：单 IP 每分钟 300 次 API 请求上限（多标签页轮询可能触发），正常单页使用不会遇到
- **想改端口**：设环境变量 `PORT`（平台一般自动注入，无需手动设置）

---

## 准确度库 / MODEL_VERSION（运维注意）

- 当前 `MODEL_VERSION = 3`（`server/accuracy.js`）。因子权重、MACD、日线回填、raw/adj 分离等变更后旧样本不兼容。
- 启动时若 `accuracy-store.json` 的 `schema`/`version` 不匹配，会**自动清空**并由 `backfill.ensureBackfilled()` 用真日线重建。
- Docker/自建部署：若挂载了旧的 `accuracy-store.json`，升级后首次启动会重建（需可访问腾讯/币安等上游）；也可手动删除该文件后重启。
- 回填强制日线间距校验（拒绝周线），结算 OFFSETS 仍为 1D=1 / 1W=5 / 1M=22 个交易日。

