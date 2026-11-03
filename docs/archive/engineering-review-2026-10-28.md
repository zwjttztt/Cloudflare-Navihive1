# NaviHive 工程健康度复审报告

| 项        | 值                                                                                                     |
| -------- | ----------------------------------------------------------------------------------------------------- |
| 复审日期     | 2026-10-28                                                                                            |
| 复审对象     | `2fb8c0c` / v16.5.0（main）                                                                             |
| 复审方式     | **不依赖任何过往结论**，从零重读代码 + 实测。四个独立维度并行审查，关键结论由主理人二次复核对源码                                                  |
| 覆盖范围     | 性能与资源占用、可维护性与代码质量、可测试性、兼容性与可扩展性、依赖与版本管理、数据处理与存储、日志与监控、可访问性、文档完整性、部署与运维、异常与容错处理                        |
| 明确排除     | 视觉呈现、功能完整性、架构分层、安全性（认证/加密/鉴权）、运行建议 —— 这五项此前已审过，本报告不复述                                                 |
| 代码规模（实测） | `src/` 84,924 行 / 338 文件；`worker/` 9,982 / 36；`server/` 2,202 / 6；`tests/` 71,063 / 327 文件 / 3,243 用例 |

> **先纠正一个流传的数字**：`src/` 不是 4.4 万行而是 **8.5 万行**（早先的 `find -name '*.ts' -o -name '*.tsx' -exec cat` 写法里 `-exec` 只作用于后一个分支，`.ts` 文件没被计入）。测试与源码的行数比也因此是 **0.84:1**，而不是 0.69:1。本文所有比例都以实测值为基数。

---

## 0. 结论先行

**这个项目的代码质量明显高于它的门禁质量，而门禁质量又明显高于它的运维交接质量。**

- 代码层：全仓 `: any` **0 处**、`as any` **0 处**、`@ts-ignore` **0 处**、`TODO/FIXME` **0 处**、`src/` 里 `console.log` **0 处**；注释密度 **21.0%**，其中 **1,976 行**在解释「为什么」而不是「做什么」。这些是同龄项目的上限水平。
- 门禁层：看起来极厚（`npm run ci` 串了 20 多个检查），但有三个洞 —— 覆盖率门禁统计的是「文件被 import 过没有」而非行覆盖率（`c8` 根本没装）；21% 的用例是读源码字符串而非验证行为；单测运行器没有超时、锁不查进程活性。
- 运维层：容器本身干净（多阶段、非 root、`HEALTHCHECK` 打真接口、日志轮转、CI 并发控制都对），但**从 commit 到生产那最后一跳完全靠人工**，脚本在仓库外、SSH 私钥在某一台特定机器上、镜像发布不看 CI 结论、回滚方案只存在于代码能力里而没有任何文字记录。

健康度评级：

| 维度        | 评级     | 一句话                          |
| --------- | ------ | ---------------------------- |
| 性能与资源占用   | **B**  | 首屏被三重锁死，风险全在「笔记数一多就线性劣化」     |
| 可维护性与代码质量 | **B+** | 纪律极强，但四处大文件拆到 80% 就停了        |
| 可测试性      | **B−** | 用例数很吓人，含金量要打八折，基础设施缺三件套      |
| 兼容性与可扩展性  | **B**  | 适配层质量最高；风险全在「边界声明缺失」         |
| 依赖与版本管理   | **B**  | 包本身健康，配置类问题多（唯一性说不清）         |
| 数据处理与存储   | **A−** | schema/索引/事务/软删除都成熟，两处未量化的放大 |
| 日志与监控     | **D**  | 全维度最弱：客户端能上报，服务端查不到          |
| 可访问性      | **A−** | 超出个人项目普遍水平，唯一实质缺陷是拖拽播报念英文    |
| 文档完整性     | **C**  | 不是没写，是 47 份没入口、没分层、没状态       |
| 部署与运维     | **C**  | 容器 A，链路 D。四个静默出错点，三个不报警      |
| 异常与容错处理   | **B−** | 输入校验和乐观回滚很强，认证失效链与超时判定有硬伤    |

---

## 1. 优先处置清单

14 项 P0，按「修起来的性价比 / 不修会出什么事」排序。

> ⚠️ **P0 的定义**：不是「线上正在冒烟」。这个站现在跑得很好。P0 = 「已经处于该风险状态，且一旦触发就是数据丢失 / 权限暴露 / 上线失控 / 没人能接手」。P0 里最便宜的几项加起来不到两小时。

| #  | 维度   | 问题                                                                                                                    | 等级 | 优先级    | 工作量              |
| -- | ---- | --------------------------------------------------------------------------------------------------------------------- | -- | ------ | ---------------- |
| 1  | 部署运维 | `docker-publish` 不看 CI 结论，CI 红的提交照样发到 GHCR `latest`，而生产拉的就是 `latest`                                                  | 高  | **P0** | 30 分钟            |
| 2  | 测试   | 单测运行器无 `--test-timeout`，一个 hang 吃掉整个 15 分钟 CI job                                                                     | 高  | **P0** | 1 行              |
| 3  | 测试   | 锁文件不查 PID 活性，`SIGKILL` 后此后每次 `npm test` 都假红（历史事故复现路径）                                                                 | 高  | **P0** | 15 行             |
| 4  | 容错   | 401 只在 `bootstrap` 一条链路触发回登录页，令牌过期后用户卡在页面上反复吃 toast                                                                   | 高  | **P0** | 20 行             |
| 5  | 容错   | `worker/routes/middleware.ts` 4 处 401 回纯文本，错误码根本传不出来（阻断第 4 项的彻底修复）                                                    | 高  | **P0** | 4 行              |
| 6  | 容错   | `ErrorBoundary` 只保护记事本，主站列表与登录页裸奔，一张脏卡片能打掉整站                                                                          | 高  | **P0** | 30 行             |
| 7  | 部署运维 | 备份不设备份密码就**明文 zip 直传网盘**（含站点账号密码）；且从未验证过能否恢复                                                                          | 高  | **P0** | 文案 10 分钟，演练 1 小时 |
| 8  | 文档   | `deploy/selfhost.md:191-250` 教人挂 `docker.sock` 并 `user:"0:0"`，与 `docker-compose.yml:72` 的现方案**完全相反**，照做等于主动交出宿主机 root | 高  | **P0** | 1 小时重写           |
| 9  | 部署运维 | 无回滚方案：镜像是 `latest` 单标签滚动，`NAVIHIVE_IMAGE` 这个回滚旋钮文档零覆盖                                                                 | 高  | **P0** | 1 小时             |
| 10 | 部署运维 | 发布链依赖仓库外的 `vps-run.py` + 某台机器的 SSH 私钥，bus factor = 1                                                                  | 高  | **P0** | 30 分钟写文档 / 半天自动化 |
| 11 | 文档   | README 本地开发缺 `.dev.vars` 这一步，新人第 2 分钟就会撞全站 503，且报错文案把人往部署环境带                                                          | 高  | **P0** | 10 分钟            |
| 12 | 依赖   | 包管理器事实上混用（`pnpm-workspace.yaml` 在、`pnpm-lock.yaml` 不存在且被 gitignore），`pnpm install` 会装出一棵无锁约束的树且永远查不出来                 | 高  | **P0** | 15 分钟            |
| 13 | 可维护性 | `src/errors` 之外的服务端 500 只打一行无上下文的 `console.error`，不落库、无请求 ID，日志轮转后就永久丢失                                               | 中  | **P0** | 1 小时             |
| 14 | 文档   | 真正完整的运维知识（生产拓扑、发布纪律、`Deploy` 为什么长期红）只存在于被 gitignore 的 `.workbuddy/memory/MEMORY.md`                                   | 高  | **P0** | 1 小时             |

P1 共 20 项，见 §3 各维度明细。

---

## 2. 三条主线

14 项 P0 分散在 7 个维度，但它们其实是三条链。

### 主线一：「认证失效」链（P0-4 → P0-5，P1-错误码消费）

```
middleware.ts 4 处 401 回纯文本
   └→ client.ts 的 response.json() 抛 → errorPayload = null → code 丢失
        └→ 前端只能靠 message.includes("认证") 判错（5 处）
             └→ 而 includes 判错只接在 bootstrap 一条链路上
                  └→ 令牌过期后：点任何按钮都弹同一句 toast，界面永不回登录页
```

修的顺序有硬依赖：**必须先修 middleware 的 4 处纯文本 401，才能把前端的 `includes` 换成 `err.code`**。顺序反了 `useSites.ts:91` 会直接坏。建议同一个人连续做完。

顺带发现：错误码体系做了 5 轮（`API_ERROR_CODES`），`ApiError.is()` 方法也写了，但**全仓零调用**；`apiError.ts:11` 注释承诺的「429 → 提示太频繁并给重试按钮」也不存在。承诺与实现脱节，比没做更容易误导后来者。

### 主线二：「上线失控」链（P0-1 → P0-9 → P0-10）

```
npm run ci 全绿（或者没绿）
   ├→ docker-publish 只看 push paths，不看 CI 结论  ← 静默出错点 1
   │      └→ GHCR :latest 被覆盖（无保留策略）
   ├→ 人工 python vps-run.py 拉 latest + 重建         ← 静默出错点 2（换人就发不了版）
   │      └→ 不比对 image digest 就可能把旧 latest 当新版验收  ← 静默出错点 3
   └→ 5 路人工验证                                     ← 静默出错点 4（内容无记录）
```

四个点里**三个不会有人报警**。而回滚这件事更微妙：技术上完全可行（每次构建都打了 `:<sha>` tag，迁移是纯加列所以「只回退代码不回退库」是安全的），但没有任何文字记录 —— **能力等于不存在**，因为出事那一刻没有人知道它存在。

### 主线三：「门禁名不副实」链（P0-2 → P0-3，P1-覆盖率 → P1-静态守卫）

```
npm run ci 打印「✅ 覆盖率分层门禁通过」
   ├→ 实际统计的是「每个源文件被任何用例 import 过没有」，374 文件全部 100%
   │      └→ 一个 909 行、零测试的 NotesBackupTab.tsx 因为被 import 一次而达标
   ├→ 3,243 条用例里 682 条（21%）是读源码字符串，不是行为断言
   └→ 而真正的运行器没有超时（一个 hang 吃满 15 分钟 job）、锁不查 PID（SIGKILL 后永久假红）
```

讽刺的是**该写的东西基本都写好了**：`coverage.mjs` 的第 2 层（真行覆盖率）代码完整，只差 `npm i -D c8` 一个 devDependency；`unit-tests.mjs` 里对锁的成因分析写得比多数项目清楚，只差一个 `process.kill(pid, 0)`。

---

## 3. 十一个维度逐项评估

### 3.1 性能与资源占用

**结论：首屏侧已被三重锁死，不会有系统性回归；风险全在「数据规模」维度 —— 记事本三条通路都是「笔记数一多就线性劣化」。**

| 发现                     | 实测数据                                           | 等级  | 优先级 |
| ---------------------- | ---------------------------------------------- | --- | --- |
| 笔记列表全程无分页              | 1 万条摘要档 = **8.47 MB** 一次下发                     | 中   | P1  |
| 每次保存笔记全表扫 FTS          | 3k 条时 **76.5 ms**，外推 1 万条约 250 ms              | 中   | P1  |
| 跨设备轮询恒定回传全量 `noteTags` | 1 万条 **151.7 KB/次**，0 变更也发                     | 中   | P1  |
| ~~自托管 API 响应从未压缩~~ **归因不成立（2026-10-28 复核，见下方说明）** | ~~`gzip_proxied` 全目录 0 次~~ → 线上 `nginx.conf` 的 `gzip_types` 早就含 `application/json`、且**没有** `gzip_proxied`；`curl -H 'Accept-Encoding: gzip' /assets/react-*.js` 实回 `content-encoding: gzip`。批次一加的那一行既没修什么、也没进生产 | — | **作废** |
| 预览每次按键全量重解析 Markdown   | 100 KB 长文 **13.9 ms/键**，手机折算 40–70 ms          | 中   | P1  |
| 本地模糊搜索每次按键扫全量          | 1 万条 **8–12 ms**，每次重建约 2 MB 字符串                | 低-中 | P2  |
| 两个常驻轮询不看页面可见性          | 常开标签页 **2,160 请求/天**                           | 低   | P2  |
| 首屏余量只剩 4.8% / 4.4%     | 876.0 KB raw / 287.0 KB gzip，预算 920/300，门槛 ≥3% | 低   | P2  |
| KaTeX 三套字体格式全量进产物      | 59 文件 1.02 MB，其中 **817 KB 现代浏览器永不下载**          | 低   | P3  |
| 自托管只有 gzip 无 brotli    | 实测可再省 **47.1 KB / 16.4%**                      | 低   | P2  |

> **2026-10-28 复核：批次一实现后实测发现「自托管 API 响应从未压缩」这个归因不成立，该行作废。**
> 原依据是「全仓 `grep gzip_proxied` = 0 次」—— 但那只是**仓库里两份模板**的计数，既没看生产实际
> 加载的 `nginx.conf`（kPanel 管的那份），也把「没有这个指令」直接等同于「没有压缩」。
> 复核到的三件事：
> ① 线上 `nginx.conf` 里 `gzip on` + `gzip_types … application/json`（还有 `gzip_static on`），
> **没有** `gzip_proxied` —— 而 `/assets/react-*.js` 实测回 `content-encoding: gzip`，说明一直在压；
> ② 语义层面：`gzip_proxied` 只对**带 `Via` 请求头**的请求生效（原文引用见本节第 2 条），
> 默认 `off` 并不等于「所有反代响应都不压」；
> ③ `git show b8bfd22 -- deploy/nginx/sites-available/navihive-selfhost.conf`：批次一唯一的功能性
> 新增就是 `gzip_proxied any` 这一行，`gzip on` / `gzip_vary` / `gzip_min_length` /
> `gzip_types … application/json` 在批次一之前就已经在文件里。
>
> 结论：那一行**既没修掉什么，也没进生产**（生产跑的不是仓库里这两份模板）。
> 已把「为什么」写进 `deploy/nginx/sites-available/navihive.conf`、`navihive-selfhost.conf` 的注释，
> `deploy/nginx/README.md` 新增「两份站点配置的 gzip 差异」一节，`deploy/selfhost.md` 对应段同时更正 ——
> 目的只有一个：下次别有人「顺手补齐」，也别有人照着旧结论重新推一遍。

**做得好的（逐项核对过）**：后端没有 N+1；列表排序完全命中覆盖索引 `idx_notes_user_order`；SQLite 连接参数逐个有理由（WAL / `busy_timeout` 5000 / `synchronous=NORMAL` / 外键开）；静态资源缓存策略正确；前端运行时缓存全部有界（`imageCache` LRU 64、`objectUrlCache` 引用计数、`firstPaintCache` 2000 上限）；零外链字体。

**具体方案（按性价比排序）**

1. **FTS 改成用 rowid 定位**（收益最大、改动最小）。`notes_fts` 的 `note_id` 声明成了 `UNINDEXED`（`internals.ts:149`），所以 `DELETE ... WHERE note_id = ?` 是全表扫。把 FTS 的隐式 rowid 直接当笔记 id 用，只改两处 SQL：
   ```sql
   INSERT INTO notes_fts(rowid, note_id, user_id, title, body) VALUES (?, ?, ?, ?, ?)
   DELETE FROM notes_fts WHERE rowid = ?     -- 走 rowid 定位，不再 SCAN
   ```
   同一 benchmark 实测 **76.50 ms → 4.63 ms（16.5×）**，`MATCH` 查询不受影响。需要一次迁移重建索引表（表小，一次性成本可接受）。
2. ~~**nginx 加一行** `gzip_proxied any;`~~ —— **2026-10-28 复核后作废：前提不成立，`/api/*` 本来就一直在压。**
   保留这个位置只为记下「结论失效」这件事，不静默删。三条依据：
   ① `gzip_proxied` 只对**带 `Via` 请求头**的请求生效（nginx 文档原文：*"The fact that the
   request is proxied is determined by the presence of the 'Via' request header field"*），
   浏览器 → 反代这条链上没有一跳会加 `Via`，所以这行加不加都不改变行为；
   ② 真正让 JSON 被压的是 `gzip_types` 里的 `application/json`（nginx 默认**只**压
   `text/html`），而线上 `nginx.conf` 早已列了它；
   ③ 实测：`curl -H 'Accept-Encoding: gzip' https://<host>/assets/react-*.js` →
   `content-encoding: gzip`。
   连带一条**仍然成立、且已完成**的项：`navihive-selfhost.conf` 那句「Node 侧不压缩」的过时注释
   （2026-10-22 起 `server/static.ts` 已经自己压静态了，那句话会让运维重复排查）已在批次一改掉。
3. **列表加分页**。`GET /api/notes?limit=&cursor=` 做 keyset 分页（正好命中已有索引），首屏只取 200 条；`exportNotes` 同步改成流式分页，避免 1 万条正文（约 50 MB）一次进内存。
4. **轮询带指纹**。`/api/notes/changes` 只在 `notesChanged>0` 或「文件夹/标签指纹变了」时才带全量列表；并把 5 条串行查询合成一个 `db.batch`。
5. **预览用 `useDeferredValue` + 150ms debounce**。范式现成 —— `useSiteSearch.ts:95` 已经这么干了。
6. 两处轮询加 `document.visibilityState === "hidden"` 跳过。

---

### 3.2 可维护性与代码质量

**结论：纪律面极强（零 any、零 TODO、零 console.log、命名零混用、注释 21%），但有四个明确的出血点，都是「历史拆分做到 80% 就停了」。**

| 发现                                                                                                                    | 证据                                                                                                                            | 等级 | 优先级 |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -- | --- |
| `NotesPage.tsx` **3,481 行是单个组件**：33 个 `useState` + 28 个 `useEffect` + 60 个 `useCallback`，2950 行逻辑 + 530 行 JSX 在一个函数体里 | `NotesPage.tsx:149` → 文件末尾                                                                                                    | 高  | P1  |
| `importData` 是**单个 834 行的函数**                                                                                         | `transfer.ts:293-1126`                                                                                                        | 高  | P1  |
| `App.tsx` 2,366 行，`function App()` 独占约 2,150 行                                                                        | `App.tsx:208-2366`                                                                                                            | 中  | P1  |
| 同一产品的**日期格式化有 6 份实现**，输出格式不同                                                                                          | `AuditDialog:66` / `RecycleBinDialog:54` / `backupFormat:17` / `BackupDialog:90` / `NoteShareDialog:56` / `settingsShared:45` | 中  | P1  |
| `fmtBytes` ×3（两份逐字相同）；`Section` 与 `TwoCol` 逐字重复（`dialogSection.tsx` 已存在却没被 `AccountDialog` 用）                         | `AttachmentManager:60` / `AttachmentPreviewDialog:57` / `settingsShared:54`；`AccountDialog:183-243` vs `dialogSection:14-51`  | 中  | P1  |
| `server/entry.ts` 1,204 行里 **540 行是 Docker 自升级**，与 HTTP 入口无关，且零测试                                                     | `entry.ts:348-885`，27 个 Docker 相关函数                                                                                           | 中  | P2  |
| `worker/cron.ts` 有 **17 处同模板 `as unknown as`**                                                                        | `:91/:111/:135/:178/:183/:192/:220/:247/:252/:262/:368/:577`                                                                  | 中  | P2  |
| **13 个死导出**，其中 `BACKUP_NOTES_CONFIG` 还留着 8 行注释描述一个已删除的功能                                                              | `configKeys.ts:105-113`                                                                                                       | 低  | P2  |
| `clearReadingPosition` 从未被调用 → 删笔记/删账号后本机 localStorage 永久堆积                                                           | `readingPosition.ts`                                                                                                          | 中  | P2  |
| ESLint warning 预算门禁可被 `eslint-disable` 静默绕过                                                                           | `lint-warnings-budget.mjs:34`；45 处 disable，36 个 `exhaustive-deps`（`NotesPage` 占 17）                                           | 中  | P2  |
| `AuditDialog.tsx:66` 有个死表达式 `+ (iso.includes("Z") ? "" : "")` —— 三目复制粘贴残留                                             | 同左                                                                                                                            | 低  | P3  |

全仓 ≥1000 行的源文件 **14 个**，≥900 行 **20 个**。

**做得好的**：零 `any` / 零 `TODO` / 零 `console.log`（`src/` 浏览器代码里那 61 处 `console.error` 几乎全在 `src/API/methods/*`，那是跑在 Worker 里的服务端方法体，不打包进前端）；命名纪律是真的（`site`/`link`/`card`、`note`/`memo`、`group`/`category` 全部无混用，`memo` 的 40 次命中全是 `React.memo`/`useMemo`）；注释质量是全仓最强项。

**具体方案**

1. **`NotesPage.tsx` 按注释里已存在的六条分界线外提**，全部是纯搬运不改行为：`useNotesTaxonomy.ts`（1260–1422）/ `useNotesRowMenuActions.ts`（1422–1673）/ `useNotesBulkOps.ts`（1673–1764）/ `useBacklinks.ts`（1764–1998）/ 空状态文案表移入 `useNotesList.ts`（2296–2948）/ JSX 拆成 `NotesPageShell.tsx`。目标主文件 ≤ 900 行。拆完那 17 个 `eslint-disable` 自然消失，可以当验收指标。
2. **`importData` 按阶段拆分**：导出 `planMerge` → `writeGroups` → `writeSites` → `writeConfigs` → `rebuildIndexes` 五个纯函数，主函数只做编排。范式照抄 `migration.ts` 的步骤表（已经跑通）。
3. **建 `src/utils/format.ts`**：`fmtBytes` / `fmtDateTime` / `fmtRelative` 三个出口，删掉 6 份本地实现和 3 份 `fmtBytes`。这条顺带修一个真 bug —— `new Date("2024-01-01 12:00:00")` 是非标准格式，Safari/iOS 返回 `Invalid Date`。
4. **`AccountDialog` 改用现成的 `dialogSection.tsx`**，`TwoCol` 搬进去让 `SettingsDialog` 复用。
5. **`lint-warnings-budget.mjs` 加第二道闸**：扫全部 `eslint-disable`，要求同行含 `--` 或上一行含 `//`，否则 `exit 1`（约 15 行代码）。当前 45 处里 6 处无理由。

---

### 3.3 可测试性

**结论：用例数很吓人，含金量要打八折；真正的问题是基础设施缺三件套，而这三件东西代码里其实都写好了。**

| 发现                                                                     | 证据                                                               | 等级 | 优先级    |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------- | -- | ------ |
| **覆盖率门禁不测覆盖率**：`c8` 未安装，第 2 层（真行覆盖率）从未执行过一次；第 1 层口径是「文件被任何用例 import 过」 | `coverage.mjs:223-235`；`node_modules/c8` 不存在；`package.json` 无 c8 | 高  | P1     |
| **682 条用例（21%）是读源码字符串**，不是行为断言                                         | `grep -rln readFileSync tests/` = 67 文件 / 18,951 行               | 高  | P1     |
| `NotesBackupTab.tsx` **909 行、零个测试文件提到**，却因被 import 一次而覆盖率 100%         | 实测 `grep -rln NotesBackupTab tests/` 为空                          | 高  | P1     |
| 运行器**没有超时**                                                            | `unit-tests.mjs:295` 只传 `--test-force-exit`                      | 高  | **P0** |
| 锁文件**不查 PID 活性**                                                       | `unit-tests.mjs:169-186`，只读 pid 打印后 `exit 1`                     | 高  | **P0** |
| 并发无上限：16 核机上同时起 15 个 jsdom 进程                                          | 未设 `--test-concurrency`                                          | 中  | P1     |
| `notes.dom.test.tsx` **6,802 行 / 226 条用例**，占全部用例 7%                    | 单文件失败无法定位                                                        | 中  | P2     |
| 146 处 `setTimeout` 在 tests 里，`--test-force-exit` 掩盖资源泄漏                | `notes.dom.test.tsx` 独占 47 处                                     | 中  | P2     |


**必须替项目说句公道话**：剩下的 2,561 条用例质量相当好 —— `assert.equal` 4,890 次、`deepEqual` 977 次，而裸 `assert.ok(变量)` 全站只有 68 处（2.7%）。DOM 用例有数据驱动的 `waitFor` 轮询且注释讲清了「为什么不能固定睡」。这跟「凑数量的测试」是两回事。

**具体方案**

1. `npm i -D c8`（**一行**）。脚本里第 2 层的完整参数已经写好了（`--exclude-after-remap --all --src src --src worker`），`unit-tests.mjs` 的 `NAVIHIVE_COVERAGE` 分支也已就绪，只差这个 devDependency。第一次先只报告不卡门，量出真实基线再定阈值。
2. `unit-tests.mjs:295` 加两个参数：`--test-timeout=60000`、`--test-concurrency=4`。60 秒对单条用例足够宽松（最慢的 `notes.dom` 单条也在秒级），`--test-concurrency=4` 让本地与 CI 的调度压力可比。
3. 抢锁失败分支加活性探测（约 6 行）：
   ```js
   const pid = Number(holder);
   let alive = false;
   if (Number.isInteger(pid) && pid > 0) {
       try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === "EPERM"; }
   }
   if (!alive) { fs.rmSync(LOCK_FILE, { force: true }); /* 重新抢锁 */ }
   ```
   更彻底的方案是按 pid 命名 `OUT_DIR`（`tmp-tests-<pid>`），**取消锁** —— 锁存在的唯一理由是共享目录。
4. 在 `script/test-inventory.mjs`（或 `coverage.mjs`）里把用例分成「行为测试 / 静态守卫」两类分别计数，CI 输出单独打一行「静态守卫 682 条」。**别再合成一个 3,243** —— 这个数字对外被高估了约 1/5。
5. 新增 `tests/notesBackupTab.dom.test.tsx`：它 props 只有 `{ data, onNotify }`，直接 `render` 即可，覆盖列表渲染 / 删除确认 / 恢复失败提示 / 完整性校验拦截。**没测跟「难测」无关，纯粹是缺口。**

---

### 3.4 兼容性与可扩展性

**结论：先纠正一个前提 —— 这个项目没有两份后端实现，而是「一份共享路由 + 两个平台适配器」，而且适配层是全仓质量最高的一段代码。真正的风险全在边界声明缺失。**

`server/entry.ts:1-5` 自述「业务路由一行不改」；实测 `worker/` 里 CF 专有 API 用量：`HTMLRewriter` 0、`caches.*` 0、`DurableObject` 0、`from "node:` 0。`sqlite-d1.ts:1-25` 逐条列出与 D1 的 6 个差异及处理方式（`batch()` 真事务 / `run()` 同时给 meta 与 RETURNING / `exec()` 补 `{count,duration}` / 外键默认开 / 错误走 rejection 通道 / 行对象拍平）。这是本次审查里质量最高的一段。

| 发现                                                                                                                                                                             | 证据                                                                               | 等级 | 优先级 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | -- | --- |
| **浏览器基线只活在一句错误的注释里**：无 `build.target`、无 `browserslist`；`tsconfig.app.json:8` 写「Chrome 109 / Safari 15.4」，实际 Vite 默认 `baseline-widely-available` = **Chrome 111 / Safari 16.4** | 而 `color-mix` 用了 **64 处**且全部无 fallback（按注释宣称的基线会整条失效、元素消失）                       | 中  | P1  |
| **Node 版本三个地方三个值**：`.nvmrc`=22、CI 四处=22、`Dockerfile` 两处=**24**；`package.json` 无 `engines`；`@types/node`=22                                                                     | 而 `node:sqlite` 是实验 API，Node 23/24 之间改过行为                                        | 中  | P1  |
| **备份格式有版本号却不校验**：`EXPORT_VERSION = "1.4"`，导出写、导入读，读完即丢，全文件无任何版本比较                                                                                                              | `transfer.ts:202/1205/1330`                                                      | 高  | P1  |
| 限速桶作用域两端不同：`worker/rateLimit.ts` 是 **isolate 内进程内存 Map**，CF 上实际阈值 ≈ N × isolate 数                                                                                              | `rateLimit.ts:41`                                                                | 中  | P1  |
| `TRUST_XFF` 默认值选了宽松的一侧（`"1"`）                                                                                                                                                  | `server/entry.ts:59-62`                                                          | 中  | P1  |
| 4 处 input `fontSize` 为 13/14px → iOS 聚焦强制缩放                                                                                                                                    | `AddSiteDialog:108`（最高频表单）/ `SiteSettingsModal:536,790` / `TagManagerDialog:188` | 中  | P2  |
| 安全区只处理了 bottom，无 top/left/right；4 处 `100vh` 残留                                                                                                                                 | `index.css:1427,1430`；`App.tsx:1707` / `ErrorBoundary:47` / `LoginScreen:80,92`  | 中  | P2  |

**做得好的**：`hover: hover` 保护 14 处（触屏不会出现「必须悬停才看得到」）；`dvh` 已全面替换（只余 4 处）；`@container notesnav` 声明与使用配对正确；`sitesChanges`/`notesChanges` 增量同步语义在两端一致。

**具体方案**

1. `vite.config.ts` 的 `build` 里**显式写 `target`**，把隐式值变成显式契约；加 `browserslist`；**改掉 `tsconfig.app.json:7-8` 那句错注释**。若要显式支持 Safari 15.x，就必须给 64 处 `color-mix` 逐个补前一条 fallback 声明（MUI sx 支持数组值：`backgroundColor: ["rgba(...)", "color-mix(...)"]`）。
2. 三处 Node 版本**对齐到 24**（以生产为准），`package.json` 加 `"engines": { "node": ">=24" }`。或最小动作：只加 `engines` + 改 `.nvmrc`，先让新人默认装对。
3. **备份加版本闸门**（在 `transfer.ts:1330` 之前）：
   ```ts
   const v = typeof raw.version === "string" ? raw.version : "0";
   const [maj] = v.split(".").map(Number);
   const [curMaj] = EXPORT_VERSION.split(".").map(Number);
   if (Number.isFinite(maj) && maj > curMaj) {
       throw apiError(400, "backup_version_too_new",
           `备份由更新的版本（${v}）生成，当前仅支持到 ${EXPORT_VERSION}，请先升级`);
   }
   ```
   版本缺失的老备份走现有「保持本地不动」语义，但**要提示一句**（现在完全静默）。配 3 条用例即可永久钉住。
4. `TRUST_XFF` 默认改 `"0"`，在 `deploy/selfhost.md` 写明「前面有 Nginx 才设 1」。
5. 4 处 `fontSize` 改 16px；补 `safe-area-inset-top/left/right`；4 处 `100vh` → `100dvh`。

---

### 3.5 依赖与版本管理

**结论：包本身健康（23 个生产依赖没有一个冗余），问题全在「配置类」—— 三件事说不清：npm 还是 pnpm、Node 22 还是 24、哪个 override 是越界。**

口径纠正：**23 个 `dependencies` / 17 个 `devDependencies`**，锁文件里 **528 个包**。

| 发现                                                                                                                                     | 证据                                                    | 等级 | 优先级    |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | -- | ------ |
| **包管理器事实上混用**：`pnpm-workspace.yaml` 在（只有 `allowBuilds`，无 `packages:`），`pnpm-lock.yaml` 不存在且被 `.gitignore:29` 忽略                        | 全仓 `grep pnpm` 除 .gitignore 外零命中，无任何文档说该用哪个           | 高  | **P0** |
| **6 条 `overrides` 里 2 条越界**：`mermaid.katex` 强制 `0.19.0`（mermaid 要求 `^0.16.47`）；`miniflare.undici` 强制 `7.30.1`（miniflare 精确要求 `7.29.1`） | katex 越界那条**没有任何用例守**，而 mermaid 的 katex 集成是按 0.16 写的  | 中  | P1     |
| 锁文件 `version` 停在 12.3.0（`package.json` 已 16.5.0）——`bump-version.mjs` 只写 package.json                                                   | `bump-version.mjs:82-85` 全文无 package-lock 相关代码        | 低  | P2     |
| 部署工具链跑在 **alpha 预发布** 运行时上（`miniflare 5.20261006.1-alpha`，由 wrangler 精确指定）                                                             | 不是选错，结果是 `wrangler` 升一个小版本就可能静默换掉它                    | 低  | P3     |
| 两个 `@types/markdown-it*` 放在 `dependencies`（应为 dev）                                                                                     | `package.json:56-57`                                  | 低  | P3     |
| 版本号机械跳档：**35 天 16 个 major**，「major = diff 超 1200 行」                                                                                    | `bump-version-lib.mjs:12-14`；CHANGELOG 222 条 / 5440 行 | 中  | P2     |
| `dependabot.yml` 注释与行为不符：注释说「只开安全 PR」，实际没有 `allow`/`groups`，minor/patch 更新会挤占那 5 个名额                                                   | `.github/dependabot.yml:9-11`                         | 中  | P2     |

**做得好的**：逐个 import 扫描确认**没有可删的依赖** —— 41 个包全部有实际用途，`@emotion/*` 是 MUI peer、`@types/*` 是类型包；`pinyin-match` 做了按需加载（`pinyin.ts:40` 动态 import，关闭开关时完全不请求）；`typescript` 是唯一用 `~` 锁 patch 的包，理由有据可查（TS 7 不带 compiler API，而 typescript-eslint 靠它做类型感知）；`docs/dependency-upgrade-assessment.md` 是一份带 `npm install --dry-run` 实证的升级评估。

**具体方案**

1. **宣布 npm 为唯一包管理器**，三步 15 分钟：① 删 `pnpm-workspace.yaml`（npm 默认允许安装脚本）；② `.gitignore:29` 的 `pnpm-lock.yaml` 改成不忽略（万一有人用错工具，至少能在 `git status` 里看见）；③ `package.json` 加 `"packageManager": "npm@<版本>"`，README 写一句「只用 npm，`pnpm-workspace.yaml` 是历史残留」。
2. **给 katex 越界加一条守**：`tests/mermaidMath.dom.test.tsx` 渲染含 `$$x^2$$` 的 mermaid 图，断言 `.katex` 出现且无 `console.error`。红则说明必须换方向（升级 mermaid 或接受两份 katex）。**这条用例比任何注释都值。**
3. 在 `docs/dependency-upgrade-assessment.md` 追加「override 登记簿」一节，每条写「谁要求什么范围 / 为什么强制 / 风险 / 由哪条用例守」。
4. `bump-version.mjs` 里加三行同步写 `package-lock.json` 的 version，并补一条守卫用例断言两者一致。
5. **让版本号重新有信息量**：`major` 的触发条件从「行数超 1200」改成「命中 `migration.ts` / `wrangler.jsonc` / `docker-compose.yml` / `.env.example` 即强制 major」。这样 `17.0.0` 开始表示「升级需要动作」，运维能在升级前一眼看到。

---

### 3.6 数据处理与存储

**结论：成熟度超出预期。27 条索引逐条对得上真实查询，软删除用「搬行」而不是「打标记」，批量写全在事务里。弱点不是设计错了，是两处没被量化过的放大。**

| 发现                                                                 | 实测数据                                                                         | 等级  | 优先级 |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------- | --- | --- |
| FTS5 索引空间放大 **158%**                                               | 200 篇 × 5000 字：正文 3212 KB → 加 FTS 后 8272 KB，折合 **+25.3 KB/篇**；1 万篇约 425 MB 库 | 中   | P2  |
| **排序写入污染变更流**：`order_num` 变更也刷 `updated_at`，拖一次序所有设备收到「N 处变更」      | `notesNote.ts:455`；触发 `notesBackup.ts:94/117` 的变更判定                          | 中   | P2  |
| 附件改名扫全库正文并把整篇拉进内存                                                  | `notesAttachment.ts:226-229`，`LIKE '%...%'` 必然全表扫                            | 低-中 | P2  |
| 时间戳两套约定并存（TEXT `'YYYY-MM-DD HH:MM:SS'` / INTEGER 秒 / ISO 8601 带 T） | 同一天同名语义三种类型                                                                  | 低   | P2  |
| 迁移只有单向（无 down）、由客户端首个请求触发，大表 `CREATE INDEX` 会锁首屏                   | `migration.ts` 18 个 step 全 forward；`SCHEMA_VERSION = "27"`                   | 中   | P2  |
| 附件孤儿依赖人工触发清理                                                       | `pruneAttachments` 未挂进 cron                                                  | 低   | P2  |
| 排序写入是全文件唯一不调 `migrate()` 的写方法                                      | `notesNote.ts:440-444`                                                       | 低   | P2  |

**做得好的**：27 条索引逐条有动机注释与 EXPLAIN 结论；软删除是「整行 JSON 搬进 `recycle_bin`」而不是 `deleted_at` 标记（主表永不被墓碑撑大，所有主查询不用带 `WHERE deleted_at IS NULL`）；WAL + `busy_timeout` + `BEGIN IMMEDIATE` + 幂等键表 `PRIMARY KEY (scope, op_id)` + 笔记 `rev` 乐观并发；无「读全表再内存过滤」的主路径（只剩 2 处明确降级）；迁移改成步骤表 + 派生版本号，把「忘了 +1」这类历史事故从制度上关掉了。

**具体方案**

1. **`order_num` 变更不刷新 `updated_at`**（排序不是内容变更）。顺带补上 `await this.migrate()`。
2. **FTS 索引瘦身**，三条可组合：只索引标题 + 前 2000 字（索引降约 60%）；换 `trigram` 分词器（中文天然按 3-gram 切，不需要 `segmentCJK` 插空格，体积通常再小 30–50%，还能直接支持子串搜索）；或在「设置 → 数据」显示索引占用并给用户一个重建开关。建议与 §3.1 的 rowid 改造**合并成一次迁移**。
3. **附件改名不动正文**，只改 `attachments.filename`，在渲染层用文件名覆盖 label（链接本身按 id 走，功能不受影响）。`renameAttachment` 就退化成一条 UPDATE。
4. 迁移步骤表加 `heavy?: boolean` 标记，heavy 步骤不在请求路径跑；迁移前自动 `VACUUM INTO` 一份 `navihive.db.bak-<version>`。
5. `pruneAttachments` 挂进现有 `cleanupExpiredRows` 一起跑。

---

### 3.7 日志与监控

**结论：全维度最弱的一面，且弱得很集中 —— 客户端有完整的 sanitize + 限流 + 去重 + 落库 + owner 查询链路，服务端却只有裸 `console.error`。结果是「用户能上报，运维查不到」。**

| 发现                                                        | 证据                                                                              | 等级  | 优先级 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- | --- | --- |
| **全仓 0 处请求 ID**，客户端上报的错误与服务端日志无法关联                        | `worker/` `server/` `src/` 零命中；`errorReporter.ts:186-200` 上报字段无请求标识             | 中   | P1  |
| **服务端 500 只打一行无上下文的 console**，没有 method / path / uid，不落库  | `worker/lib/apiError.ts:125-135`；`server/entry.ts:1100` 的 catch 里拿不到 `pathname` | 中   | P1  |
| 自托管访问日志**没有状态码、没有耗时、且在请求开始时就打**                           | `server/entry.ts:1098` 位于 `await proxyToWorker` 之前；只有 >1s 才 warn                | 中   | P1  |
| Cloudflare 侧 `worker/index.ts` **零访问日志**（`console.` 命中 0） | 只有 `observability.enabled: true`，无采样率、无 Analytics Engine                        | 低-中 | P2  |
| 无日志级别、无结构化输出                                              | `console` 分布：`src` 1/61/12、`worker` 10/23/2、`server` 13/10/8、`shared` 0/0/0     | 低-中 | P2  |

|                                                  |       |                                                                                                                                                                                                                                                                     |
| ------------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **做得好的**：日志里**没有凭据泄露**（\`grep console.* password | token | secret` 只剩 2 条命中，一条是启动告警文案、一条记录了「曾经打印过密码、已修」）；`slowQuery.ts:16-19`明确只记 SQL 摘要 + 参数个数不记值；客户端错误上报有密钥黑名单、URL 去 query、10s 同错去重、8 KB 硬截断、Map 超 200 清理；健康检查打`/api/init` 真读库；Docker 日志轮转已配（`10m×3`）；SIGTERM 会 checkpoint WAL 再退出；启动自检有 fail-closed（缺 `AUTH_SECRET\` 直接退出）。 |

**具体方案**（三处小改即可闭最贵的环，零新依赖）

1. **注入请求 ID**：`server/entry.ts` 生成 `rid = crypto.randomUUID().slice(0,8)`，以 `x-request-id` 注入请求头并在响应结束日志带上；`worker/index.ts` 的 catch 里取 `x-request-id ?? 自生成`，塞进 `errorResponse` 的 headers；`apiError.ts:131` 改成 `console.error("[api]", rid, method, pathname, err)`；客户端 `errorReporter` 从响应头读 `rid` 一起上报。CF 侧由 worker 自己生成即可（`cf-ray` 已在平台日志里，两者能对上）。
2. **500 落库**：`errorResponse` 的非 `ApiError` 分支加一次 `writeAudit("server-error", uid, ip, JSON.stringify({method, path, code, message, rid}))`（**不带 stack**，stack 留 console 靠 rid 关联）。`audit_log` 已有索引与保留期清理，成本极低。
3. **访问日志挪到 `res.on("finish")`**，一行结构化 JSON（时间 / rid / 方法 / 路径 / 状态码 / 耗时 / ip / ua）。`slowQuery.ts` 那套环形缓冲可以直接复用，加一个 owner 可查的 `/api/system/request-stats` 返回 per-route 计数与 p50/p95。
4. `shared/logger.ts` 一个约 30 行的函数（`debug/info/warn/error` + 级别过滤 + 结构化字段），`src/API/methods/*` 全量替换。前端构建时通过 `import.meta.env.PROD` 把 `debug/info` 摇掉。

---

### 3.8 可访问性

**结论：这是全项目做得最扎实的一块，超出「个人导航站」的普遍水平。唯一实质缺陷是拖拽的读屏播报念英文。**

| 发现                                                         | 证据                                                                                                      | 等级 | 优先级 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -- | --- |
| **dnd-kit 播报文案是英文**（纯中文产品的读屏用户听不懂），且播报里带 `site-12` 这种内部 id | 全站 `grep accessibility\|announcements\|screenReaderInstructions` **零命中**；4 处 `DndContext` 都配了键盘传感器但没配文案 | 中  | P2  |
| `audit:a11y` 只扫首页与记事本两页，**分享页、登录页在门禁外**（而分享页是陌生人第一次打开的入口）  | `a11y-audit.mjs:74-76`                                                                                  | 低  | P3  |

**做得好的（逐项核对过，无需重复体检）**：

- **`prefers-reduced-motion` 用 `*` + `!important` 全局覆盖**（`index.css:930-962`），比逐个类关更抗新增 —— 将来新加的动画不会漏网。
- **`aria-live` 25 处 + 一个常驻的专用播报组件**（`AriaLiveRegion.tsx`，注释解释了「必须常驻，因为 aria-live 区域必须先于内容存在」），异步结果全都播。
- **162 个弹窗全走 MUI `Dialog`**（手写 `role="dialog"` 0 处）→ `aria-modal`、焦点陷阱、关闭后焦点归还全由框架保证。
- **118 个 `IconButton` 的 `aria-label` 覆盖率 100%**。
- **表单可访问性自动接线**：89 个输入全是 `<TextField>` → MUI 自动挂 `aria-describedby` 与 `aria-invalid`（`grep aria-invalid` = 0 是**正常的**，不是漏了）。
- 没有「只靠颜色/图标承载唯一信息」的状态。


**具体方案**

1. 4 处 `DndContext` 统一注入中文 `accessibility`（建议抽成 `src/components/dndA11y.ts` 一处导出，4 处共用，否则又是一次四份复制）：
   ```tsx
   accessibility={{
     screenReaderInstructions: { draggable: "按空格拿起，用方向键移动，再按空格放下，按 Esc 取消。" },
     announcements: {
       onDragStart: ({ active }) => `已拿起「${labelOf(active.id)}」`,
       onDragOver: ({ active, over }) => over ? `「${labelOf(active.id)}」移动到「${labelOf(over.id)}」上方` : "已离开可放置区域",
       onDragEnd: ({ active, over }) => over ? `「${labelOf(active.id)}」已放到「${labelOf(over.id)}」` : "已放下",
       onDragCancel: ({ active }) => `已取消，「${labelOf(active.id)}」回到原位`,
     },
   }}
   ```
2. `a11y-audit.mjs` 的场景从 2 个扩到 4 个（加 `/login` 与 `/s/<token>`）；扫描表达式加一条：`[aria-invalid="true"]` 的元素必须同时有 `aria-describedby` —— 这条能自动抓住未来所有自定义表单。

---

### 3.9 文档完整性

**结论：不是「没写」，是 47 份文档没入口、没分层、没状态。32 份带日期的历史报告把 2 份真正有用的长期文档埋了。**

| 发现 | 证据 | 等级 | 优先级 |
|---|---|---|---|
| `docs/` 47 个文件（40 个 .md），**无 `README.md`、无索引**；同一主题有 6 份 inkstone 对比报告 | `ls docs/README.md` 不存在 | 中 | P1 |
| README 本地开发缺 `.dev.vars`，第 2 步 `npm run dev` 就全站 503，且报错文案把人往部署环境带 | `wrangler.jsonc:105` `AUTH_ENABLED:"true"`；`worker/index.ts:265` 入口最前面就 return 503 | 高 | **P0** |
| README 的 Cloudflare 部署缺「换 `database_id` / KV `id`」这一步 → 手动部署者会把数据写进作者的库 | `wrangler.jsonc:47/72` 是作者本人实例；:41-42 自己写了警告但 README 没转述 | 中 | P1 |
| **6 个环境变量在代码里生效但文档零覆盖** | `NAVIHIVE_SLOW_QUERY_MS` / `NAVIHIVE_UPGRADE_SPOOL` / `NAVIHIVE_IMAGE` / `NAVIHIVE_COMPOSE_DIR` / `NAVIHIVE_DOCKER_SOCK` / `NAVIHIVE_UPGRADE_DIR` | 中 | P1 |
| **没有任何面向贡献者的文档**（加一个端点要同步 6 处 + 2 道守卫，这套顺序只存在于代码里） | 无 `CONTRIBUTING.md` | 高 | P1 |
| `deploy/selfhost.md:191-250` 与 `docker-compose.yml` **完全相反**，照做等于主动交出宿主机 root | 手册教挂 sock + `user:"0:0"`；compose `:72` 明确「**不再挂**」 | 高 | **P0** |
| **三份运维文档互相矛盾**，且都不对应现在的生产形态 | `selfhost.md`（裸机 Nginx）/ `vps-redeploy-runbook`（kPanel）/ `nginx/README.md`（反代到 CF） | 中 | P1 |
| 运维手册缺四块：升级回滚、备份恢复演练、初始账号/重置、双部署数据迁移注意事项 | `grep 回滚` 只有 DNS 改回与一句「容器升级回滚更干净」 | 高 | **P0** |
| `npm run check:whitedot` 指向不存在的脚本（`probe-white-dot.mjs` 才是真名） | `package.json:38` | 低 | P3 |
| CHANGELOG 5,440 行 / 222 条**无索引**；版本号只出现在最近 18 条标题里，git 里的 `v3.1.1`/`v6.0.0` 在 CHANGELOG 里查不到 | 18 条带版本号 vs 204 条只有日期 | 中 | P2 |
| CHANGELOG 里大量「真机探针 N/N 通过」引用的 `harness/*.mjs` **已不在仓库** | `ls harness` 无此目录，但至少 8 处引用 | 中 | P2 |

**做得好的**：README 的可信度有机器守卫 —— 徽章里的 React 19.3 / TS 6.0 / MUI 9.5 与 `package-lock.json` 实测版本**逐项一致**，目录结构与实际 `ls` 一致，5 张截图全部存在。

**具体方案**

1. **`docs/README.md` 作为唯一索引**，分三栏：长期文档（`pitfalls.md` / `style-guide` / `notebook-design`）/ 运维手册（并注明「哪一份对应现在的生产形态」）/ 历史报告（按月份分组，每条一句话结论 + 状态标记 `已落地/部分落地/已废弃`）。索引只写一行一条，别写摘要。
2. **README 加「第 0 步」**：
   ```bash
   printf 'AUTH_SECRET=%s\nAUTH_USERNAME=root\nAUTH_PASSWORD=dev-only\n' "$(openssl rand -hex 32)" > .dev.vars
   ```
   并加一句反常识提示：「不建 `.dev.vars` 时 `npm run dev` 会全站 503，这是有意的（缺密钥时凭据加密等价明文）」。
3. **重写 `deploy/selfhost.md:191-250`**：把「必须 `user: 0:0`」整段删掉，改成 spool 方案原理（应用只写 `/spool/request`，upgrader 持 sock）+ 三种选法（默认 upgrader / 不挂 sock 手动 pull / 自己改回 sock 不推荐）。
4. **新增三节**：「升级与回滚」（含**回滚三步**与「为什么可以只回退代码不回退库」的依据：18 个迁移 step 全文无 `DROP`，全是 `ADD COLUMN` 与 `CREATE TABLE IF NOT EXISTS`）；「备份与恢复」（备/验/恢三段，并诚实写明「目前没有恢复演练记录」）；「账号与密钥」（三个脚本的用途/前置/后果）。
5. **`docs/contributing.md`**：加端点 6 处清单 + 两道守卫、加页面 lazy 预取三件套、三类测试分别什么时候用、提交与推送流程。
6. 三份运维文档各加一行「本文对应哪种形态，什么时候该读」。

---

### 3.10 部署与运维

**结论：容器层做得比大多数自托管项目都干净，几乎挑不出结构性问题。真正的风险全在「从 commit 到生产」这条链的自动化缺口。**

| 发现 | 证据 | 等级 | 优先级 |
|---|---|---|---|
| **镜像发布不看 CI 结论**：`docker-publish.yml` 只有 `on: push: branches:[main] paths:`，无 `workflow_run`、无 `needs`、无结论判断；而生产拉的是 `:latest` | 对照 `deploy.yml:68-120` 的严格门禁（要求 `conclusion == success`） | 高 | **P0** |
| **发布链依赖仓库外的脚本 + 某台机器的 SSH 私钥** | `vps-run.py` / `rest-push.py` 都在仓库外；仓库里只有 `script/chromeToJSON.py` | 高 | **P0** |
| **没有回滚方案**：只打 `:latest` 与 `:<sha>`，GHCR 无保留策略；`NAVIHIVE_IMAGE` 这个回滚旋钮文档零覆盖 | `docker-publish.yml:133-139` | 高 | **P0** |
| **备份只有 WebDAV 一条路；不设备份密码就明文上传**；从未验证过恢复 | `worker/notesBackup.ts:393/397` `body = password ? encrypt : zip` | 高 | **P0** |
| 生产核验靠人肉：比对 image digest、5 路验证、看 `.navihive-upgrade.log` | `MEMORY.md` 明写这条「会导致把旧镜像当新版验收」 | 中 | P1 |
| `Deploy`（Cloudflare）自 v14.0.0 起**每次都红**（缺 `CLOUDFLARE_API_TOKEN`），没人修也没人关 → 训练团队无视红灯 | 本次实测：`Deploy failure` 只挂在 `Deploy to Cloudflare Workers` 那一步 | 中 | P1 |
| upgrader 把宿主路径**硬编码**成 `/home/docker/navihive`，与 README 的任意目录、selfhost.md 的 `/opt/navihive` 冲突 → 换机器一键升级静默失败 | `docker-compose.yml:113/147` | 高 | P1 |
| `docker-publish` 的 paths 白名单靠人维护（漏一个就静默落后一个 commit） | 已因此发生过一次事故（注释记录了） | 中 | P2 |
| 容器无资源上限（无 `mem_limit` / `cpus`） | 而 systemd 接法里写了 `MemoryMax=512M`，两套接法不齐 | 中 | P2 |
| 基础镜像未固定 digest（`node:24-slim` / `docker:27-cli`），而 gitleaks 固定了 `v8.30.1` 并解释了原因 | 同一套推理没用到基础镜像上 | 低 | P3 |

**做得好的（逐项核对）**：多阶段构建 + 运行阶段零依赖（runtime 只 COPY `dist/client` 与 `dist-server/entry.mjs`，**没有 node_modules、没有源码**）；非 root（`USER node`，compose 默认 `NAVIHIVE_RUN_AS:-node`）；`HEALTHCHECK` 打 `/api/init`（真读库，比 TCP 探活强）；`.dockerignore` 该排的都排了（尤其 `.env`）；日志轮转已配；CI 并发控制两处都做对了且反向设置正确（CI 取消、部署不取消）。

**具体方案**

1. **`docker-publish.yml` 加 CI 门禁**：改成 `on: workflow_run: workflows: ["CI"], types: [completed], branches: [main]`，顶部加一个与 `deploy.yml:68-120` 同款的 gate job（直接复制那段 shell，改成 `if conclusion != success → exit 1`，`ref` 用 `github.event.workflow_run.head_sha`）。保留 `workflow_dispatch` 作紧急出口，但同样要求填 `ci_run_id`。
2. **写 `docs/deploy/release.md`**：五步各配一条命令 + 预期输出 —— ①`npm run ci` ②推 main（写清为什么用 REST：github.com:443 不通）③等 GHCR 出现本次 commit 的 tag（`docker buildx imagetools inspect ghcr.io/…:<sha>`）④VPS `docker pull` + `up -d --force-recreate` ⑤**5 路验证清单**（登录 / 首屏 / 建一条站点 / 建一条笔记 / 图片上传），每项给点击路径或 curl。
3. **把回滚写进文档**（和 §3.9 第 4 条同一件事）：回滚三步 + 「迁移是纯加列所以只回退代码是安全的」+ **它的有效期**（一旦有人加了 `DROP COLUMN`，这条就不成立，必须同步更新本节）。
4. **备份三件事**：①把「不设备份密码 = 未加密 zip 上传网盘（含站点账号密码）」写进 README 与设置界面文案；②加一条宿主 crontab 的 `VACUUM INTO` + `tar` 兜底（`selfhost.md:307-327` 已有现成命令，只是没说要挂 cron）；③**真做一次恢复演练并把日期写进文档** —— 这是唯一能让「备份存在」变成「备份可用」的动作。
5. **paths 白名单改成排除式**：`paths-ignore: ['**.md', 'docs/**', 'tests/**', '.github/**']`。语义从「列举会变的东西」（漏一个就静默落后）翻转成「列举不会变的东西」（漏一个只是多构建一次）。这是这类白名单唯一安全的写法。
6. upgrader 路径改 `- ${NAVIHIVE_COMPOSE_DIR:-.}:${NAVIHIVE_COMPOSE_DIR:-.}`（这个变量代码里已经在读，只是 compose 没用它）。
7. `Deploy` 工作流二选一落定：加 secret 恢复可用（它是唯一的真实回滚目标，5 分钟），或承认停用、只留 `workflow_dispatch`（10 分钟）。**别再挂着每次报红。**

---

### 3.11 异常与容错处理

**结论：输入校验和乐观回滚明显高于平均水位；结构性短板集中在「认证失效」与「超时判定」两条主链上。**

| 发现 | 证据 | 等级 | 优先级 |
|---|---|---|---|
| **`ErrorBoundary` 只有根上一处**，`<SiteListBody>`（`App.tsx:1917`）与登录页裸奔 → 一张脏卡片能打掉整站 | 全站唯一 `ErrorBoundary` 在 `main.tsx:122`；`ChunkBoundary` 21 处但都在 else 分支 | 高 | **P0** |
| **401/403 只在 `bootstrap` 与 `checkAuthStatus` 生效**，其余接口 401 只弹 toast，用户卡在页面上永不回登录页 | `onAuthFail` 全仓 3 处命中，实际调用点只有 `useSites.ts:92` | 高 | **P0** |
| **`middleware.ts` 4 处 401 回纯文本**，破坏统一 envelope，`code` 传不出来（上面那条的根因） | `:38/:48/:58/:94` | 高 | **P0** |
| 错误码体系做了 5 轮但**前端零消费**，判错仍靠 `message.includes`（5 处） | `API_ERROR_CODES.` 全仓 3 次全在产出侧；`ApiError.is()` **零调用** | 高 | P1 |
| **25MB 附件上传必超时**：慢端点靠端点名正则豁免，而 `notes/attachments` 不含 `upload` | `client.ts:122`；`notes.ts:130`；`ATTACHMENT_MAX_BYTES = 25MB`；25MB/30s ≈ 830KB/s | 高 | P1 |
| 读操作**零重试**（写操作有完整的指数退避 + 抖动，只包 mutation） | `offlineQueue.ts:88-98` 设计很好但只覆盖写 | 中 | P2 |
| `useAccountSession` 有 3 个裸 `fetch`，其中「拉账号清单」**静默失败**（`if (!res.ok) return;`） | `:227-235` | 中 | P2 |
| 排序**部分失败**时本地一条都不更新，但服务端改了一部分 → UI 与库不一致 | `useSortController.ts:203-210` | 中 | P2 |
| `bootstrap` 只挡了 `null`，没挡「不是数组」（`{}` / `""` 会让 `for...of` 与 `.filter` 抛） | `useSites.ts:44-63` | 中 | P2 |
| 自托管自定义端点返回**第三种错误形状**，前端把 `error` 字段直接丢掉 | `server/entry.ts:936/955/1028` vs `VersionUpgradeSection.tsx:183-193` | 中 | P2 |
| 429（限速）前端**完全没处理**，而注释承诺有「重试按钮」 | `apiError.ts:11` 的承诺不存在 | 低 | P3 |

**做得好的**：`readJsonBody` 三档严格解析 + `tests/jsonBodyGuard.test.ts` 静态守卫（递归扫 `worker/**.ts`、剥注释、断言「除自己外不许裸 `request.json()`」，且守卫本身被审过一次并收紧了豁免）—— 这是本次审查里最规范的一环；`useNotes.runUpdate` 有快照回滚 + 同笔记写入串行化 + 一个关键安全闸（`content_truncated` 时先 `ensureFullNote`，防止把摘要当全文写回库）；排序保存**不做乐观更新**（服务端成功后才改本地，所以「拖拽后保存失败会不一致」这个常见坑不存在）；离线四件事齐全（横幅 / 待同步角标 / 失败列表可重试可放弃 / 启动主动重放）；171 个 `useEffect` 里只有 2 个「含异步且无 cleanup」，且都有替代守卫。

**具体方案**（严格按依赖顺序）

1. **先修 `middleware.ts` 的 4 处纯文本 401** → 全部换成 `errorResponse(ApiError.unauthenticated(<原中文>), { headers: <原 headers> })`（`:48` 保留 `WWW-Authenticate`）。
2. **再把 `message.includes` 换成 `err.code`**（5 处）。顺序反了 `useSites.ts:91` 会直接坏。加一条守卫：`grep` 断言 `src/` 下除 `chunkFailure.ts` 外不再出现 `includes("认证")`。
3. **401 处置下沉到统一出口**：在 `client.ts:157` 的 401 分支里 `window.dispatchEvent(new CustomEvent("navihive:unauthorized"))`，`App` 挂一个监听器统一处理 —— 这样裸 `fetch` 走的三条路也能覆盖。
4. **给主站列表与登录页各加一个 `RenderBoundary`**（复用 `ErrorBoundary` 的 UI 加 `onReset`）：
   ```tsx
   <RenderBoundary label="站点列表">  {/* App.tsx:1917 */}
   <RenderBoundary label="登录页">    {/* App.tsx:1620 */}
   ```
   单卡片崩溃只显示「站点列表这块出了点问题，点这里重试」，顶栏和记事本入口还在。
5. **附件上传显式传 `timeoutMs: 0`**（`request` 已支持），并把 `slow` 正则换成显式白名单、删掉不可达的 `icon` 分支；`iconBatch.ts:122` 的裸 fetch 加 `AbortSignal.timeout(8000)`。
6. 读操作加 2 次退避重试（300ms / 900ms + 抖动），只对幂等 GET 且只对 `status === 0` 与 `503` 生效。**写操作不要在这一层加重试** —— 已有离线队列接住，两处重试会打架。
7. `useSites.ts:46` 改用 `Array.isArray` 判定，并在形状异常时 `onError`。

---

## 4. 建议执行路线

三个批次，按「先止血、再提效、后偿还」。

### 批次一：止血（约 1.5 天，14 项 P0）

| 顺序 | 动作 | 工作量 |
|---|---|---|
| 1 | `unit-tests.mjs` 加 `--test-timeout=60000` + `--test-concurrency=4`（2 行） | 10 分钟 |
| 2 | 锁文件加 `process.kill(pid, 0)` 活性探测（15 行） | 30 分钟 |
| 3 | `docker-publish.yml` 加 CI 门禁 gate job | 30 分钟 |
| 4 | `middleware.ts` 4 处纯文本 401 改 `errorResponse` | 20 分钟 |
| 5 | 前端 5 处 `includes` 改 `err.code` + 401 统一下沉 | 1 小时 |
| 6 | 主站列表 + 登录页各加 `RenderBoundary` | 40 分钟 |
| 7 | 删 `pnpm-workspace.yaml` + 加 `packageManager` + README 一句 | 15 分钟 |
| 8 | README 加 `.dev.vars` 第 0 步 | 10 分钟 |
| 9 | 重写 `selfhost.md` 的 sock 一节 | 1 小时 |
| 10 | 写 `docs/deploy/release.md`（含回滚三步与 5 路验证） | 1 小时 |
| 11 | 备份文案改「不设密码 = 明文上传」+ 宿主 crontab 兜底 | 1 小时 |
| 12 | **真做一次恢复演练**，把日期写进文档 | 1 小时 |
| 13 | 500 落库 + 请求 ID 注入 | 1 小时 |
| 14 | 把 `MEMORY.md` 里可公开的部分拆进仓库 | 1 小时 |

### 批次二：提效（约 3 天，10 项高性价比 P1）

`npm i -D c8`（一行换真覆盖率）→ FTS rowid 改造（实测 16.5×）+ 一次迁移 → ~~nginx `gzip_proxied any`（一行）~~（2026-10-28 复核：归因不成立，已作废，见 3.1）→ 笔记列表分页 → 轮询带指纹 → 备份版本闸门 + 3 条用例 → `NotesBackupTab` 补测试 → 附件上传超时修正 → 预览 `useDeferredValue` → 三处 Node 版本对齐 + `engines`。

### 批次三：偿还（约 1 周，结构性）

`NotesPage.tsx` 3481 → ≤900 行（六条现成的切割线）→ `importData` 834 行函数按阶段拆 → `src/utils/format.ts` 收敛 6 份日期格式化 → 13 个死导出 + `BACKUP_NOTES_CONFIG` 的过时注释清理 → `docs/README.md` 索引 + `docs/contributing.md` → `lint-warnings-budget` 加 disable 理由闸 → dnd-kit 中文播报 → `shared/logger.ts` 统一日志。

---

## 5. 本轮验证说明

### 由主理人二次复核过的结论（不是只采信成员报告）

| 结论 | 复核方式 |
|---|---|
| `notes_fts` 的 `note_id` 是 `UNINDEXED`，同步走 `DELETE ... WHERE note_id` | 读 `internals.ts:149` + `notesSearch.ts:39` |
| `listNotes` 的 SQL 无 `LIMIT` | 读 `notesNote.ts:98` |
| ~~nginx `gzip_proxied` 全目录 0 次~~ → **该证据推不出「API 未压缩」（2026-10-28 复核）** | 当时的 `grep -rn gzip_proxied deploy/nginx/ \| wc -l` 只数了**仓库里两份模板**，没看生产实际加载的 `nginx.conf`（kPanel 管的那份）。复核：生产 `nginx.conf` 没有 `gzip_proxied`，但 `gzip_types` 含 `application/json`，`/assets/react-*.js` 实测 `content-encoding: gzip` —— 反代这层一直在压 |
| `console` 分布 61/23/13 | 逐目录 grep 计数，与成员报告逐项吻合 |
| 请求 ID 全仓零命中 | `grep x-request-id\|requestId` 排除 `requestIdleCallback` 后为空 |
| `unit-tests.mjs:295` 无超时参数 | 读源码 |
| 锁逻辑无活性探测 | 读 `:169-186` |
| `c8` 未安装 | `ls node_modules/c8` 不存在 + `package.json` 无 c8 |
| `EXPORT_VERSION` 读完即丢 | 读 `transfer.ts:202/1205/1330`，全文件无版本比较 |
| Node 版本 22/22/24 三处不一致 | 读 `.nvmrc` / 四个 workflow / `Dockerfile:14,33` |
| `.dev.vars` 缺失导致 503 | 无该文件；`wrangler.jsonc:105` + `worker/index.ts:265` |
| `docker-publish` 无 CI 门禁 | 读 `:45-60` |
| `pnpm-workspace.yaml` 在、`pnpm-lock.yaml` 被 ignore | `cat` + `ls` + `.gitignore:29` |
| `selfhost.md` 与 compose 相反 | 手册 :193/:227/:231 vs compose :72/:145 |
| `<SiteListBody>` 无错误边界保护 | 读 `App.tsx:1912-1920`，`ChunkBoundary` 在 1913 已闭合 |
| `onAuthFail` 只有一个实际调用点 | `grep -rn onAuthFail src/` = 3 处（1 声明 + 1 类型 + 1 调用） |
| `middleware.ts` 4 处纯文本 401 | 读 `:38/48/58/94` |
| `notes/attachments` 不含 `upload` → 拿到 30s 超时 | 读 `notes.ts:130` + `client.ts:122` |
| `API_ERROR_CODES.` 只在产出侧、`ApiError.is()` 零调用 | 3 次命中全在 `client.ts`；`.is(` grep 为空 |

**一处自我纠正**：我最初据 `AbortController` 在 `src/` 只有 1 处判断「请求从不超时」，读 `client.ts:124` 后发现用的是 `AbortSignal.timeout(timeoutMs)`，默认 30 秒且超时有中文提示 —— **超时是做了的**。这条没有进入报告的问题清单。

### 未能验证的部分（诚实标注）

|  |  |
| --- | --- |
- 线上真实响应是否已压缩：需在 VPS 上 `curl -sI -H 'Accept-Encoding: gzip' https://<host>/api/groups | grep -i content-encoding` 确认。
- mermaid 内嵌 katex 0.19 是否真的会炸：**未实测**，所以建议是「加一条用例把风险变显式」而不是「直接回退」。
- 1 万条笔记时 FTS 同步的 250 ms 是**按实测斜率外推**（25 µs/条，三段线性），没有 1 万条的实测点。
- `npm run dev` 起不来 503 是**代码推断**，未实跑（避免在审查期间改动本地状态）。
- `pruneAttachments` 是否真的没有 cron 入口：未穷尽搜索，标注为待确认。

---

## 附：一句话给未来的自己

这个项目的**代码**值得信任，**门禁**需要修，**运维交接**从零开始。最贵的缺口不是任何一个具体 bug，而是「能力存在但没人知道它存在」——回滚能力、行覆盖率能力、`NAVIHIVE_IMAGE` 旋钮、`.navihive-upgrade.log` 的位置，全都躺在代码或未提交的笔记里。把知识从「我知道」变成「仓库知道」，比修十个 P1 更有价值。
