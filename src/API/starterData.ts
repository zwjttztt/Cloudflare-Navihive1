// src/API/starterData.ts
// 新注册账号的「起手数据」：注册成功后立刻给几个默认分组和常用卡片，
// 免得新账号一进来面对一片空白、不知道能干什么。
//
// 内容与 init_table.sql 里的示例数据保持一致（老部署第一次初始化看到的就是这套），
// 登录后可自由增删改，也可以整组删掉。

export interface StarterSite {
    name: string;
    url: string;
    description: string;
}

export interface StarterGroup {
    name: string;
    sites: StarterSite[];
}

export const STARTER_GROUPS: StarterGroup[] = [
    {
        name: "常用工具",
        sites: [
            { name: "豆包", url: "https://www.doubao.com", description: "智能 AI 助手" },
            { name: "腾讯文档", url: "https://docs.qq.com", description: "在线协作文档" },
            { name: "坚果云", url: "https://www.jianguoyun.com", description: "云盘同步" },
        ],
    },
    {
        name: "开发资源",
        sites: [
            { name: "GitHub", url: "https://github.com", description: "代码托管与开源社区" },
            {
                name: "MDN Web Docs",
                url: "https://developer.mozilla.org",
                description: "Web 开发文档",
            },
            { name: "掘金", url: "https://juejin.cn", description: "开发者技术社区" },
        ],
    },
    {
        name: "学习",
        sites: [
            { name: "知乎", url: "https://www.zhihu.com", description: "知识问答社区" },
            { name: "哔哩哔哩", url: "https://www.bilibili.com", description: "视频学习与娱乐" },
            { name: "菜鸟教程", url: "https://www.runoob.com", description: "编程入门教程" },
        ],
    },
    {
        name: "娱乐",
        sites: [
            { name: "微博", url: "https://weibo.com", description: "社交媒体" },
            { name: "豆瓣", url: "https://www.douban.com", description: "书影音社区" },
        ],
    },
];
