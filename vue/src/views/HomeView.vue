<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { NAlert, NButton, NEmpty, NInput, NSkeleton } from "naive-ui";
import { useNavStore } from "@/stores/nav";
import SiteCard from "@/components/SiteCard.vue";
import SiteEditDialog from "@/components/SiteEditDialog.vue";
import type { Site } from "@/api/types";

const nav = useNavStore();

// 弹窗状态：null 关闭；对象带 id 是编辑，不带是新增
const editing = ref<Partial<Site> | null>(null);
const isEdit = computed(() => Number(editing.value?.id) > 0);

function openCreate() {
    editing.value = { group_id: nav.groups[0]?.id ?? 0, order_num: 0 };
}

function openEdit(site: Site) {
    editing.value = { ...site };
}

// 拼音词典第一次输入时才拉
function onSearchInput() {
    void nav.ensureMatcher();
}

onMounted(() => {
    void nav.load();
});
</script>

<template>
    <div class="page">
        <header class="topbar">
            <h1 class="brand">Navihive</h1>
            <n-input
                v-model:value="nav.query"
                class="search"
                clearable
                placeholder="搜索网站（支持拼音）"
                @input="onSearchInput"
            />
            <n-button type="primary" @click="openCreate">新增站点</n-button>
        </header>

        <main class="content">
            <n-alert v-if="nav.error" type="error" title="加载失败" closable>
                {{ nav.error }}
            </n-alert>

            <div v-if="nav.loading" class="grid">
                <n-skeleton v-for="i in 6" :key="i" height="86px" />
            </div>

            <template v-else-if="nav.groupsWithSites.length">
                <section v-for="entry in nav.groupsWithSites" :key="entry.group.id" class="group">
                    <h2 class="group-title">{{ entry.group.name }}</h2>
                    <div class="grid">
                        <SiteCard
                            v-for="site in entry.sites"
                            :key="site.id"
                            :site="site"
                            @edit="openEdit"
                        />
                    </div>
                </section>
            </template>

            <n-empty v-else-if="!nav.error" :description="nav.query ? '没有匹配的网站' : '还没有网站'">
                <template #extra>
                    <n-button size="small" @click="openCreate">新增一个</n-button>
                </template>
            </n-empty>
        </main>

        <SiteEditDialog :site="editing" @close="editing = null" />
    </div>
</template>

<style scoped>
.page {
    min-height: 100vh;
}
.topbar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 20px;
    background: #fff;
    border-bottom: 1px solid #e5e6eb;
    position: sticky;
    top: 0;
    z-index: 10;
}
.brand {
    margin: 0;
    font-size: 17px;
    font-weight: 600;
}
.search {
    flex: 1;
    max-width: 420px;
}
.content {
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 24px;
}
.group-title {
    margin: 0 0 10px;
    font-size: 14px;
    font-weight: 600;
    color: #4e5969;
}
.grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
    gap: 12px;
}
</style>
