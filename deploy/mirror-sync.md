# 单向镜像同步（主站 → 只读备站）

配套脚本：`script/sync-mirror.mjs`（`npm run sync:mirror`）
架构背景与选型对比：`docs/dual-deploy-arch-2026-10-14.md`（本文落地的是那篇里的方案 ②）

---

## 一、它做什么

把**源站**（可写、日常在用）的导航数据与笔记，**覆盖式**搬到**镜像站**（只读），
定时跑一次。镜像站保持一份近乎实时的全量副本，源站出事时切过去就能用。

```
源站（可写）  ──定时全量覆盖──▶  镜像站（只读 / 维护模式）
  VPS 自托管                      Cloudflare Workers + D1
```

**为什么是单向、为什么必须只读**：`sites` / `groups` 只有自增整数 id、没有 uuid，
`/api/sites/changes` 只回「删了哪些」—— 那套变更流是给**客户端跨设备轮询**用的，
不是 server-to-server 的复制流。做双活要加 uuid 列 + 回填 + 冲突策略，等于重写一个
同步引擎。单向覆盖则**零冲突**，代价只有一个：镜像站不能有人写。

> ⚠️ 镜像站一旦可写，那里的写入会在下一次同步被**静默覆盖、无任何提示**。
> 这是本方案唯一会真的丢数据的情形，所以脚本把「镜像站是否只读」当成硬闸门。

---

## 二、前置条件（缺一条脚本会以退出码 2 拒绝开工）

| # | 条件 | 怎么确认 |
|---|---|---|
| 1 | 两端都能用**所有者（owner）**账号登录 | 脚本要用 owner 登录镜像站 —— 维护模式对 owner 豁免，否则自己也写不进去 |
| 2 | 镜像站开了维护模式 | `curl -s https://镜像站/api/init` 返回里 `"maintenance": true` |
| 3 | 镜像站的部署里有 `/api/import` 与 `/api/notes/import` | 这两个是老接口，正常部署都有；换过部署方式就先探一下 |
| 4 | 源站的部署里有 `/api/notes/export`（2026-10-15 新增） | 源站重新构建一次镜像才带这条 |
| 5 | 两端时钟不要差太远 | 笔记是按 `updated_at` 合并的，时钟差会让「较新」判断失真 |

**开维护模式**（在镜像站上做一次即可，之后一直开着）：

```bash
# 用所有者账号登录拿到 cookie 后
curl -X PUT 'https://<镜像站>/api/configs/maintenance.enabled' \
     -H 'Content-Type: application/json' \
     -H 'Sec-Fetch-Site: same-origin' \
     -H 'Cookie: navihive_token=<...>; navihive_session=1' \
     -d '{"value":"1"}'
```

也可以直接用所有者账号在镜像站的「设置」里打开维护模式。开完之后：
读操作照常（能看数据）、写操作对非所有者返回 503、前端挂维护横幅。

---

## 三、配置

凭据走环境变量，**不要**写成命令行参数（`ps` 和 shell history 都看得见）。

```bash
# /etc/navihive-mirror.env（chmod 600）
MIRROR_SRC_URL=https://home.example.com      # 源站：日常在用的那个
MIRROR_SRC_USER=zwj
MIRROR_SRC_PASS='...'

MIRROR_DST_URL=https://xxx.workers.dev       # 镜像站：只读备站
MIRROR_DST_USER=zwj
MIRROR_DST_PASS='...'

MIRROR_STATE_FILE=/var/lib/navihive/mirror-sync-state.json   # 可选，默认 ./mirror-sync-state.json
```

| 选项 | 作用 |
|---|---|
| `--dry-run` | 只导出与统计，**不往镜像站写一个字节**。第一次务必先跑这个 |
| `--skip-notes` | 只搬导航数据，跳过笔记通道 |
| `--with-credentials` | 连站点保存的登录凭据一起搬（见下） |
| `--allow-writable` | 镜像站没开维护模式也继续。**只在确认没人写镜像站时用** |
| `--quiet` | 只输出结论行 |

**关于 `--with-credentials`**：`/api/export` 默认把站点账号密码抹掉（明文备份会被同步到网盘）。
加这个开关后，脚本会临时把源站的 `backup.includeCredentials` 置为 `true`、导出后**立刻还原**。
不加的话，镜像站上的站点会缺密码（站点本身照常在）。

---

## 四、跑起来

### 第一次：先试跑

```bash
set -a; . /etc/navihive-mirror.env; set +a
npm run sync:mirror -- --dry-run
```

看输出里的分组 / 站点 / 笔记条数对不对。确认无误再去掉 `--dry-run`。

### 定时：systemd timer（推荐）

```ini
# /etc/systemd/system/navihive-mirror.service
[Unit]
Description=NaviHive mirror sync
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=/home/docker/navihive-src
EnvironmentFile=/etc/navihive-mirror.env
ExecStart=/usr/bin/node script/sync-mirror.mjs
User=root
```

```ini
# /etc/systemd/system/navihive-mirror.timer
[Unit]
Description=Run NaviHive mirror sync every 30 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=30min
Persistent=true
Unit=navihive-mirror.service

[Install]
WantedBy=timers.target
```

```bash
systemctl daemon-reload
systemctl enable --now navihive-mirror.timer
systemctl list-timers navihive-mirror
```

或者 crontab（更简单，但失败不好告警）：

```
*/30 * * * * set -a; . /etc/navihive-mirror.env; set +a; cd /home/docker/navihive-src && node script/sync-mirror.mjs >> /var/log/navihive-mirror.log 2>&1
```

**同步间隔就是数据丢失窗口**：源站挂掉时，最多丢这一段时间内的改动。
30 分钟对个人站足够；`/api/export` 有频率限速（按账号 + IP 分桶），低于 15 分钟可能被拦。

---

## 五、监控与告警

脚本的退出码是给定时任务看的：

| 退出码 | 含义 | 怎么办 |
|---|---|---|
| 0 | 成功 | — |
| 1 | 同步或对账失败 | 看日志；重跑即可（导出/导入都是幂等的） |
| 2 | 前置条件不满足 | 配置缺失，或镜像站没开维护模式 —— **不要**用 `--allow-writable` 绕过，先去开维护模式 |

两条监控建议：

1. **同步必须告警**：失败后脚本不会自己重试写操作，静默停掉你可能几周后才发现。
   systemd 用 `OnFailure=`，crontab 就在命令后面接 `|| curl 你的告警地址`。
2. **看状态文件的新鲜度**（比看退出码更可靠 —— 定时任务整体没跑也能发现）：

```bash
# 超过 90 分钟没更新就告警
find /var/lib/navihive/mirror-sync-state.json -mmin +90 | grep -q . && echo "镜像同步停滞"
```

---

## 六、已知缺口（刻意不做，别当成 bug）

1. **附件不同步。** 笔记图片存在各自的存储里（Cloudflare 是 KV、自托管是目录），
   上传接口由服务端发 uuid，没有「按原 id 幂等写入」的口子 —— 强行搬会把笔记正文里的
   图片引用指到不存在的 id 上。当前两端都还没有附件；有了之后单独设计通道三
   （内容不可变，按 `attach/<user_id>/<uuid>` 单向 sync 即可）。
2. **站点 id 会重发号。** `/api/import` 一律由数据库重新分配 id（避免撞主键），
   所以**镜像站上**按站点 id 存的本机数据（星标 / 标签）每轮同步后都要重新对应。
   导航数据本身不受影响。
3. **回收站 / 审计日志 / 分享链接不在同步范围内。** 它们是「这一站自己的运维数据」，
   不是站点内容。分享链接切过去后需要重建。
4. **笔记是 merge 不是覆盖。** 导入按 `uuid` + `updated_at` 合并，所以镜像站上
   有而源站没有的笔记不会被删。脚本在镜像站笔记更多时会打警告 —— 那通常意味着
   有人在镜像站写过东西。

---

## 七、切到镜像站

1. 停掉定时任务（否则它会继续把源站的旧数据往镜像站盖）。
2. 手动跑一次同步，确认对账通过。
3. 在镜像站**关掉**维护模式，它才变成可写的主站。
4. 域名指向镜像站。
5. 源站恢复后，如果要反向搬回来：把两端的环境变量对调，并在**新的镜像站**
   （原源站）上开维护模式，再跑一次。

---

## 八、验证清单（首次上线逐条过一遍）

- [ ] `npm run sync:mirror -- --dry-run` 输出的条数与源站页面一致
- [ ] 去掉 `--dry-run` 后退出码 0，日志里「对账通过」
- [ ] 镜像站页面能看到全部分组 / 站点 / 笔记
- [ ] 在镜像站上用**非所有者**账号试着改一条 → 应该被 503 拦下
- [ ] 用所有者账号在镜像站改一条，然后跑一次同步 → 该改动被覆盖（这是预期行为，用来确认覆盖真的生效）
- [ ] 定时任务跑过一轮后，状态文件的 mtime 是新的
- [ ] 故意把 `MIRROR_DST_URL` 改错 → 退出码非 0 且日志有人话原因
