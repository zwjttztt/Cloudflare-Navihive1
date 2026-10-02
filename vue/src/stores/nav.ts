// 站点数据的唯一来源：分组 + 平铺站点 + 全站配置。
// 用 setup 式 store，和组件里写 composable 的姿势一致。
import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { fetchBootstrap } from "@/api/http";
import type { Group, Site } from "@/api/types";
import { loadPinyinMatcher } from "@shared/utils/pinyin";

type PinyinFn = (input: string, keys: string) => [number, number] | false;

export interface GroupWithSites {
    group: Group;
    sites: Site[];
}

export const useNavStore = defineStore("nav", () => {
    const groups = ref<Group[]>([]);
    const sites = ref<Site[]>([]);
    const configs = ref<Record<string, string>>({});
    const loading = ref(false);
    const error = ref("");
    const query = ref("");

    // 拼音词典约 28KB，按需加载：用户没搜过中文就永远不下载
    const matcher = ref<PinyinFn | null>(null);

    async function load() {
        loading.value = true;
        error.value = "";
        try {
            const data = await fetchBootstrap();
            groups.value = data.groups ?? [];
            sites.value = data.sites ?? [];
            configs.value = data.configs ?? {};
        } catch (e) {
            error.value = e instanceof Error ? e.message : String(e);
        } finally {
            loading.value = false;
        }
    }

    async function ensureMatcher() {
        if (!matcher.value) matcher.value = await loadPinyinMatcher();
    }

    const keyword = computed(() => query.value.trim().toLowerCase());

    const filteredSites = computed<Site[]>(() => {
        const kw = keyword.value;
        if (!kw) return sites.value;
        const m = matcher.value;
        return sites.value.filter(site => {
            // 名称 / 链接 / 描述任一字段命中即算命中
            return [site.name, site.url, site.description].some(text => {
                if (!text) return false;
                if (text.toLowerCase().includes(kw)) return true;
                return m ? m(text, kw) !== false : false;
            });
        });
    });

    /** 按分组归拢：搜索时也跟着收窄，空分组自动隐藏 */
    const groupsWithSites = computed<GroupWithSites[]>(() => {
        const byGroup = new Map<number, Site[]>();
        for (const site of filteredSites.value) {
            const list = byGroup.get(site.group_id);
            if (list) list.push(site);
            else byGroup.set(site.group_id, [site]);
        }
        return groups.value
            .map(group => ({ group, sites: byGroup.get(group.id!) ?? [] }))
            .filter(entry => entry.sites.length > 0);
    });

    return {
        groups,
        sites,
        configs,
        loading,
        error,
        query,
        load,
        ensureMatcher,
        filteredSites,
        groupsWithSites,
    };
});
