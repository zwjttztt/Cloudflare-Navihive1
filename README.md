<div align="center">

# 个人导航站 · NaviHive

![NaviHive 导航站](https://img.shields.io/badge/NaviHive-个人导航站-blue)
![React](https://img.shields.io/badge/React-19.0.0-61dafb)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6)
![Material UI](https://img.shields.io/badge/Material_UI-7.0-0081cb)
![Cloudflare](https://img.shields.io/badge/Cloudflare-Workers_+_D1-f38020)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/zwjttztt/myhomepage)

</div>

这是基于 **NaviHive**（[原项目](https://github.com/jiangxiaobaicool/Cloudflare-Navihive1)）定制的一份**个人网站导航系统**，用于整理和管理你收藏的网站链接。支持分组管理、拖拽排序、登录认证、暗色模式、自定义 CSS 等功能，可免费部署到 Cloudflare 全球边缘网络。

## ✨ 特性

- 📚 **分组管理** — 将网站按类别整理成分组（如：常用工具、开发、学习、娱乐）
- 🔄 **拖拽排序** — 直观地调整分组和网站的排列顺序（网站卡片支持跨分组拖拽）
- 🔐 **用户认证** — 内置登录系统，保护你的导航数据
- 🌓 **暗色/亮色模式** — 随时切换主题
- 📱 **响应式设计** — 完美适配桌面和移动设备
- 🎨 **自定义配置** — 支持自定义网站标题、名称和自定义 CSS 样式
- 💾 **数据导入/导出** — 一键备份与迁移你的导航数据
- 🚀 **高性能** — 基于 Cloudflare Workers + D1 数据库，免费、全球加速

## 🛠️ 技术栈

- **前端**：React 19 · TypeScript · Material UI 7 · DND Kit（拖拽）· Tailwind CSS 4 · Vite 6
- **后端**：Cloudflare Workers · Cloudflare D1（SQLite）· JWT 认证

## 🚀 部署指南（两种方式）

### 方式一：一键部署（推荐，无需命令行）

1. 打开上方 **"Deploy to Cloudflare Workers"** 按钮（或访问
   `https://deploy.workers.cloudflare.com/?url=https://github.com/zwjttztt/myhomepage`）。
2. 使用你的 Cloudflare 账号登录。
3. D1 数据库 `navigation-db` 及登录凭据已内置在 `wrangler.jsonc`（database_id 已填，AUTH_* 已配置），直接点击 **"Deploy"** 即可。
4. 部署完成后你会得到类似
   `https://myhomepage.<你的用户名>.workers.dev` 的地址。

> 默认登录账号：`admin` ／ 密码：`j55XeeGvQZJXf3`（部署后在 Cloudflare 控制台「设置 → 变量」中可自行修改）。

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

### 使用

访问你的导航站首页 → 使用上面设置的管理员账号密码登录 → 即可：
- 添加/编辑/删除分组和网站
- 点击"排序"后拖拽调整顺序，并支持将网站卡片拖到其他分组（跨组移动）
- 在"网站设置"中修改站点标题、名称与自定义 CSS（默认显示名 MyHomepage）
- 在"数据"中导出备份或导入恢复

## 🌐 绑定自定义域名（可选）

1. Cloudflare 控制台 → 你的项目 → **触发器 (Triggers)** → **自定义域 (Custom Domains)** → 添加自定义域。
2. 按提示完成 DNS 配置即可，无需自建服务器。

## 🔧 常见问题

**忘记管理员密码？** 在 Cloudflare 控制台 → 项目 → 设置 → 环境变量中修改 `AUTH_PASSWORD` 并重新部署即可。

**想关闭登录？** 将 `AUTH_ENABLED` 设为 `false`，任何访问者都可浏览与编辑（不建议公开站点使用）。

**如何备份数据？** 登录后使用界面内的"数据导出"；或命令行 `wrangler d1 database export navigation-db`。

**如何更新？** 拉取本项目最新代码后重新构建并 `pnpm deploy`。

## 🗂️ 项目结构

```
├── worker/index.ts        # Cloudflare Workers 后端（API + 静态资源）
├── src/                   # 前端源码（React）
│   ├── API/http.ts        # API 客户端与 D1 数据访问
│   ├── components/        # React 组件（卡片、弹窗等）
│   └── App.tsx            # 主应用
├── public/                # 静态资源
├── init_table.sql         # 数据库初始化脚本（含示例数据）
├── wrangler.jsonc         # Cloudflare 配置
├── pnpm-workspace.yaml    # pnpm 构建脚本许可
├── package.json
└── vite.config.ts
```

## 📄 许可证与致谢

本项目基于 MIT 许可证发布。核心代码来自 [NaviHive](https://github.com/jiangxiaobaicool/Cloudflare-Navihive1) 项目，感谢原作者。技术栈致谢：React · Material UI · DND Kit · Cloudflare Workers · Vite · Tailwind CSS。
