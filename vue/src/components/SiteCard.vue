<script setup lang="ts">
import { computed, ref } from "vue";
import type { Site } from "@/api/types";

const props = defineProps<{ site: Site }>();
const emit = defineEmits<{ edit: [site: Site] }>();

const iconBroken = ref(false);

// 没有图标（或图标加载失败）时用站点名首字兜底，避免出现一堆碎图
const initial = computed(() => props.site.name?.trim().charAt(0) || "?");
const subtitle = computed(() => props.site.description || props.site.url || "");
</script>

<template>
    <article class="card">
        <a class="hit" :href="site.url" target="_blank" rel="noopener noreferrer">
            <div class="icon">
                <img v-if="site.icon && !iconBroken" :src="site.icon" alt="" @error="iconBroken = true" />
                <span v-else class="initial">{{ initial }}</span>
            </div>
            <div class="meta">
                <div class="name">{{ site.name }}</div>
                <div class="desc">{{ subtitle }}</div>
            </div>
        </a>
        <button class="edit" type="button" @click="emit('edit', site)">编辑</button>
    </article>
</template>

<style scoped>
.card {
    position: relative;
    background: #fff;
    border: 1px solid #e5e6eb;
    border-radius: 10px;
    transition:
        box-shadow 0.15s,
        border-color 0.15s;
}
.card:hover {
    border-color: #c9cdd4;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.06);
}
.hit {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px;
    text-decoration: none;
    color: inherit;
}
.icon {
    width: 34px;
    height: 34px;
    flex: 0 0 34px;
    border-radius: 8px;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #f2f3f5;
}
.icon img {
    width: 100%;
    height: 100%;
    object-fit: cover;
}
.initial {
    font-size: 15px;
    font-weight: 600;
    color: #4e5969;
}
.meta {
    min-width: 0;
}
.name {
    font-size: 14px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.desc {
    font-size: 12px;
    color: #86909c;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
/* 默认隐藏，hover / 键盘聚焦时才出现：列表页保持干净，操作又不至于找不到 */
.edit {
    position: absolute;
    top: 8px;
    right: 8px;
    padding: 2px 8px;
    font-size: 12px;
    color: #4e5969;
    background: #fff;
    border: 1px solid #e5e6eb;
    border-radius: 6px;
    cursor: pointer;
    opacity: 0;
}
.card:hover .edit,
.edit:focus-visible {
    opacity: 1;
}
</style>
