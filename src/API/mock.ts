import {
    Group,
    Site,
    Note,
    AttachmentUploadResult,
    NoteAttachment,
    NoteFolder,
    NoteRevision,
    NoteTag,
    LoginResponse,
    ExportData,
    ImportResult,
    BootstrapData,
    WebDavConfig,
    WebDavFile,
    WebDavResult,
    SiteOrderUpdateResult,
    SiteBatchDeleteResult,
    RecycleBatchRestoreResult,
    SessionInfo,
    ImportOptions,
    ImportStage,
    AiStatus,
    AiSuggestResponse,
    AiTestResponse,
} from "./http";
import { verifyBackupIntegrity, withBackupIntegrity } from "../utils/backupIntegrity";
import type { SiteMetaSuggestion, TagSuggestion } from "../utils/aiMeta";
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
    kind: "site" | "group" | "note";
    name: string;
    deletedAt: number;
    group?: Group;
    sites?: Site[];
    site?: Site;
}
const mockRecycleBin: MockRecycleItem[] = [];
let mockRecycleSeq = 1;

/**
 * 图片附件的内存副本（2026-07）。
 *
 * ⚠️ 演示模式**不存字节** —— 只留元数据、url 指向一个占位图。
 * 目的是让「插入图片」的交互链路在演示模式下能跑通（弹窗 / 插入 / 删除），
 * 而不是让人以为上传坏了。真实字节要靠后端的 R2/KV。
 */
const mockAttachments: NoteAttachment[] = [];

/** 演示模式的占位图：1×1 透明 PNG。抽成常量是因为 uploadAttachment 里要用两次。 */
const PLACEHOLDER_PNG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

// 记事本：给两条示例，其中一条用 Markdown 演示渲染层要处理的语法
const mockNotes: Note[] = [
    {
        id: 1,
        uuid: "m1-note-a",
        title: "常用入口",
        content: "# 常用入口\n\n- [x] 部署文档\n- [ ] 监控面板\n\n> 记得改完先跑一遍冒烟",
        pinned: true,
        order_num: 0,
        site_id: null,
        // 演示数据刻意留一条**在文件夹里**的笔记（2026-10-07）：
        // 否则「选中文件夹 → 笔记内联在左栏 → 内联笔记右键」这条路径在演示模式
        // 里根本走不到，文件夹树看起来永远是空的。
        folder_id: 1,
    },
    {
        id: 2,
        uuid: "m1-note-b",
        title: "待办",
        content: "## 待办\n\n1. 备份加密\n2. 整理标签",
        pinned: false,
        order_num: 1,
        site_id: null,
        folder_id: null,
    },
];

// 阶段三收尾：演示模式下的文件夹 / 标签内存状态。
// 与 mockNotes 一样是模块级可变数组 —— 演示模式没有服务端，刷新即重置。
const mockFolders: NoteFolder[] = [{ id: 1, name: "收集箱", order_num: 0 }];
const mockTags: NoteTag[] = [{ id: 1, name: "待办", color: "#f59e0b" }];
/** 笔记 ↔ 标签关联。故意不挂 id：关联表本身就是「两列 + 主键」的形状 */
const mockNoteTagLinks: { note_id: number; tag_id: number }[] = [{ note_id: 2, tag_id: 1 }];
let mockFolderSeq = mockFolders.length;
let mockTagSeq = mockTags.length;
/** 版本历史快照（演示模式）。只保留最近若干条，与后端同一套裁剪语义。 */
const mockRevisions: NoteRevision[] = [];
let mockRevisionSeq = 0;

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
function validateMockParent(parent: number | null, moving?: number): void {
    const seen = new Set<number>(moving === undefined ? [] : [moving]);
    let cursor = parent;
    while (cursor !== null) {
        if (!Number.isInteger(cursor) || cursor <= 0 || seen.has(cursor)) throw new Error("文件夹不能移入自身或子文件夹");
        seen.add(cursor);
        const folder = mockFolders.find(f => f.id === cursor);
        if (!folder) throw new Error("目标文件夹不存在");
        cursor = folder.parent_id ?? null;
    }
}

async function syncMockInlineTags(note: Note): Promise<void> {
    if (note.id === undefined || !note.content.includes("#")) return;
    const { extractNoteTags } = await import("../utils/markdownNoteTags");
    for (const name of extractNoteTags(note.content)) {
        let tag = mockTags.find(t => t.name === name);
        if (!tag) {
            tag = { id: Math.max(0, ...mockTags.map(t => t.id ?? 0)) + 1, name, color: null };
            mockTags.push(tag);
            mockTagSeq = Math.max(mockTagSeq, tag.id! + 1);
        }
        if (!mockNoteTagLinks.some(l => l.note_id === note.id && l.tag_id === tag.id))
            mockNoteTagLinks.push({ note_id: note.id, tag_id: tag.id! });
    }
}

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

    // ---- 记事本 ----
    // 演示模式没有公开服务，不能生成看似可用但无法打开的分享链接。
    /** 分享列表（演示模式：内存里没有就返回空数组，形状与真实实现一致） */
    async listNoteShares(): Promise<import("./types").NoteShareListItem[]> {
        await new Promise(resolve => setTimeout(resolve, 120));
        return [];
    }

    async getNoteShare(_id: number): Promise<import("./types").NoteShare | null> {
        return null;
    }
    async createNoteShare(_id: number, _days: number | null): Promise<import("./types").NoteShare | null> {
        throw new Error("演示模式不支持公开分享，请连接真实账号");
    }
    async revokeNoteShare(_id: number): Promise<{ success: boolean }> {
        return { success: true };
    }
    async updateNoteShare(_id: number, _days: number | null): Promise<import("./types").NoteShare | null> {
        throw new Error("演示模式不支持公开分享，请连接真实账号");
    }

    async listNotes(): Promise<Note[]> {
        await new Promise(resolve => setTimeout(resolve, 200));
        return [...mockNotes].sort(
            (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (a.order_num || 0) - (b.order_num || 0)
        );
    }

    async getNote(id: number): Promise<Note | null> {
        await new Promise(resolve => setTimeout(resolve, 200));
        return mockNotes.find(n => n.id === id) || null;
    }

    async createNote(draft: Partial<Note>): Promise<Note> {
        await new Promise(resolve => setTimeout(resolve, 200));
        const note: Note = {
            id: Math.max(0, ...mockNotes.map(n => n.id || 0)) + 1,
            uuid: draft.uuid || `m1-${Date.now().toString(36)}`,
            title: draft.title || "",
            content: draft.content || "",
            pinned: draft.pinned || false,
            order_num: Math.max(0, ...mockNotes.map(n => n.order_num || 0)) + 1,
            site_id: draft.site_id ?? null,
        };
        validateMockParent(draft.folder_id ?? null);
        note.folder_id = draft.folder_id ?? null;
        mockNotes.push(note);
        await syncMockInlineTags(note);
        return note;
    }

    async updateNote(id: number, patch: Partial<Note>): Promise<Note | null> {
        await new Promise(resolve => setTimeout(resolve, 200));
        const note = mockNotes.find(n => n.id === id);
        if (!note) return null;
        if (patch.folder_id !== undefined) validateMockParent(patch.folder_id);
        // 版本历史：改动前先存一份（与后端 updateNote 同一时机与判据）
        if (patch.content !== undefined && patch.content !== note.content) {
            await this.pushRevision(id, note.title, note.content);
        }
        Object.assign(note, patch, { updated_at: new Date().toISOString() });
        if (patch.content !== undefined) await syncMockInlineTags(note);
        return note;
    }

    async deleteNote(id: number): Promise<{ success: boolean; recycleId?: number }> {
        await new Promise(resolve => setTimeout(resolve, 200));
        const idx = mockNotes.findIndex(n => n.id === id);
        if (idx === -1) return { success: false };
        mockNotes.splice(idx, 1);
        return { success: true, recycleId: mockRecycleSeq++ };
    }

    async updateNoteOrder(orders: { id: number; order_num: number }[]): Promise<boolean> {
        await new Promise(resolve => setTimeout(resolve, 200));
        for (const item of orders) {
            const note = mockNotes.find(n => n.id === item.id);
            if (note) note.order_num = item.order_num;
        }
        return true;
    }

    async countNotes(): Promise<number> {
        await new Promise(resolve => setTimeout(resolve, 200));
        return mockNotes.length;
    }

    // ---- 图片附件（2026-07，演示模式下的内存实现）----
    // ⚠️ 与 client.ts 一一对应：契约守卫测试盯着两边的方法集合，少一个 mock 就会
    // 在演示模式下抛「不是函数」。

    async uploadAttachment(file: File, noteId?: number | null): Promise<AttachmentUploadResult> {
        await new Promise(resolve => setTimeout(resolve, 200));
        const id = `mock-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const mime = file.type || "image/png";
        mockAttachments.unshift({
            id,
            note_id: noteId ?? null,
            filename: file.name || `image.${(mime.split("/")[1] || "png").split("+")[0]}`,
            mime,
            size: file.size,
            storage: "kv",
            created_at: Date.now(),
        });
        // 占位图：1×1 透明 PNG（data URI 直接能进 <img src>）。
        // 演示模式没有后端存储，给一张真实可显示的图，好过让用户对着裂图困惑。
        return {
            id,
            url: PLACEHOLDER_PNG,
            filename: file.name || "image.png",
            mime,
            size: file.size,
        };
    }

    async listAttachments(): Promise<NoteAttachment[]> {
        await new Promise(resolve => setTimeout(resolve, 80));
        return mockAttachments.map(a => ({ ...a }));
    }

    async deleteAttachment(id: string): Promise<{ ok: boolean }> {
        await new Promise(resolve => setTimeout(resolve, 80));
        const i = mockAttachments.findIndex(a => a.id === id);
        if (i >= 0) mockAttachments.splice(i, 1);
        return { ok: i >= 0 };
    }

    /** 设置→数据→维护：演示模式下所有附件都挂在示例笔记里，无未引用 → 空清理 */
    async pruneAttachments(): Promise<{ removed: number; freedBytes: number }> {
        await new Promise(resolve => setTimeout(resolve, 120));
        return { removed: 0, freedBytes: 0 };
    }

    // ---- 阶段三收尾：笔记文件夹 / 标签（演示模式下的内存实现）----
    // 与 client.ts 一一对应：两者的方法集合是对齐的（有契约守卫测试盯着），
    // 少一个 mock 那边就会在演示模式下抛「不是函数」。
    async listFolders(): Promise<NoteFolder[]> {
        await new Promise(resolve => setTimeout(resolve, 120));
        return mockFolders.map(f => ({ ...f, count: mockNotes.filter(n => !n.archived && n.folder_id === f.id).length }));
    }

    async createFolder(name: string, parent_id: number | null = null): Promise<NoteFolder> {
        await new Promise(resolve => setTimeout(resolve, 120));
        validateMockParent(parent_id);
        const folder: NoteFolder = {
            id: mockFolderSeq++,
            name,
            parent_id,
            order_num: mockFolders.length,
            count: 0,
        };
        mockFolders.push(folder);
        return folder;
    }

    async updateFolder(id: number, patch: Partial<NoteFolder>): Promise<NoteFolder | null> {
        await new Promise(resolve => setTimeout(resolve, 120));
        const folder = mockFolders.find(f => f.id === id);
        if (!folder) return null;
        if (patch.parent_id !== undefined) validateMockParent(patch.parent_id, id);
        Object.assign(folder, patch);
        return folder;
    }

    async deleteFolder(id: number): Promise<{ success: boolean; orphaned: number }> {
        await new Promise(resolve => setTimeout(resolve, 120));
        const idx = mockFolders.findIndex(f => f.id === id);
        if (idx === -1) return { success: false, orphaned: 0 };
        mockFolders.splice(idx, 1);
        for (const folder of mockFolders) if (folder.parent_id === id) folder.parent_id = null;
        // 笔记不跟着删：只把它们挪到未归类，和后端 deleteFolder 一个语义
        const orphaned = mockNotes.filter(n => n.folder_id === id).length;
        for (const note of mockNotes) {
            if (note.folder_id === id) note.folder_id = null;
        }
        return { success: true, orphaned };
    }

    async listTags(): Promise<NoteTag[]> {
        await new Promise(resolve => setTimeout(resolve, 120));
        return mockTags.map(t => ({
            ...t,
            // 与后端 listTags / 前端 tagCounts 同一口径：归档笔记不算
            count: mockNoteTagLinks.filter(
                l => l.tag_id === t.id && !mockNotes.find(n => n.id === l.note_id)?.archived
            ).length,
        }));
    }

    async createTag(name: string, color?: string | null): Promise<NoteTag> {
        await new Promise(resolve => setTimeout(resolve, 120));
        const tag: NoteTag = { id: mockTagSeq++, name, color: color ?? null, count: 0 };
        mockTags.push(tag);
        return tag;
    }

    async updateTag(id: number, patch: Partial<NoteTag>): Promise<NoteTag | null> {
        await new Promise(resolve => setTimeout(resolve, 120));
        const tag = mockTags.find(t => t.id === id);
        if (!tag) return null;
        Object.assign(tag, patch);
        return tag;
    }

    async deleteTag(id: number): Promise<{ success: boolean }> {
        await new Promise(resolve => setTimeout(resolve, 120));
        const idx = mockTags.findIndex(t => t.id === id);
        if (idx === -1) return { success: false };
        mockTags.splice(idx, 1);
        // 只删关联，笔记留着
        for (let i = mockNoteTagLinks.length - 1; i >= 0; i -= 1) {
            if (mockNoteTagLinks[i].tag_id === id) mockNoteTagLinks.splice(i, 1);
        }
        return { success: true };
    }

    async listNoteTags(): Promise<Record<number, number[]>> {        await new Promise(resolve => setTimeout(resolve, 120));
        return mockNoteTagLinks.reduce<Record<number, number[]>>((acc, link) => {
            (acc[link.note_id] ||= []).push(link.tag_id);
            return acc;
        }, {});
    }

    async setNoteTags(noteId: number, tagIds: number[]): Promise<NoteTag[]> {
        await new Promise(resolve => setTimeout(resolve, 120));
        const kept = new Set(tagIds.filter(n => Number.isInteger(n) && n > 0));
        for (let i = mockNoteTagLinks.length - 1; i >= 0; i -= 1) {
            if (mockNoteTagLinks[i].note_id === noteId) mockNoteTagLinks.splice(i, 1);
        }
        for (const tagId of kept) mockNoteTagLinks.push({ note_id: noteId, tag_id: tagId });
        return this.listTags();
    }

    // ---- 版本历史（与后端同一套语义：存改动前的内容 + 只留 N 条）----
    async pushRevision(noteId: number, title: string, content: string): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, 60));
        mockRevisions.push({
            id: ++mockRevisionSeq,
            note_id: noteId,
            title,
            content,
            created_at: new Date().toISOString().slice(0, 19).replace("T", " "),
        });
        const mine = mockRevisions.filter(r => r.note_id === noteId);
        // 与后端 REVISION_KEEP_PER_NOTE 一致：超出的从最旧开始裁
        for (const old of mine.slice(0, Math.max(0, mine.length - 60))) {
            const at = mockRevisions.indexOf(old);
            if (at >= 0) mockRevisions.splice(at, 1);
        }
    }

    async listNoteRevisions(noteId: number): Promise<NoteRevision[]> {
        await new Promise(resolve => setTimeout(resolve, 120));
        // 与后端一致：列表**不带正文**，只给长度
        return mockRevisions
            .filter(r => r.note_id === noteId)
            .sort((a, b) => b.id - a.id)
            .map(({ content, ...rest }) => ({ ...rest, content: "", size: content.length }));
    }

    async getNoteRevision(noteId: number, revisionId: number): Promise<NoteRevision | null> {
        await new Promise(resolve => setTimeout(resolve, 120));
        return mockRevisions.find(r => r.note_id === noteId && r.id === revisionId) ?? null;
    }

    async restoreNoteRevision(noteId: number, revisionId: number): Promise<Note | null> {
        const revision = await this.getNoteRevision(noteId, revisionId);
        if (!revision) return null;
        return this.updateNote(noteId, { title: revision.title, content: revision.content });
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

    // ---- AI 助手 ----
    // 演示模式一律「没开」：这台机器上没有模型，也没有密钥，
    // 与其编一份假建议让人以为 AI 能用，不如老实说没配。

    async aiStatus(): Promise<AiStatus> {
        return {
            enabled: false,
            provider: "workers-ai",
            textModel: "",
            embedModel: "",
            embedded: 0,
            problem: "演示模式没有 AI",
        };
    }

    private aiUnavailable(): { success: false; message: string } {
        return { success: false, message: "演示模式没有 AI" };
    }

    async aiSiteMeta(): Promise<AiSuggestResponse<{ suggestion: SiteMetaSuggestion }>> {
        return this.aiUnavailable();
    }

    async aiSuggestTags(): Promise<AiSuggestResponse<{ suggestions: TagSuggestion[] }>> {
        return this.aiUnavailable();
    }

    async aiEmbed(): Promise<{ success: boolean; done: number; total: number; message?: string }> {
        return { success: false, done: 0, total: 0, message: "演示模式没有 AI" };
    }

    async aiSearch(): Promise<
        AiSuggestResponse<{ results: { id: number; score: number }[]; empty?: boolean }>
    > {
        return this.aiUnavailable();
    }

    async aiTest(): Promise<AiTestResponse> {
        return { success: false, message: "演示模式没有 AI" };
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
        items: Array<{ id: number; kind: "site" | "group" | "note"; name: string; deletedAt: number }>;
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
