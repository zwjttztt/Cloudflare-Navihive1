import {
    Group,
    Site,
    LoginResponse,
    ExportData,
    ImportResult,
    BootstrapData,
    SiteMeta,
    WebDavConfig,
    WebDavFile,
    WebDavResult,
    SiteOrderUpdateResult,
    SiteBatchDeleteResult,
    RecycleBatchRestoreResult,
    SessionInfo,
    ImportOptions,
    ImportStage,
} from "./http";
import { verifyBackupIntegrity, withBackupIntegrity } from "../utils/backupIntegrity";
import {
    IDEMPOTENCY_MAX_BODY,
    IDEMPOTENCY_TTL_MS,
    type IdempotencyRecord,
} from "./methods/idempotency";

/** 演示模式的幂等记录：scope|opId -> 记录 */
const mockIdempotency = new Map<
    string,
    {
        state: "pending" | "done";
        status: number | null;
        body: string | null;
        created_at: number;
        expires_at: number;
    }
>();

// 登录标记的 Secure 属性要和服务端那条令牌 cookie 一致，否则会出现
// 「标记在、令牌不在」的半登录态（详见 NavigationClient.secureAttr）。
function secureAttr(): string {
    return typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
}

// 模拟数据
const mockGroups: Group[] = [
    {
        id: 1,
        name: "常用工具",
        order_num: 1,
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
    },
    {
        id: 2,
        name: "开发资源",
        order_num: 2,
        created_at: "2024-01-01T20:00:00Z",
        updated_at: "2024-01-01T30:00:00Z",
    },
    {
        id: 3,
        name: "开发资源3",
        order_num: 3,
        created_at: "2024-01-01T40:00:00Z",
        updated_at: "2024-01-01T50:00:00Z",
    },
];

const mockSites: Site[] = [
    {
        id: 1,
        group_id: 1,
        name: "Google",
        url: "https://www.google.com",
        icon: "https://img.zhengmi.org/file/1742480539412_微信图片_20240707011628.jpg",
        description: "搜索引擎",
        notes: "",
        order_num: 1,
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
    },
    {
        id: 2,
        group_id: 1,
        name: "GitHub",
        url: "https://github.com",
        icon: "https://img.zhengmi.org/file/1742480539412_微信图片_20240707011628.jpg",
        description: "代码托管平台",
        notes: "",
        order_num: 2,
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
    },
    {
        id: 3,
        group_id: 1,
        name: "Google",
        url: "https://www.google.com",
        icon: "https://img.zhengmi.org/file/1742480539412_微信图片_20240707011628.jpg",
        description: "搜索引擎",
        notes: "",
        order_num: 1,
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
    },
    {
        id: 4,
        group_id: 1,
        name: "GitHub",
        url: "https://github.com",
        icon: "github.png",
        description: "代码托管平台",
        notes: "",
        order_num: 2,
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
    },
    {
        id: 5,
        group_id: 1,
        name: "GitHub",
        url: "https://github.com",
        icon: "github.png",
        description: "代码托管平台",
        notes: "",
        order_num: 2,
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
    },
    {
        id: 6,
        group_id: 1,
        name: "GitHub",
        url: "https://github.com",
        icon: "github.png",
        description: "代码托管平台6",
        notes: "",
        order_num: 2,
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
    },
];

// 添加模拟配置数据
const mockConfigs: Record<string, string> = {
    "site.title": "我的导航站",
    "site.name": "个人导航",
    "site.customCss": ""
};

// 回收站：本地 mock 也是真的软删除 —— 删掉的分组/站点先搬到这儿，还原时按原数据塞回去。
interface MockRecycleItem {
    id: number;
    kind: "site" | "group";
    name: string;
    deletedAt: number;
    group?: Group;
    sites?: Site[];
    site?: Site;
}
const mockRecycleBin: MockRecycleItem[] = [];
let mockRecycleSeq = 1;

// 本地没有服务端审计流水，这里保持空列表（接口形状与真实实现一致）
type MockAuditEntry = {
    id: number;
    action: string;
    actor: string;
    ip: string;
    detail: string;
    created_at: string;
};
const mockAuditLog: MockAuditEntry[] = [];

// 模拟API实现
export class MockNavigationClient {
    // 与真实 client 保持一致：登录态看可读的 session cookie，令牌本身不落 JS
    constructor() {
        if (typeof localStorage !== 'undefined') {
            localStorage.removeItem('auth_token');
        }
    }

    // 检查是否已登录
    isLoggedIn(): boolean {
        if (typeof document === 'undefined') return false;
        return document.cookie
            .split(';')
            .some(part => part.trim().startsWith('navihive_session=1'));
    }

    // 设置认证令牌（Secure 属性同 NavigationClient：与服务端那条令牌 cookie 保持一致）
    setToken(_token: string): void {
        if (typeof document !== 'undefined') {
            document.cookie = `navihive_session=1; Path=/; SameSite=Strict${secureAttr()}`;
        }
    }

    // 清除认证令牌
    clearToken(): void {
        if (typeof document !== 'undefined') {
            document.cookie = `navihive_session=; Path=/; SameSite=Strict; Max-Age=0${secureAttr()}`;
        }
    }

    // 登录API
    async login(username: string, password: string, _remember = false): Promise<LoginResponse> {
        await new Promise(resolve => setTimeout(resolve, 500));
        void password;
        // 这里曾经 console.log(username, password) —— 本地 mock 模式下密码会原样打进控制台。
        // 虽然是假的后端，但用户填的往往是真密码（尤其在本机调试登录流程时），
        // 截图、录屏、贴控制台输出都会把它带出去，不值得为省一行冒这个险。
        // 模拟登录验证逻辑 - 在Mock环境中任何账号密码都能登录
        const token = btoa(`${username}:${new Date().getTime()}`);
        this.setToken(token);

        return {
            success: true,
            token: token,
            message: "登录成功(模拟环境)"
        };
    }

    // 登出
    logout(): void {
        this.clearToken();
    }

    // 用恢复令牌重置管理员密码（模拟环境仅返回成功）
    async recoverPassword(_token: string): Promise<{ success: boolean; message?: string }> {
        await new Promise(resolve => setTimeout(resolve, 300));
        return { success: true, message: "模拟环境未真正修改管理员凭据" };
    }

    // 是否已配置恢复公钥（模拟环境默认已配置）
    async getRecoveryStatus(): Promise<{ configured: boolean }> {
        return { configured: true };
    }

    // 注册（模拟环境：任何邀请码都接受，只为让界面跑通）
    async register(
        username: string,
        _password: string,
        _inviteCode: string,
        _remember = false
    ): Promise<{ success: boolean; message?: string; username?: string }> {
        await new Promise(resolve => setTimeout(resolve, 300));
        this.setToken(btoa(`${username}:${new Date().getTime()}`));
        return { success: true, message: "注册成功(模拟环境)", username };
    }

    // 生成邀请码（模拟环境返回固定码，方便调试）
    async createInvite(): Promise<{ success: boolean; message?: string; code?: string; expiresAt?: number }> {
        await new Promise(resolve => setTimeout(resolve, 200));
        return {
            success: true,
            code: "MOCKCODE",
            expiresAt: Math.floor(Date.now() / 1000) + 30 * 60,
            message: "模拟环境邀请码",
        };
    }

    // 注销账号（模拟环境只清登录态，不真删数据）
    async deleteAccount(_currentPassword: string): Promise<{ success: boolean; message?: string }> {
        await new Promise(resolve => setTimeout(resolve, 300));
        this.clearToken();
        return { success: true, message: "模拟环境未真正注销账号" };
    }

    // 当前身份（模拟环境固定为 owner；id 用 0 表示「无账号」这一档）
    async getMe(): Promise<{ id: number; username: string; role: "owner" | "user" } | null> {
        return { id: 0, username: "mock", role: "owner" };
    }

    // 保存恢复公钥（模拟环境仅返回成功，不真的落库）
    async setRecoveryPublicKey(
        _publicKey: string,
        _currentPassword: string
    ): Promise<{ success: boolean; message?: string }> {
        await new Promise(resolve => setTimeout(resolve, 200));
        return { success: true, message: "模拟环境未真正保存恢复公钥" };
    }

    // 检查身份验证状态
    async checkAuthStatus(): Promise<boolean> {
        await new Promise(resolve => setTimeout(resolve, 300));
        
        // 模拟真实环境中的行为：有登录标记则认为已认证
        if (this.isLoggedIn()) {
            return true;
        }
        
        // 开发环境中，也可以设置为总是返回true，便于开发
        // return true;
        
        // 没有token则需要登录
        return false;
    }

    async getGroups(): Promise<Group[]> {
        // 模拟网络延迟
        await new Promise(resolve => setTimeout(resolve, 200));
        return [...mockGroups];
    }

    // 首屏 / 刷新：与真实客户端保持一致，一次返回全部数据
    async bootstrap(): Promise<BootstrapData> {
        await new Promise(resolve => setTimeout(resolve, 200));
        return {
            groups: [...mockGroups],
            sites: [...mockSites],
            configs: { ...mockConfigs },
        };
    }

    async getGroup(id: number): Promise<Group | null> {
        await new Promise(resolve => setTimeout(resolve, 200));
        return mockGroups.find(g => g.id === id) || null;
    }

    async createGroup(group: Group): Promise<Group> {
        await new Promise(resolve => setTimeout(resolve, 200));
        const newGroup = {
            ...group,
            id: Math.max(0, ...mockGroups.map(g => g.id || 0)) + 1,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };
        mockGroups.push(newGroup);
        return newGroup;
    }

    async updateGroup(id: number, group: Partial<Group>): Promise<Group | null> {
        await new Promise(resolve => setTimeout(resolve, 200));
        const index = mockGroups.findIndex(g => g.id === id);
        if (index === -1) return null;

        mockGroups[index] = {
            ...mockGroups[index],
            ...group,
            updated_at: new Date().toISOString(),
        };
        return mockGroups[index];
    }

    async deleteGroup(id: number): Promise<{ success: boolean; recycleId?: number }> {
        await new Promise(resolve => setTimeout(resolve, 200));
        const index = mockGroups.findIndex(g => g.id === id);
        if (index === -1) return { success: false };

        const group = mockGroups[index];
        const sites = mockSites.filter(s => s.group_id === id);
        const recycleId = mockRecycleSeq++;
        mockRecycleBin.push({
            id: recycleId,
            kind: "group",
            name: `${group.name}（含 ${sites.length} 张卡片）`,
            deletedAt: Math.floor(Date.now() / 1000),
            group,
            sites,
        });
        mockGroups.splice(index, 1);
        return { success: true, recycleId };
    }

    async getSites(groupId?: number): Promise<Site[]> {
        await new Promise(resolve => setTimeout(resolve, 200));
        if (groupId) {
            return mockSites.filter(site => site.group_id === groupId);
        }
        return [...mockSites];
    }

    // 实现其他方法，与NavigationClient保持一致的接口...
    async getSite(id: number): Promise<Site | null> {
        await new Promise(resolve => setTimeout(resolve, 200));
        return mockSites.find(s => s.id === id) || null;
    }

    async createSite(site: Site): Promise<Site> {
        await new Promise(resolve => setTimeout(resolve, 200));
        const newSite = {
            ...site,
            id: Math.max(0, ...mockSites.map(s => s.id || 0)) + 1,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };
        mockSites.push(newSite);
        return newSite;
    }

    async updateSite(id: number, site: Partial<Site>): Promise<Site | null> {
        await new Promise(resolve => setTimeout(resolve, 200));
        const index = mockSites.findIndex(s => s.id === id);
        if (index === -1) return null;

        mockSites[index] = {
            ...mockSites[index],
            ...site,
            updated_at: new Date().toISOString(),
        };
        return mockSites[index];
    }

    async deleteSites(ids: number[]): Promise<SiteBatchDeleteResult> {
        await new Promise(resolve => setTimeout(resolve, 200));
        const items: Array<{ id: number; recycleId?: number }> = [];
        const failed: number[] = [];
        for (const id of ids) {
            const index = mockSites.findIndex(s => s.id === id);
            if (index === -1) {
                failed.push(id);
                continue;
            }
            const site = mockSites[index];
            const recycleId = mockRecycleSeq++;
            mockRecycleBin.push({
                id: recycleId,
                kind: "site",
                name: site.name,
                deletedAt: Math.floor(Date.now() / 1000),
                site,
            });
            mockSites.splice(index, 1);
            items.push({ id, recycleId });
        }
        return { items, failed };
    }

    async deleteSite(id: number): Promise<{ success: boolean; recycleId?: number }> {
        await new Promise(resolve => setTimeout(resolve, 200));
        const index = mockSites.findIndex(s => s.id === id);
        if (index === -1) return { success: false };

        const site = mockSites[index];
        const recycleId = mockRecycleSeq++;
        mockRecycleBin.push({
            id: recycleId,
            kind: "site",
            name: site.name,
            deletedAt: Math.floor(Date.now() / 1000),
            site,
        });
        mockSites.splice(index, 1);
        return { success: true, recycleId };
    }

    async updateGroupOrder(groupOrders: { id: number; order_num: number }[]): Promise<boolean> {
        await new Promise(resolve => setTimeout(resolve, 200));
        for (const order of groupOrders) {
            const index = mockGroups.findIndex(g => g.id === order.id);
            if (index !== -1) {
                mockGroups[index].order_num = order.order_num;
            }
        }
        return true;
    }

    async updateSiteOrder(
        siteOrders: { id: number; order_num: number; group_id?: number }[]
    ): Promise<SiteOrderUpdateResult> {
        await new Promise(resolve => setTimeout(resolve, 200));
        const updated: number[] = [];
        const failed: number[] = [];
        for (const order of siteOrders) {
            const index = mockSites.findIndex(s => s.id === order.id);
            if (index === -1) {
                failed.push(order.id);
                continue;
            }
            mockSites[index].order_num = order.order_num;
            if (order.group_id !== undefined) {
                mockSites[index].group_id = order.group_id;
            }
            updated.push(order.id);
        }
        return { success: failed.length === 0, updated, failed };
    }

    // 配置相关API
    async getConfigs(): Promise<Record<string, string>> {
        await new Promise(resolve => setTimeout(resolve, 200));
        return { ...mockConfigs };
    }

    async getConfig(key: string): Promise<string | null> {
        await new Promise(resolve => setTimeout(resolve, 200));
        return mockConfigs[key] || null;
    }

    async setConfig(key: string, value: string): Promise<boolean> {
        await new Promise(resolve => setTimeout(resolve, 200));
        mockConfigs[key] = value;
        return true;
    }

    // 服务端那版把「比较 + 写入」压进同一条 SQL；内存版只有一个 Map，
    // 读-改-写不会被别的请求插进来，直接在这里一次性比完即可。
    async compareAndSetConfig(key: string, expected: string | null, next: string): Promise<boolean> {
        await new Promise(resolve => setTimeout(resolve, 200));
        const current = key in mockConfigs ? mockConfigs[key] : null;
        if (current !== expected) return false;
        mockConfigs[key] = next;
        return true;
    }

    async setConfigs(entries: Record<string, string>): Promise<boolean> {
        await new Promise(resolve => setTimeout(resolve, 200));
        Object.assign(mockConfigs, entries);
        return true;
    }

    async deleteConfig(key: string): Promise<boolean> {
        await new Promise(resolve => setTimeout(resolve, 200));
        if (key in mockConfigs) {
            delete mockConfigs[key];
            return true;
        }
        return false;
    }

    // 修改管理员账号密码（模拟环境仅返回成功）
    async updateAuthCredentials(
        _username: string,
        _password: string,
        _currentPassword: string
    ): Promise<{ success: boolean; message?: string }> {
        await new Promise(resolve => setTimeout(resolve, 200));
        return { success: true, message: "模拟环境未真正修改管理员凭据" };
    }

    // 数据导出
    async exportData(): Promise<ExportData> {
        await new Promise(resolve => setTimeout(resolve, 200));
        return await withBackupIntegrity({
            groups: [...mockGroups],
            sites: [...mockSites],
            configs: {...mockConfigs},
            version: "1.0",
            exportDate: new Date().toISOString()
        });
    }
    
    // ============ WebDAV 备份（模拟环境不支持，仅返回提示） ============
    async webdavTest(_config: Partial<WebDavConfig> = {}): Promise<WebDavResult> {
        return { success: false, message: "模拟环境不支持 WebDAV，请使用真实 API（设置 VITE_USE_REAL_API=true）" };
    }

    async webdavUpload(
        _config: Partial<WebDavConfig> = {},
        _data?: ExportData,
        _filename?: string
    ): Promise<WebDavResult<{ filename: string; size: number }>> {
        return { success: false, message: "模拟环境不支持 WebDAV 备份" };
    }

    async webdavList(_config: Partial<WebDavConfig> = {}): Promise<WebDavResult<WebDavFile[]>> {
        return { success: false, message: "模拟环境不支持 WebDAV 备份", data: [] };
    }

    async webdavDownload(
        _filename: string,
        _config: Partial<WebDavConfig> = {}
    ): Promise<WebDavResult<ExportData>> {
        return { success: false, message: "模拟环境不支持 WebDAV 备份" };
    }

    async webdavDelete(_filename: string, _config: Partial<WebDavConfig> = {}): Promise<WebDavResult> {
        return { success: false, message: "模拟环境不支持 WebDAV 备份" };
    }

    // 站点元信息抓取：模拟环境不发真实请求，给一份占位数据
    async getSiteMeta(url: string): Promise<SiteMeta> {
        let host = "";
        try {
            host = new URL(url).hostname.replace(/^www\./, "");
        } catch {
            host = url;
        }
        return { title: host || "示例站点", description: "", image: "", icon: "" };
    }

    // 数据导入
    async importData(data: ExportData, opts?: ImportOptions): Promise<ImportResult> {
        await new Promise(resolve => setTimeout(resolve, 500));

        // 与真实实现同一道关：文件坏了就别清空现有数据
        const integrityCheck = await verifyBackupIntegrity(data);
        if (!integrityCheck.ok) {
            return {
                success: false,
                message: integrityCheck.reason || "备份文件校验失败",
                groupIdMap: {},
                siteIdMap: {},
            };
        }
        const report = (stage: ImportStage, done: number, total: number) => {
            try {
                opts?.onProgress?.({ stage, done, total });
            } catch {
                // 进度回调出错不能把导入拖垮
            }
        };

        try {
            const groupTotal = data.groups?.length ?? 0;
            const siteTotal = data.sites?.length ?? 0;
            report("verify", 1, 1);
            report("encrypt", siteTotal, siteTotal);

            // 清空现有数据
            mockSites.length = 0;
            mockGroups.length = 0;

            // 模拟环境里 id 原地沿用，映射就是「自己映射自己」
            const groupIdMap: Record<string, number> = {};
            const siteIdMap: Record<string, number> = {};

            // 导入分组数据
            data.groups.forEach((group, index) => {
                mockGroups.push({...group});
                if (group.id !== undefined) groupIdMap[String(group.id)] = group.id;
                report("write", index + 1, groupTotal + siteTotal);
            });

            // 导入站点数据
            data.sites.forEach((site, index) => {
                mockSites.push({...site});
                if (site.id !== undefined) siteIdMap[String(site.id)] = site.id;
                report("write", groupTotal + index + 1, groupTotal + siteTotal);
            });

            // 导入配置数据（共享配置从 1.3 起放在 sharedConfigs，老的还在 configs）
            const configEntries = [
                ...Object.entries(data.configs || {}),
                ...Object.entries(data.sharedConfigs || {}),
            ];
            configEntries.forEach(([key, value]) => {
                mockConfigs[key] = value;
            });
            report("cleanup", groupTotal + siteTotal, groupTotal + siteTotal);
            report("done", groupTotal + siteTotal, groupTotal + siteTotal);

            return { success: true, groupIdMap, siteIdMap };
        } catch (error) {
            console.error("模拟导入数据失败:", error);
            return { success: false, groupIdMap: {}, siteIdMap: {} };
        }
    }

    // ============ 审计日志（本地没有服务端流水，按接口形状返回空列表） ============
    async getAuditLog(opts: { limit?: number; offset?: number; actor?: string } = {}): Promise<{
        success: boolean;
        log: Array<{ id: number; action: string; actor: string; ip: string; detail: string; created_at: string }>;
        hasMore: boolean;
    }> {
        await new Promise(resolve => setTimeout(resolve, 100));
        const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
        const offset = Math.max(opts.offset ?? 0, 0);
        const rows = opts.actor ? mockAuditLog.filter(r => r.actor === opts.actor) : mockAuditLog;
        const page = rows.slice(offset, offset + limit);
        return { success: true, log: page, hasMore: rows.length > offset + limit };
    }

    async getClientErrors(limit = 200): Promise<{
        success: boolean;
        groups: Array<{
            key: string;
            source: string;
            message: string;
            count: number;
            lastAt: string;
            paths: string[];
        }>;
    }> {
        await new Promise(resolve => setTimeout(resolve, 100));
        // 本地演示用：把 mock 的 client-error 记录按真实那套规则归并一遍
        const rows = mockAuditLog.filter(r => r.action === "client-error");
        const groups = new Map<string, { key: string; source: string; message: string; count: number; lastAt: string; paths: string[] }>();
        for (const row of rows.slice(0, limit)) {
            let parsed: { source?: string; message?: string; path?: string } = {};
            try {
                parsed = JSON.parse(row.detail || "{}") as typeof parsed;
            } catch {
                parsed = { message: (row.detail || "").slice(0, 200) };
            }
            const source = parsed.source || "unknown";
            const message = parsed.message || (row.detail || "（无错误信息）").slice(0, 200);
            const key = `${source}|${message.slice(0, 120)}`;
            const found = groups.get(key);
            if (found) {
                found.count += 1;
                if (row.created_at > found.lastAt) found.lastAt = row.created_at;
                continue;
            }
            groups.set(key, {
                key,
                source,
                message,
                count: 1,
                lastAt: row.created_at,
                paths: parsed.path ? [parsed.path] : [],
            });
        }
        return { success: true, groups: [...groups.values()] };
    }

    // ============ 回收站（与真实实现一致：软删除后可还原 / 彻底删除 / 清空） ============
    async getRecycleBin(): Promise<{
        success: boolean;
        items: Array<{ id: number; kind: "site" | "group"; name: string; deletedAt: number }>;
    }> {
        await new Promise(resolve => setTimeout(resolve, 100));
        return {
            success: true,
            items: mockRecycleBin.map(r => ({ id: r.id, kind: r.kind, name: r.name, deletedAt: r.deletedAt })),
        };
    }

    async restoreRecycleItem(id: number): Promise<{ success: boolean }> {
        await new Promise(resolve => setTimeout(resolve, 100));
        const index = mockRecycleBin.findIndex(r => r.id === id);
        if (index === -1) return { success: false };

        const item = mockRecycleBin[index];
        if (item.kind === "group" && item.group) {
            mockGroups.push(item.group);
            (item.sites || []).forEach(site => mockSites.push(site));
        } else if (item.site) {
            mockSites.push(item.site);
        }
        mockRecycleBin.splice(index, 1);
        return { success: true };
    }

    async restoreRecycleItems(ids: number[]): Promise<RecycleBatchRestoreResult> {
        await new Promise(resolve => setTimeout(resolve, 100));
        const restored: Site[] = [];
        const failed: number[] = [];
        for (const id of ids) {
            const index = mockRecycleBin.findIndex(r => r.id === id);
            if (index === -1) {
                failed.push(id);
                continue;
            }
            const item = mockRecycleBin[index];
            if (item.kind === "group" && item.group) {
                mockGroups.push(item.group);
                (item.sites || []).forEach(site => mockSites.push(site));
            } else if (item.site) {
                mockSites.push(item.site);
                restored.push(item.site);
            }
            mockRecycleBin.splice(index, 1);
        }
        return { restored, failed };
    }

    async purgeRecycleItems(ids: number[]): Promise<{ purged: number[] }> {
        await new Promise(resolve => setTimeout(resolve, 100));
        const purged: number[] = [];
        for (const id of ids) {
            const index = mockRecycleBin.findIndex(r => r.id === id);
            if (index === -1) continue;
            mockRecycleBin.splice(index, 1);
            purged.push(id);
        }
        return { purged };
    }

    async purgeRecycleItem(id: number): Promise<{ success: boolean }> {
        await new Promise(resolve => setTimeout(resolve, 100));
        const index = mockRecycleBin.findIndex(r => r.id === id);
        if (index === -1) return { success: false };

        mockRecycleBin.splice(index, 1);
        return { success: true };
    }

    async emptyRecycleBin(): Promise<{ success: boolean }> {
        await new Promise(resolve => setTimeout(resolve, 100));
        mockRecycleBin.length = 0;
        return { success: true };
    }

    // ============ 登录设备（会话） ============
    // 本地演示模式不发真实令牌，也就没有「设备」可列：返回空列表，
    // 界面上「登录设备」那一段会因此直接不显示（与真实接口拿不到时一致）。
    async getSessions(): Promise<SessionInfo[]> {
        await new Promise(resolve => setTimeout(resolve, 60));
        return [];
    }

    async revokeSession(_jti: string): Promise<{ success: boolean; message?: string }> {
        await new Promise(resolve => setTimeout(resolve, 60));
        return { success: true };
    }

    async revokeOtherSessions(): Promise<{
        success: boolean;
        revoked: number;
        message?: string;
    }> {
        await new Promise(resolve => setTimeout(resolve, 60));
        return { success: true, revoked: 0 };
    }

    // ============ 幂等键 ============
    // 本地演示模式不发真实请求，重放也就撞不到「响应丢了又补发」那道缝。
    // 这里仍然照实走一遍状态机（占位 → 完成 → 回放），让界面与调用的语义
    // 跟服务端一致，而不是让每个方法都撒手不管。
    async readIdempotency(scope: string, opId: string): Promise<IdempotencyRecord | null> {
        const rec = mockIdempotency.get(`${scope}|${opId}`);
        if (!rec) return null;
        if (rec.expires_at <= Date.now()) return null;
        return { state: rec.state, status: rec.status, body: rec.body, createdAt: rec.created_at };
    }

    async claimIdempotency(scope: string, opId: string): Promise<boolean> {
        const key = `${scope}|${opId}`;
        const existing = mockIdempotency.get(key);
        if (existing && existing.expires_at > Date.now()) return false;
        mockIdempotency.set(key, {
            state: "pending",
            status: null,
            body: null,
            created_at: Date.now(),
            expires_at: Date.now() + IDEMPOTENCY_TTL_MS,
        });
        return true;
    }

    async completeIdempotency(
        scope: string,
        opId: string,
        result: { status: number; body: string | null }
    ): Promise<void> {
        const key = `${scope}|${opId}`;
        const existing = mockIdempotency.get(key);
        if (!existing) return;
        existing.state = "done";
        existing.status = result.status;
        existing.body =
            result.body !== null && result.body.length <= IDEMPOTENCY_MAX_BODY
                ? result.body
                : null;
        existing.expires_at = Date.now() + IDEMPOTENCY_TTL_MS;
    }

    async releaseIdempotency(scope: string, opId: string): Promise<void> {
        mockIdempotency.delete(`${scope}|${opId}`);
    }

    async purgeExpiredIdempotency(now = Date.now()): Promise<number> {
        let removed = 0;
        for (const [key, rec] of [...mockIdempotency]) {
            if (rec.expires_at <= now) {
                mockIdempotency.delete(key);
                removed++;
            }
        }
        return removed;
    }
}
