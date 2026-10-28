# 发布手册（VPS 自托管形态，2026-10-28）

一条命令一条命令照着敲的版本。**五步 + 一条纪律**。

> 适用范围：自托管主站（Docker 容器 + 宿主机反代到 `127.0.0.1:8787`）。
> Cloudflare Workers 那条发布路径（`npm run deploy`）不在本文范围。
>
> 拓扑只描述形状：本机（开发）→ GitHub → GHCR → 你的 VPS。
> 本手册**不写**任何具体 IP / 域名 / SSH 用户 / 密钥路径，照抄时自己替换 `< >` 里的部分。

---

## 0. 先确认起点干净

```bash
git status --short          # 除了你这次要发的改动，别的都不该出现
git log --oneline -1        # 记下这个 sha，后面第 3 步要用它
node -v                     # 与 .nvmrc 一致
```

预期：`git status` 只列出你本次改的文件（或全空）；`git log` 输出一行 sha。

⚠️ 这里有未提交的改动混进来时，**先 `git stash`**。发布流程里最贵的错误不是「发错了版本」，
而是「发出去的版本里混进了一段自己都忘了的调试代码」。

---

## 1. `npm run ci`

```bash
npm run ci
```

它串的是这一整串（按执行顺序，挑重点说为什么在这里）：

| 环节 | 命令 | 拦住什么 |
|---|---|---|
| 类型 | `npm run typecheck`（`tsc -b`） | 增量构建下的类型漂移 —— 单测跑得过但 `tsc` 红是常态 |
| Lint | `npm run lint` | `eslint .` + **warning 预算**（`lint-warnings-budget.mjs`）。只降不升，防止「先加 warn 以后再修」 |
| 单测 | `npm run test` | 自定义 runner（`script/unit-tests.mjs`），两千多条 |
| 品牌 | `npm run check:brand` | `sync-brand.mjs --check`：品牌串只允许有一个真源，防止某处漏改 |
| 构建 | `npm run build` | `tsc -b && vite build`。这一步同时产出 `dist/client/_headers`（CSP 的唯一真源） |
| 首屏预算 | `npm run check:budget` | 首屏体积硬门禁，超了直接红 |
| 契约 e2e | `npm run e2e` / `e2e:share` / `e2e:share-extra` / `e2e:cron` / `e2e:webdav` | 打真实 HTTP，覆盖登录、分享、定时任务、WebDAV |
| 冒烟 | `npm run smoke` | 静态头 / SPA fallback / 404 |
| 审计 | `audit:a11y` / `audit:contrast` / `audit:perf` / `audit:visual` | 无障碍、对比度、性能预算、视觉回归 |
| 覆盖率 | `npm run check:coverage` | 分层阈值（不是单一数字） |
| 边缘探针 | `npm run probe:edge` | 先 `build:server` 再探 API 边界 |

预期：最后一行是全部通过的汇总，退出码 0。

```bash
echo $?
```

⚠️ **不要跳过这一步去「先推上去让 CI 跑」**。CI 跑的是同一套东西，但它跑完要几分钟，
而失败时你已经在第 2 步之后了 —— 那时 `main` 上留着一个红的 commit，镜像流水线不会发布，
你会盯着「为什么 GHCR 上没有新 tag」排查半天。

---

## 2. 推送到 `main`

### 为什么会有一台机器要走 REST API

这台开发机上 `github.com:443` **不通**（DNS 能解析、TCP 连不上，代理只放了部分域名）。
所以 `git push` 会卡到超时。绕法是用本机的 Python 脚本走 GitHub REST API 提交
（`POST /repos/<owner>/<repo>/git/blobs` → `trees` → `commits` → 更新 ref）。

⚠️ **这个脚本不在仓库里**，是这台机器的私人工具。换一台机器（网络正常）时：

```bash
git push origin main
```

就够了，不需要任何脚本。

### 走脚本时要做的事

1. 用脚本把本次改动提交并更新 `main` 的 ref；
2. **同步本地 git 引用**，否则本地 HEAD 和远端会对不上，下一次 diff 全是假的：

```bash
git fetch origin main
git reset --soft origin/main     # 只挪 HEAD，工作区不动
git log --oneline -1             # 应该等于远端最新的那个提交
git status --short               # 应该干净
```

预期：本地 HEAD 与 `origin/main` 一致，工作区干净。

⚠️ 这里是 `--soft` 不是 `--hard`。`--hard` 会丢掉你没提交的东西 —— 而「推送脚本绕过 git」
这件事本身就意味着本地可能有未入库的改动。

---

## 3. 等 GHCR 出现本次 commit 的镜像

镜像**不会**在推送后立刻出现：`docker-publish.yml` 由 `workflow_run` 驱动，**只有在 CI
结论为 success 且分支是 main 时才发布**，发布的正是 CI 验证过的那个 sha。

```bash
docker buildx imagetools inspect ghcr.io/<owner>/navihive:<上一步记下的 sha>
```

预期输出里能看到 `MediaType`、`Digest: sha256:...`、以及两个平台的清单
（`linux/amd64`、`linux/arm64`）。

- **`no such manifest` / `manifest unknown`** → 镜像还没出。去 Actions 看 `CI` 是不是还在跑、
  是不是红了；CI 绿了但 `docker-publish` 没触发，就看它的触发条件（`workflow_run`）。
- 第一次在这个仓库上发版时，还要确认 GHCR 上的包是 **public**，否则 VPS 上匿名 pull 会 401。

> ⚠️ 为什么必须用 sha tag 而不是 `:latest` 来确认：`:latest` 是一个**会被覆盖的指针**，
> 你看到它存在，不能证明它是这次构建的。sha tag 才唯一对应一个 commit。

---

## 4. VPS 上换镜像

```bash
# 先记下「换之前」的 digest —— 这是后面判断「到底换没换」的唯一依据
docker image inspect ghcr.io/<owner>/navihive:latest --format='{{index .RepoDigests 0}}'

cd /path/to/navihive
docker compose pull navihive
# 再看「换之后」的 digest，两次必须不同
docker image inspect ghcr.io/<owner>/navihive:latest --format='{{index .RepoDigests 0}}'

docker compose up -d --force-recreate navihive
```

预期：两次 `RepoDigests` 输出的 `sha256:` 部分**不相同**；`up -d` 显示 `Recreated` / `Started`。

### 🔴 部署纪律：pull 前后比对 digest

**这是本节最重要的一条，不是可选项。**

`docker compose pull` 在「远端 `:latest` 没有变化」时会输出 `Image is up to date` 并**什么
都不做**。此时如果你直接 `up -d --force-recreate`，容器会用**旧镜像**重建 —— 健康检查
通过、页面能开、版本号也许还是旧的，而你会在验收清单上打五个勾，认为上线成功。

digest 没变 = 三种可能，逐个排除：

1. 流水线没发布（回第 3 步）；
2. 本机推送的 commit 不是 CI 跑的那个（看 `git log` 与 Actions 里的 sha 对不对得上）；
3. 这台机器上 `NAVIHIVE_IMAGE` 指向的不是 `:latest`（比如上次回滚时写的固定 sha 还留在
   `.env` 里）—— 这种情况 pull 的是那个旧 tag，**永远也拉不到新版**。

> 这条纪律以前只写在私人笔记里，代价是「把旧镜像当新版验收」。它比任何一条自动化检查都
> 重要，因为它失败时**所有检查都是绿的**。

---

## 5. 五路验证

每一项都要有明确的「看到了什么」，不是「点了一下没报错」。

| # | 验什么 | 怎么做 | 预期 |
|---|---|---|---|
| 1 | **登录** | 打开 `https://<your-host>/` → 输入账号密码 | 进入主界面；`curl -i` 看响应里 `Set-Cookie` 带 `Secure; HttpOnly` |
| 2 | **首屏渲染** | 直接刷新首页（不要从别的页跳） | 卡片与分组都出来，无长白屏；控制台无 CSP 报错、无 404 资源 |
| 3 | **建一条站点** | 首页 → 新增 → 填名称 + URL → 保存 | 新卡片立刻出现；**刷新后还在**（这一步验的是写入没被限速/幂等键误拦） |
| 4 | **建一条笔记** | 左下「记事本」→ 新建 → 打几行字 → 等 3 秒 | 出现「已保存 · 刚刚」；刷新后内容还在 |
| 5 | **传一张图片** | 笔记工具栏 → 插图 / 直接粘贴 | 图片显示出来；刷新后仍在（这一步同时验附件目录与 `data/files` 的属主） |

命令行版探活（不需要登录，任何时候都能打）：

```bash
curl -fsS https://<your-host>/api/init                  # → {"ok":true,"initialized":true,...}
docker inspect --format='{{.State.Health.Status}}' navihive   # → healthy
curl -sI -H 'Accept-Encoding: gzip' https://<your-host>/ | grep -i content-encoding
```

⚠️ 第 5 项是五项里最容易漏也最容易坏的：附件落在 `data/files`，容器以 `node`(1000) 跑，
属主不对时**上传接口会成功、读回来 500**。所以必须**刷新后再看一次图**，只看上传成功的
提示不算通过。

验收完成后：把第 3/4/5 项建的测试数据删掉（站点进回收站、笔记删除、图片删除），
别把测试数据留在生产库里。

---

## 6. 出问题怎么办

| 现象 | 去哪看 |
|---|---|
| 第 4 步 digest 没变 | 回第 3 步；检查 `.env` 里的 `NAVIHIVE_IMAGE` 是不是被固定成了某个 sha |
| 容器 `unhealthy` | `docker compose logs --tail=100 navihive`，先看有没有 `AUTH_SECRET` 告警 |
| 站点 502 | 反代上游是不是还指着公网 IP（见 `deploy/selfhost.md` 第十一节） |
| 网页一键升级失败 | `docker logs --tail=50 navihive-upgrader` —— 重建会换掉 `navihive` 自己的日志，升级器容器的日志才是现场 |
| 要退回去 | `deploy/selfhost.md` 第八节「升级与回滚」，三步，别只做第一步 |

回滚之后**不要**顺手把 `.env` 里的 `NAVIHIVE_IMAGE` 留在旧 sha 上不管 —— 那会让下一次
「网页一键升级」拉回同一个旧版本，表现为「点了更新，版本号纹丝不动」。
