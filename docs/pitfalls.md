# 踩过的坑（改这个项目前先读一遍）

每条都是**线上真出过事**的，不是理论风险。按「症状 → 根因 → 现在怎么防」写，
能配守卫的都配了（单测/静态检查），配不上的写明原因。

> 新增条目时：先写清「当时看到什么」，再写根因。只写「不要 X」的条目过半年就没人看得懂了。

---

## 运行时 / 双端

### 1. `routes/data.ts`：`startsWith("X/")` 前缀分支必须排在 `X/{id}` 之后
`parseInt("abc")` 不报错、返回 `NaN`，于是 `/api/notes/abc` 这种请求会**静默走错分支**，
表现是接口返回 200 但内容不是你要的。守卫：`tests/attachmentRoutes` 等用例按路径形状逐一钉。

### 2. Workers `env.ASSETS.fetch()` 返回的 Response headers 是 immutable
直接 `headers.set(...)` 抛 `Can't modify immutable headers.`，整站 500。
修法是**重建可变副本** `new Response(res.body, res)` 再改头（`worker/httpUtils.ts`）。
⚠️ 教训：**mock 必须模拟真机运行时语义**，不是「恰好能编译的最小桩」——
用可变 Response 当桩时所有门禁全绿，真机全炸。

### 3. D1 `batch()` 按「会不会返回行」派发
判据是 `/^\s*(select|with|values)\b/i`。只认 `RETURNING` 会漏掉 SELECT 行 → 首页空白。
`server/` 的 SQLite 桩要按同样规则回数组。

### 4. undici：`new Request(request, {body:null})` 抛 already used
要复制请求就用 `new Request(url)`。SPA fallback 只对**无扩展名**的路径生效。

### 5. 迁移加列必须同步升 `SCHEMA_VERSION`
漏了就是「新代码读旧库」，症状随机。

---

## 前端 / 构建

### 6. 弹窗/菜单的懒加载 `fallback` 禁 `null`
必须是能显示的组件。`fallback={null}` 时首屏预取失败的观感是「点了没反应」。
三层预取（悬停/菜单 mount/登录后 idle）入口集中在 `src/utils/dialogChunks.ts`，
与 `lazy()` 同 chunk；`tests/lazyPrefetch.dom.test.tsx` 守着。

### 7. rolldown 回调期 `importers` 混动态边，「沿图上溯判首屏」必然误判
manualChunks 回调里拿到的模块图还没定型。判首屏要用**配置期的源码扫描**
（`vite.config.ts` 的 `scanFirstScreenMui()`），从 `main.tsx` 只沿静态 import 走闭包。
把首屏组件误判进懒加载的后果是入口 chunk 白背一大截。

### 8. 版本号必须同源
`__NAVIHIVE_BUILD_VERSION__`（烘进产物）与 `precache-manifest.json` 的 `version`
必须是**同一个常量**。各取一次 `Date.now()` 会让页面每次加载都判定自己过期 → 无限重载。

### 9. 焦点环：别用 `el.focus()` 量，它不触发 `:focus-visible`
2026-10-20 据此得出「chip 没有焦点环」的**错误结论**，还差点加一个无效补丁。
真判断要用 CDP 发真 Tab 键（`script/a11y-audit.mjs` 第 4 节）。
同理：**任何 `:focus-visible` / `:hover` 相关的样式判断都不能用程序化 focus 量。**

### 10. jsdom 里 `window` 与 `globalThis` 不是同一个对象
代码读裸 `caches` 而桩装在 `window` 上 → 逻辑没跑也不报错，断言语无伦次地空着。
**两处都装**（真实浏览器里二者是同一个对象，语义不变）。

### 11. esbuild 会把**常量路径**的动态 import 提前到 bundle 顶层
想「先装桩再 import」必须把路径写成变量，否则 import 在桩装好之前就执行了。
（最终结论：入口文件别放需要单测的逻辑，抽成模块——见 `utils/staleRecovery.ts`。）

---

## 部署 / Docker

### 12. 网页一键升级：三种做法都不对，只有一种对
| 做法 | 结局 |
|------|------|
| 容器内自己 `stop → rm → create → start` | `stop` 一发出去本进程立刻死，后续步骤一行不执行（容器停在 Exited(0)，站点 502） |
| `POST /containers/{id}/restart` | 按**创建时记录的 ImageID** 启动，不重新解析 `:latest` → 镜像拉到了、也重启了，跑的仍是旧代码 |
| helper 把 compose 目录挂在**容器内的 `/compose`** | compose 把自己运行时的工作目录写进新容器的 `com.docker.compose.project.working_dir` 标签（下一轮读坐标的唯一来源）→ 第一次成功、**第二次必失败** |

✅ 正确做法：拉完镜像起一次性 helper 容器，挂 **sock + 宿主原路径 compose 目录 + 宿主 docker CLI + cli-plugins**，
由它在容器外跑 `docker compose up -d --force-recreate`。源和目标写成**同一个宿主路径**，
容器内外看到同一个目录，标签就不会被写歪。

### 13. 回归验证「升级」必须连跑两次
12 的第三种失败模式的特征就是第一次成功。只验一次等于没验。
驱动进程要放在**独立容器**里（`Claw/vps-upgrade-twice-regression.py`）——
放在主容器里的话，主容器一被重建驱动进程跟着死，拿不到 wait/logs。

### 14. `docker.sock` 挂载 = 容器内 root 可控宿主机 Docker
这是网页一键升级的前提，等价于把宿主机 Docker 控制权交给容器（可起特权容器、读任意卷）。
现有缓解：端口只绑 `127.0.0.1`、端点 owner-only。要更严就上 `docker-socket-proxy`
（只放行必要端点，禁 `/exec`）。

### 15. CHANGELOG 日期守卫用**本地时区**
`tests/changelogFreshness.test.ts` 比的是 `git log -1 --format=%cs`（本地时区）。
UTC 还在当天、本地已过零点时，段标题必须写**本地当天**，写 UTC 那天会红。
**晚间推送前先看一眼本地 `date`。**

### 16. 推送走 REST 时，本地 ref 不会自动更新
github.com:443 被墙，走 API 推 commit 后必须补跑
`python Claw/rebuild-refs.py <sha>` + `git reset <sha>`，否则本地 HEAD 落后。
跳版规则：≤5 文件 ≤200 行 patch；≤20 文件 ≤1200 行 minor；超出 major。

---

## 测试 / CI

### 17. 静态守卫必须**反向验证一次**
写「不得出现 X」的断言后，故意把 X 加回去跑一次，确认它真的会红。
2026-10-20 有两条就是这么发现是摆设的（焦点环判据覆盖不到 Chip；
`upgradeStatus` 作用域那条如果没反向验证，也发现不了它确实能抓住旧版）。

### 18. 「只打印不判据」往往是测量方法错了，不是页面没问题
见第 9 条。发现某项长期「假红」时，先怀疑量法。

### 19. 改动必须配用例
v2.0.0 的登录设备去重当时没写单测，回归时无声无息。
凡是「平时不出现、出事就要命」的逻辑（版本漂移自愈、崩溃兜底、升级链路），
都必须有能在 CI 里跑的用例。

### 20. CI 上 ubuntu + small-icu：中文 `Intl` 用例禁、绝对路径用例 skip
`tests/` 在 build 之前跑，`bundleBudget` 之类 skip 是正常的。
