# VPS 反向代理加速方案（方案 A）

日期：2026-10-14
适用：站点仍部署在 Cloudflare（Workers + D1），**不改动任何业务代码**，
只在前面加一台 VPS 做反向代理，把「国内家宽 → Cloudflare 边缘」这段最烂的跨境链路，
换成「国内家宽 → VPS（优化线路）」+「VPS 机房 → Cloudflare（优质出口）」两段。

---

## 一、它解决什么、不解决什么

### 现状与改造后的分段对比（实测 + 估算）

| 阶段 | 现在（直连 CF） | 反代后 |
|---|---|---|
| 客户端 → 第一跳 | 家宽 → **CF 欧洲节点**（`CF-RAY` 尾缀 `MAN`/`MAD`）≈ **300ms** | 家宽 → 东京/香港 VPS ≈ **50–90ms** |
| 第一跳 → CF 边缘 | —（已经是了） | VPS 机房 → CF 日本边缘 ≈ **2–10ms** + TLS 握手 |
| CF 边缘 → Worker → D1 | Worker 在边缘执行，D1 同区 ≈ 10–50ms | 不变 ≈ 10–50ms |
| **TTFB** | **0.92–2.22s**（实测） | 估算 **100–180ms** |
| 243KB 主 JS 下载 | 4.58s（**53 KB/s**） | 0.3–0.8s |
| **首屏可用** | ~4.5s | 估算 **~1s** |

⚠️ 上表右侧为**估算值**，实际取决于你到 VPS 的线路质量，务必先用 `ping` / `curl -w` 实测再决定。

### 解决

- ✅ 「家宽 → CF 边缘」这段跨境路由绕路 + 带宽被掐（53 KB/s 是致命伤）
- ✅ 节点调度错误（你被 BGP 送去了欧洲，这个问题用户端几乎无法自行修正）
- ✅ 不需要改一行业务代码，不需要迁数据

### 不解决

- ❌ **Worker → D1 的往返**：反代反而多了一跳。但这段本来就只有 10–50ms，影响不大
- ❌ VPS 成为新的单点（见第八节）
- ❌ 登录限速粒度退化（见第四节坑 3）

---

## 二、三种拓扑变体

| 变体 | 做法 | 适用场景 |
|---|---|---|
| **A1 全站反代**（推荐） | 所有请求（静态 + API）都经 VPS 代理回源 | 想要最大收益 |
| **A2 只反代静态** | `/assets/*` 走 VPS 并缓存，`/api/*` 直连 CF | 风险最低，但 API 仍然慢 |
| **A3 反代 + 本地缓存** | A1 的基础上，VPS 上开 `proxy_cache` 缓存静态资源 | 绝大多数人的实际选择 |

实际落地建议直接上 **A3**：A1 的配置加上几行缓存而已，但能省掉大量回源往返。

---

## 三、完整 Nginx 配置（可直接用）

### 3.1 公共代理片段

`/etc/nginx/snippets/navi-proxy.conf`：

```nginx
# ⚠️ 回源地址必须是 workers.dev，不能是自定义域名（原因见第四节坑 1）
set $origin_host "cloudflare-navihive1.<你的子域>.workers.dev";
# 用变量 + resolver，让 Nginx 定期重新解析（直接写主机名只在启动时解析一次）
resolver 1.1.1.1 8.8.8.8 valid=300s ipv6=off;

proxy_pass https://$origin_host$request_uri;
proxy_ssl_server_name on;          # 用变量时不会自动带 SNI，必须显式开
proxy_ssl_protocols TLSv1.2 TLSv1.3;

# ⚠️ Host 必须是源站域名，不能写 $host
proxy_set_header Host              $origin_host;
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Accept-Encoding   "";   # 让源站返回明文，由本机统一压缩

proxy_redirect off;
proxy_http_version 1.1;
proxy_set_header Connection "";          # 配合 upstream keepalive
```

### 3.2 站点配置

```nginx
proxy_cache_path /var/cache/nginx/navi levels=1:2 keys_zone=navi_cache:32m
                 max_size=1g inactive=7d use_temp_path=off;

# 登录限速：源站侧的限速会退化（见第四节坑 3），必须在这一层补回来
limit_req_zone $binary_remote_addr zone=navi_login:10m rate=10r/m;

upstream navi_origin {
    # 占位：真正的地址由 snippet 里的 $origin_host 决定，
    # 这里只为 keepalive 提供一个 upstream 上下文
    server 127.0.0.1:1 backup;
    keepalive 16;
}

server {
    listen 80;
    server_name <cf-host>;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;                       # Nginx ≥ 1.25.1；老版本写 listen 443 ssl http2
    server_name <cf-host>;

    ssl_certificate     /etc/letsencrypt/live/<cf-host>/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/<cf-host>/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;        # 省掉 0-RTT 的重放风险

    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/css application/javascript application/json application/manifest+json image/svg+xml;
    # 有 ngx_brotli 模块就再加 brotli，JS 能再小 15–20%

    client_max_body_size 30m;       # 附件单文件上限 25MB（worker/attachments.ts:35）

    add_header X-Cache-Status $upstream_cache_status;

    # ---- 静态资源：缓存 30 天，几乎不再回源 ----
    location /assets/ {
        include snippets/navi-proxy.conf;
        proxy_cache navi_cache;
        proxy_cache_valid 200 206 30d;
        proxy_cache_lock on;        # 同一资源并发回源只放一个过去
        proxy_ignore_headers Cache-Control Expires;   # 源站已是 immutable
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    # ---- 登录：单独限流 ----
    location = /api/login {
        limit_req zone=navi_login burst=5 nodelay;
        include snippets/navi-proxy.conf;
        proxy_no_cache 1;
        proxy_cache off;
    }

    # ---- WebDAV：上传可能很长（代码里 uploadTimeoutMs 封顶 10 分钟）----
    location /api/webdav/ {
        include snippets/navi-proxy.conf;
        proxy_cache off;
        proxy_request_buffering off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }

    # ---- 其余 API：不缓存、不缓冲 ----
    location /api/ {
        include snippets/navi-proxy.conf;
        proxy_cache off;
        proxy_buffering off;         # ⚠️ 导入进度是 NDJSON 流式响应（见坑 4）
        proxy_request_buffering off; # 25MB 附件别先在 VPS 落盘再转发
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    # ---- SPA 兜底 ----
    location / {
        include snippets/navi-proxy.conf;
        proxy_cache navi_cache;
        proxy_cache_valid 200 1m;    # 首页 HTML 源站 max-age=60，跟着走
    }
}
```

`worker/errorReport.ts`、`/api/csp-report` 等也会落到 `/api/` 里，无需单独配置。

---

## 四、五个必踩的坑

### 坑 1：回源 Host 写错 = 死循环（最常见）

```
错误：proxy_set_header Host <cf-host>;
```

`<cf-host>` 是 Cloudflare 上绑定的 Worker 自定义域。一旦你把它的 DNS 指向 VPS，
Nginx 带着这个 Host 回源 → 解析回 VPS 自己 → 无限循环 → 502。

**必须用 Worker 自带的 `*.workers.dev` 地址作为源站**（它不依赖你的 DNS）。

### 坑 2：Cloudflare 侧的 DNS 要关掉橙色云

在 Cloudflare DNS 里把 `<cf-host>` 的 A 记录改成 VPS IP，并**点掉代理（变灰云 DNS only）**。
否则 CF 仍然接管解析与代理，你的 A 记录改了也不生效。

Worker 的自定义域路由**保留不动** —— 它不影响，且方便回滚（把 A 记录改回 CF 即可）。

### 坑 3：登录限速会退化成一个桶（本项目特有）

`worker/loginGuard.ts` 的 `clientBucket()` 优先读 `CF-Connecting-IP`。
反代之后，从 Cloudflare 的角度看"客户端"就是你的 VPS，所以：
**所有请求都会落进同一个限速桶（= VPS 的 IP）**，而且 `NAVIHIVE_TRUST_XFF=1` 也救不回来
（因为 `CF-Connecting-IP` 永远有值，优先级更高）。

后果：别人（或你自己的脚本）连续试错密码，会把**你自己也一起锁在外面**。

**对策（必做）**：把限速搬到 Nginx 这一层 —— 它看到的 `$remote_addr` 才是真实客户端 IP。
配置见 3.2 的 `limit_req_zone` + `location = /api/login`。
配合 fail2ban 效果更好。

顺带：审计日志里记的 IP 也会是 VPS 的 IP（`clientIp()` 同样优先取 `CF-Connecting-IP`）。
个人站无所谓，但要知道这件事。

### 坑 4：导入进度是流式响应，别缓冲

`worker/routes/backup.ts:296` 在 `Accept: application/x-ndjson` 时会返回 NDJSON 流，
服务端一边跑一边推进度。**如果 `proxy_buffering on`，进度条会卡住不动直到结束** ——
用户看到的就是"转圈 5 秒然后突然完成"。

→ `/api/` 整体 `proxy_buffering off`。

### 坑 5：大文件与长超时

| 项目 | 值 | 出处 |
|---|---|---|
| 附件单文件 | 25 MB | `worker/attachments.ts:35` |
| 导入文件 | 10 MB | `worker/routes/backup.ts` 的 `isBodyTooLarge` |
| WebDAV 上传超时 | 最长约 10 分钟 | 代码里 `uploadTimeoutMs` 封顶 10min |

`client_max_body_size` 必须 ≥ 30m，否则附件上传**在 Nginx 这层就先挂了**，
前端只会显示一句"上传失败"，很难查。

---

## 五、VPS 选型

| 维度 | 建议 |
|---|---|
| **地区** | 东京（首选，软银 / IIJ / NTT 线路）、中国香港（CN2 GIA 最好但贵）、新加坡（次选） |
| **到 CF 的距离** | 东京 → CF 日本边缘（NRT/KIX）只要 **2–10ms**，这是东京最大的优势 |
| **配置** | 反代几乎不吃 CPU：1C / 512MB–1GB 足够。开 `proxy_cache` 的话内存给到 1–2GB |
| **带宽** | 按流量计费的小站每月用不了多少；注意「月流量上限」比「峰值带宽」更要紧 |
| **Oracle 东京免费机** | 2 OCPU / 12GB / 10TB 月出网，配置绰绰有余。⚠️ 但（a）**有闲置回收条款**，7 天内 CPU/网络/内存三项 95 分位都 <20% 可能被回收，个人站正好符合 → 升级 PAYG（仍 $0）豁免；（b）**两层防火墙**都要放行（VCN 安全列表 + 实例内 iptables，Ubuntu 镜像默认挡所有端口，这是"端口开了却连不上"的经典原因） |

---

## 六、切换步骤与灰度

1. **先验证收益再切**：临时改本机 `hosts` 把域名指向 VPS IP，跑
   `curl -w "TTFB:%{time_starttransfer} Total:%{time_total}"` 对比前后。
   没变快就不要切。
2. 装 Nginx，套用第三节配置（先不切 DNS）。
3. 用 `curl --resolve <cf-host>:443:<VPS_IP>` 验证：登录、CRUD、附件上传、导入进度条、WebDAV。
4. `certbot --nginx` 签证书（80 端口先放行）。
5. 改 DNS：CF 上 A 记录 → VPS IP，**关橙色云**。TTL 建议 300s 便于回滚。
6. 观察 24 小时（`X-Cache-Status` 是否 HIT、`limit_req` 有没有误伤）。
7. **回滚**：把 A 记录改回 CF 并开回橙色云，一分钟生效。这是这个方案最大的优点。

---

## 七、监控

- `nginx -t` 之后 `systemctl reload`（不要 restart，会断连接）
- 探活：`/api/` 任意只读接口 200 即可
- 看 `X-Cache-Status`：`HIT` 说明静态命中缓存，`MISS` 持续出现说明缓存没生效
- 日志里关注 `502`（= 回源失败，多半是 Host 写错或源站域名解析失败）
- fail2ban 盯 `/api/login` 的 401

---

## 八、优缺点与适用判断

**优点**
- 零代码改动、零数据迁移，半天搞定
- 回滚成本极低（改一条 A 记录）
- 收益立竿见影（TTFB 300ms → 100–180ms，下载 53KB/s → MB/s 级）

**缺点**
- **VPS 成为新的单点**：VPS 挂了站点全挂（原来 CF 几乎不会挂）
- API 多走一跳，动态请求比原来略慢一点点（但换来的是带宽和首跳的巨大改善，净收益为正）
- 登录限速需要自己在 Nginx 层补（坑 3）
- 多一个要维护的东西（证书续期、Nginx 升级、安全补丁）

**什么时候不该选它**
- 你到 VPS 的线路本身就不稳 → 先测，别想当然
- 站点可用性比速度重要 → 考虑方案 B（整站自托管）或方案 ②（东京主 + CF 温备）
- 你已经在计划迁到 VPS → 直接上方案 B，别反代绕一圈

---

## 九、与方案 B 的关系

反代（方案 A）和自托管（方案 B）不是二选一，而是**两步**：

```
第一步：方案 A（反代）    —— 半天，零风险，先拿到 80% 的收益
第二步：方案 B（自托管）  —— 1.5 天，彻底去掉 Cloudflare 这一跳
```

方案 A 把"要不要迁"这个决定推迟了，但保留了回滚能力。
如果你做完第一步觉得够快了，**完全可以停在这里**。

方案 B 的落地细节见 `docs/selfhost-plan-2026-10-14.md`；
两站并存（东京主 + CF 温备）的完整对比见 `docs/dual-deploy-arch-2026-10-14.md`。
