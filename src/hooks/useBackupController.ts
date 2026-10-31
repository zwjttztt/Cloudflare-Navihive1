import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { reportError } from "../utils/errorReporter";
import {
    BACKUP_CREDENTIALS_CONFIG,
    CRON_LAST_ERROR_KEY,
    EXPORT_VERSION,
    normalizeImportData,
    type ExportData,
    type WebDavConfig,
    type LocalPrefsBackup,
    type ImportProgress,
} from "../API/http";
import { NavigationClient } from "../API/client";
import { MockNavigationClient } from "../API/mock";
import { encryptBackup } from "../API/crypto";
import { GroupWithSites } from "../types";
import { verifyBackupIntegrity, withBackupIntegrity } from "../utils/backupIntegrity";
import {
    canWriteSharedConfigs,
    pickCronError,
    pickExportConfigs,
    remapLocalPrefs,
} from "../utils/backupScope";
import type { NotifyFn } from "../context/NotifyContext";
import { exportLinkHealth } from "../utils/linkHealth";
import { cronErrorDismissed, dismissCronError } from "../utils/cronErrorDismiss";

type CurrentUser = { username: string; role: "owner" | "user" } | null;

// 这些键名原本是 App 的模块级常量，这里自留一份让 hook 自包含
// （App 里同名的常量仍服务于 applyRemoteExtras 与 linkHealth/prefSync 推送逻辑）。
const WEBDAV_CONFIG_PREFIX = "webdav.";
const LINK_HEALTH_CONFIG = "link.health";
const LINK_HEALTH_SYNC_CONFIG = "link.healthSync";
const PREF_SYNC_CONFIG = "pref.sync";
const PREF_STARRED_CONFIG = "pref.starred";
const PREF_TAGS_CONFIG = "pref.tags";
const DEFAULT_WEBDAV_CONFIG: WebDavConfig = {
    url: "",
    username: "",
    password: "",
    path: "navihive-backup",
    backupPassword: "",
    allowPrivateNetwork: false,
};

interface BackupControllerDeps {
    api: NavigationClient | MockNavigationClient;
    configs: Record<string, string>;
    groups: GroupWithSites[];
    starred: number[];
    tags: Record<string, string[]>;
    currentUser: CurrentUser;
    notify: NotifyFn;
    handleError: (message: string) => void;
    handleMenuClose: () => void;
    /**
     * 打开「备份与恢复」。
     *
     * 2026-10-29：入口从独立弹窗换成「设置」中心的备份面板，
     * 所以这里不再自己开关弹窗，而是请上层把中心开到那一屏（tab 一起带过去：
     * 命令面板直达「恢复 / 导入」时要落在第二页）。
     */
    onOpenBackupPanel: (tab: number) => void;
    fetchData: () => Promise<boolean>;
    restoreLocalPrefs: (
        prefs: LocalPrefsBackup | undefined,
        mode: "replace" | "merge"
    ) => void;
    setConfigs: React.Dispatch<React.SetStateAction<Record<string, string>>>;
    setWebdavConfig: React.Dispatch<React.SetStateAction<WebDavConfig>>;
    setPrefSync: (value: boolean) => void;
    // 这两个 ref 与 App 里的 linkHealth / prefSync 推送逻辑共用（写入），传入避免重复
    lastHealthPushRef: MutableRefObject<string>;
    lastPrefPushRef: MutableRefObject<string>;
}

/**
 * 备份 / 导入 / WebDAV 同步控制器。
 *
 * 从 App.tsx 搬来的有：备份弹窗开关状态、cron 失败常驻提示、构造备份数据、
 * 下载到本地、导入预览的 promise 桥、整体导入/恢复，以及 WebDAV 配置写入与
 * 三个「同步开关」。WebDAV 配置状态本身（webdavConfig）仍留在 App——
 * applyConfigs 会写它，BackupDialog 也直接读它。
 *
 * 原 App 里这些名字直接解构自本 hook，引用点无需改动。
 */
export function useBackupController(deps: BackupControllerDeps) {
    const {
        api,
        configs,
        groups,
        starred,
        tags,
        currentUser,
        notify,
        handleError,
        handleMenuClose,
        onOpenBackupPanel,
        fetchData,
        restoreLocalPrefs,
        setConfigs,
        setWebdavConfig,
        setPrefSync,
        lastHealthPushRef,
        lastPrefPushRef,
    } = deps;

    // 备份面板停在哪个页签（0 = 备份，1 = 恢复 / 导入）。
    // 开关本身交给上层（中心），这里只记「落到哪一页」。
    const [backupTab, setBackupTab] = useState(0);

    // 导入预览：备份导入前先摊开差异让用户挑，确认/取消都通过 promise 回传给备份弹窗
    const [importPreview, setImportPreview] = useState<{
        data: ExportData;
        /** 预览要按覆盖口径列「将删除」清单（值本身仍以确认导入时的调用为准） */
        overwrite?: boolean;
    } | null>(null);
    const importPreviewResolve = useRef<((result: ExportData | null) => void) | null>(null);

    // 打开「备份与恢复」：记下要落的页签，再请上层把中心开到那一屏。
    // handleMenuClose 仍先走一遍（收起可能开着的旧入口），随后上层打开中心。
    const handleOpenBackup = (tab = 0) => {
        setBackupTab(tab);
        handleMenuClose();
        onOpenBackupPanel(tab);
    };

    // 最近一次定时任务（每周自动备份 / 死链巡检）的失败留痕，没有就是 null。
    // 定时任务跑在 Worker 里，失败了页面上毫无动静，只能靠启动时提示一句 +
    // 备份弹窗里常驻一条 —— 否则「自动备份其实早就不工作了」要等到真要恢复那天才发现。
    const cronError = useMemo(() => pickCronError(configs, CRON_LAST_ERROR_KEY), [configs]);

    // 启动后提示一次（同一条不重复弹）：定时任务失败不是用户当下的操作引起的，
    // 不提示的话他根本不会知道要去看一眼备份设置
    const cronErrorNotifiedRef = useRef<string>("");
    useEffect(() => {
        if (!cronError) return;
        if (cronErrorNotifiedRef.current === cronError.message) return;
        // 「忽略一周」生效期内不弹：用户明确说知道了的消息别再骚扰。
        // 留痕本体还在服务端，备份弹窗里仍能看到 —— 只是不再弹全局提示。
        if (cronErrorDismissed(cronError.message)) return;
        cronErrorNotifiedRef.current = cronError.message;
        // ⚠️ 三个任务的名字都要列全：notesBackup 之前落进 else 分支被标成「死链巡检」
        const taskLabel =
            cronError.task === "backup"
                ? "每周自动备份"
                : cronError.task === "notesBackup"
                  ? "记事本自动备份"
                  : "死链巡检";
        notify(
            `${taskLabel}未成功：${cronError.message}`,
            "error",
            8000,
            // 一周备份窗口内这条消息会一直挂在服务端，给个「忽略一周」的出口
            { label: "忽略一周", onClick: () => dismissCronError(cronError.message) }
        );
    }, [cronError, notify]);

    // 构造完整备份数据（分组 + 站点（含账号密码）+ 网站配置 + 本机星标/标签）
    const buildExportData = (): ExportData => {
        // 全站设置（标题 / 主题 / 背景…）是所有账号共用的，只有站点所有者（或未启用
        // 登录的单账号部署）才写进备份文件：否则这份备份被别的账号恢复时，会把整站
        // 外观一起改掉。按账号隔离的那批（webdav.*）属敏感配置，一律不进备份。
        const mayExportShared = canWriteSharedConfigs(currentUser);
        // 什么进备份文件的规则统一在 utils/backupScope 里（导出与导入共用同一份判定）
        const { own: ownConfigs, shared: sharedConfigs } = pickExportConfigs(
            configs,
            currentUser
        );

        return {
            groups: groups.map(group => ({
                id: group.id,
                name: group.name,
                order_num: group.order_num,
            })),
            sites: groups.flatMap(group =>
                group.sites.map(site => ({
                    ...site,
                    // 与后端 /api/export、每周定时备份用同一个开关：
                    // 关掉之后导出文件里不带网站账号密码
                    ...(configs[BACKUP_CREDENTIALS_CONFIG] === "true"
                        ? {}
                        : { username: "", password: "" }),
                }))
            ),
            // 全站设置（标题 / 主题 / 背景…）：所有者写进 sharedConfigs（恢复时会覆盖全站），
            // 普通账号只带自己那份外观，不会把整站长什么样改掉。
            configs: ownConfigs,
            ...(mayExportShared ? { sharedConfigs } : {}),
            version: EXPORT_VERSION,
            exportDate: new Date().toISOString(),
            // 星标 / 标签只存在本机，数据库里没有对应字段，所以由前端附带进备份文件
            localPrefs: {
                starred: [...starred],
                tags: { ...tags },
            },
        };
    };

    // 备份到本地：下载备份文件。传了口令就用它加密后再落盘（明文 JSON 会带着站点
    // 密码直接躺在磁盘 / 网盘同步目录里），不传则维持原来的明文 JSON（兼容老备份）。
    const handleDownloadLocal = async (password?: string) => {
        try {
            // 摘要在「写文件前的最后一刻」才算：这份数据里带着本机星标 / 标签（localPrefs），
            // 服务端那份 exportData 不知道它，早算一步就会对不上
            const dataStr = JSON.stringify(await withBackupIntegrity(buildExportData()), null, 2);
            const stamp = new Date().toISOString().slice(0, 10);

            let blob: Blob;
            let exportFileName: string;
            if (password) {
                const bytes = await encryptBackup(new TextEncoder().encode(dataStr), password);
                blob = new Blob([bytes], { type: "application/octet-stream" });
                // 换后缀：加密文件已经不是 JSON 了，用 .navihive 免得被当文本打开
                exportFileName = `导航站备份_${stamp}.navihive`;
            } else {
                blob = new Blob([dataStr], { type: "application/json;charset=utf-8" });
                exportFileName = `导航站备份_${stamp}.json`;
            }

            const url = URL.createObjectURL(blob);

            const linkElement = document.createElement("a");
            linkElement.setAttribute("href", url);
            linkElement.setAttribute("download", exportFileName);
            document.body.appendChild(linkElement);
            linkElement.click();
            document.body.removeChild(linkElement);
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (error) {
            reportError(error, { source: "backup-export" });
            handleError("导出数据失败: " + (error instanceof Error ? error.message : "未知错误"));
        }
    };

    // 保存 WebDAV 配置到服务端
    const handleSaveWebdavConfig = async (config: WebDavConfig) => {
        try {
            // 原来 5 个 setConfig 串行 = 5 次网络往返，网络慢时能把「连接成功」的反馈一起拖住。
            // 两个口令必须单独写（setConfig 会用 AUTH_SECRET 加密落库，批量接口不会），
            // 其余 4 项一次写完。
            await api.setConfigs({
                [`${WEBDAV_CONFIG_PREFIX}url`]: config.url,
                [`${WEBDAV_CONFIG_PREFIX}username`]: config.username,
                [`${WEBDAV_CONFIG_PREFIX}path`]: config.path || DEFAULT_WEBDAV_CONFIG.path,
                [`${WEBDAV_CONFIG_PREFIX}allowPrivateNetwork`]: config.allowPrivateNetwork ? "1" : "0",
            });
            // 两个口令都「写了才存、清空就删」：
            // worker 的 configs/{key} PUT 会拒绝空值（validateConfig 要求 value 非空），
            // 写空串会直接 400 —— 而备份口令是可选的，留空才是常态，所以清空必须走 DELETE。
            if (config.password) {
                await api.setConfig(`${WEBDAV_CONFIG_PREFIX}password`, config.password);
            } else {
                await api.deleteConfig(`${WEBDAV_CONFIG_PREFIX}password`);
            }
            // 备份口令单独存（落库加密），定时备份与恢复都靠它，与 AUTH_SECRET 无关
            if (config.backupPassword) {
                await api.setConfig(
                    `${WEBDAV_CONFIG_PREFIX}backupPassword`,
                    config.backupPassword
                );
            } else {
                await api.deleteConfig(`${WEBDAV_CONFIG_PREFIX}backupPassword`);
            }
            setWebdavConfig(config);
        } catch (error) {
            reportError(error, { source: "backup-webdav-save" });
            handleError("保存 WebDAV 配置失败: " + (error instanceof Error ? error.message : "未知错误"));
            throw error;
        }
    };

    // 每周自动备份开关（存在服务器，定时备份由 Worker 的 Cron 触发）
    // 注意顺序：先翻转本地状态，再发请求。Switch 是受控组件，如果等 await 回来才
    // setConfigs，从点下去到界面响应之间整整隔一个网络往返 —— 那就是「点一下卡一下」的来源。
    // 请求失败再回滚成原值。
    const handleToggleAutoBackup = async (enabled: boolean) => {
        const key = `${WEBDAV_CONFIG_PREFIX}autoBackup`;
        const previous = configs[key] ?? "true";
        const next = enabled ? "true" : "false";
        setConfigs(prev => ({ ...prev, [key]: next }));
        try {
            await api.setConfig(key, next);
        } catch (error) {
            setConfigs(prev => ({ ...prev, [key]: previous }));
            reportError(error, { source: "backup-auto-save" });
            handleError("保存自动备份设置失败: " + (error instanceof Error ? error.message : "未知错误"));
        }
    };

    /**
     * 开/关「备份文件带上网站登录凭据」。
     * 存服务端配置（不是本机偏好），这样 Worker 里的每周定时备份也读得到同一个开关。
     * 同样是乐观更新：开关先动、提示先弹，写库失败再回滚。
     */
    const handleToggleIncludeCredentials = async (enabled: boolean) => {
        const previous = configs[BACKUP_CREDENTIALS_CONFIG] ?? "false";
        const next = enabled ? "true" : "false";
        setConfigs(prev => ({ ...prev, [BACKUP_CREDENTIALS_CONFIG]: next }));
        notify(
            enabled ? "以后的备份会带上网站账号密码" : "以后的备份不再包含网站账号密码",
            "info"
        );
        try {
            await api.setConfig(BACKUP_CREDENTIALS_CONFIG, next);
        } catch (error) {
            setConfigs(prev => ({ ...prev, [BACKUP_CREDENTIALS_CONFIG]: previous }));
            reportError(error, { source: "backup-settings-save" });
            handleError(
                "保存备份设置失败: " + (error instanceof Error ? error.message : "未知错误")
            );
        }
    };

    /**
     * 开/关「失效检测结果同步到服务端」。
     * 打开时顺手把本机这份推一次，否则要等到下次探测才有内容上去。
     * 关掉不动服务端已经存的那份：下次再打开还能接着用（也方便误关后恢复）。
     */
    const handleToggleLinkHealthSync = async (enabled: boolean) => {
        const next = enabled ? "true" : "false";
        const rollback = configs[LINK_HEALTH_SYNC_CONFIG] ?? "";
        // 乐观更新：先拨开关再发请求。原来是 await 完才改状态，等于让用户盯着一个没反应的
        // 开关等一次网络往返（实测 150ms RTT 下要 188ms 才翻转）。
        setConfigs(prev => ({ ...prev, [LINK_HEALTH_SYNC_CONFIG]: next }));
        try {
            await api.setConfig(LINK_HEALTH_SYNC_CONFIG, next);
            if (enabled) {
                const payload = JSON.stringify(exportLinkHealth());
                await api.setConfig(LINK_HEALTH_CONFIG, payload);
                lastHealthPushRef.current = payload;
                notify("失效检测结果已同步到服务端", "success");
            } else {
                notify("已停止同步失效检测结果（服务端那份先留着）", "info");
            }
        } catch (error) {
            // 没写进去就把开关拨回去，别让界面显示一个不存在的状态
            setConfigs(prev => ({ ...prev, [LINK_HEALTH_SYNC_CONFIG]: rollback }));
            reportError(error, { source: "backup-sync-save" });
            handleError(
                "保存同步设置失败: " + (error instanceof Error ? error.message : "未知错误")
            );
        }
    };

    /**
     * 开/关「星标与标签同步到服务端」。
     * 这两样本机是唯一来源，所以打开时先推一份上去，避免另一台设备看到的还是空的。
     */
    const handleTogglePrefSync = async (enabled: boolean) => {
        if (!enabled) {
            setPrefSync(false);
            try {
                await api.setConfig(PREF_SYNC_CONFIG, "false");
            } catch {
                // 关同步失败不用打扰用户，本机已经不再上传了
            }
            notify("已停止同步星标与标签", "info");
            return;
        }

        // 乐观更新：打开时本来要连发 3 次配置写入，串行 await 完才拨开关，
        // 实测 150ms RTT 下要 374ms 才有反馈。先拨开关，三次写入并发发出去。
        setPrefSync(true);
        const payload = JSON.stringify({ starred, tags });
        try {
            await Promise.all([
                api.setConfig(PREF_SYNC_CONFIG, "true"),
                api.setConfig(PREF_STARRED_CONFIG, JSON.stringify(starred)),
                api.setConfig(PREF_TAGS_CONFIG, JSON.stringify(tags)),
            ]);
            // 记一下刚推的内容，免得开关打开后立刻又原样推一次
            lastPrefPushRef.current = payload;
            notify("星标与标签已同步到服务端", "success");
        } catch (error) {
            setPrefSync(false);
            reportError(error, { source: "backup-sync-save" });
            handleError(
                "保存同步设置失败: " + (error instanceof Error ? error.message : "未知错误")
            );
        }
    };

    // 导入前的差异预览：弹出预览框，等用户确认（返回裁剪后的数据）或取消（返回 null）。
    // overwrite 一起带进预览：覆盖模式下预览要列出「将删除」清单并要求二次确认
    const requestImportPreview = (data: ExportData, overwrite: boolean) => {
        setImportPreview({ data, overwrite });
        return new Promise<ExportData | null>(resolve => {
            importPreviewResolve.current = resolve;
        });
    };

    const closeImportPreview = (result: ExportData | null) => {
        setImportPreview(null);
        const resolve = importPreviewResolve.current;
        importPreviewResolve.current = null;
        resolve?.(result);
    };

    // 导入 / 恢复数据。
    //
    // 默认（overwrite=false）走**增量合并 upsert**：认得出是同一条的就更新或跳过，
    // 认不出的才新建，本地多出来的一根汗毛都不动 —— 重复导入是幂等的。
    //
    // overwrite=true（用户在恢复页显式勾了「覆盖导入」，且在预览里确认过删除清单）
    // 会额外让服务端删掉「备份里没有」的分组 / 卡片 / 笔记 —— 删除与写入在同一个
    // 事务里，要么整份生效要么一个字节都不变。界面默认永远是合并。
    const handleImportBackup = async (
        data: ExportData,
        overwrite: boolean,
        onProgress?: (progress: ImportProgress) => void
    ) => {
        try {
            // 恢复前先验文件有没有损坏。必须拿**原始**数据验：normalizeImportData 会补默认值、
            // 重排字段，归一化之后再算摘要必然对不上，好文件也会被拦下来。
            const integrityCheck = await verifyBackupIntegrity(data);
            if (!integrityCheck.ok) {
                throw new Error(integrityCheck.reason || "备份文件校验失败");
            }

            const normalized = normalizeImportData(data);
            // 站点 id 映射：服务端认出「同一条」时不换 id，新建时会重发号并回传映射，
            // 两种情形都要它来把备份里的星标 / 标签翻译到库里的 id 上
            const siteIdMap = new Map<number, number>();

            // 空备份当成失败处理：一份没有分组也没有卡片的备份导进来不会动任何东西，
            // 多半是文件选错了 / 解析没成功。宁可报错让人重选，也不要「导入成功」后一片安静。
            if (normalized.groups.length === 0 && normalized.sites.length === 0) {
                throw new Error("这份备份里没有任何分组或卡片，已取消导入（现有数据未改动）");
            }

            // 传原始 data（不是 normalized）：服务端会自己归一化，
            // 而完整性校验必须在归一化之前做，否则摘要永远对不上。
            // onProgress 让服务端把真实阶段进度流式推回来 —— 几千条站点要跑好几秒，
            // 一个不带动的转圈跟卡死没区别。模式走 opts（不塞进 body：文件摘要是对
            // 整份 payload 算的，多一个字段好文件也会被拦）。
            const result = await api.importData(data, {
                ...(overwrite ? { mode: "overwrite" as const } : {}),
                ...(onProgress ? { onProgress } : {}),
            });
            if (!result.success) {
                throw new Error(result.message || "服务端导入失败");
            }
            for (const [oldId, newId] of Object.entries(result.siteIdMap || {})) {
                siteIdMap.set(Number(oldId), newId);
            }

            // 把备份里的星标 / 标签写回本机 localStorage：
            // 服务端可能重新发号（也可能认出同一条沿用原 id），按映射翻译一遍就两种都对。
            const prefs = normalized.localPrefs;
            const remapped = remapLocalPrefs(prefs, siteIdMap);
            // 合并导入只补缺不删；覆盖导入按备份整份替换（与覆盖的语义一致）
            if (remapped) {
                restoreLocalPrefs(remapped, overwrite ? "replace" : "merge");
            }

            // 恢复/导入是低频重操作，这里同步刷新一次（一次 bootstrap 请求）
            await fetchData();
            // 把服务端数出来的账交给调用方：重复导入时「新增 0」是幂等性唯一可见的证据
            return result;
        } catch (error) {
            reportError(error, { source: "backup-import" });
            handleError("导入数据失败: " + (error instanceof Error ? error.message : "未知错误"));
            throw error;
        }
    };

    return {
        backupTab,
        setBackupTab,
        importPreview,
        setImportPreview,
        importPreviewResolve,
        cronError,
        handleOpenBackup,
        buildExportData,
        handleDownloadLocal,
        handleSaveWebdavConfig,
        handleToggleAutoBackup,
        handleToggleIncludeCredentials,
        handleToggleLinkHealthSync,
        handleTogglePrefSync,
        requestImportPreview,
        closeImportPreview,
        handleImportBackup,
    };
}
