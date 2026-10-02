<script setup lang="ts">
// 新增 / 编辑站点。样板阶段只做核心字段：名称、链接、图标、描述、备注。
// 登录凭据、标签、星标等后续再补 —— 先把「能读能写」这条链路打通。
import { computed, ref, watch } from "vue";
import {
    NButton,
    NForm,
    NFormItem,
    NInput,
    NModal,
    NSelect,
    NSpace,
    useMessage,
} from "naive-ui";
import { createSite, fetchSiteMeta, updateSite } from "@/api/http";
import type { Site } from "@/api/types";
import { useNavStore } from "@/stores/nav";

const props = defineProps<{ site: Partial<Site> | null }>();
const emit = defineEmits<{ close: []; saved: [] }>();

const message = useMessage();
const nav = useNavStore();

const form = ref<Partial<Site>>({});
const saving = ref(false);
const fetching = ref(false);

const visible = computed(() => props.site !== null);
const isEdit = computed(() => Number(props.site?.id) > 0);

// 弹窗打开时把外头那份拷进来改，别直接动 store 里的对象：
// 改一半关掉不该留下脏数据。
watch(
    () => props.site,
    incoming => {
        form.value = incoming ? { ...incoming } : {};
    },
    { immediate: true }
);

const groupOptions = computed(() =>
    nav.groups.map(g => ({ label: g.name, value: g.id as number }))
);

async function grabMeta() {
    if (!form.value.url) return;
    fetching.value = true;
    try {
        const meta = await fetchSiteMeta(form.value.url);
        if (meta.title) form.value.name = form.value.name || meta.title;
        if (meta.description) form.value.description = form.value.description || meta.description;
        if (meta.icon) form.value.icon = form.value.icon || meta.icon;
    } catch (e) {
        message.warning(e instanceof Error ? e.message : "抓取失败");
    } finally {
        fetching.value = false;
    }
}

async function save() {
    if (!form.value.name?.trim() || !form.value.url?.trim()) {
        message.error("站点名称和链接都要填");
        return;
    }
    saving.value = true;
    try {
        if (isEdit.value) await updateSite(form.value as Site);
        else await createSite(form.value as Site);
        message.success(isEdit.value ? "已保存" : "已创建");
        await nav.load();
        emit("saved");
    } catch (e) {
        message.error(e instanceof Error ? e.message : "保存失败");
    } finally {
        saving.value = false;
    }
}
</script>

<template>
    <n-modal :show="visible" preset="card" :title="isEdit ? '编辑站点' : '新增站点'" style="width: 520px" @update:show="emit('close')">
        <n-form label-placement="top">
            <n-form-item label="站点名称" required>
                <n-input v-model:value="form.name" placeholder="给它起个名字" />
            </n-form-item>
            <n-form-item label="站点链接" required>
                <n-input v-model:value="form.url" placeholder="https://example.com" />
                <template #feedback>
                    <n-button text :loading="fetching" @click="grabMeta">根据链接抓取标题与描述</n-button>
                </template>
            </n-form-item>
            <n-form-item label="图标链接">
                <n-input v-model:value="form.icon" placeholder="留空自动用站点图标" />
            </n-form-item>
            <n-form-item label="分组">
                <n-select v-model:value="form.group_id" :options="groupOptions" />
            </n-form-item>
            <n-form-item label="描述">
                <n-input v-model:value="form.description" type="textarea" :rows="2" placeholder="一句话说明它是干什么的" />
            </n-form-item>
            <n-form-item label="备注">
                <n-input v-model:value="form.notes" type="textarea" :rows="2" placeholder="可选的私人备注" />
            </n-form-item>
        </n-form>

        <template #footer>
            <n-space justify="end">
                <n-button @click="emit('close')">取消</n-button>
                <n-button type="primary" :loading="saving" @click="save">保存</n-button>
            </n-space>
        </template>
    </n-modal>
</template>
