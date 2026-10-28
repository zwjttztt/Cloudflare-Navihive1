# VPS 重装后重建 Runbook（2026-10-16）

适用场景：VPS 重装、kPanel 全新，要把自托管 NaviHive 拉起来，并把 Cloudflare 那端的
数据搬过来。全程约 20 分钟（不含镜像构建等待）。

配套文件：`deploy/kpanel-compose.yaml`（kPanel 粘贴即用的 compose）。

---

## 0. 前置检查（5 分钟，别跳过）

```bash
# 1) VPS 的公网 IP 变了没有？域名还指不指着它
curl -s ifconfig.me          # VPS 上执行，记下 IP
dig +short <your-host>  # 任意机器执行，对比上面那个 IP
```

- **一致** → 跳过域名解析，Cloudflare 那边不用动。
- **不一致** → 去 Cloudflare DNS 把 `<your-host>` 的 A 记录改成新 IP
  （代理状态保持「已代理」小橙云不变）。改完等 1~2 分钟再继续。

另外确认这台 VPS 上 kPanel 已经装好、Docker 正常：

```bash
docker version && docker compose version
```

---

## 1. 让镜像存在（二选一）

### A. GHCR 镜像（推荐，VPS 不用编译）

镜像由 GitHub Actions 构建推到 `ghcr.io/zwjttztt/navihive:latest`。首次要做三件事：

1. **触发一次构建**：GitHub 仓库 → Actions → 「docker-publish」→ Run workflow（选 main）。
   跑完约 3~5 分钟，日志最后出现 `push docker.io/...` 之类的行即成功。
2. **把包改成公开**（否则 VPS 上匿名 `docker pull` 会被 401 拦）：
   GitHub → 仓库页右上「Packages」→ `navihive` → Package settings →
   Danger Zone → Change visibility → **Public**。一次性操作，以后不用管。
3. VPS 上验证能拉：

```bash
docker pull ghcr.io/zwjttztt/navihive:latest
```

> 以后每次往 main 推代码（只要动了 Dockerfile / server / worker / src/API / 依赖清单），
> 这条流水线会自动重发镜像；更新部署就是 `docker compose pull && docker compose up -d`。

### B. VPS 本地构建（镜像拉不下来时的退路）

```bash
git clone https://github.com/zwjttztt/Cloudflare-Navihive1.git /home/docker/navihive-src
cd /home/docker/navihive-src
# 构建期要跑 tsc + vite，小内存机器必须给 swap（≥2G）；4C/24G 的机器直接跑
AUTH_SECRET=dummy-build-only docker compose build
docker images navihive   # 确认 navihive:latest 在位
```

用这条路就把 compose 里的 `image:` 改成 `navihive:latest`。

---

## 2. kPanel 部署（就是截图里那个对话框）

1. kPanel → Docker → 部署应用。
2. 「粘贴部署内容」框里**整个替换**掉预填的 `docker run ... nginx:alpine` 示例，
   粘入 `deploy/kpanel-compose.yaml` 的全文（仓库里那份，或本文末附录）。
3. **改两个值**（其余保持原样）：
   - `AUTH_SECRET`：ssh 上 VPS 跑 `openssl rand -hex 32`，把输出贴进去；
   - `AUTH_PASSWORD`：设一个初始密码（首次登录会强制改）。
4. 点「部署」。起来后验证：

```bash
docker ps --filter name=navihive --format '{{.Status}}'   # 应为 Up ... (healthy)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/api/init   # 应为 200
```

**两个最容易踩、且毫无报错的坑**（都是真踩过的）：

- 端口必须写成 `127.0.0.1:8787:8787`——只写 `8787:8787` 会把应用直接暴露公网；
  而 `NAVIHIVE_HOST` 必须是 `0.0.0.0`（容器内听回环的话端口映射整个废掉）。
- compose 里别用 `${VAR}`——kPanel 的部署目录没有 .env，插值失败服务直接起不来。
  要改的值全是字面量。

---

## 3. kPanel 网站反代 + 证书（域名指对 IP 的情况下）

1. kPanel → 网站 → 新建站点：域名 `<your-host>`，类型选**反向代理**，
   目标 `http://127.0.0.1:8787`。
2. SSL：
   - **有 Cloudflare 源站证书**（CF → SSL/TLS → Origin Server → Create Certificate，
     勾选 `*.<your-host>` + `<your-host>`，有效期 15 年）→ 把证书/私钥粘进 kPanel 对应位置；
   - 没有的话用 kPanel 的 Let's Encrypt 申请：先把 CF 的代理**临时关掉**（灰云），
     签发成功后再开回橙云。
3. 验证公网：

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<your-host>/api/init   # 200
```

> nginx 侧不用手写配置：kPanel 生成的站点配置就是反代到 8787，静态资源由容器里的
> Node 直接服务（安全头以 `dist/client/_headers` 为唯一事实来源，反代不掺和）。

---

## 4. 把 Cloudflare 上的数据搬过来

数据分两份，导航和笔记**故意**分开（导航备份不含笔记），两边都要导、都要导。

### 4.1 从 Cloudflare 站导出（重要：用你平时那台浏览器）

1. 浏览器打开 `https://<your-host>`，登录。
2. 顶栏「更多选项」→「备份与恢复」→ 确认在**备份**页：
   - 「备份含站点账号密码」开关**打开**（否则搬过去的卡片没有账号密码）；
   - 如果设过「用密码加密备份文件」，记住那个口令，恢复时要输。
3. 点「下载备份文件」→ 得到 `navihive-data.json`（或 `.navihive` 加密文件）。
4. 顶栏「记事本」→ 右上角齿轮「设置」→「数据」页 →「导出全部数据」→ 得到 zip（含附件）。

> ⚠️ **星标和标签存在下载备份的那台浏览器里**（本机偏好，随备份文件一起走）。
> 所以你平时在哪儿加的星标，就得用哪台浏览器下载备份——换台电脑下载，
> 备份里就没有星标/标签，搬过去是光秃秃的站点列表。

### 4.2 导入新 VPS

1. 浏览器打开 `https://<your-host>`（此时已指向新 VPS），
   用第 2 步设的账号密码登录，按提示改密码。
2. 「更多选项」→「备份与恢复」→ 切到「**恢复 / 导入**」页 →
   选 4.1 下载的那个文件 →「开始恢复」→ 出差异预览 → 确认导入。
   - 预览默认是**增量合并**：认得出是同一条的按新旧更新，认不出的新建，本地多出来的不动；
   - 想「整站还原成备份那一刻的样子」才开「覆盖导入」（会删备份里没有的条目，
     **被删卡片会进回收站**，真删错了能从回收站捞回来）。
3. 「记事本」→ 齿轮「设置」→「数据」页 →「导入」→ 选 4.1 导出的 zip。

### 4.3 搬完验证清单

- [ ] 分组数、卡片数与 CF 站一致（「更多选项」→ 统计里能看站点总数）；
- [ ] 随便开一张**带账号密码**的卡片：密码框点「显示」，明文应与原站一致
      （这一步不过 = 密钥/加密链路有问题，别跳过）；
- [ ] 记事本条数、附件图片都在；
- [ ] 星标、标签在位（用的同一台浏览器下载的话）；
- [ ] 「更多选项」→「网站设置」里站点标题等配置已跟过来。

### 4.4 搬完之后不会自动跟过来的（需要手工重配）

- **WebDAV 自动备份**：备份文件刻意不含网盘账号密码，要去「备份与恢复」里重填
  （地址 / 账号 / 密码或应用密码 / 备份口令），填完点「测试连接并保存」。
- **AI 设置**（如用过）：凭据同样不进备份，在「AI 设置」里重填。
- **搜索历史 / 访问统计**：本机数据，不随账号走（开了偏好同步的那份在服务端，会随配置过来）。

---

## 5. 出问题时先看哪儿

| 现象 | 先查 |
| --- | --- |
| 部署后起不来 | `docker logs navihive`——缺 AUTH_SECRET 会在启动自检里直接喊 |
| 网站 502 | 容器是否 healthy；kPanel 反代目标是否是 `127.0.0.1:8787` |
| 登录后 401 / 一直要求登录 | AUTH_SECRET 中途换过（所有令牌失效）——别换，换了就得全员重登 |
| 导入提示「校验失败」 | 备份文件被改过一个字节（比如用编辑器打开又保存）——重新下载一份 |
| 导入的卡片密码是乱的 | 导出时「备份含站点账号密码」开关是关的——重导 |

完整手册：`deploy/selfhost.md`（环境变量全表、systemd 方案、备份命令、nginx 参考配置）。

---

## 附录：kPanel 粘贴内容

就是 `deploy/kpanel-compose.yaml` 那份文件。要点回顾：`image` 用
`ghcr.io/zwjttztt/navihive:latest`（或本地构建的 `navihive:latest`）、端口
`127.0.0.1:8787:8787`、`NAVIHIVE_HOST=0.0.0.0`、命名卷 `navihive-data`、
日志轮转 10m×3、`AUTH_SECRET` 与 `AUTH_PASSWORD` 部署前改掉。
