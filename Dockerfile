# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# NaviHive 自托管镜像（Docker）
#
# 这个项目本体是 Cloudflare Workers + D1，所以容器里跑的是 Wrangler 的本地模式
# （Miniflare/workerd）：Workers 运行时是真的，D1 由本地 SQLite 模拟，
# 数据落在 --persist-to 指定的目录 —— 挂个卷就能持久化。
#
# 构建产物布局（由 @cloudflare/vite-plugin 产出）：
#   dist/client/               前端静态资源
#   dist/<worker-name>/index.js       已打包好的 Worker
#   dist/<worker-name>/wrangler.json  插件生成的 Wrangler 配置（assets 指向 ../client）
# 运行阶段直接用那份生成的 wrangler.json，不再从 worker/index.ts 现场打包。
# ---------------------------------------------------------------------------

# ============================== 1. 构建 ==============================
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# 关掉遥测/审计输出，构建日志干净些
ENV CI=1 \
    WRANGLER_SEND_METRICS=false \
    npm_config_audit=false \
    npm_config_fund=false

# 依赖清单单独先拷：只改源码时这一层能命中缓存，不用重装依赖
COPY package.json package-lock.json ./
# 仓库里 wrangler 与 @cloudflare/workers-types 的 peer 范围互相不认，
# 严格解析会 ERESOLVE 失败，这里按 lock 文件宽松安装。
RUN npm ci --legacy-peer-deps

COPY . .
RUN npm run build

# ============================== 2. 运行 ==============================
FROM node:22-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    CI=1 \
    WRANGLER_SEND_METRICS=false \
    APP_DIR=/app \
    DATA_DIR=/data \
    PERSIST_DIR=/data/wrangler-state \
    PORT=8787 \
    IP=0.0.0.0

# 复用构建阶段装好的 node_modules（里面就有 wrangler），省一次安装、版本也一致
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/dist ./dist

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# 兜底：万一构建上下文里的脚本被检出成了 CRLF（Windows 上 core.autocrlf=true 会这样），
# 这里先抹掉行尾的 CR，否则 bash 会报 "\r: command not found"。正常情况下这步是空操作。
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
    && chmod +x /usr/local/bin/docker-entrypoint.sh

# D1 / KV / Cache 的本地状态都写在这里，挂卷即可持久化
VOLUME ["/data"]
EXPOSE 8787

# 用 node 自带的 fetch 探活，镜像里不必为了 healthcheck 再装 curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
