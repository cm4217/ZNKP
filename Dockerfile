FROM node:22-alpine

WORKDIR /app

# 先装依赖（利用层缓存）
COPY server/package.json server/package-lock.json ./
RUN npm install --omit=dev

# 复制前端资源与后端代码（目录结构与 server.js 的 path.join(__dirname,'..') 匹配）
COPY market-dashboard.html ./
COPY assets ./assets
COPY _shared ./_shared
COPY server ./server

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server/server.js"]
