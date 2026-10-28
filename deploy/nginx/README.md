# 方案 A 落地手册：VPS 反向代理

把 `<cf-host>` 的访问从「家宽直连 Cloudflare 欧洲节点（~300ms）」
改成「家宽 → 东京 VPS（50–90ms）→ CF 日本边缘（2–10ms）」。
**不改一行业务代码，不迁数据，回滚只需改一条 DNS。**

预计耗时：半天。前置阅读：`docs/vps-reverse-proxy-2026-10-14.md`（原理与收益测算）。

---

## 步骤 0：拿到源站地址（5 分钟，先做这一步）

反向代理需要一个**不会被我们自己的 DNS 影响**的源站地址。

### 主选：Worker 自带的 `*.workers.dev`

1. Cloudflare Dashboard → **Workers and Pages** → 点进 `cloudflare-navihive1`
2. 在概览页找 **Workers.dev** 区块（有些版本叫 "Preview URL"），复制完整地址，
   形如 `https://cloudflare-navihive1.xxxxx.workers.dev`
3. 验证它真的通：

```bash
curl -sI https://cloudflare-navihive1.xxxxx.workers.dev/ | head -3
# 期望：HTTP/2 200（或 200 OK），Server: cloudflare
```

⚠️ 如果返回 `Code: 10021` 或提示 workers.dev 未启用：
到 **Workers and Pages → 你的账户子域** 页面点启用；或者直接走下面的备用方案。

### 备用：给 Worker 加第二个自定义域当源站

如果 workers.dev 不可用，就在 Cloudflare 上再加一个自定义域专门当源站：

1. `cloudflare-navihive1` → **Settings → Domains & Routes → Add → Custom domain**
   填 `<origin-host>`（**保持橙色云开启**）
2. 用它当源站：把配置文件里两处 `<WORKERS_DEV_HOST>` 都换成 `<origin-host>`
3. 这样不会死循环 —— 因为只有 `<cf-host>` 的 DNS 指向 VPS，
   `<origin-host>` 仍然由 Cloudflare 代理

> 为什么不能直接用 `<cf-host>` 当源站：一旦它的 DNS 指向 VPS，
> Nginx 带着这个 Host 回源就会解析回 VPS 自己 → 无限循环 → 502。

---

## 步骤 1：开 VPS

推荐东京（到 CF 日本边缘 2–10ms，这是东京最大的优势），次选中国香港 / 新加坡。
1C / 512MB–1GB 足够（反代几乎不吃 CPU；开 `proxy_cache` 建议给 1–2GB）。

Oracle 东京免费机（2 OCPU / 12GB / 10TB 月出网）配置绰绰有余，但有两条要注意：

- **闲置回收**：7 天内 CPU/网络/内存三项 95 分位都 <20% 可能被回收，个人站正好符合。
  → 开完立刻把账号升级成 **Pay As You Go**（仍在免费额度内，账单 $0），回收策略不再适用。
- **Home region 注册时锁定、永久不可改**；A1 常 "Out of host capacity"，要重试或换 AD。

记下公网 IP，下面用 `<vps-ip>` 代称。

---

## 步骤 2：装 Nginx（Ubuntu 24.04）

```bash
sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx
sudo mkdir -p /etc/nginx/snippets /var/cache/nginx
```

---

## 步骤 3：放行防火墙（Oracle 用户特别注意两层）

**第一层 —— 云控制台**：VCN → Security List → Ingress Rules → 放行 `0.0.0.0/0` 的 TCP 80、443。

**第二层 —— 实例内 iptables**（Oracle 的 Ubuntu 镜像默认挡掉所有端口，
只开安全列表会出现"端口开了却连不上"）：

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80  -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

验证：`curl -sS -o /dev/null -w "%{http_code}\n" http://<vps-ip>/` 应该返回 Nginx 的响应码。

---

## 步骤 4：放配置文件

从本目录拷到 VPS（路径要对应）：

```bash
scp snippets/navi-proxy.conf            root@<vps-ip>:/etc/nginx/snippets/
scp sites-available/navihive.conf       root@<vps-ip>:/etc/nginx/sites-available/
```

然后在 VPS 上把 `<WORKERS_DEV_HOST>` 替换成步骤 0 拿到的地址（**两处都要改**）：

```bash
sudo sed -i 's|<WORKERS_DEV_HOST>|cloudflare-navihive1.xxxxx.workers.dev|g' \
    /etc/nginx/snippets/navi-proxy.conf \
    /etc/nginx/sites-available/navihive.conf
```

---

## 步骤 5：先上最小配置，切 DNS 之前验证一遍

证书还不存在，完整配置过不了 `nginx -t`。先启用 bootstrap 段：

```bash
# 把 sites-available/navihive.conf 里 bootstrap 那一整段 server 块的注释去掉
sudo ln -s /etc/nginx/sites-available/navihive.conf /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

**在不动 DNS 的前提下验证反代通路**（这一步能提前发现源站地址写错）：

```bash
curl -sI --resolve <cf-host>:80:<vps-ip> http://<cf-host>/
# 期望：200 OK（不是 502）
# 502 = 源站地址写错 / 防火墙没开 / Host 死循环，先别切 DNS
```

---

## 步骤 6：切 DNS 并签证书

1. Cloudflare DNS：`<cf-host>` 的 A 记录改成 `<vps-ip>`，**点掉橙色云（DNS only）**。
   - Cloudflare 上 Worker 的自定义域路由**保留不动** —— 它不影响，且方便回滚。
   - TTL 建议 300s。
2. 等解析生效：`dig +short <cf-host>` 应该返回 `<vps-ip>`。
3. 签证书：

```bash
sudo certbot --nginx -d <cf-host>
```

certbot 会自动改写配置加上 443。

---

## 步骤 7：启用完整配置

1. 删掉 bootstrap 那个 `server { listen 80; ... location / { include ... } }` 块
   （改回只保留 `/.well-known/acme-challenge/` + 301 到 https）
2. 注释掉 bootstrap 段后：

```bash
sudo nginx -t && sudo systemctl reload nginx
```

3. 补一个每天 reload 的 timer —— upstream 里的主机名只在启动时解析一次，
   每天 reload 一次可以自动跟上 IP 变化：

```bash
sudo systemctl enable --now nginx-reload.timer 2>/dev/null || {
  sudo tee /etc/systemd/system/nginx-reload.timer >/dev/null <<'EOF'
[Unit]
Description=Reload nginx daily to refresh upstream DNS
[Timer]
OnCalendar=daily
Persistent=true
[Install]
WantedBy=timers.target
EOF
  sudo tee /etc/systemd/system/nginx-reload.service >/dev/null <<'EOF'
[Unit]
Description=Reload nginx
[Service]
Type=oneshot
ExecStart=/usr/bin/systemctl reload nginx
EOF
  sudo systemctl enable --now nginx-reload.timer
}
```

---

## 步骤 8：验证清单（逐条过）

| # | 检查项 | 期望 / 命令 |
|---|---|---|
| 1 | 首页能打开 | 浏览器访问，`CF-Cache-Status` 头消失（不再经 CF 代理） |
| 2 | **登录 cookie 两条都下发** | `curl -sI` 登录接口，应看到**两行** `set-cookie`（`navihive_token` + `navihive_session`）。只有一行 = `proxy_pass` 或头处理有问题，会导致「登录 200 但立刻掉线」 |
| 3 | 登录后刷新不掉线 | 浏览器刷新几次 |
| 4 | 站点增删改 | 新增 / 编辑 / 删除一个站点 |
| 5 | 笔记保存 | 编辑一段笔记并保存 |
| 6 | 附件上传 | 传一张图（≤25MB） |
| 7 | **导入进度条在动** | 导入一个备份，进度条应逐格推进；如果卡住不动直到结束 = `proxy_buffering off` 没生效 |
| 8 | WebDAV 备份 | 手动跑一次备份 |
| 9 | 静态缓存命中 | 第二次请求 `/assets/*.js`，响应头 `X-Cache-Status: HIT` |
| 10 | 限速生效 | 连输 5 次错密码，应被 Nginx 挡（503 或慢响应），而不是把源站桶锁死 |

第 2、4、7 三条最容易出问题，**一定要测**。
其中第 4 条如果报 `API错误: 403`，是 CSRF 同源校验被 Host 改写误伤 ——
Worker 侧 2026-10-14 已改成按 `Sec-Fetch-Site` 判定（不再看 Host），
推一次 GitHub 就好；详见下面「坑速查」的专节。

---

## 步骤 9：观察与回滚

**观察 24 小时**：`X-Cache-Status` 是否稳定 HIT、错误日志有没有 502、
`limit_req` 有没有误伤自己。

**回滚（1 分钟）**：把 A 记录改回原来的值并**开回橙色云**。
这是方案 A 最大的优点 —— 数据一直在 Cloudflare 上，随时能回去。

---

## 坑速查

| 现象 | 原因 |
|---|---|
| 502 Bad Gateway | 源站地址写错；**Host 写成了自定义域名（死循环）**；防火墙没开 |
| **页面能打开，一保存就弹「API错误: 403」** | **回源 Host 改写成 `*.workers.dev` 后，Worker 的同源校验误判跨站**（Worker 侧已自适应，见下方专节） |
| 登录 200 但立刻掉线 | Set-Cookie 被合并成一条（检查是否被上游/CDN 二次代理） |
| 导入进度条卡住 | `/api/` 缺 `proxy_buffering off` |
| 附件上传失败 | `client_max_body_size` 小于 30m |
| 输错几次密码后自己也登不上 | 源站侧限速退化成一个桶 —— **必须在 Nginx 层配 `limit_req`**（见 sites 配置） |
| 静态资源每次都 MISS | `proxy_cache_path` 目录没建，或 `/assets/` 没 include 缓存指令 |
| 站点偶尔 502，过一会又好了 | upstream 只在启动时解析，IP 变了 —— 配每日 reload timer |
| `/api/*` 的 JSON 没被压缩 | `gzip_types` 里漏了 `application/json`（nginx 默认**只**压 `text/html`）。**不是** `gzip_proxied` 的问题，见下节 |

### 两份站点配置的 gzip 差异：`gzip_proxied any` 只有自托管那份有

`navihive.conf`（方案 A）**刻意不写** `gzip_proxied any`，`navihive-selfhost.conf`（方案 B）写了。
这不是遗漏，别「顺手补齐」。两个方向的误判都在这条链上不成立：

1. **「上游已经被 Cloudflare 压好了，再加一层是白烧 CPU」—— 反了。**
   `snippets/navi-proxy.conf` 里有 `proxy_set_header Accept-Encoding ""`：本机回源时
   **明确不要压缩**，CF 回的是 identity。也就是说压缩责任 100% 在本机这一层，
   方案 A 的 `gzip on` + `gzip_types` 是**真在干活**的，不是冗余。
2. **「不写 `gzip_proxied any` 就压不到反代响应」—— 也不对。**
   nginx 文档原文：*"The fact that the request is proxied is determined by the presence of
   the 'Via' request header field."* 这个指令只对**带 `Via` 请求头**的请求生效。
   浏览器 → CF 边缘 → 本机这条链上没有一跳会加 `Via`，所以那一行在这里不改变任何行为。
   （方案 B 那份留着它，护的是「VPS 前面再套一层代理」的情形 —— 那层通常会加 `Via`。）
3. **真正让 API 的 JSON 被压的是 `gzip_types` 里的 `application/json`**
   （nginx 默认只压 `text/html`，列得再全也压不到 JSON 的老说法就是这么来的）。
   两份配置都列了它 —— 改压缩相关的东西，先看那一行。

> 2026-10-28 复核：`docs/engineering-review-2026-10-28.md` 里「自托管 API 响应从未压缩，
> 因为全仓 `gzip_proxied` 0 次」这条归因是错的（批次一之前自托管那份配置就有
> `gzip on` + `gzip_types … application/json`，见 `git show b8bfd22` 的 diff：
> 唯一的功能性新增就是 `gzip_proxied any` 这一行）。
> 线上也验了：生产实际加载的 `nginx.conf`（kPanel 管的那份，**不是**本目录这两份模板）
> 没有 `gzip_proxied`，但 `gzip_types` 里早有 `application/json`，`/assets/react-*.js`
> 的响应带 `content-encoding: gzip` —— 反代这一层一直在压，批次一那行既没修什么也没进生产。
> 要验压缩有没有生效，别看指令清单，看响应：
> `curl -sI -H 'Accept-Encoding: gzip' https://<host>/api/init | grep -i content-encoding`。


### 「API错误: 403」专节：写操作全被 CSRF 拦下

**现象**：首页 / 列表 / 详情都能正常打开，但一切**写操作**——
保存卡片、增删改、改设置——全部失败，提示 `API错误: 403`（没有后半句人话）。

**根因**：`worker/httpUtils.ts` 的 `isSameOrigin()` 原先拿 `Origin` 头的 host 和
`request.url` 的 host 相比。而本方案为了防回源死循环，必须把 `Host` 改写成
`*.workers.dev`（见文件头硬性要求第 3 条）。于是：

- 浏览器发来 `Origin: https://<你的域名>`
- Worker 看到 `request.url = https://<WORKERS_DEV_HOST>/...`

两者不相等 → `middleware.ts` 判跨站并拒绝。前端 `parseApiError()` 只认 JSON，
解析不出 message，就只剩光秃秃的 `API错误: 403`。
读请求（GET/HEAD）不走这个分支，所以「能看不能写」。

**修复已落在 Worker 侧（2026-10-14，推 GitHub 即生效）**：`isSameOrigin()`
改成 **`Sec-Fetch-Site` 优先**。那是浏览器按「发起页面 vs 目标」自己算的禁伪造头，
**与中间经过几层反代、回源 Host 被改成什么都无关** —— 它回答的就是
「浏览器眼里这次请求是不是同源发的」。所以只要浏览器是 Chrome 76+/Firefox 90+/
Safari 16.4+（现在几乎没有更老的），**不需要在 nginx 里做任何事**，
回源 Host 该改写照改。安全性不降：跨站请求的 `Sec-Fetch-Site` 是 `cross-site`，
照样拦；`same-site`（子域名）也照样拦。

同时这次拒绝从纯文本改成了结构化 JSON，万一日后还有 403，
用户看到的会是「跨站请求已被拒绝：…」而不是一句没法排查的 `API错误: 403`。

**nginx 侧那行现在变成可选**（双保险，留着无害）：在
`snippets/navi-proxy.conf` 里加一行，回源时不转发 `Origin` 头：

```nginx
proxy_set_header Origin "";
```

（nginx 规则：`proxy_set_header` 的值是空字符串 = 不发送该头。）
Worker 会因此直接走 `Sec-Fetch-Site` 判据：同站 fetch 是 `same-origin` 放行，
跨站伪造是 `cross-site` 照样拦，防护不减弱。改完 `nginx -t && systemctl reload nginx`。

**备选做法**（想保留 Worker 的 `Origin` 判据）：用 `map` 只把「自己域名」的 Origin
改写成源站主机名，其它一律置空丢弃。`map` 要写在 `http` 块（如
`/etc/nginx/conf.d/navi-origin-map.conf`）：

```nginx
map $http_origin $navi_origin {
    default                            "";
    "https://<你的域名>"               "https://<WORKERS_DEV_HOST>";
}
```

再把片段里的 `proxy_set_header Origin "";` 换成 `proxy_set_header Origin $navi_origin;`。

**自检**：`curl -s -X POST https://<你的域名>/api/sites -H "Cookie: navihive_token=x"`
应返回 401「请先登录」而不是 403；登录后在浏览器里保存一张卡片，应成功。
如果仍然 403，看响应正文：写着「跨站请求已被拒绝」= 走到 CSRF 分支；
是 CF 拦截页 HTML = Cloudflare 层；是 JSON = 应用层，按 message 处理。


---

## 关于审计日志里的 IP

反代之后，从 Cloudflare 的角度看"客户端"就是你的 VPS，所以：

- 登录限速会退化成一个桶（**必须**在 Nginx 层补限速 —— 配置里已经配了）
- 审计日志记的 IP 会变成 VPS 的 IP（`clientIp()` 优先读 `CF-Connecting-IP`）

个人站无所谓，但要知道这件事。想保留真实 IP 只能走方案 B（整站自托管）。
