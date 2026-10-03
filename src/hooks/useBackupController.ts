import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { reportError } from "../utils/errorReporter";
import {
    BACKUP_CREDENTIALS_CONFIG,
    CRON_LAST_ERROR_KEY,
    EXPORT_VERSION,
    normalizeImportData,
    type ExportData,
    type Group,
    type Site,
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
    pickImportConfigEntries,
    remapLocalPrefs,
} from "../utils/backupScope";
import { NotifySeverity } from "./useNotify";
import { exportLinkHealth } from "../utils/linkHealth";

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
    notify: (message: string, severity?: NotifySeverity, duration?: number) => void;
    handleError: (message: string) => void;
    handleMenuClose: () => void;
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
        fetchData,
        restoreLocalPrefs,
        setConfigs,
        setWebdavConfig,
        setPrefSync,
        lastHealthPushRef,
        lastPrefPushRef,
    } = deps;

    // 备份/恢复对话框状态
    const [openBackup, setOpenBackup] = useState(false);
    const [backupTab, setBackupTab] = useState(0);

    // 导入预览：备份恢复前先摊开差异让用户挑，确认/取消都通过 promise 回传给备份弹窗
    const [importPreview, setImportPreview] = useState<{
        data: ExportData;
        overwrite: boolean;
    } | null>(null);
    const importPreviewResolve = useRef<((result: ExportData | null) => void) | null>(null);

    const handleOpenBackup = (tab = 0) => {
        setBackupTab(tab);
        setOpenBackup(true);
        handleMenuClose();
    };

    const handleCloseBackup = () => {
        setOpenBackup(false);
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
        cronErrorNotifiedRef.current = cronError.message;
        notify(
            `${cronError.task === "backup" ? "每周自动备份" : "死链巡检"}未成功：${
                cronError.message
            }`,
            "error",
            8000
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

    // 导入前的差异预览：弹出预览框，等用户确认（返回裁剪后的数据）或取消（返回 null）
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

    // 导入/恢复数据：overwrite=true 覆盖恢复（服务端整体导入），false 合并追加
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
            // 站点 id 映射：覆盖恢复由服务端重新发号并回传映射，合并导入在下面自己建，
            // 两种模式都要它来把备份里的星标 / 标签翻译到新 id 上
            const siteIdMap = new Map<number, number>();
            // 全站共享配置只有所有者（或未启用登录的单账号部署）能改，
            // 免得普通账号拿别人的备份恢复时把整站外观改掉
            // 能不能改全站外观由 pickImportConfigEntries 判定（见 utils/backupScope）

            // 空备份当成失败处理：覆盖恢复的语义是「以这份备份为准」，拿一份没有分组
            // 也没有卡片的备份去覆盖，等于把账号清空 —— 多半是文件选错了 / 解析没成功。
            // 宁可报错让人重选，也不要「恢复成功」后一片空白。
            if (normalized.groups.length === 0 && normalized.sites.length === 0) {
                throw new Error("这份备份里没有任何分组或卡片，已取消导入（现有数据未改动）");
            }

            if (overwrite) {
                // 传原始 data（不是 normalized）：服务端会自己归一化，
                // 而完整性校验必须在归一化之前做，否则摘要永远对不上。
                // onProgress 让服务端把真实阶段进度流式推回来 —— 覆盖恢复可能要跑好几秒，
                // 一个不带动的转圈跟卡死没区别。
                const result = await api.importData(data, onProgress ? { onProgress } : undefined);
                if (!result.success) {
                    throw new Error(result.message || "服务端导入失败");
                }
                for (const [oldId, newId] of Object.entries(result.siteIdMap || {})) {
                    siteIdMap.set(Number(oldId), newId);
                }
            } else {
                // 合并导入：新建分组并记录新旧ID映射，再追加站点
                const groupIdMap = new Map<number, number>();

                // 合并是一条一条建的，条数自己就数得出来 —— 进度用真实计数推，
                // 不用「看起来在动」的假动画糊弄
                const mergeTotal = normalized.groups.length + normalized.sites.length;
                let mergeDone = 0;
                const reportMerge = () => {
                    onProgress?.({ stage: "write", done: ++mergeDone, total: mergeTotal });
                };

                for (const group of normalized.groups) {
                    const created = await api.createGroup({
                        name: group.name,
                        order_num: group.order_num ?? 0,
                    } as Group);

                    if (group.id !== undefined && created && created.id !== undefined) {
                        groupIdMap.set(group.id, created.id);
                    }
                    reportMerge();
                }

                for (const site of normalized.sites) {
                    const created = await api.createSite({
                        ...site,
                        id: undefined,
                        group_id: groupIdMap.get(site.group_id) ?? site.group_id,
                    } as Site);

                    if (site.id !== undefined && created && created.id !== undefined) {
                        siteIdMap.set(site.id, created.id);
                    }
                    reportMerge();
                }

                // 老备份的全站设置混在 configs 里，新备份放在 sharedConfigs，
                // 两边都按「共享键只有所有者能写」过滤一遍
                const configEntries = pickImportConfigEntries(normalized, currentUser);
                for (const [key, value] of configEntries) {
                    await api.setConfig(key, value);
                }
            }

            // 把备份里的星标 / 标签写回本机 localStorage：
            // 服务端现在会重新发号（不再保留备份里的 id），所以两种模式都按映射翻译一遍。
            // 老备份/无 id 的备份拿不到映射，就只能照原样写回。
            const prefs = normalized.localPrefs;
            const remapped = remapLocalPrefs(prefs, siteIdMap);
            if (remapped) {
                restoreLocalPrefs(remapped, overwrite ? "replace" : "merge");
            }

            // 恢复/导入是低频重操作，这里同步刷新一次（一次 bootstrap 请求）
            await fetchData();
        } catch (error) {
            reportError(error, { source: "backup-import" });
            handleError("导入数据失败: " + (error instanceof Error ? error.message : "未知错误"));
            throw error;
        }
    };

    return {
        openBackup,
        setOpenBackup,
        backupTab,
        setBackupTab,
        importPreview,
        setImportPreview,
        importPreviewResolve,
        cronError,
        handleOpenBackup,
        handleCloseBackup,
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
