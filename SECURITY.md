# 安全策略（Security Policy）

NaviHive 是**单实例自托管**项目：一套代码、两种形态（Cloudflare Workers + D1，或 Docker 里的 Node + SQLite）。
没有多租户运营方，也没有 LTS 分支 —— 这份文档说明「怎么报问题」和「出事之后按什么顺序换钥匙」。

## 支持的版本

| 形态 | 支持的版本 | 说明 |
|---|---|---|
| 自托管（Docker） | `ghcr.io/zwjttztt/navihive:latest` 与最新 `<sha>` tag | 只有一个维护线。旧镜像不补丁、不回移修复 |
| Cloudflare Workers | 仓库 `main` 的最新提交 | 同上：部署的是哪个 commit，就只对它负责 |

发现问题的版本已落后很多时，第一步永远是**先升级到最新**再复现 —— 绝大多数已知问题在升级后就不存在了。

## 怎么报告

1. **首选 GitHub Security Advisories**：仓库 → `Security` → `Advisories` → `Report a vulnerability`。
   这是一条私密通道，讨论、修复、披露时间线都在里面走。
2. 如果你的环境用不了 Advisories，发邮件到 **`<请自行填写安全邮箱>`**（占位：维护者请换成真实可达的地址）。
   标题带上 `[SECURITY]`，正文写清版本 / 形态（Cloudflare 还是自托管）/ 复现步骤 / 影响面。
3. **不要**开公开 issue 描述可利用细节。能复现的 PoC 请走上面两条私密渠道。

我们尽量在 7 天内给出首次回复。这是个人维护的项目，没有 SLA 承诺，但不会已读不回。

## 报告里不要贴这些

| 不要贴 | 为什么 |
|---|---|
| 站点备份 zip / 导出的 JSON | **备份默认不加密**（没设「备份密码」时服务端把原始 zip 直接上传网盘）。里面是全部笔记、附件，以及站点账号密码 |
| `AUTH_SECRET` / `DATA_ENCRYPTION_KEY` / `JWT_SECRET` / `JWT_SECRET_OLD` 的值 | 前两个是**库里已加密数据**的解密钥匙，拿到就等于拿到全部站点密码与 WebDAV 口令 |
| `.env` / `.dev.vars` / `wrangler.jsonc` 里的 secret 段 / 恢复私钥（PEM） | 恢复私钥丢了 = 忘记密码时再也进不来；贴出来 = 谁都能重置你的密码 |
| AI 服务的 `apiKey`（AI 设置里那份） | 它和站点密码一样是加密落库的凭据，泄漏后要按「换钥 + 重填」两步处理 |
| 审计日志原文里的来源 IP、邀请码 | 属于运行数据，跟漏洞无关，贴出来只会扩大暴露面 |

需要给证据时：把密钥替换成 `<REDACTED>`，或者只截**请求/响应结构**（字段名、状态码、错误码），不截值。

## 密钥轮换 SOP

仓库里已有轮换助手：`node scripts/rotate-secrets.mjs`（**只生成新密钥并打印命令，不替你执行**）。
它把顺序和代价都写在输出里，下面这份是给人读的版本。

### 0. 先认清楚「换哪一把、代价是什么」

| 键 | 作用 | 换掉之后会怎样 |
|---|---|---|
| `AUTH_SECRET` | 兜底钥匙：令牌签名 + 数据加密（`JWT_SECRET` / `DATA_ENCRYPTION_KEY` 都没单独配时用它） | 用它加密的历史密文（`enc$…` 无 keyId 的那批）**解不开** —— 站点密码、WebDAV 口令、AI 密钥全变成乱码。数据没丢，是钥匙换了 |
| `DATA_ENCRYPTION_KEY` | 只用于落库加密。新写入的密文带 `enc$1$…`（keyId=1），旧的 `enc$…` 仍由 `AUTH_SECRET` 解 | 新数据用新钥、旧数据照旧能读，**不需要停机迁移**。前提是 `AUTH_SECRET` 别同时换 |
| `JWT_SECRET` | 只用于登录令牌签名 | 已签发令牌当场失效（所有人重新登录），数据不受影响 |
| `JWT_SECRET_OLD` | 轮换 `JWT_SECRET` 期间的旧值，**只验签** | 留着它，旧密钥就一直能验通过 —— 过渡期结束必须删掉 |
| `AUTH_RECOVERY_PUBLIC_KEY` | 恢复令牌的验签公钥（私钥离线保存，永不入库） | 换掉之后，旧私钥签出的恢复令牌立刻失效 |

### 1. 轮换顺序（不可颠倒）

1. **先备份，且此时不要换钥**：登录站点 →「备份与恢复」导出一份到本地。
   这一步必须在换 `AUTH_SECRET` 之前做 —— 换完再导，导出的就是解不开的密文。
2. **记下要重填的项**：每个站点的账号密码、WebDAV 网盘口令、AI 的 `apiKey`。
3. **换 `AUTH_SECRET`（和/或 `DATA_ENCRYPTION_KEY`）**：`node scripts/rotate-secrets.mjs` 打印的就是
   `wrangler secret put …`（Cloudflare 形态）或写进 `.env`（自托管形态，改完重启容器）。
4. **重新填一遍加密项**：新的写入会用新钥；旧密文读不出来是预期行为，不是故障。
5. **`JWT_SECRET` 想做到「旧会话自然过期」**：先把当前值复制到 `JWT_SECRET_OLD`，再把 `JWT_SECRET` 换成新值，
   等一个令牌有效期过去，最后**删掉** `JWT_SECRET_OLD`。
6. **换管理员密码**：站内「账号与安全」改，或 `node scripts/reset-admin-password.mjs`（只对 Cloudflare/D1 有效，
   自托管请看 `deploy/selfhost.md` 第九节，那里说明了为什么它「会骗你说成功了」）。
7. **换完复核**：`wrangler secret list`（或容器 `env`）确认旧值已不在；把 `git log -p -- .env` 之类的残留清一遍；
   `.github/workflows/secret-history.yml` 每周会全历史扫一次，可以手动 `workflow_dispatch` 立刻跑一次确认。

### 2. 两个信任开关必须成对设置

`NAVIHIVE_TRUST_XFF` 与 `NAVIHIVE_TRUST_X_REAL_IP` 都是**默认 `0`**，只有同时为 `1` 才读 `X-Real-IP`。

- 只在**反代以覆盖模式**写了 `X-Forwarded-For $remote_addr` **且**写了 `X-Real-IP $remote_addr` 时才两个一起设 `1`
  （本仓 `deploy/nginx/` 模板满足条件；Caddy / Traefik 默认**不写** `X-Real-IP`）。
- 追加模式（`$proxy_add_x_forwarded_for`）下，XFF 首段仍是客户端伪造的：攻击者每个请求换一个值，
  就能换一个**限速桶**，五类限速（登录 / 改密 / 恢复 / 注册 / 写操作）会同时失效。这不是理论问题，是本仓库修过一次的真缺陷。
- 两个开关**只开一个**同样错：`X-Real-IP` 本身就是客户端可填的头，反代没覆盖写时，客户端自带的值会决定限速分桶键。

### 3. 生产环境永远不要开的两个开关

- `ALLOW_PLAINTEXT_SECRETS`：开了之后站点密码**明文落库**。它只用于本地调试；
  自托管形态下它曾经「设了不生效也不报错」一整轮（现已修），所以现在设了会真的生效 —— 更要小心。
- `NAVIHIVE_COOKIE_SECURE=0`：只在「确实只能走 http、且反代连 `X-Forwarded-Proto` 都不传」时用。
  否则登录 cookie 不带 `Secure`，令牌在明文链路上裸奔。

## 已知的安全边界（不是 bug，但你要知道）

- **备份默认不加密**：不设「备份密码」时，zip 原样上传到你的网盘（内含全部笔记、附件、站点账号密码）。
  强烈建议设一个与 `AUTH_SECRET` 不同的备份密码 —— 它与服务端密钥解耦，轮换服务端密钥不影响已有备份。
- **自托管必须自己终止 TLS**：容器只监听 `127.0.0.1:8787`，明文裸露到公网等于把令牌和密码公开。
  配置见 `deploy/nginx/` 与 `deploy/selfhost.md`。
- **审计日志会记录来源 IP 与操作者**：这是设计（排查需要），但也意味着这份日志本身是敏感数据。

## 相关文档

- 部署与运行时密钥清单：[`deploy/selfhost.md`](deploy/selfhost.md) 第三节
- 密钥与信任开关的逐条说明（含默认值）：根 [`README.md`](README.md) 的「🔐 密钥说明」
- 踩过的坑（包含多起安全相关的静默失效）：[`docs/pitfalls.md`](docs/pitfalls.md)
- 文档总索引：[`docs/README.md`](docs/README.md)
