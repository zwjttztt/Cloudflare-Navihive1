-- =============================================================
-- 个人导航站 (NaviHive) 数据库初始化脚本
-- 在 Cloudflare 控制台 -> Workers & Pages -> 你的项目 ->
-- 设置 -> 数据库 -> navigation-db -> 控制台 -> SQL 编辑器 中
-- 一次性执行本脚本的全部内容。
--
-- 脚本会：1) 建表  2) 写入初始化标志  3) 插入示例导航数据
-- 示例数据仅供演示，可在登录后手动删除或直接修改。
--
-- 升级提示：如果你在「站点账号密码」功能上线前已经初始化过数据库，
-- Worker 会在首次请求时自动执行下面的迁移语句补上 username / password 两列，
-- 无需手动处理；如需手动执行，请逐条运行（重复运行会报 duplicate column 错误，可忽略）：
--   ALTER TABLE sites ADD COLUMN username TEXT;
--   ALTER TABLE sites ADD COLUMN password TEXT;
-- =============================================================

-- 1. 创建分组表
CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    order_num INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. 创建站点表（含站点登录凭据字段 username / password）
CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    icon TEXT,
    description TEXT,
    notes TEXT,
    username TEXT,
    password TEXT,
    order_num INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
);

-- 3. 创建配置表
CREATE TABLE IF NOT EXISTS configs (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. 设置初始化标志
INSERT INTO configs (key, value) VALUES ('DB_INITIALIZED', 'true');

-- =============================================================
-- 5. 示例导航数据（可按需删除，登录后可在界面中自由增删改）
-- =============================================================

-- 分组
INSERT INTO groups (name, order_num) VALUES ('常用工具', 1);
INSERT INTO groups (name, order_num) VALUES ('开发资源', 2);
INSERT INTO groups (name, order_num) VALUES ('学习', 3);
INSERT INTO groups (name, order_num) VALUES ('娱乐', 4);

-- 站点：常用工具（group_id=1）
INSERT INTO sites (group_id, name, url, icon, description, notes, order_num) VALUES
(1, '豆包', 'https://www.doubao.com', '', '智能 AI 助手', '', 1),
(1, '飞书', 'https://www.feishu.cn', '', '团队协作与文档', '', 2),
(1, '腾讯文档', 'https://docs.qq.com', '', '在线协作文档', '', 3),
(1, '石墨文档', 'https://shimo.im', '', '云端办公套件', '', 4),
(1, '坚果云', 'https://www.jianguoyun.com', '', '云盘同步', '', 5);

-- 站点：开发资源（group_id=2）
INSERT INTO sites (group_id, name, url, icon, description, notes, order_num) VALUES
(2, 'GitHub', 'https://github.com', '', '代码托管与开源社区', '', 1),
(2, 'Stack Overflow', 'https://stackoverflow.com', '', '编程问答', '', 2),
(2, 'MDN Web Docs', 'https://developer.mozilla.org', '', 'Web 开发文档', '', 3),
(2, 'Cloudflare Docs', 'https://developers.cloudflare.com', '', 'Cloudflare 官方文档', '', 4),
(2, '掘金', 'https://juejin.cn', '', '开发者技术社区', '', 5);

-- 站点：学习（group_id=3）
INSERT INTO sites (group_id, name, url, icon, description, notes, order_num) VALUES
(3, '知乎', 'https://www.zhihu.com', '', '知识问答社区', '', 1),
(3, '哔哩哔哩', 'https://www.bilibili.com', '', '视频学习与娱乐', '', 2),
(3, '中国大学MOOC', 'https://www.icourse163.org', '', '名校公开课', '', 3),
(3, '菜鸟教程', 'https://www.runoob.com', '', '编程入门教程', '', 4);

-- 站点：娱乐（group_id=4）
INSERT INTO sites (group_id, name, url, icon, description, notes, order_num) VALUES
(4, '微博', 'https://weibo.com', '', '社交媒体', '', 1),
(4, '豆瓣', 'https://www.douban.com', '', '书影音社区', '', 2),
(4, 'YouTube', 'https://www.youtube.com', '', '海外视频平台', '', 3);
