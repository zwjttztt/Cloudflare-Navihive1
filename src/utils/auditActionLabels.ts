// src/utils/auditActionLabels.ts
// 审计动作名 -> 中文标签的共享映射。
//
// 为什么抽出来：AuditDialog（审计流水）和 StatsPanel（运营看板的「高频动作」）
// 都要翻译同一批动作名，原先只有 AuditDialog 有一份私有表，看板那条就裸奔着
// 显示 login_success 这种原始键（用户 2026-10-17 报告）。
//
// ⚠️ 表里故意留着**历史变体**：老版本服务端写过下划线形态（login_success /
// data.import / data.export），这些行还躺在生产库的 audit_log 里，30 天保留期内
// 依旧会出现在看板上 —— 不映射的话用户就会看到原始键。当前代码写的是点号形态，
// 新代码不要再用下划线。

const LABELS: Record<string, string> = {
    // 登录 / 账号
    "login.success": "登录成功",
    "login_success": "登录成功",
    "login.failed": "登录失败",
    "login_failed": "登录失败",
    "logout": "退出登录",
    "auth.recover": "密钥找回密码",
    "auth.recover.failed": "找回密码失败",
    "auth.register": "注册账号",
    "auth.register.failed": "注册失败",
    "auth.credentials": "修改凭据",
    "auth.credentials.failed": "修改凭据失败",
    "auth.recoveryKey": "更新恢复密钥",
    "auth.recoveryKey.failed": "更新恢复密钥失败",
    "auth.invite": "生成邀请码",
    "auth.deleteAccount": "注销账号",
    "auth.inactive.disable": "停用不活跃账号",
    "auth.inactive.delete": "删除不活跃账号",
    // 内容管理
    "site.delete": "删除站点",
    "site.batchDelete": "批量删除站点",
    "group.delete": "删除分组",
    "note.delete": "删除笔记",
    // 回收站
    "recycle.restore": "回收站还原",
    "recycle.batchRestore": "回收站批量还原",
    "recycle.purge": "回收站彻底删除",
    "recycle.batchPurge": "回收站批量彻底删除",
    "recycle.empty": "清空回收站",
    // 数据进出
    "data-export": "导出数据",
    "data_export": "导出数据",
    "data.export": "导出数据",
    "data-import": "导入数据",
    "data_import": "导入数据",
    "data.import": "导入数据",
    // 运维 / 升级（server/entry.ts 的 POST /api/system/upgrade，判定在 server/upgradeAudit.ts）
    // 这条是「谁在什么时候把生产容器换掉了」的唯一记录：2026-10-28 v17.0.0 发布后
    // 升级器重建了容器，而审计表里一条都没有 —— 从此每次升级受理 / 提交失败 / 越权尝试都留痕。
    "system-upgrade": "网页触发升级",
    "system-upgrade.failed": "升级提交失败",
    "system-upgrade.denied": "越权尝试升级",
    // 观测
    "client-error": "前端错误上报",    // 服务端未处理异常（worker/index.ts 的入口 catch 落的）。detail 里带 rid，
    // 与前端上报的 requestId 是同一个值，可以对起来看。
    "server-error": "服务端错误",
};

/** 动作名 -> 中文标签；没登记过的原样返回（新动作上线忘加表也不会显示成空） */
export function actionLabel(action: string): string {
    return LABELS[action] || action;
}
