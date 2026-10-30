// 「新增网站」弹窗的 AI 补全：一个带超时、带请求号防串台的小状态机。
//
// 原来是 App.tsx 里内联的 70 多行（P2-17 下沉）。搬出来不是为了行数好看，是因为
// 这段的**正确性全靠三个易漏的细节**，散在大组件里改一次就容易被顺手改坏：
//
//   ① 请求号（requestId）：弹窗关掉又重开、URL 改一次又改回来，都会让上一条请求
//      晚到。晚到的响应往表单里写 name/description 就是「AI 把上一张表单的内容
//      填进了这一张」——用户看到的是一串莫名其妙的鬼话。所以每次发请求都自增，
//      回来先对号，号不对整条丢弃。
//   ② 30 秒超时：AI 供应商卡住时 fetch 不会自己结束，弹窗会永远转圈。超时与真
//      响应赛跑（Promise.race），谁先到算谁的 —— 但**超时不算请求号失效**，所以
//      仍在 finally 里收 busy。
//   ③ 清理时机是 openAddSite + newSite.url：关弹窗要清，改了 URL 也要清 —— 后者
//      是刻意的，旧 URL 的补全结果对新 URL 就是错的。外加一个 mount/unmount 时的
//      兜底自增，防止组件卸载后 setState（React 会警告，且状态已经没人看了）。
//
// 与「编辑站点」那边的补全是同一套交互（成功不说话、失败才提示），刻意没有合并成
// 一个通用 hook：两边的入参来源完全不同（一个改草稿、一个改已有记录），抽在一起
// 只会变成一堆 if。
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { Site } from "../API/http";
import type { useSiteAiMeta } from "./useAiAssistant";

export type UseNewSiteAiAssistParams = {
    /** 顶栏/弹窗共用的那份 AI 元信息（enabled 决定按钮显不显示） */
    siteAi: ReturnType<typeof useSiteAiMeta>;
    /** 正在编辑的新建草稿 */
    newSite: Partial<Site>;
    setNewSite: Dispatch<SetStateAction<Partial<Site>>>;
    /** 供 AI 参考的既有分组名（让它别起一个跟现有一模一样的名字） */
    groupNames: string[];
    /** 供 AI 参考的既有标签 */
    allTags: string[];
    /** 「新增网站」弹窗开着没有；关掉要清干净 */
    openAddSite: boolean;
    /** 真正关弹窗的动作（本 hook 只负责关之前把 AI 状态收干净） */
    closeAddSite: () => void;
};

export function useNewSiteAiAssist({
    siteAi,
    newSite,
    setNewSite,
    groupNames,
    allTags,
    openAddSite,
    closeAddSite,
}: UseNewSiteAiAssistParams) {
    const [aiBusy, setAiBusy] = useState(false);
    const [aiMessage, setAiMessage] = useState("");
    const [aiMessageError, setAiMessageError] = useState(false);
    const requestId = useRef(0);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    useEffect(() => {
        // 包括创建成功后的关闭、URL 改写和卸载；旧请求不能污染下一张表单。
        requestId.current += 1;
        clearTimeout(timer.current);
        setAiBusy(false);
        setAiMessage("");
        setAiMessageError(false);
        return () => {
            requestId.current += 1;
            clearTimeout(timer.current);
        };
    }, [openAddSite, newSite.url]);

    const handleCloseAddSiteWithAiReset = () => {
        requestId.current += 1;
        setAiBusy(false);
        setAiMessage("");
        setAiMessageError(false);
        closeAddSite();
    };

    const handleAiComplete = async () => {
        if (!siteAi?.enabled || !newSite.url || aiBusy) return;
        const id = ++requestId.current;
        setAiBusy(true);
        setAiMessage("");
        setAiMessageError(false);
        const timeout = new Promise<never>((_resolve, reject) => {
            timer.current = setTimeout(() => reject(new Error("AI 补全超时，请检查网络或稍后重试")), 30_000);
        });
        try {
            const res = await Promise.race([
                siteAi.siteMeta(newSite.url, {
                    name: newSite.name || undefined,
                    groups: groupNames,
                    tags: allTags,
                }),
                timeout,
            ]);
            if (id !== requestId.current) return;
            if (!res.ok) {
                setAiMessage(res.message);
                setAiMessageError(true);
                return;
            }
            const { name, description } = res.data;
            setNewSite(prev => ({
                ...prev,
                name: name || prev.name,
                description: description || prev.description,
            }));
        } catch (error) {
            if (id === requestId.current) {
                setAiMessage(error instanceof Error ? error.message : "AI 补全失败，请重试");
                setAiMessageError(true);
            }
        } finally {
            if (id === requestId.current) {
                clearTimeout(timer.current);
                setAiBusy(false);
            }
        }
    };

    return {
        aiBusy,
        aiMessage,
        aiMessageError,
        handleAiComplete,
        handleCloseAddSiteWithAiReset,
    };
}
