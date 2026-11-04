# syntax=docker/dockerfile:1
# NaviHive 自托管（方案 B）容器镜像。
#
# 多阶段构建：builder 装依赖、跑构建；runtime 只带两份构建产物 ——
#   dist/client/            Vite 产物（含 _headers，静态安全头的唯一事实来源）
#   dist-server/entry.mjs   esbuild 自包含单文件（worker/ 与 src/API/ 零 npm 依赖）
# 所以运行阶段既没有 node_modules 也没有源码，镜像里没有构建链路可蹭。
#
# ⚠️ 唯一的例外：`node_modules/undici`（下面 COPY --from=builder 那一行）。
#    它不是「顺手带的依赖」，而是出站 SSRF 防护的一部分：server/egressDispatch.ts
#    用 `new undici.Agent({ connect: { lookup } })` 把出站连接钉在校验过的那份 IP 上，
#    消灭「复核时公网、连接时内网」的 DNS rebinding 窗口。它不能被 esbuild 打进
#    单文件（会报 Dynamic require of "node:assert"），所以只能 external + 运行期提供。
#    缺了它服务照样能起（installEgressDispatcher 返回 installed:false），但会退化成
#    「仅出站前复核」的缓解模式并在启动日志告警 —— 这行 COPY 就是别让它退化的原因。
#    undici 8.x 自身零依赖，不需要连带 COPY 别的包。
#
# 构建：  docker build -t navihive .
# 运行：  docker compose up -d（见 docker-compose.yml，密钥走 .env）
# 手册：  deploy/selfhost.md 第四节 B

# ---------- 构建阶段 ----------
# ⚠️ node 版本与 .nvmrc / ci.yml 保持一致（均为 22），改一处需同步三处，
# 否则 node:sqlite 等行为差异会在 CI 验不到、本地与镜像跑出不同结果。
# ⚠️ 基础镜像固定到 **digest**（2026-11-04，审查项 R18「供应链固定」）。
#    tag 会被上游重新推送（同一个 `22-slim` 某天指向另一份内容），digest 是内容的哈希，
#    改不了内容就换不掉 digest。所以两处 FROM 都写成「tag@sha256:…」：tag 留着给人读，
#    digest 才是真正被拉取的东西。
#    digest = 多架构 manifest list 的 digest（amd64 / arm64 共用同一个 index），
#    2026-11-04 解析自 Docker Hub（`node:22-slim`），四个独立来源互相对上：
#      ① 本仓 ghcr 镜像里 buildx 的 provenance：docker.io/library/node:22-slim@sha256:4b150b48…
#      ② public.ecr.aws/docker/library/node:22-slim（AWS ECR Public 对 Docker 官方镜像的镜像）
#      ③ docker.m.daocloud.io / ④ docker.1ms.run（两个 Docker Hub 拉取代理）
#      ②③④ 都核对了 sha256(响应体) == 响应头 Docker-Content-Digest，内容自校验通过。
#    ⚠️ 换 digest 的姿势：先 `docker buildx imagetools inspect node:22-slim` 或
#      `docker pull node:22-slim` 从自己机器上解析（本机开发环境的出网策略会挡
#      registry API，别照抄注释里的旧值），改完必须同步 .nvmrc / ci.yml 的 22 这一档，
#      再跑一遍 `npm run ci`。tests/supplyChainPinning.test.ts 盯着「这里的 FROM 必须带
#      @sha256:」，漏了直接红。
FROM node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS builder

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
# 与 builder 阶段**同一个 digest**（理由与解析过程见上面那段）。分两处写而不是用
# `FROM builder` 派生：runtime 只需要 node 运行时而不要 builder 的 /app、环境变量与
# 那一堆构建期层，派生会把构建链路一起带进最终镜像（镜像里没有构建链路可蹭是硬约束）。
FROM node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS runtime

ENV NODE_ENV=production \
    NAVIHIVE_HOST=0.0.0.0 \
    NAVIHIVE_PORT=8787

WORKDIR /app
COPY --from=builder /app/dist/client ./dist/client
COPY --from=builder /app/dist-server/entry.mjs ./dist-server/entry.mjs
# 唯一的运行期依赖，理由见文件头那段「⚠️ 唯一的例外」。
# 路径写死到包目录（不是整份 node_modules）：镜像里不带构建期依赖，也不带 devDependency。
COPY --from=builder /app/node_modules/undici ./node_modules/undici

# 数据目录（SQLite 库 + 附件）。先建好并归属 node 用户：新建的命名卷会继承这个属主，
# 用绑定挂载（./data:/app/data）时宿主机目录要自己 chown 1000:1000，否则以 node 身份写不进去。
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 8787
VOLUME /app/data

# 探活打 /api/readyz：公开路由、无需登录、库通就 200 + {"ok":true}、库不通就 503。
#
# ⚠️ 刻意**不**打 /api/healthz（那是 liveness：零 DB，只要进程活着就 200）。
#    理由是 upgrader 的自动回滚判据就是这里的 `State.Health.Status`
#    （见 server/upgradeHealth.ts 与 docker-compose.yml 的 upgrader）：
#    如果健康检查打 healthz，那么「数据库打不开」的新镜像会被判 healthy，
#    自动回滚**永远不触发** —— 而那正是最需要回滚的情形（迁移失败 / 库文件损坏 /
#    磁盘满）。代价是每次探活的 DB 读取从 3 次（/api/init 要迁移检查 + 读配置）
#    降到 1 次（一条 SELECT 1），而不是 0 次。
#    任何 2xx/3xx 算健康。
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.NAVIHIVE_PORT||8787)+'/api/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# node:sqlite 在 Node 22/24 都会打 ExperimentalWarning，与 npm run start:selfhost 一致地静音。
# SIGTERM 由 entry.ts 接住：清 timer → 关库 checkpoint WAL → 退出，容器停止不会丢 WAL 尾段。
CMD ["node", "--disable-warning=ExperimentalWarning", "dist-server/entry.mjs"]
