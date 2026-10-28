# 方案 B 落地手册：整站自托管

把 NaviHive 从 Cloudflare Workers + D1 + KV 搬到一台 VPS 上用 Node 跑。
**业务代码一行没改** —— `worker/` 与 `src/API/` 原本就只依赖 Web 标准 API，
本方案只是把平台替我们做的四件事（D1、KV、静态资源、定时任务）在 `server/` 里重新长出来。

原理与取舍见 `docs/selfhost-plan-2026-10-14.md`；这份手册只讲**怎么落地**。

---

## 一、这次落地改了什么

| 文件 | 作用 |
|---|---|
| `server/sqlite-d1.ts` | `node:sqlite` → D1 形状适配器（真事务 batch、RETURNING 行、外键开启） |
| `server/file-kv.ts` | 本地目录 → `KVNamespaceLike`（笔记图片附件，带路径穿越防护） |
| `server/entry.ts` | Node 入口：HTTP 桥接 + 静态资源（含 `_headers` 规则与 SPA fallback）+ 定时任务 |
| `server/static.ts` | 静态资源与 `_headers` 解析（从 entry.ts 抽出，单测覆盖） |
| `script/build-server.mjs` | esbuild 把入口打成自包含单文件 `dist-server/entry.mjs` |
| `script/selfhost-smoke.mjs` | 26 项端到端冒烟（登录/改密/CRUD/静态头/SPA/附件/cron/404） |
| `tests/server*.test.ts` | 35 条单测：事务原子性、RETURNING 行、外键、文件 KV、`_headers` 解析 |
| `deploy/nginx/sites-available/navihive-selfhost.conf` | 自托管版 Nginx 配置 |
| `Dockerfile` / `.dockerignore` / `docker-compose.yml` / `.env.example` | 容器化部署件（第四节 B） |
| `tests/dockerDeploy.test.ts` | Docker 部署件漂移守卫（17 条） |
| `tsconfig.server.json` | 服务端目录的独立类型检查配置 |

新增脚本：`npm run build:server`、`npm run start:selfhost`、`npm run smoke:selfhost`。
Workers 部署路径（`npm run deploy`）完全不受影响，两条路可以并行跑一段时间。

---

## 二、快速开始（本机 5 分钟）

```bash
npm ci
npm run build          # 产出 dist/client（含 _headers）
npm run build:server   # 产出 dist-server/entry.mjs

# 起服务（密钥随便给一个，仅本地验证用）
AUTH_SECRET=$(openssl rand -hex 32) npm run start:selfhost
# → 监听 http://127.0.0.1:8787

# 另开一个终端跑冒烟（26 项）
npm run smoke:selfhost http://127.0.0.1:8787
```

首次启动会自动建库建表（`NavigationAPI.migrate()` 补到当前 `SCHEMA_VERSION`），
并用 `AUTH_USERNAME` / `AUTH_PASSWORD` 种下第一个账号（默认 `root` / 见下方环境变量表）。
冒烟会覆盖：登录 → 改密 → 重登 → 建分组/站点 → PUT 站点 → 静态响应头 → SPA fallback
→ 附件上传读回 → 结构化 404。

> 想用 Docker？直接跳到**第四节 B**（`docker compose up -d --build` 一把起）。

> ⚠️ `node:sqlite` 在 Node 22.5+ 就可用（`--experimental-sqlite` 只在 22.5–22.12 与
> 23.0–23.3 需要，v22.13.0 / v23.4.0 起不再需要）。状态按版本不同：Node 22 是
> Experimental 1.1，启动会打一条 ExperimentalWarning（`start:selfhost` 已带
> `--disable-warning` 静音）；**Node 24.15+ 起是 Release candidate 1.2，不再打那条警告**。
>
> **版本现状（2026-10-28，读这段时先确认它还没过期）**：生产镜像是 24（`Dockerfile`
> 两个 stage 都是 `node:24-slim`），而 **CI / `.nvmrc` / `engines` 仍是 22**。也就是说
> 「测试跑的运行时」和「生产跑的运行时」**还不是同一个** —— 这是已知缺口，不是笔误。
>
> 方向是 24（生产已经是）：只有两边一致，「本地绿、线上炸」这个口子才算关上。
> 2026-10-28 试过一次性把 CI / `.nvmrc` / `engines` / `@types/node` 全部翻到 24，
> **CI 红了**：`markdownRender.dom` 的「图片：结论进缓存后不再重复请求」在 Node 24 上
> 缓存不命中（期望 `blob:stub-1`，实际回到原始 URL），本机只有 Node 22 无法复现/调试。
> 于是把这一项从那批里剥离、回退到 22，留待拿到 Node 24 环境后单独处理。
> ⚠️ 动手前先查 `git log` 看是否已解决；解决时记得 `@types/node` 主版本必须与
> `ci.yml` 的 `node-version` 同改（`tests/toolchainPin.test.ts` 硬性要求，分批必红）。

---

## 三、环境变量全表

配置全部走环境变量（systemd `EnvironmentFile` 或 `.env`），没有配置文件、没有命令行参数。

### 服务本身

| 变量 | 默认 | 说明 |
|---|---|---|
| `NAVIHIVE_PORT` | `8787` | 监听端口 |
| `NAVIHIVE_HOST` | `127.0.0.1` | 监听地址。**前面挡 Nginx 就别改**；直接暴露公网才改 `0.0.0.0`（不建议） |
| `NAVIHIVE_DB` | `./data/navihive.db` | SQLite 库文件路径（目录会自动建） |
| `NAVIHIVE_FILES` | `./data/files` | 附件根目录 |
| `NAVIHIVE_STATIC_DIR` | `./dist/client` | 构建产物目录 |
| `NAVIHIVE_TRUST_XFF` | `1` | 是否信任 `X-Forwarded-For`（限速分桶用）。**挡 Nginx 时保持 1**；端口直接暴露公网必须设 `0`，否则改个请求头就能换限速桶、绕开爆破防护 |
| `NAVIHIVE_CRON` | `1` | 进程内每小时跑一次定时任务。多副本部署必须设 `0`（否则每个副本各跑一遍），改用 `POST /__cron` |
| `NAVIHIVE_CRON_TOKEN` | 空 | `POST /__cron` 的 bearer token。**不配 = 该端点 404** |

### 密钥与业务开关（按需）

| 变量 | 说明 |
|---|---|
| `AUTH_ENABLED` | `true`（默认）/ 其他值 = 关鉴权，仅内网调试用 |
| `AUTH_SECRET` | **`AUTH_ENABLED=true` 时必配**。令牌签名 + 数据加密。从 D1 迁数据时必须和线上完全一致，否则已加密的凭据解不开 |
| `AUTH_USERNAME` / `AUTH_PASSWORD` | 只在**首次建库**时当种子；库已存在则忽略（以 `configs` 表为准） |
| `DATA_ENCRYPTION_KEY` | 站点凭据加密密钥。迁库时必须与线上一致 |
| `JWT_SECRET` / `JWT_SECRET_OLD` | 令牌签名密钥（轮换时旧的放 `JWT_SECRET_OLD`） |
| `AUTH_RECOVERY_PUBLIC_KEY` | 恢复流程用 |
| `NAVIHIVE_COOKIE_SECURE` | 逃生舱：反代不传 `X-Forwarded-Proto` 又只能 http 访问时设 `0`，否则令牌 cookie 存不上、登录必掉线 |
| `NAVIHIVE_SESSION_FAIL_OPEN_ON_ERROR` | 会话校验出错时是否放行。默认 fail-closed，别随便开 |

启动时会打两条告警自查：`AUTH_ENABLED=true` 但没配 `AUTH_SECRET`（登录必然失败）、
`AUTH_ENABLED` 不是 `true`（站点无需登录即可读写）。

---

## 四、VPS 部署

两种接法二选一：**A. systemd**（Node 直接跑，最小依赖）或 **B. Docker**（容器，升级回滚更干净）。
数据都在 `data/`（库 + 附件）里，两种接法共用一套备份与迁移步骤。

### A. systemd

```bash
# 1) 代码落到 /srv/navihive，构建一次
sudo mkdir -p /srv/navihive && cd /srv/navihive
# （把仓库 clone / rsync 过来）
npm ci && npm run build && npm run build:server

# 2) 密钥文件：权限收紧，只有服务账号能读
sudo install -d -m 700 /etc/navihive
sudo tee /etc/navihive/env >/dev/null <<'EOF'
AUTH_ENABLED=true
AUTH_SECRET=换成 64 位十六进制
DATA_ENCRYPTION_KEY=与线上一致
JWT_SECRET=与线上一致
NAVIHIVE_TRUST_XFF=1
NAVIHIVE_CRON=1
EOF
sudo chmod 600 /etc/navihive/env
```

`/etc/systemd/system/navihive.service`：

```ini
[Unit]
Description=NaviHive self-hosted
After=network.target

[Service]
Type=simple
WorkingDirectory=/srv/navihive
EnvironmentFile=/etc/navihive/env
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning dist-server/entry.mjs
Restart=always
RestartSec=3
# 自托管最大的新增责任是备份，别让进程被 OOM 悄悄杀干净
MemoryMax=512M
# 最小权限：只读代码目录 + 读写数据目录
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/srv/navihive/data
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now navihive
sudo systemctl status navihive
```

探活用 `/api/init`（公开路由，无需登录，回 `{"ok":true,"initialized":true}`）：

```bash
curl -fsS http://127.0.0.1:8787/api/init
```

> 升级就是 `git pull && npm run build && npm run build:server && sudo systemctl restart navihive`。
> 库的迁移在启动时自动做，不用手工跑 SQL。

### B. Docker

仓库根四个文件：`Dockerfile`（多阶段，运行镜像只带 `dist/client` + `dist-server/entry.mjs`，
没有 node_modules 也没有源码）、`.dockerignore`、`docker-compose.yml`、`.env.example`。

```bash
# 1) 代码落到 /opt/navihive，按需改 .env
cd /opt/navihive
cp .env.example .env
$EDITOR .env            # AUTH_SECRET 必填；从 D1 迁了数据还要填 DATA_ENCRYPTION_KEY / JWT_SECRET

# 2) 构建并起服务（首次构建要编译整个前端，小机器上几分钟）
docker compose up -d --build
docker compose logs -f navihive        # 看到「NaviHive 自托管服务已启动」+ 两条自检告警（没有才算对）

# 3) 验证
curl -fsS http://127.0.0.1:8787/api/init     # → {"ok":true,"initialized":true,...}
docker inspect --format='{{.State.Health.Status}}' navihive   # → healthy（探活打的就是 /api/init）
```

几个和 systemd 接法不同、值得记住的点：

- **数据在命名卷 `navihive-data` 里**（容器内 `/app/data`），`docker compose down` 不丢，
  重建容器也不丢。换机器迁移 = 把这个卷拷走。想用绑定挂载（`./data:/app/data`）也行，
  但宿主机目录要先 `chown 1000:1000`——容器里是 `node` 用户，不是 root。
- **compose 强制要求 `AUTH_SECRET`**（`${AUTH_SECRET:?…}` 语法）：没设就直接启动失败，
  不会给你一个「起来了但登不进去」的服务。`.env` 已在 `.gitignore` 和 `.dockerignore` 里。
- **端口只绑宿主机回环**（`127.0.0.1:8787`），TLS 仍然交给前面的 Nginx/Caddy。

#### 网页一键升级：为什么应用容器**不**挂 `docker.sock`

> ⚠️ **本节 2026-10-28 重写过。** 旧版（2026-10-20 之前）教的是「把 `/var/run/docker.sock`
> 挂进应用容器、并以 `user: "0:0"` 跑」—— 那套方案已经**废弃**。照旧版做等于把宿主机
> 的 Docker 控制权交给一个会渲染用户内容的进程。下面讲现在的形状。

##### 现在的结构：两个容器，一个特权点

```
┌─────────────────────────┐        ┌──────────────────────────┐
│ navihive（业务容器）      │        │ navihive-upgrader        │
│ 端口 127.0.0.1:8787      │        │ 不开端口、不跑业务代码      │
│ 零 Docker daemon 权限     │        │ 持 /var/run/docker.sock  │
│ 只做一件事：写请求文件     │        │ 轮询请求 → pull → 重建     │
└──────────┬──────────────┘        └───────────┬──────────────┘
           │        共享命名卷 upgrade-spool    │
           └──── /spool/request（请求）─────────┘
                 /spool/state.json（进度）
```

流程：设置 →「版本与升级」→ 更新 → 应用容器写 `/spool/request`（先写 `request.tmp`
再 `rename`，避免升级器读到半截文件）→ `upgrader` 轮询到它 → `docker pull` 新镜像 →
`docker compose up -d --force-recreate --no-deps navihive` → 把 `pulling / recreating /
done / failed` 写进 `/spool/state.json`，前端轮询 `GET /api/system/upgrade` 拿进度。

开关是环境变量 `NAVIHIVE_UPGRADE_SPOOL`（compose 里已设成 `/spool`）。**没设它就没有
一键升级**：`dockerAvailable()` 里 spool 分支直接不成立，升级端点回 501，前端回落成
「复制 `docker pull` 命令到服务器执行」。这是刻意的降级，不是故障。

##### 这个隔离解决了什么

Docker socket 不是「一个 API」，是**宿主机 root 的等价物** —— 能 `POST /containers/create`
就能起一个 `--privileged -v /:/host` 的容器，然后把宿主文件系统读个遍。而业务容器同时
暴露着 HTTP、解析用户上传的附件、渲染 Markdown 和 Mermaid。把这两件事放在同一个进程里，
等于说「应用层任何一个 RCE 都直接升格成宿主机 root」。

拆成两个容器后：业务容器被攻破，攻击者能读到 `data/`（这本来就该被读到）、能写
`/spool/request`（最坏结果是触发一次镜像重建），**拿不到 daemon**。升级器持 sock，但它
不监听端口、不执行用户输入、不发任何网络响应 —— 攻击面只有一个轮询循环。

> ⚠️ **已知且未解决的残余风险**：`/spool/request` 一旦可写，就能让升级器把容器换掉。
> 所以「谁能写 spool 卷」≈「谁能改运行中的镜像」。目前的缓解是：卷只挂给这两个容器、
> 升级端点限 owner、镜像来自固定的 GHCR 仓库。别把 `/spool` 挂给第三个容器。

##### 四条不能改的细节（照 `docker-compose.yml` 的注释）

1. **只重建 `navihive` 自己**：`up -d --force-recreate --no-deps navihive`。不带服务名时
   compose 会把 `upgrader` 也纳入检查/重建 —— 那是让正在执行升级的进程自杀，升级会卡在
   一半（容器已换、`state.json` 永远停在 `recreating`）。
2. **挂载点必须是宿主原路径**（`/path/to/navihive` 挂到**同名**路径）。compose 会把运行时
   工作目录写进新容器的 `com.docker.compose.project.working_dir` 标签，那是下一轮升级读
   坐标的唯一来源；挂到 `/compose` 之类的别名路径会把这个标签写歪，**第二轮升级必失败**
   （第一轮看起来是好的，所以这个坑很难发现）。
   ⚠️ 仓库模板里写的是 `/home/docker/navihive`。**你的 compose 目录如果是别的路径**
   （比如第四节 B 用的 `/opt/navihive`），必须把 `upgrader` 的 `working_dir` 和那条绑定挂载
   两处一起改成你的真实路径，否则一键升级会在日志里报「找不到 compose 配置文件」。
3. **`pull` 用完整镜像名，再 `tag` 成 compose 里的 `image` 名**：先 `docker pull
   ghcr.io/<owner>/navihive:<tag>`，再 `docker tag` 成 `navihive:latest`。因为不同部署的
   compose 里 `image` 可能是 `navihive:latest` 也可能是 `ghcr.io/...:latest`；直接
   `pull navihive:latest` 会去 Docker Hub 找，必然 404。
4. **轮询而不是 inotify**：共享卷落在 overlayfs 上，inotify 事件不保证触发。所以升级器是
   `sleep 2` 轮询，最多等 2 秒才看到请求 —— 这是设计，不是迟钝。

配套的两个变量必须**两边一致**：`NAVIHIVE_IMAGE`（navihive 与 upgrader 服务都读它）。
只改一边 = 应用以为要升到 A，升级器实际拉 B。

##### 三种选法（按推荐度）

| 选法 | 做法 | 代价 / 适用 |
|---|---|---|
| ① **默认 upgrader**（推荐） | 保持仓库模板不动 | 应用容器零 daemon 权限，网页点一下就能升级。代价是多一个常驻容器（`docker:27-cli`，几十 MB）和一个共享卷 |
| ② **完全不碰 socket** | 删掉整个 `upgrader` 服务、删掉 `NAVIHIVE_UPGRADE_SPOOL` 与 `upgrade-spool` 卷 | 最保守。网页「更新」按钮退化成「复制命令」，升级改成手动 `docker compose pull && docker compose up -d --force-recreate navihive`。适合「几个月才升一次、不想多一个特权容器」 |
| ③ **改回应用容器直接挂 sock** | 给 `navihive` 加 `/var/run/docker.sock:/var/run/docker.sock`，并 `group_add` 加上宿主的 docker GID | **不推荐**。代价是宿主机 root：应用层被突破 = 整台机器被突破。只有在你明确接受这条、且这台机器上没有别的东西时才考虑。真要这么做，至少保留端口绑回环，并且明白「绑回环」并不能阻止已经拿到 sock 的攻击者 |

> ⚠️ 为什么不再推荐 `docker-socket-proxy`（`deploy/docker-socket-proxy.yml` 那份）：
> 实测跑不通。`docker compose up` 需要 `create` / `stop` / `networks` / `volumes` 一整套
> 权限，而一旦放开 `POST /containers/create`，就等于把 daemon 全权交出去 —— 加固当场归零，
> 只剩「多一层要维护的配置」。那份文件保留仅作历史参考。

##### 运行身份：默认 `node`(1000)，不再要求 `0:0`

compose 里是 `user: "${NAVIHIVE_RUN_AS:-node}"` —— **默认 node，不是 0:0**。镜像的
Dockerfile 已经 `USER node` 并把 `/app` chown 给 node；命名卷 `navihive-data` 里的库与附件
因此是 1000 属主，符合最小权限。

什么时候才需要覆盖 `NAVIHIVE_RUN_AS`：**只有**在改用绑定挂载（`./data:/app/data`）且宿主机
那个目录属主是 root、你又不想 chown 的时候。这时设 `NAVIHIVE_RUN_AS=0:0`，并清楚这是
把权限放大，不是修复。

> 升级器容器用 `docker:27-cli` 镜像、以 root 跑，这是**刻意**的：它必须能读
> `/var/run/docker.sock`（`root:docker`，非 root 直接 `connect EACCES`）。因为它不跑任何
> 业务代码，这条 root 的爆炸半径被限制在「能操作本机 Docker」——也就是它本来就要做的事。

> ⚠️ 2026-10-22 之前一直以 root 跑的老部署，卷里文件是 root 属主，直接切非 root 会写不进
> 库和附件。容器停掉时一次性改属主：
> ```bash
> docker run --rm -v navihive-data:/data alpine chown -R 1000:1000 /data
> ```
> 全新部署（卷还是空的）不用管。

##### 为什么升级不能「在容器里自己重启自己」

两件线上真发生过的事，解释了这个设计为什么绕这么远：

- ⚠️ **不能在容器里 `stop` 自己**：执行升级的进程就在这个容器里，`stop` 一发出去本进程
  就死了，后面的步骤一行都不会执行。2026-10-20 现场就是这样：点更新 → 502 →
  容器停在 `Exited(0)`，站点自己起不来了。
- ⚠️ **也不能用 `restart`**：`restart` 按**容器创建时记录的 ImageID** 启动，不会重新解析
  `:latest`。结果是镜像拉到了、容器也重启了、跑的还是旧代码 —— 表现为「点更新长时间
  无反应，刷新后版本号不变」（同一天踩的第二个坑）。
- ✅ 走 `compose up --force-recreate` 还有个附带好处：**改过 compose（新增环境变量 / 卷 /
  端口）也会跟着生效**，不用再手工 `down && up`。
- ⚠️ 升级会短暂中断约 10–30 秒：服务先把 200 回给前端再执行。前端轮询
  `GET /api/system/upgrade` 拿进度，版本真变了就清 Service Worker 缓存自动刷到新版。
- ⚠️ 出问题看哪里：**`docker logs navihive-upgrader`**。升级器容器不会被重建（它只重建
  `navihive`），所以它的日志一直在，`[upgrader] 拉取 / 重建 / 完成 / 失败` 四行都在里面。
  而 `navihive` 自己的日志会随容器重建而消失 —— 别去 `docker compose logs navihive` 找
  上一次升级的记录。
  （历史包袱：宿主上的 `<compose 目录>/.navihive-upgrade.log` 只有**旧路径**才会写 ——
  也就是「应用容器直连 docker.sock 起 helper 容器」那套。spool 模式下这个文件不存在。）

##### 另外三条要记住的

- **小内存机器构建要 swap**：`tsc -b` 全量编译在 512MB 内存的机器上会 OOM
  （Node 按物理内存把堆上限收到 ~257MB，exit 134）。Dockerfile 已设
  `NODE_OPTIONS=--max-old-space-size=3072` 兜住，但**至少再给 2G swap**：
  ```bash
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ```
  （这只是上限不是预分配，大内存机器上毫无影响。）
  注意：这条只影响**本机构建**（`docker compose up --build`）。走 GHCR 拉镜像不编译，
  1 核 512MB 的机器也够。
- **备份命令和 systemd 版不同** —— 容器里没有 `sqlite3` CLI，见第七节。
- 升级与回滚的完整步骤见**第八节**；迁移照旧在启动时自动做，不用手工跑 SQL。

> **已实测（2026-10-14）**：Debian 13 / 1 核 / 464MB 内存 / Docker 29.9.0 的 VPS 上
> 真构建真跑过——镜像构建 8 分 26 秒成功（356MB），端到端验证 29 项全过：
> 登录 → 首登强制改密 → 重新登录 → bootstrap → 建分组 → 读回 → CSP 三头
> （`trusted-types navihive-sw` / XFO / XCTO）→ SPA fallback → 未知路由 404 →
> `POST /__cron` 无 token 404 → healthcheck healthy → 容器以 node(1000) 运行 →
> 重启后数据还在 → **删掉容器重建后数据还在**（升级路径）→ 旧种子密码已失效。
> compose 也实测了：不配 `AUTH_SECRET` 直接拒绝启动、`.env` 正确贯通、端口只绑回环。

---

## 五、Nginx

用 `deploy/nginx/sites-available/navihive-selfhost.conf`（与方案 A 的反代配置同目录，
区别只是上游从 `*.workers.dev` 变成本机 Node）。要点：

- **静态资源也走 Node**，不配 `root`。这样 CSP 等安全头仍然只有 `dist/client/_headers`
  一个事实来源 —— Nginx 认不了 `_headers`，抄一份进 nginx 配置必然漂移，而 CSP 少一条
  （比如 `trusted-types navihive-sw`）表现为 Service Worker 注册静默失败，没有任何报错。
  单用户站点的静态吞吐 Node 绰绰有余。**压缩不用在这里补**：2026-10-22 起
  `server/static.ts` 自己给静态资源做 gzip（`Vary: Accept-Encoding`，已压缩格式跳过，
  见该文件「压缩与条件请求」一节）。Nginx 那层的 `gzip on` 现在还留着，主要收益在
  `/api/*` 的 JSON。
  ⚠️ **2026-10-28 复核：上面这句原先写的是「反代响应默认要 `gzip_proxied any` 才会压，
  这一项没配就等于没压」—— 那句是错的，已删。** `gzip_proxied` 只对**带 `Via` 请求头**的
  请求生效（nginx 文档原文：*"The fact that the request is proxied is determined by the
  presence of the 'Via' request header field"*），而浏览器 → 反代这条链上没有一跳会加 `Via`；
  真正让 JS/JSON 被压的是 `gzip_types` 里的 `application/json`
  （nginx 默认**只**压 `text/html`）。线上实测也印证：`nginx.conf` 里根本没有
  `gzip_proxied`，而 `curl -H 'Accept-Encoding: gzip' /assets/react-*.js` 回的是
  `content-encoding: gzip` —— 反代这层一直在压。详见 `deploy/nginx/README.md` 的
  「两份站点配置的 gzip 差异」一节。
- `proxy_set_header X-Forwarded-Proto $scheme` **必须有**：cookie 的 `Secure` 属性靠它判断。
- `client_max_body_size 30m`：附件单文件上限 25MB，小了会在 Nginx 这层先挂。
- `/api/webdav/` 超时放到 600s：备份上传封顶 10 分钟。
- **上游写 `127.0.0.1:8787`，不要写 VPS 公网 IP**。面板类工具默认爱填公网 IP
  （发卡路径），平时能通，但会把「端口绑回环」这个安全措施直接废掉——详见第十一节的陷阱说明。

首次上线证书还不存在时，`nginx -t` 会失败 —— 先只留 80 端口的 acme 块，
`certbot certonly --webroot` 签完证书再启用 443。

---

## 六、定时任务

`worker/cron.ts` 的 `runScheduledTasks` 每小时一轮：附件删除重试 → 导航页每周备份
→ 死链巡检 → 记事本备份调度。两种接法二选一：

**A. 进程内（默认，`NAVIHIVE_CRON=1`）** —— 零配置，对齐 UTC 整点。单实例部署用它。

**B. 外部触发（多副本 / 想把定时任务和 Web 进程解耦时）** —— 服务设 `NAVIHIVE_CRON=0`，
再配 token，然后用 systemd timer 或 crontab 打：

```bash
curl -fsS -X POST -H "Authorization: Bearer $NAVIHIVE_CRON_TOKEN" http://127.0.0.1:8787/__cron
```

没配 token 时该端点恒 404（冒烟里有这条断言），不会成为一个无鉴权的触发口。

---

## 七、备份与恢复（这次迁移最大的新增责任）

D1 托管版自带时间点恢复，搬到 VPS 后**全没了**，必须自己补。

这一节按「备 / 验 / 恢」三段写。**三段缺任何一段都等于没备份** —— 只有「备」的备份
是一份没人打开过的文件。

### 7.1 备：两个层次，都要有

#### 层次一：应用内自动备份（走 WebDAV，需先在设置里配）

设置 →「备份」里配好 WebDAV 之后，记事本备份由定时任务按设定频率自动跑，
产物是 `notes-*.zip`（含 `notes.json` + `attachments/`）传到你的网盘。
导航页备份同理（每周）。

⚠️ **这一层的前提是「你已经配了」**：没配 WebDAV 就完全没有这一层，而且界面不会报错 ——
它只是不出现。**别把「设置里有备份页」当成「备份在跑」。**

⚠️ **安全提示（重要）**：设备份密码时，备份包是**未加密的 zip 直接传网盘**
（`worker/notesBackup.ts`：`body = password ? await encryptBackup(zip, password) : zip`）。
而这个包里含**站点账号密码**（导航页备份）与全部笔记正文。所以：

- 要么在设置里设一个备份密码（AES 加密后才上传）；
- 要么确认你那个网盘本身可信、且开了二次验证；
- ⚠️ 备份密码丢了 = 那个包永久打不开，它不会存在任何地方可以找回。

#### 层次二：宿主 crontab 的本地兜底（不依赖任何配置）

即使 WebDAV 一个字都没配，这台机器上也必须有本地快照。**这是唯一一层「不需要应用配合」
的备份**，应用升级坏了、WebDAV 凭据过期了，它照样在跑。

systemd 接法（`/srv/navihive`）：

```bash
# ⚠️ 不能直接 cp：WAL 模式下会拿到不一致的快照。VACUUM INTO 目标文件必须不存在
mkdir -p /backup
sqlite3 /srv/navihive/data/navihive.db "VACUUM INTO '/backup/navihive-$(date +%F).db'"

# 附件单独备（KV 搬过来的二进制全在这儿）
rsync -a /srv/navihive/data/files/ /backup/files-$(date +%F)/

# 异地（示例用 rclone，换成任何你有的对象存储 / 另一台机器都行）
rclone copy /backup remote:navihive-backup/
```

Docker 接法容器里没有 `sqlite3` CLI，用 `node:sqlite` 跑同一条 SQL（效果一样，都是快照）：

```bash
# 库：在容器内 VACUUM INTO，再拷出来、删掉容器里的中间文件（目标必须不存在，下次还要用）
docker compose exec navihive node --input-type=module -e \
  "import { DatabaseSync } from 'node:sqlite'; new DatabaseSync('/app/data/navihive.db').exec(\"VACUUM INTO '/app/data/backup.db'\")"
docker compose cp navihive:/app/data/backup.db ./navihive-$(date +%F).db
docker compose exec navihive rm /app/data/backup.db

# 附件：tar 流式导出
docker compose exec navihive tar czf - -C /app/data files > files-$(date +%F).tgz
```

挂进 cron（每天 03:20，避开整点的定时任务；日志留着，出问题要知道它跑没跑）：

```bash
# crontab -e  （建议用部署账号自己的 crontab，别用 root）
20 3 * * * cd /path/to/navihive && /path/to/navihive/scripts/../backup.sh >> /var/log/navihive-backup.log 2>&1
```

> ⚠️ 上面那行里 `backup.sh` **仓库里没有**，要你自己写一个 5 行的脚本把前面那几条命令串起来。
> 故意不提供现成脚本：备份脚本必须知道你这台机器的路径、保留策略和异地目标，抄来的脚本
> 里只要有一个人没改的路径，就会「每天成功备份到不存在的地方」。

保留策略建议：每天一次、保留 30 天、每周留一份不动。数据库文件含密码哈希与加密凭据，
备份按敏感数据对待（加密存放、传输用 TLS）。

### 7.2 验：备份能不能用，要主动证明

**有 `sqlite3` CLI 的机器**（宿主上装过、或 systemd 接法）：

```bash
# 1) 库完整性（几分钟，会真读一遍全文）
sqlite3 /backup/navihive-2026-10-28.db "PRAGMA integrity_check;"     # → ok

# 2) 顺手确认表还在、行数不是 0（空库也会 integrity_check ok）
sqlite3 /backup/navihive-2026-10-28.db \
  "SELECT 'users', COUNT(*) FROM users UNION ALL SELECT 'sites', COUNT(*) FROM sites UNION ALL SELECT 'notes', COUNT(*) FROM notes;"

# 3) 附件包能不能解开（不用全解，列个头就够）
tar tzf files-2026-10-28.tgz | head -5
```

**Docker 接法（容器里没有 `sqlite3` CLI）** —— 和 7.1 同一个办法，用镜像自带的
`node:sqlite`。注意验的是**宿主上的备份文件**，所以要把目录只读挂进去：

```bash
docker compose run --rm --entrypoint node \
  -v /backup:/backup:ro \
  navihive --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
// ⚠️ readOnly 别省：校验不该有写权限，开成可写时一次手误就能改掉备份
const db = new DatabaseSync(process.argv[1], { readOnly: true });
console.log("integrity:", db.prepare("PRAGMA integrity_check").get().integrity_check);
for (const t of ["users", "sites", "notes"]) console.log(t, db.prepare("SELECT COUNT(*) AS c FROM " + t).get().c);
db.close();
' /backup/navihive-2026-10-28.db

# 附件包同一条 tail 就行（宿主命令，不用进容器）
tar tzf files-2026-10-28.tgz | head -5
```

> 想顺便验**现役库**（不是备份）：路径换成 `/app/data/navihive.db`，并去掉 `-v` 那行 ——
> 数据卷本来就挂着。⚠️ 只读连接在有服务跑着时可能因 `-shm` 被占用而打不开；打不开就
> **停服再验**，别为了这一条去改服务配置。对比两次输出的行数，差值就是「上次备份之后新写的
> 数据」。

⚠️ `integrity_check` 回 `ok` **只说明文件结构没问题**，不说明内容对：一个 0 行的库也是
`ok`。所以第 2 条必须一起做 —— 行数断崖式下跌（比如 sites 从 200 变成 3）说明备份
取的是某个空档期，或者备错了文件。

### 7.3 恢：真出事时按这个顺序

```bash
# 1) 停服 —— 这不是礼貌建议，是硬前提
#    systemd: sudo systemctl stop navihive
#    Docker:  docker compose stop navihive
#
#    为什么必须先停（2026-10-28 演练实测）：只要还有一个连接没关，
#    · Windows / 某些文件系统上：rename 直接 EBUSY，你会立刻发现；
#    · Linux 上：不报错，但你会「换掉一个还在被写的库」—— 更隐蔽。
#    后者才是最坏的情况：操作看起来成功了，下一个 checkpoint 把旧 WAL 刷到新文件上，
#    库就变成两份数据的混合体。所以别用「我直接 mv 了，好像也没事」说服自己。

# 2) 把现役库改名留档，别直接覆盖 —— 万一是「备错了、现役才是对的」
#    mv data/navihive.db data/navihive.db.broken-$(date +%F-%H%M)
#    同时删掉 navihive.db-wal / navihive.db-shm（它们属于旧库，留着会污染新库）

# 3) 放回备份文件
#    cp /backup/navihive-2026-10-28.db data/navihive.db
#    chown 1000:1000 data/navihive.db        # Docker 接法必须做，否则 node 用户写不进
#    附件：tar xzf files-2026-10-28.tgz -C data/    （先确认 data/files 已改名留档）

# 4) 启服
#    systemd: sudo systemctl start navihive
#    Docker:  docker compose up -d navihive
```

**恢复后必须抽查四件事**，不抽查等于没恢复：

1. 能登录（账号密码在 `configs` 表里，登不进说明库是错的或者是别人的）；
2. 随机点开 **3 条笔记**，正文完整、不是空白；
3. 打开 **1 个附件**（图片能显示 / 文本能读），确认附件包和库里的 id 对得上；
4. 站点列表能出来，且**站点密码能复制**（这一项验的是 `AUTH_SECRET` /
   `DATA_ENCRYPTION_KEY` 有没有跟着一起换 —— 换错了这里会出乱码，见第九节）。

> ⚠️ **演练状态：命令级做过了，真实数据级还没做。** 这两件事的差别，决定你现在该不该相信
> 这份备份：
>
> **已做（2026-10-28）**：命令级演练，**合成库、没碰任何真实数据**。做法是造一个 WAL 模式
> 的库（`users` / `sites` / `notes` 三张表，252 行），**故意不 checkpoint**，让 `-wal` 里
> 真堆着 1 MB 未落盘的数据模拟「服务正在跑」，然后照 7.1 → 7.2 → 7.3 逐条跑。11 项断言全过：
> `VACUUM INTO` 在 WAL 运行中能产出文件、快照自身不带 `-wal`（是完整单文件）、
> `integrity_check` 回 `ok`、行数与现役一致、**WAL 里未 checkpoint 的数据也在快照里**、
> 目标已存在时 `VACUUM INTO` 会报错（不会静默覆盖）、连接全关掉之后 rename 成功、
> 恢复后能打开且 `integrity_check` 仍 `ok`、旧库留档还在、恢复后可写。
> 顺带实证了 7.1 那句「不能直接 `cp`」：快照只有 16 KB，而现役 `-wal` 有 1 MB，
> 快照却拿到了全部 252 行 —— 直接 `cp` 主文件会丢掉那 1 MB。
>
> **未做：真实库演练。** 合成库证明的是**步骤和命令对**，证明不了「你这份备份里的数据本身
> 是好的」——`integrity_check` 只验文件结构，行数只验量不验质（252 行全是垃圾也是 252 行）。
> 第一次真实演练请留出完整的一小时、在**另一台机器**上做（把备份拷过去恢复，别拿生产库试），
> 做完把「哪一步卡住了」写回本节。

---

## 八、升级与回滚

### 8.1 升级：两条路

**路一：网页一键**（前提是 `upgrader` 容器在跑，见第四节 B）

设置 →「版本与升级」→ 检查更新 → 更新。中断约 10–30 秒。进度看界面，事后看
`docker logs --tail=50 navihive-upgrader`（四行：拉取 → 重建 → 完成/失败）。

**路二：命令行**（不依赖 upgrader，最可控）

```bash
cd /path/to/navihive
docker compose pull navihive
docker compose up -d --force-recreate navihive
docker inspect --format='{{.State.Health.Status}}' navihive    # → healthy
```

> ⚠️ 为什么是 `--force-recreate` 而不是 `restart`：`restart` 按容器创建时记录的 ImageID
> 启动，`pull` 下来的新镜像它根本不会用 —— 表现为「明明拉了新版，跑的还是旧代码」。

### 8.2 回滚：三步，别只做第一步

镜像每次构建都会打两个 tag：`:latest` 和 `:<commit sha>`
（`.github/workflows/docker-publish.yml` 里 `--tag ...:latest --tag ...:${{ github.sha }}`）。
**回滚靠的就是 sha tag** —— `:latest` 是唯一会被覆盖的那个，拿它回滚等于没回滚。

**第 1 步：在 GHCR 上找到要回退到的 sha**

GitHub → 仓库 → Packages → `navihive` → 版本列表。或者直接问镜像：

```bash
docker buildx imagetools inspect ghcr.io/<owner>/navihive:<旧sha>
# → 能看到 digest 与平台清单，说明这个 tag 存在且可拉
```

> 手头没有旧 sha 时：`git log --oneline -20` 找那个「上一个好版本」的提交号。
> 从没记过版本号的话，去 GitHub Actions 的 `docker-publish` 历史里翻那一次绿色的运行。

**第 2 步：用旧镜像重建**

```bash
cd /path/to/navihive
NAVIHIVE_IMAGE=ghcr.io/<owner>/navihive:<旧sha> docker compose up -d --force-recreate navihive
```

> ⚠️ 必须用 `NAVIHIVE_IMAGE=... docker compose ...` 这种**同一条命令里**赋值的写法。
> 写成 `export NAVIHIVE_IMAGE=...` 然后忘了它，下次网页一键升级会把 `NAVIHIVE_IMAGE`
> 又读成新版本 —— 回滚就白做了。想固定下来就写进 `.env`，并记住它在哪。

**第 3 步：验证真的回退了（三项都要做）**

```bash
# 1) 进程活着
docker inspect --format='{{.State.Health.Status}}' navihive      # → healthy
# 2) 接口通
curl -fsS http://127.0.0.1:8787/api/init                          # → {"ok":true,...}
# 3) 跑的确实是那个旧镜像（两个 Id 必须相同）
docker inspect --format='{{.Image}}' navihive
docker image inspect ghcr.io/<owner>/navihive:<旧sha> --format='{{.Id}}'
# 4) 如果刚才是用网页点的升级 / 用的 upgrader，再看它的日志
docker logs --tail=20 navihive-upgrader
```

再打开页面看一眼**版本号确实变小了**。`healthy` 只说明进程活着，不说明跑的是旧代码 ——
上一版的 bug 也可能让健康检查通过；只有第 3 条的两个 Id 相同，才能证明镜像真的换了。

### 8.3 「只回退代码、不回退库」为什么现在是安全的，以及它的有效期

回滚时**不需要**把数据库恢复到升级前 —— 旧代码读新库不会崩。依据是
`src/API/methods/migration.ts` 里的迁移步骤（当前 `SCHEMA_VERSION = "27"`）：

- **全文零 `DROP`**（`grep -n "DROP" src/API/methods/migration.ts` 零命中，
  2026-10-28 核过）；
- 全部是 `ALTER TABLE ... ADD COLUMN`（带 `DEFAULT`）与 `CREATE TABLE IF NOT EXISTS`；
- 加列对旧代码是**透明**的：`SELECT *` 拿到不认识的列会忽略，`INSERT` 不写它就取默认值。

> ⚠️ **这条结论有有效期。** 它只对「2026-10-28 的 `migration.ts`」成立。一旦有人在迁移里
> 加了 `DROP COLUMN`、改了列名、或者把某列的语义换了（比如 `views` 从「次数」改成
> 「毫秒」），这条立刻不成立 —— 旧代码会读到不存在的列直接报错，或者算出荒谬的值。
> **加这类迁移时必须同步更新本节**，并在 CHANGELOG 里标 `安全`。反过来，如果你在回滚前
> 发现最近的迁移动了删除/改名，那就必须**连库一起回**（用 7.3 的步骤恢复到升级前的备份）。

⚠️ **回滚后一个反直觉的现象，先知道就少慌一次**：新版本写入的数据如果落在**新列**上，
旧代码看不见那些列，但也不会报错。用户看到的是「这条笔记我明明改过」——
内容还是老的。这不是数据丢了，是旧代码不认新列。

遇到这种情况**以备份为准，别在现场反复改**：反复编辑只会让新旧两份数据更难对齐，
最终还是要回到 7.3 用升级前的备份恢复。判断方法：

```bash
# 新列有没有被写过（把 <新列名> 换成最近一次迁移加的那个）
sqlite3 data/navihive.db "SELECT COUNT(*) FROM notes WHERE <新列名> IS NOT NULL;"
```

计数大于 0 = 升级之后确实写过新列 = 回滚会「看不见改过的东西」。

---

## 九、账号与密钥

三个脚本在 `scripts/` 下。**它们都针对 Cloudflare 部署形态写**（`reset-admin-password`
与 `rotate-secrets` 直接调 `wrangler`），自托管形态要按表里的「自托管对应做法」走。

### 9.1 三个脚本

| 脚本 | 用途 | 前置条件 | 做完的后果 |
|---|---|---|---|
| `reset-admin-password.mjs` | 忘记管理员密码时直接改库里的密码哈希 | 本机有 wrangler 登录态；知道 D1 库名（默认 `navigation-db`，`--db` 可改）；新密码 ≥12 位且不能是同一字符重复 | 立刻生效。⚠️ **只改 `configs` 表**（所有者那份凭据），`users` 表里的普通账号一行都不碰；且它 bump 的是**全站** `auth.tokenVersion`，在多账号库里只对「没有账号上下文的旧令牌」有效 —— 别人的会话不会因此掉线。旧密码立即不可用 |
| `recovery-token.mjs` | 无需 wrangler：离线签一个一次性重置令牌，粘到登录页就能重置 | ① 先 `generate` 出密钥对（私钥落 `scripts/recovery-private.key`），公钥配到服务端；或用户在「设置 → 账户安全」点「生成并下载私钥」（公钥自动入库）；② 手上有私钥文件 | 只影响令牌里的那个账号。令牌默认 24 小时过期（`--exp-hours` 可改）、一次性。**私钥丢了 = 以后忘记密码再也进不来**（除非还能改库）。`generate` 时若私钥文件已存在会直接退出，防止误覆盖 |
| `rotate-secrets.mjs` | 生成一套新密钥并**打印**要执行的命令，不替你执行 | 无（纯本地生成，不碰网络、不碰 dist） | **会打断已加密的数据**，见下 |

三个脚本的实际参数（照代码抄，别猜）：

```bash
node scripts/reset-admin-password.mjs --password '<新密码>' [--username <账号>] [--db <库名>] [--local]
node scripts/recovery-token.mjs generate
node scripts/recovery-token.mjs sign --password '<新密码>' [--username <账号>] [--key <私钥文件>] [--exp-hours 24] [--jti <串>] [--out <文件>]
node scripts/rotate-secrets.mjs [--json]
```

`reset-admin-password` 的密码也可以走环境变量 `NEW_ADMIN_PASSWORD`（避免进 shell 历史）；
不给 `--password` 就交互式输入两遍确认。

### 9.2 ⚠️ 轮换 `AUTH_SECRET` 会让已有密文解不开

`rotate-secrets.mjs` 的注释和输出里都写了，但值得再强调一次，因为它的后果是**静默的**：

- `AUTH_SECRET` / `DATA_ENCRYPTION_KEY` 同时是**库里已加密字段的解密钥匙**
  （站点密码、WebDAV 口令、AI 密钥）。
- 换掉之后，旧密文**不是「数据没了」，是「那些字段变成读不出的乱码」** —— 库还在、
  行还在、界面不报错，点「复制密码」出来一串乱码。这比报错更难排查。
- 会话签名也一并换钥：所有设备立即掉线。

所以正确的顺序**只有一种**：

```
1. 先导出备份（此时旧钥匙还在，能正常解密）   设置 → 备份 → 立即备份 一份
2. 记下要重填的清单：WebDAV 口令 / 各站点密码 / AI 密钥（能记多少记多少）
3. 再轮换密钥（换完旧密文就废了）
4. 逐项重新填写 → 新写入的用新钥匙加密，从此正常
```

⚠️ **反过来做就救不回来了**：先换钥匙、再想备份 —— 那时导出的备份里已经是乱码，
备份救不了你。

### 9.3 自托管形态改密码（实测过的命令）

`wrangler` 那一套在这里用不上（没有 D1）。按优先级，三条路：

1. 还登得进去 → 设置里改密码（走正常流程，重算哈希、吊销会话）；
2. 登不进去、有恢复私钥 → `recovery-token.mjs sign` 出一张令牌，粘到登录页；
3. 两条都不成立 → 手工改库，**用下面这条命令，别自己拼哈希串**。

#### ⚠️ 先搞清楚改的是哪张表（这是最容易白干的一步）

凭据在**两个地方**，含义不同：

| 位置 | 谁在用 |
|---|---|
| `users` 表（`password_hash` / `token_version`） | **多账号上线后的实际登录凭据**。`accounts.login` 先查 `users`，命中就只用它验密码 |
| `configs` 表（`auth.username` / `auth.password` / `auth.tokenVersion`） | 首次部署的种子凭据 + **`users` 里查不到该用户名时的兜底**。另外「修改密码时校验当前密码」读的是这里（`auth.ts` 的 `verifyCurrentPassword`） |

所以：**只改 `configs` 那一份，在现代库上等于没改** —— 迁移会把种子凭据复制成 `users` 里
`role='owner'` 的一行（`migration.ts` 的 `migrateFirstAccount`），之后登录就走 `users` 了。
你改完 `configs` 去登录，密码还是旧的，然后会以为整条命令失效。

下面这条命令**两处一起写**，并顺手递增两处的令牌版本。同一份哈希写两处，不会不一致。

先探一下这台库是哪种形态（不打印哈希，只打印长度）：

```bash
docker compose stop navihive        # 先停服。SQLite 单写者，热改会被 WAL 覆盖

docker compose run --rm --entrypoint node navihive -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
console.log("users:", JSON.stringify(db.prepare("SELECT id, username, role FROM users").all()));
console.log("configs:", JSON.stringify(db.prepare("SELECT key, length(value) AS len FROM configs WHERE key LIKE ?").all("auth.%")));
' /app/data/navihive.db
```

- `users` 里有一行 `role: "owner"` → 主凭据在 `users`（只要这个库跑过一次带多账号的迁移，
  就会是这个形态）；
- `users` 是空的、`configs` 有两个 `auth.*` → 还是老的单管理员形态。

#### 改密命令（两处一起写）

```bash
docker compose run --rm --entrypoint node navihive -e '
const { DatabaseSync } = require("node:sqlite");
const { pbkdf2Sync, randomBytes } = require("node:crypto");
const [dbPath, pwd] = process.argv.slice(1);
if (!dbPath || !pwd) { console.error("缺参数：<db 路径> <新密码>"); process.exit(2); }
// 60 万 = crypto.ts 的 DEFAULT_PBKDF2_ITERS（Node 端）；不要自己调小，
// 这个数写在哈希串里，校验时按串里记的值算，所以改动只影响这一次写入。
const ITERS = 600000;
const b64u = b => Buffer.from(b).toString("base64url");
const salt = randomBytes(16);
const hash = "pbkdf2$" + ITERS + "$" + b64u(salt) + "$" + b64u(pbkdf2Sync(pwd, salt, ITERS, 32, "sha256"));

const db = new DatabaseSync(dbPath);
const owner = db.prepare("UPDATE users SET password_hash = ?1, token_version = token_version + 1 WHERE role = ?2")
                .run(hash, "owner");
db.prepare("UPDATE configs SET value = ?1, updated_at = CURRENT_TIMESTAMP WHERE key = ?2")
  .run(hash, "auth.password");
db.prepare("INSERT INTO configs (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)")
  .run("auth.tokenVersion", "1");

console.log("users 更新行数:", owner.changes, "（0 = 这台库没有 owner 行，只写了 configs）");
console.log("configs: auth.password 已同步，auth.tokenVersion 已 +1");
' /app/data/navihive.db '<你的新密码>'

docker compose start navihive
```

四条实测过的前提（不用再猜）：

1. **`/app/data/navihive.db` 是对的**：`Dockerfile` 里 `WORKDIR /app`、`mkdir -p /app/data`，
   compose 把命名卷挂在 `/app/data`。用绑定挂载的部署要换成你自己的宿主路径。
2. **`node -e` 里可以用 `require`**，即使仓库根 `package.json` 是 `"type": "module"` ——
   `-e` 的输入类型默认是 CommonJS，不受 package.json 影响（本机 Node 22.22.2 实测
   `typeof require === "function"`）。
3. **不要加 `--experimental-sqlite`**：它在 22.5–23.3 那一段才是必需的，现在的版本直接
   `require("node:sqlite")` 就行（22.22.2 实测不加也能用，只打一条 ExperimentalWarning）。
   万一你的 Node 报 `bad option`，说明是相反的问题 —— 把 flag 去掉。
4. **`process.argv.slice(1)` 取两个参数是对的**：`node -e '<code>' a b` 的 argv 是
   `[node, "a", "b"]`（实测），`slice(1)` 正好跳过可执行文件路径。

⚠️ 密码里**不要带单引号**（整段脚本是 shell 单引号包起来的，会截断）。带特殊字符就先
改成临时密码，登录后立刻在设置里换掉。

#### 改完验证

```bash
docker compose start navihive
curl -fsS http://127.0.0.1:8787/api/init          # → {"ok":true,...}
docker compose exec navihive node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/app/data/navihive.db");
console.log("owner 迭代数:", (db.prepare("SELECT password_hash AS h FROM users WHERE role = ?").get("owner") || {}).h?.split("$")[1]);
'
```

然后用新密码登录一次。**如果登不进**，按顺序查三件事：`users` 里那个用户名拼写对不对
（登录是按用户名查的，改了密码没改用户名）；哈希串前缀是不是 `pbkdf2$600000$`（不是的话
说明写进去的是明文）；旧密码是不是还能登（能登 = 你改的那行没命中，看 `users` 更新行数）。

> ⚠️ 登录成功却被要求「首次登录必须改密」：那是 `configs` 里的 `auth.mustChangePassword`
> 还是 `1`（种子账号留下的标志，和密码对不对无关）。想跳过就在同一条命令里再补一句
> `UPDATE configs SET value='0' WHERE key='auth.mustChangePassword'`；不想跳就当它是
> 一次正常的改密，改完标志自己会清。

#### ⚠️ 60 万迭代数的一个副作用：搬回 Cloudflare 之前先改一次密码

`crypto.ts` 里的迭代数按运行时取值：Node（自托管）写 **60 万**，Workers 写 **10 万**
（`WORKERS_PBKDF2_MAX_ITERS`，硬上限）。

校验时迭代数取自**哈希串自己记的那个数**（`pbkdf2$<iters>$…`，读它的是 `crypto.ts:242`），
而不是当前的运行时配置 —— 这是刻意的设计，为了让改过迭代数的老哈希照样能登。

但取出来的这个数**没有在 `verifyPassword` 里就地消化**，它被原样往下传：`:245` 是
`const derived = await pbkdf2(password, salt, iters, 32)`，`pbkdf2`（`:249` 起）再把它塞进
`crypto.subtle.deriveBits({ name: "PBKDF2", iterations, … })`（`:262`）—— 而 **Workers 的
WebCrypto 就是在这一层拒绝 > 100000 的**。所以「从串里读」不构成安全网：它忠实复现出来的，
正好是那台机器吃不下的大数。

后果：把自托管库搬到 Workers 之后，这条 60 万的哈希在那边**登录会直接失败**（不是变慢，
是抛错）。不是推测，同一个文件里已经有现成的同类事故：

- `crypto.ts:584-595`：备份文件加密格式从 15 万次降到 10 万次，原因就是「Worker 侧一解密
  就抛 `Pbkdf2 failed: iteration counts above 100000`，**线上真踩过**」；
- `crypto.ts:646-655`：还专门写了一段 catch，遇到「迭代数 > 10 万且在报 PBKDF2 相关错误」
  时给一句人话提示，而不是把原文糊到用户脸上。

也就是说 **15 万就已经过不去**，60 万是它的 4 倍。而且密码校验这条路**没有**上面那段
兜底 catch，表现是登录接口报错（500），不是「用户名或密码错误」—— 这两种现象要分清楚：
看到的是 500 就别去反复试密码了。

> ⚠️ `crypto.ts:161-162` 那句注释「只有在 Workers 上才会被夹到 10 万，所以不存在『自托管
> 写了 60 万、搬到 Workers 登不进去』这种隐式陷阱」——**它的错不在漏了场景，而在把失败形态
> 说错了**：它把「夹到 10 万」和「验不过」当成同一件事。实际上根本到不了「夹」这一步，
> `deriveBits` 先抛异常。这两种说法对排障的指向完全不同：
> **看到 500 = 这条（抛异常）；看到「用户名或密码错误」= 另一种（真的比对不上）**。
> 后半句「搬库前要先把密码改一遍」是对的 —— 写注释的人知道有坑，只是把坑的形状写歪了。

处理办法：**迁移前**先在自托管上把密码改一遍，让哈希降到 10 万档 ——
`NAVIHIVE_PBKDF2_ITERS=100000` 起服务后在设置里改密（新哈希按 10 万写），或直接按上面的
命令把 `ITERS` 改成 `100000`。**别等搬完才发现登不进去**，那时你连界面都进不去，只能再
回来改库。

> ⚠️ 自托管下 `reset-admin-password.mjs` **不能直接用** —— 它执行的是
> `wrangler d1 execute <库名>`，指的是 Cloudflare 上的 D1，不是你机器上的这个 `.db` 文件。
> 硬跑会去改云端那个库（如果还在），本地一点变化都没有，而你会以为改成功了。
> **它也只改 `configs`**（`scripts/reset-admin-password.mjs` 的三条 UPDATE 全打在 `configs` 上），
> 所以就算在 Cloudflare 上跑，它也只对**单管理员形态**有效；多账号库里要改普通用户的密码，
> 得走界面或改 `users.password_hash`。

`AUTH_RECOVERY_PUBLIC_KEY` 在自托管下同样走环境变量（`.env` 里加一行），生成方式与
Cloudflare 一致：`recovery-token.mjs generate` 打印的那串公钥。

---

## 十、从 D1 迁数据

```bash
# 1) 全量导出（标准 SQLite 方言）
npx wrangler d1 export navigation-db --remote --output d1-dump.sql

# 2) 灌进本地库（服务先停掉，避免迁移逻辑和灌库打架）
sudo systemctl stop navihive
mkdir -p /srv/navihive/data
sqlite3 /srv/navihive/data/navihive.db < d1-dump.sql

# 3) 删掉 FTS 虚拟表，让 migrate() 按当前分词规则重建
sqlite3 /srv/navihive/data/navihive.db "DROP TABLE IF EXISTS notes_fts;"

# 4) 起服务，migrate() 自动补到当前 SCHEMA_VERSION，FTS 数据由同步逻辑回灌
sudo systemctl start navihive
```

四个注意点：

- **FTS 表不要从 dump 带过去**（第 3 步别省）：D1 导出的定义与本地 SQLite 可能有细微差异，
  删掉让代码重建最稳。
- **附件（KV）要单独搬**，最容易漏。先查有没有数据：
  ```bash
  npx wrangler kv key list --binding=FILES_KV
  ```
  有 key 就逐个 `wrangler kv key get --binding=FILES_KV "<key>" > data/files/<key>` 落盘
  （key 形如 `attach/<userId>/<uuid>`，子目录要一起建）。一个 key 都没有就直接跳过。
- **导出文件含敏感数据**（`users` 的密码哈希、`configs` 里加密过的凭据）：加密存放，用完即删。
- **`AUTH_SECRET` / `DATA_ENCRYPTION_KEY` / `JWT_SECRET` 必须与线上完全一致**，
  否则老令牌全部失效、已加密的站点凭据解不开。迁完先用自己的账号登一次验证。

---

## 十一、切流状态（2026-10-15 已定型）

**当前形态：自托管即主站，对外暴露走 Nginx 反代。**

- 域名（`https://<your-host>`）→ Cloudflare → VPS 443 → Nginx → `127.0.0.1:8787` → 容器。
  Nginx 与 NaviHive 同机（可以是同机的 Nginx 容器，host 网络模式）。
- **8787 只绑宿主机回环**（`127.0.0.1:8787:8787`），不直接面对公网 —— 裸 HTTP 直连
  等于绕过 TLS 和 Nginx 的安全/限流层。
- Cloudflare 那套（Workers + D1）**保留不删**，作为回滚目标；但它不再是主站，
  上面的数据停留在此刻的状态（**已决定：不把 CF 端数据再重导同步过来**）。
  两端各自独立，将来要搬数据用备份文件手工导入（导航 `/api/export` → 另一端 `/api/import`；
  站点密码在导出时解密为明文、导入时用目标库密钥重加密，两端 `AUTH_SECRET` 不同也能搬）。
- 回滚 = DNS 改回 Cloudflare（分钟级）。注意切流后新写的数据只在 VPS 侧，
  回滚前需先用备份导出把 VPS 这段时间的数据搬回去——没有自动同步，别以为有。

### ⚠️ 上游指公网 IP 的「发卡」陷阱

把 8787 绑回环之前，**先确认 Nginx 的上游写的是 `127.0.0.1:8787` 而不是 VPS 的公网 IP**
（`server <vps-ip>:8787` 这种）。面板类工具（kPanel 等）默认常填公网 IP，
请求走「本机 → 公网 IP → 本机」的发卡路径——平时能通，一旦把端口收进回环就全站 502。
生产上就踩过：改绑定后站点挂掉，根因是上游还指着公网 IP。两步必须一起做：

```bash
# 1) Nginx 上游改回环（容器外是宿主上的配置文件，改完 reload）
sed -i 's/<公网IP>:8787/127.0.0.1:8787/g' /etc/nginx/conf.d/<站点>.conf
docker exec nginx nginx -t && docker exec nginx nginx -s reload
# 2) 再把 compose 的端口映射收进回环，重建容器
#    "8787:8787" → "127.0.0.1:8787:8787"
docker compose down && docker compose up -d
ss -tln | grep 8787        # 应只剩 127.0.0.1:8787
```

---

## 十二、排障

| 现象 | 先看哪 |
|---|---|
| 登录 200 但立刻掉线 | ① Nginx 有没有传 `X-Forwarded-Proto`；② 真只 http 访问就设 `NAVIHIVE_COOKIE_SECURE=0`；③ 多条 Set-Cookie 有没有被中间层黏成一条（`curl -i` 数一下） |
| 静态页没有 CSP / SW 注册失败 | `dist/client/_headers` 没构建出来或路径不对（启动时有告警）；`NAVIHIVE_STATIC_DIR` 指错 |
| 写操作 403 | 同源判据是 `Sec-Fetch-Site`；确认访问用的就是站点自己的域名，没有混用 workers.dev |
| 附件 413 | Nginx `client_max_body_size` 小于 25MB |
| `SQLITE_BUSY` | 有别的进程在写（备份脚本 / 手工 sqlite3）。适配器已开 WAL + 5s 等待；备份请用 `VACUUM INTO` 而不是长事务 |
| 定时任务没跑 | `NAVIHIVE_CRON=1`？多副本是不是每个都跑了？外部触发就看 `NAVIHIVE_CRON_TOKEN` 配了没 |
| 改完代码不生效 | `npm run build && npm run build:server` 之后**重启服务**；`dist-server/` 是构建产物，不会热更新 |
| **Docker：构建 OOM（exit 134 / `Aborted (core dumped)`）** | 小内存机器上 Node 按物理内存把堆上限收到 ~257MB，`tsc -b` 直接爆。Dockerfile 已设 `NODE_OPTIONS=--max-old-space-size=3072`，**但至少要给 2G swap**（`fallocate -l 2G /swapfile && mkswap && swapon`） |
| **Docker：compose 显示 Up 但宿主连不上** | 上一次 `up` 因端口冲突失败后会留一个半成品容器（PortBindings 有、实际映射没建立）。`docker compose down && docker compose up -d` 重建即可 |
| **Docker：compose 拒绝启动并提示 AUTH_SECRET** | 设计如此（`${AUTH_SECRET:?…}`）：宁可直接失败，也不给一个「起来了但登不进去」的服务。去 `.env` 配上 |
| **Docker：绑定挂载（`./data`）写不进** | 容器里是 `node` 用户（uid 1000）不是 root。宿主机目录 `chown 1000:1000`，或改用命名卷 |
| **Docker：首登后任何写操作 403** | 种子账号首登强制改密是既定行为，不是故障。`PUT /api/auth/credentials` 改完再写 |
| **把 8787 绑回环后全站 502** | Nginx 上游还指着 VPS 公网 IP（发卡路径），回环一绑就断。上游改 `127.0.0.1:8787` 再 reload，见第十一节 |

---

## 十三、安全须知

- **不要把 8787 直接暴露公网**。默认只听 `127.0.0.1` 是故意的；真要不挡 Nginx，
  必须 `NAVIHIVE_TRUST_XFF=0`（否则改 `X-Forwarded-For` 就能换限速桶）。
  Docker 接法同理：compose 的端口映射默认只绑 `127.0.0.1`，改直连前先想清楚这条。
- `AUTH_ENABLED` 不是 `true` 时全站无需登录即可读写，只适合内网调试。
- 密钥文件（`/etc/navihive/env` 或 Docker 的 `.env`）权限 600，别进 git
  （`.gitignore` 已忽略 `.env`，`.dockerignore` 同样排除——进镜像等于把密钥烙进层里）。
- 服务按最小权限跑：systemd 段已给 `ProtectSystem=strict` + `ReadWritePaths`；
  Docker 镜像以 `node` 用户运行，只挂 `/app/data`，它只需要读代码目录、写 `data/`。
- 数据库文件含密码哈希与加密凭据，备份按敏感数据对待（加密存放、传输用 TLS）。
