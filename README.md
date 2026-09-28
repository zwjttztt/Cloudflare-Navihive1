<div align="center">

# 个人导航站 · NaviHive

![NaviHive 导航站](https://img.shields.io/badge/NaviHive-个人导航站-blue)

![React](https://img.shields.io/badge/React-19.0.0-61dafb)



![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6)



![Material UI](https://img.shields.io/badge/Material_UI-7.0-0081cb)

![Cloudflare](https://img.shields.io/badge/Cloudflare-Workers_+_D1-f38020)

![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)

</div>

这是基于 **NaviHive**（[原项目](https://github.com/jiangxiaobaicool/Cloudflare-Navihive1)）定制的一份**个人网站导航系统**，用于整理和管理你收藏的网站链接。支持分组管理、拖拽排序、登录认证、暗色模式、自定义 CSS 等功能，可免费部署到 Cloudflare 全球边缘网络。

## ✨ 特性

- 📚 **分组管理** — 将网站按类别整理成分组，可一键收起/展开分组，标题右侧显示卡片数量
- 🔄 **拖拽排序** — 直观地调整分组和网站的排列顺序（网站卡片支持跨分组拖拽，保存只需一次请求）
- 🔐 **用户认证** — 内置登录系统，保护你的导航数据
- 🌓 **暗色/亮色模式** — 随时切换主题
- 📱 **响应式设计** — 完美适配桌面和移动设备
- 🎨 **自定义配置** — 支持自定义网站标题、名称、背景图片与自定义 CSS 样式
- 🖼️ **背景图片** — 「网站设置」中可填写背景图 URL 并拖动滑块调整蒙版透明度
- 🔑 **站点账号密码** — 新增卡片时即可填写登录账号/密码；网站设置里支持一键复制与密码显隐
- ✨ **自动获取图标** — 「网站设置」可配置图标 API（`{domain}` 占位符），填好/修改网站链接即自动生成图标 URL，也可点魔棒按钮手动重新获取
- 💾 **备份与恢复** — 「更多选项 → 导出/导入数据」支持备份到本地文件 / WebDAV，并可从本地或远端备份恢复
- ☁️ **WebDAV 备份** — 支持坚果云、Nextcloud、ownCloud、群晖等，由 Worker 代理上传，不受浏览器跨域限制
- 🚀 **高性能** — 基于 Cloudflare Workers + D1 数据库，免费、全球加速

## 🛠️ 技术栈

- **前端**：React 19 · TypeScript · Material UI 7 · DND Kit（拖拽）· Tailwind CSS 4 · Vite 6
- **后端**：Cloudflare Workers · Cloudflare D1（SQLite）· JWT 认证

## 🚀 部署指南（两种方式）

### 方式一：一键部署（推荐，无需命令行）

1. 打开上方 **"Deploy to Cloudflare Workers"** 按钮（或访问  
   `https://deploy.workers.cloudflare.com/?url=https://github.com/zwjttztt/myhomepage`）。
2. 使用你的 Cloudflare 账号登录。
3. D1 数据库 `navigation-db` 已内置在 `wrangler.jsonc`（database_id 已填）；
   登录凭据需要你自己先设成 Cloudflare secret（**不要**写进 `wrangler.jsonc`，会明文进 Git）：
   ```bash
   wrangler secret put AUTH_USERNAME
   wrangler secret put AUTH_PASSWORD
   wrangler secret put AUTH_SECRET
   ```
   然后直接点击 **"Deploy"** 即可。
4. 部署完成后你会得到类似  
   `https://myhomepage.<你的用户名>.workers.dev` 的地址。

> 管理员账号密码由你上一步 `wrangler secret put` 决定（没有默认值）。  
> 这套凭据只在**第一次部署**时生效：首次登录会写入 D1 的 `configs` 表，之后就以数据库为准，重新部署不会再改动。  
> 首次登录后会提示改密码（种子凭据来自部署变量，等同半公开），建议立刻改成自己的账号密码。

### 方式二：手动部署（适合开发者）

```bash
# 1. 克隆本项目
git clone https://github.com/zwjttztt/myhomepage.git
cd myhomepage

# 2. 安装依赖
pnpm install

# 3. 安装并登录 Wrangler
npm install -g wrangler
wrangler login

# 4. 创建 D1 数据库
wrangler d1 create navigation-db   # 记下返回的 database_id

# 5. 编辑 wrangler.jsonc，把 database_id 换成上面的 ID，并设置好认证环境变量

# 6. 本地预览 / 构建 / 部署
pnpm dev        # 本地开发
pnpm build      # 构建
pnpm deploy     # 部署到 Cloudflare Workers
```

### 初始化数据库（两种方式都必须做一次）

部署完成后，数据库是空的，需要执行一次初始化 SQL：

1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/) → **Workers & Pages** → 选择你的项目 → **设置** → **数据库** → 点击已绑定的 `navigation-db`。
2. 进入 **控制台** 的 SQL 编辑器，**将仓库根目录的 `init_table.sql` 全部内容复制粘贴进去并运行**。
3. 看到"查询成功"即完成初始化（脚本会自动建表、写入初始化标志，并插入一份示例导航数据）。

> 若你不想用示例数据，可把 `init_table.sql` 中"示例导航数据"部分删掉再运行。

### 部署后必做（安全相关，别跳过）

凭据不再写在 `wrangler.jsonc` 里（那里的明文段已经删掉），改用 Cloudflare 的加密 secret：

```bash
wrangler secret put AUTH_USERNAME
wrangler secret put AUTH_PASSWORD
wrangler secret put AUTH_SECRET      # JWT 签名密钥 + 站点密码 / WebDAV 凭据落库加密密钥
# 可选但强烈建议：配置后可用「恢复私钥」签名令牌找回管理员密码（见下「忘记管理员密码」）
wrangler secret put AUTH_RECOVERY_PUBLIC_KEY
```

> `AUTH_SECRET` 请用全新的随机长串（比如 `openssl rand -base64 32`）。
> 它负责登录令牌签名，以及站点密码、WebDAV 凭据在数据库里的静态加密。
> **它不再参与备份文件加密** —— 备份用的是你自己在页面上设的「备份密码」（见下），
> 所以轮换 `AUTH_SECRET` 不会影响已有备份能不能解开。

部署完在页面上再做两件事：

1. **登录后立刻改一次管理员密码**（网站设置 → 管理员账号与密码）。这一步会把数据库里
   的旧明文密码升级成 PBKDF2 哈希，同时让所有旧会话失效。
2. **给备份设一个密码**（数据备份 → WebDAV 备份密码）。备份文件落到网盘/磁盘后就不在
   服务端密钥的保护范围内了，用自己的口令加密，换 `AUTH_SECRET` 也不影响它。

> ⚠️ 在此之前（用 `AUTH_SECRET` 加密备份的旧版本）导出的加密备份，现在已无法用服务端
> 密钥解开 —— 备份加密已与 `AUTH_SECRET` 解耦。请重新备份一份。

> 部署后所有已登录设备都需要重新登录一次 —— 旧令牌格式无法验签，这是预期的安全结果，不是故障。
>
> 如果你的仓库历史里曾经提交过明文密码（早期版本的 `wrangler.jsonc` 里确实写过），
> 可以用 [git-filter-repo](https://github.com/newren/git-filter-repo) 的 `--replace-text` 擦一遍。
> 但擦历史**不能撤回已经泄露的值**，擦完仍要把这些凭据全部重新生成一遍。

### 使用

访问你的导航站首页 → 使用上面设置的管理员账号密码登录 → 即可：

- 添加/编辑/删除分组和网站（新增卡片时可直接填写网站账号与密码）
- 点击「排序」后拖拽调整顺序，并支持将网站卡片拖到其他分组（跨组移动）
- 分组标题左侧的箭头按钮可一键**收起 / 展开**该分组（状态记在浏览器本地，刷新后保持），标题右侧显示该分组内的卡片数量
- 在「网站设置」中修改站点标题、名称、获取图标 API、背景图片与自定义 CSS（默认显示名 MyHomepage）

> 新增卡片、或有改动地保存「网站设置」后，页面会自动刷新一次，确保展示的是服务端最新数据（首屏为单次 bootstrap 请求，刷新很快）。
>
> 排序保存已合并为**一次请求**：顺序调整和跨组移动一起提交，卡片再多也是一次往返。

### 一键获取站点图标

1. 打开「更多选项 → 网站设置」，在 **获取图标API设置** 中填写图标接口，用 `{domain}` 作域名占位符，  
   默认值为 `https://www.faviconextractor.com/favicon/{domain}?larger=true`  
   （另支持 `{host}`、`{origin}`、`{url}` 占位符）。
2. **填好网站链接后图标会自动生成**：新增卡片对话框里输入「站点URL」、或站点「网站设置」中修改「网站链接」时，都会自动按上述模板填好「图标 URL」。
3. 也可以点图标输入框右侧的魔棒按钮手动重新获取；手动改过图标后，再改链接不会覆盖你的自定义图标。

### 背景图片

在「更多选项 → 网站设置 → 背景图片设置」中填写图片 URL（留空则关闭背景图），并拖动  
**背景蒙版透明度** 滑块：值越大背景图越清晰，值越小内容越易读（默认 0.15）。

### 站点账号密码

1. 新增卡片时直接在「网站账号」「网站密码」栏填写；或鼠标悬停站点卡片 → 点右上角齿轮打开「网站设置」。
2. 在「登录凭据」区域修改**账号**与**密码**，点击输入框右侧的复制图标即可一键复制（密码框左侧的眼睛图标可切换明文显示）。
3. 点击「保存」后凭据会存入 D1 数据库，并随备份文件一起导出/恢复。

### 备份与恢复（「更多选项 → 导出/导入数据」）

在页面右上角「更多选项」菜单里点 **导出数据** 或 **导入数据** 打开「数据备份与恢复」窗口：

- **备份到本地**：把全部分组、站点（含账号密码）与网站设置导出为 JSON 文件下载到本机。
- **备份到 WebDAV**：填写 WebDAV 地址、账号、密码（建议使用应用专用密码）与备份目录，点击「测试连接并保存」，再点「备份到 WebDAV」即可上传（目录不存在会自动创建）。
- **恢复 / 导入**：
  - 从本地文件恢复：选择之前导出的 JSON 文件 → 「开始恢复」。
  - 从 WebDAV 恢复：点「查看远端备份」→ 选中某个远端备份 → 「从选中备份恢复」，也可删除旧备份。
  - 通过开关选择 **覆盖恢复**（清空现有数据后导入，保留原 ID）或 **合并导入**（追加到现有数据）。

> WebDAV 配置保存在服务端（`configs` 表中的 `webdav.*` 键），**不会**写入备份文件，避免凭据随文件泄露。

**每周自动备份**：同一窗口里的「每周自动备份一次」默认开启，Worker 会在 **每周一上午 10:00（北京时间）** 自动备份一次到 WebDAV，无需打开页面。

- 备份内容是 gzip 压缩后的 `.json.gz`（实测体积约为原来的 6%），上传快很多；
- 自动备份成功后会**删掉上一次的自动备份**（文件名带 `auto-` 前缀），自动备份始终只留最新一份；
  手动点「备份到 WebDAV」产生的备份**一律保留、不会被任何自动任务删除**，需要存档时手动备份即可；
- 远端备份列表按时间倒序返回，最新的那份在最上面；
- 想改时间就编辑 `wrangler.jsonc` 的 `triggers.crons`（默认 `0 2 * * 1`，UTC 时间）后重新部署；
- 从 WebDAV 恢复时，压缩备份会自动解压，早期的 `.json` 明文备份也照样能恢复。

## 🌐 绑定自定义域名（可选）

1. Cloudflare 控制台 → 你的项目 → **触发器 (Triggers)** → **自定义域 (Custom Domains)** → 添加自定义域。
2. 按提示完成 DNS 配置即可，无需自建服务器。

## 🔧 常见问题

**忘记管理员密码？** 几种方式任选其一（都不需要登录，也不依赖「重置码」这类可被外人反复尝试的共享密钥）：

1. **用恢复私钥签名令牌找回（推荐，登录页即可操作）**：部署时生成一对 Ed25519 密钥，公钥设为 `AUTH_RECOVERY_PUBLIC_KEY`，私钥离线保管。忘记密码时，用私钥本地对 `{账号, 新密码哈希, 过期时间, 一次性 jti}` 签名成一个 JWS 令牌，粘到登录页「用恢复密钥找回账号」即可重置。服务器只持公钥、只做验签——没有私钥造不出合法令牌，所以这个公网入口是安全的：

   ```bash
   # ① 一次性生成密钥对：公钥用于 secret，私钥写到 ./scripts/recovery-private.key（请离线保管）
   node scripts/recovery-token.mjs generate
   wrangler secret put AUTH_RECOVERY_PUBLIC_KEY   # 粘贴上一步打印的公钥

   # ② 忘记密码时，用私钥本地签发一个重置令牌（默认 24 小时有效、一次性使用）
   node scripts/recovery-token.mjs sign --username admin --password '新密码至少12位'
   # 把打印出的令牌粘到登录页「用恢复密钥找回账号」即可
   ```

   > 恢复令牌带 `exp` 过期时间与 `jti` 一次性防重放；私钥等同万能钥匙，**务必离线保存、绝不提交到 Git**（已加入 `.gitignore`）。

2. **用重置脚本（推荐给没有私钥在手的场景，按正确格式写哈希，不落明文）**：仓库自带 `scripts/reset-admin-password.mjs`，会用和后端完全相同的算法生成密码哈希，并更新 D1、同时让所有已登录会话失效：

   ```bash
   # 在仓库根目录执行；可加 --username 改账号，不写则只改密码
   AUTH_ENABLED=true node scripts/reset-admin-password.mjs --password '你的新密码'
   # 不想把密码写在命令行，可走交互输入：
   node scripts/reset-admin-password.mjs
   # 数据库名不是默认的 navigation-db 时用 --db 指定：
   node scripts/reset-admin-password.mjs --db 你的库名 --username admin --password '你的新密码'
   ```

   > 脚本依赖 `wrangler` 命令行（全局装了或能 `npx wrangler` 即可），走的是你本机已有的 Cloudflare 登录态——本质上就是「你亲自改库」，所以不存在可被外人反复尝试的公开入口。

3. **直接改 D1**（没有 Node 环境时）：凭据存在 D1 的 `configs` 表里，直接改这两行即可（无需重新部署）。下面的写法会先把密码存成明文，**下次正常登录时后端会自动把它升级成哈希**，所以不必手动算哈希：

   ```bash
   wrangler d1 execute navigation-db --command "UPDATE configs SET value='你的新密码' WHERE key='auth.password'"
   wrangler d1 execute navigation-db --command "UPDATE configs SET value='你的新账号' WHERE key='auth.username'"
   ```

4. **登录后修改**：还能登录时，到「网站设置 → 管理员账号与密码」修改（需填写当前密码），改动立即生效且不会被后续部署覆盖。

> 设计取舍：本项目不再提供「登录页填共享码找回」这种对公网开放、可被暴力猜解的入口（旧版的 `AUTH_RESET_CODE` 应急重置码已移除）。找回密码一律要求你能操作 Cloudflare / D1——或持有离线保管的恢复私钥。恢复公钥入口因为是**非对称验签**，服务器不持任何秘密，比共享密钥安全得多。

**想关闭登录？** 将 `AUTH_ENABLED` 设为 `false`，任何访问者都可浏览与编辑（不建议公开站点使用）。

**如何备份数据？** 登录后点右上角「更多选项 → 导出数据」，可备份到本地或 WebDAV；或命令行 `wrangler d1 database export navigation-db`。

**旧数据库没有账号密码字段？** Worker 会在首次请求时自动执行 `ALTER TABLE sites ADD COLUMN username/password` 补齐字段，无需手工处理。

**WebDAV 连不上？** 确认地址以 `https://` 开头、使用应用专用密码（坚果云等需在网页端生成），并点击「测试连接并保存」查看具体提示。

**如何更新？** 拉取本项目最新代码后重新构建并 `pnpm deploy`。

## ⚡ 性能说明

首屏与刷新都只走 **一次** `GET /api/bootstrap` 请求（服务端用 `db.batch` 把分组、站点、配置三条查询合并为一次 D1 往返），不再像早期版本那样「先查分组、再逐个分组查站点」。数据库结构迁移结果缓存在 Worker 模块作用域，同一 isolate 内只执行一次，不会每个请求都跑 DDL。

界面上删除、拖拽排序、改分组等操作都**先就地更新本地状态**，随后静默拉一次最新数据，因此不会出现每次修改都整页转圈等待的情况；而**新增卡片**与**保存有改动的网站设置**会主动刷新一次页面，保证看到的一定是服务端最新数据（单次 bootstrap 请求，刷新很快）。静态资源侧另有 `public/_headers`，对带哈希指纹的 `/assets/*` 启用长期强缓存。

## 🗂️ 项目结构

```
├── worker/index.ts        # Cloudflare Workers 后端（API + WebDAV 备份代理）
├── src/                   # 前端源码（React）
│   ├── API/http.ts        # API 客户端与 D1 数据访问
│   ├── components/        # React 组件（卡片、弹窗、备份窗口等）
│   ├── context/           # 全局配置透传（图标 API、背景图等）
│   ├── utils/clipboard.ts # 一键复制工具
│   ├── utils/iconApi.ts   # 图标 API 模板解析（{domain} 占位符）
│   └── App.tsx            # 主应用
├── public/                # 静态资源（含 _headers 缓存规则）
├── init_table.sql         # 数据库初始化脚本（含示例数据）
├── wrangler.jsonc         # Cloudflare 配置
├── pnpm-workspace.yaml    # pnpm 构建脚本许可
├── package.json
└── vite.config.ts
```

## 📄 许可证与致谢

本项目基于 MIT 许可证发布。核心代码来自 [NaviHive](https://github.com/jiangxiaobaicool/Cloudflare-Navihive1) 项目，感谢原作者。技术栈致谢：React · Material UI · DND Kit · Cloudflare Workers · Vite · Tailwind CSS。
