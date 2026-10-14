# syntax=docker/dockerfile:1
# NaviHive 自托管（方案 B）容器镜像。
#
# 多阶段构建：builder 装依赖、跑构建；runtime 只带两份构建产物 ——
#   dist/client/            Vite 产物（含 _headers，静态安全头的唯一事实来源）
#   dist-server/entry.mjs   esbuild 自包含单文件（worker/ 与 src/API/ 零 npm 依赖）
# 所以运行阶段既没有 node_modules 也没有源码，镜像里没有构建链路可蹭。
#
# 构建：  docker build -t navihive .
# 运行：  docker compose up -d（见 docker-compose.yml，密钥走 .env）
# 手册：  deploy/selfhost.md 第四节 B

# ---------- 构建阶段 ----------
FROM node:24-slim AS builder

WORKDIR /app

# 先只拷依赖清单再 npm ci：依赖没变时这一层命中缓存，不用每次重装
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# dist/client 给静态资源（entry.ts 的 _headers 解析读它），
# dist-server/entry.mjs 给服务本体。两条命令与 npm run start:selfhost 前面两步完全一致。
#
# ⚠️ NODE_OPTIONS 是小内存 VPS 的必需品：Node 会按物理内存自动收堆上限
# （464MB 的机器上只有 ~257MB），tsc -b 全量编译直接 OOM（exit 134）。
# 这只是「上限」不是预分配，大机器上毫无影响；构建期间内存实际占用由 swap 兜底。
ENV NODE_OPTIONS=--max-old-space-size=3072
RUN npm run build && npm run build:server

# ---------- 运行阶段 ----------
FROM node:24-slim AS runtime

ENV NODE_ENV=production \
    NAVIHIVE_HOST=0.0.0.0 \
    NAVIHIVE_PORT=8787

WORKDIR /app
COPY --from=builder /app/dist/client ./dist/client
COPY --from=builder /app/dist-server/entry.mjs ./dist-server/entry.mjs

# 数据目录（SQLite 库 + 附件）。先建好并归属 node 用户：新建的命名卷会继承这个属主，
# 用绑定挂载（./data:/app/data）时宿主机目录要自己 chown 1000:1000，否则以 node 身份写不进去。
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 8787
VOLUME /app/data

# 探活打 /api/init：公开路由、无需登录、回 {"ok":true,...}，且会真读一次库 ——
# 比「TCP 端口通」强，worker 或数据库挂了它会是 5xx。任何 2xx/3xx 算健康。
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.NAVIHIVE_PORT||8787)+'/api/init').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# node:sqlite 在 Node 22/24 都会打 ExperimentalWarning，与 npm run start:selfhost 一致地静音。
# SIGTERM 由 entry.ts 接住：清 timer → 关库 checkpoint WAL → 退出，容器停止不会丢 WAL 尾段。
CMD ["node", "--disable-warning=ExperimentalWarning", "dist-server/entry.mjs"]
