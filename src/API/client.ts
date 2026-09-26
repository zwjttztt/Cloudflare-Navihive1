import {
    Group,
    Site,
    LoginResponse,
    ExportData,
    BootstrapData,
    SiteMeta,
    WebDavConfig,
    WebDavFile,
    WebDavResult,
} from "./http";

export class NavigationClient {
    private baseUrl: string;
    private token: string | null = null;

    constructor(baseUrl = "/api") {
        this.baseUrl = baseUrl;
        // 从本地存储加载令牌
        this.token = localStorage.getItem('auth_token');
    }

    // 检查是否已登录
    isLoggedIn(): boolean {
        return !!this.token;
    }

    // 设置认证令牌
    setToken(token: string): void {
        this.token = token;
        localStorage.setItem('auth_token', token);
    }

    // 清除认证令牌
    clearToken(): void {
        this.token = null;
        localStorage.removeItem('auth_token');
    }

    // 登录API
    async login(username: string, password: string, remember = false): Promise<LoginResponse> {
        try {
            const response = await fetch(`${this.baseUrl}/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ username, password, remember })
            });

            const data = await response.json();
            
            if (data.success && data.token) {
                this.setToken(data.token);
            }
            
            return data;
        } catch (error) {
            console.error('登录失败:', error);
            return {
                success: false,
                message: '登录请求失败，请检查网络连接'
            };
        }
    }

    // 登出
    logout(): void {
        this.clearToken();
    }

    private async request(endpoint: string, options = {}) {
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
        };
        
        // 如果有认证令牌，则添加到请求头
        if (this.token) {
            headers["Authorization"] = `Bearer ${this.token}`;
        }

        const response = await fetch(`${this.baseUrl}/${endpoint}`, {
            headers,
            ...options,
        });

        if (response.status === 401) {
            // 带上服务端给出的具体原因（未登录 / 令牌无效 / 已过期），方便排查
            const reason = await response.text().catch(() => "");
            // 清除无效令牌
            this.clearToken();
            throw new Error(reason ? `认证失败：${reason}` : "认证已过期或无效，请重新登录");
        }

        if (!response.ok) {
            throw new Error(`API错误: ${response.status}`);
        }

        return response.json();
    }

    // 检查身份验证状态
    async checkAuthStatus(): Promise<boolean> {
        try {
            // 如果本地没有令牌，直接返回未认证
            if (!this.token) {
                return false;
            }
            
            // 尝试获取配置，如果成功则表示已认证
            await this.getConfigs();
            return true;
        } catch (error) {
            console.log("认证检查:", error);
            
            // 特定处理401错误
            if (error instanceof Error) {
                if (error.message.includes("认证") || error.message.includes("API错误: 401")) {
                    this.clearToken();
                    return false;
                }
            }
            
            // 其他错误不影响认证状态，如果有token则认为已认证
            return !!this.token;
        }
    }

    // 分组相关API
    async getGroups(): Promise<Group[]> {
        return this.request("groups");
    }

    // 首屏 / 刷新：一次请求取回分组 + 站点 + 配置（替代 N+1 次请求）
    async bootstrap(): Promise<BootstrapData> {
        return this.request("bootstrap");
    }

    async getGroup(id: number): Promise<Group> {
        return this.request(`groups/${id}`);
    }

    async createGroup(group: Group): Promise<Group> {
        return this.request("groups", {
            method: "POST",
            body: JSON.stringify(group),
        });
    }

    async updateGroup(id: number, group: Partial<Group>): Promise<Group> {
        return this.request(`groups/${id}`, {
            method: "PUT",
            body: JSON.stringify(group),
        });
    }

    async deleteGroup(id: number): Promise<boolean> {
        const response = await this.request(`groups/${id}`, {
            method: "DELETE",
        });
        return response.success;
    }

    // 网站相关API
    async getSites(groupId?: number): Promise<Site[]> {
        const endpoint = groupId ? `sites?groupId=${groupId}` : "sites";
        return this.request(endpoint);
    }

    async getSite(id: number): Promise<Site> {
        return this.request(`sites/${id}`);
    }

    async createSite(site: Site): Promise<Site> {
        return this.request("sites", {
            method: "POST",
            body: JSON.stringify(site),
        });
    }

    async updateSite(id: number, site: Partial<Site>): Promise<Site> {
        return this.request(`sites/${id}`, {
            method: "PUT",
            body: JSON.stringify(site),
        });
    }

    async deleteSite(id: number): Promise<boolean> {
        const response = await this.request(`sites/${id}`, {
            method: "DELETE",
        });
        return response.success;
    }

    // 配置相关API
    async getConfigs(): Promise<Record<string, string>> {
        return this.request("configs");
    }

    /**
     * 批量写入配置：保存网站设置时一次请求搞定，
     * 不用为每一项各发一个请求（改十项就是十个 RTT）。
     */
    async setConfigs(configs: Record<string, string>): Promise<boolean> {
        const result = await this.request("configs/batch", {
            method: "POST",
            body: JSON.stringify({ configs }),
        });
        return result?.success !== false;
    }

    async getConfig(key: string): Promise<string | null> {
        try {
            const response = await this.request(`configs/${key}`);
            return response.value;
        } catch {
            return null;
        }
    }

    async setConfig(key: string, value: string): Promise<boolean> {
        const response = await this.request(`configs/${key}`, {
            method: "PUT",
            body: JSON.stringify({ value }),
        });
        return response.success;
    }

    async deleteConfig(key: string): Promise<boolean> {
        const response = await this.request(`configs/${key}`, {
            method: "DELETE",
        });
        return response.success;
    }

    // 修改管理员账号密码（保存在数据库中，重新部署不会被覆盖）
    async updateAuthCredentials(
        username: string,
        password: string,
        currentPassword: string
    ): Promise<{ success: boolean; message?: string }> {
        return this.request("auth/credentials", {
            method: "PUT",
            body: JSON.stringify({ username, password, currentPassword }),
        });
    }

    // 应急重置码是否已配置（只返回布尔值）
    async getResetCodeStatus(): Promise<{ configured: boolean }> {
        return this.request("auth/reset-code");
    }

    /**
     * 用应急重置码重设密码。
     * 这个接口失败时会返回 400 + 具体的 message，所以不能走会抛异常的 request，
     * 否则前端只能看到「API错误: 400」而拿不到「重置码不正确」这类提示。
     */
    async resetPasswordWithCode(
        code: string,
        newPassword: string,
        newUsername?: string
    ): Promise<{ success: boolean; message?: string }> {
        try {
            const response = await fetch(`${this.baseUrl}/auth/reset`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ code, newPassword, newUsername: newUsername || "" }),
            });

            const data = await response.json().catch(() => ({ success: false }));
            if (!response.ok && !data.message) {
                return { success: false, message: "重置密码失败，请稍后再试" };
            }
            return data;
        } catch (error) {
            console.error("重置密码失败:", error);
            return { success: false, message: "重置密码请求失败，请检查网络连接" };
        }
    }

    // 批量更新排序
    async updateGroupOrder(groupOrders: { id: number; order_num: number }[]): Promise<boolean> {
        const response = await this.request("group-orders", {
            method: "PUT",
            body: JSON.stringify(groupOrders),
        });
        return response.success;
    }

    // 批量更新站点排序（可同时修改分组，一次请求完成）
    async updateSiteOrder(
        siteOrders: { id: number; order_num: number; group_id?: number }[]
    ): Promise<boolean> {
        const response = await this.request("site-orders", {
            method: "PUT",
            body: JSON.stringify(siteOrders),
        });
        return response.success;
    }

    // 数据导出
    async exportData(): Promise<ExportData> {
        return this.request("export");
    }
    
    // 数据导入
    async importData(data: ExportData): Promise<boolean> {
        const response = await this.request("import", {
            method: "POST",
            body: JSON.stringify(data),
        });
        return response.success;
    }

    // ============ WebDAV 备份（Worker 代理） ============
    // 传入的 config 可只填部分字段，缺失的字段会使用服务端已保存的配置

    async webdavTest(config: Partial<WebDavConfig> = {}): Promise<WebDavResult> {
        return this.request("webdav/test", {
            method: "POST",
            body: JSON.stringify(config),
        });
    }

    async webdavUpload(
        config: Partial<WebDavConfig> = {},
        data?: ExportData,
        filename?: string
    ): Promise<WebDavResult<{ filename: string; size: number }>> {
        return this.request("webdav/upload", {
            method: "POST",
            body: JSON.stringify({ ...config, filename, data }),
        });
    }

    async webdavList(config: Partial<WebDavConfig> = {}): Promise<WebDavResult<WebDavFile[]>> {
        return this.request("webdav/list", {
            method: "POST",
            body: JSON.stringify(config),
        });
    }

    async webdavDownload(
        filename: string,
        config: Partial<WebDavConfig> = {}
    ): Promise<WebDavResult<ExportData>> {
        return this.request("webdav/download", {
            method: "POST",
            body: JSON.stringify({ ...config, filename }),
        });
    }

    async webdavDelete(filename: string, config: Partial<WebDavConfig> = {}): Promise<WebDavResult> {
        return this.request("webdav/delete", {
            method: "POST",
            body: JSON.stringify({ ...config, filename }),
        });
    }

    /**
     * 抓目标站点的标题 / 描述 / 图标（新增卡片时一键补全）。
     * 这里不走通用 request()：meta 接口失败时会带一句人能看懂的原因
     * （站点拒绝了 / 超时 / 网址不合法），直接抛给调用方展示。
     */
    async getSiteMeta(url: string): Promise<SiteMeta> {
        const headers: Record<string, string> = {};
        if (this.token) headers["Authorization"] = `Bearer ${this.token}`;

        const response = await fetch(
            `${this.baseUrl}/meta?url=${encodeURIComponent(url)}`,
            { headers }
        );
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data?.error || `抓取失败（${response.status}）`);
        }
        return data as SiteMeta;
    }
}
