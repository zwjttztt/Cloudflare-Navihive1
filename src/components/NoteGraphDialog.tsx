// src/components/NoteGraphDialog.tsx
// 双链关系图谱（2026-10-09，照 inkstone 的 GraphPanel 做一个轻量版）。
//
// 为什么值得有：双链写到一定数量之后，「谁引用了谁」在列表里是看不出来的 ——
// 一条笔记可能同时被五篇引用、又链出去三篇，而在列表视图里这些关系全是暗的。
// 图谱把这层关系一次摊开：点一个节点就跳过去。
//
// ⚠️ 刻意**不做**力导向动画（inkstone 那版 675 行里有大半是它的物理与缩放）：
// 这里用确定性布局（当前笔记居中、邻居按弧长均匀分布在环上），
// 没有动画就没有「每次打开位置都不一样」的困惑，也不用一个 rAF 循环常驻。
//
// 数据全部来自已有的 utils/noteWikiLink（buildBacklinks / resolveWikiLinks），
// 与正文渲染用的是同一套 `[[双链]]` 判据，不会出现「图上连了、正文里没连」。

import { useMemo, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import CloseIcon from "@mui/icons-material/Close";
import HubIcon from "@mui/icons-material/Hub";
import type { Note } from "../API/types";
import { buildBacklinks, resolveWikiLinks } from "../utils/noteWikiLink";

export interface NoteGraphDialogProps {
    open: boolean;
    notes: Note[];
    /** 当前笔记（图谱以它为中心；没有就退化成「全站图」的第一种布局） */
    activeId?: number | null;
    onOpenNote: (id: number) => void;
    onClose: () => void;
}

interface GraphNode {
    id: number;
    title: string;
    degree: number;
    x: number;
    y: number;
}

const WIDTH = 640;
const HEIGHT = 420;
const CENTER_X = WIDTH / 2;
const CENTER_Y = HEIGHT / 2;
/** 环的半径：留出边上标签的位置，别让节点顶到画布边缘 */
const RADIUS = 150;
const NODE_R = 9;

export default function NoteGraphDialog({
    open,
    notes,
    activeId,
    onOpenNote,
    onClose,
}: NoteGraphDialogProps) {
    /** true = 只画当前笔记的邻域；false = 全站所有笔记（含孤岛） */
    const [localOnly, setLocalOnly] = useState(true);
    const [hover, setHover] = useState<number | null>(null);

    const graph = useMemo(() => {
        const active = activeId === null || activeId === undefined
            ? null
            : notes.find(n => n.id === activeId) ?? null;

        // 1) 先算出「谁连谁」：出链 + 入链都算一条边（无向，图上不区分方向）
        const edges: { from: number; to: number }[] = [];
        const seen = new Set<string>();
        const addEdge = (from: number, to: number) => {
            if (from === to) return;
            const key = from < to ? `${from}-${to}` : `${to}-${from}`;
            if (seen.has(key)) return;
            seen.add(key);
            edges.push({ from, to });
        };
        if (localOnly && active) {
            for (const out of resolveWikiLinks(notes, active)) addEdge(active.id!, out.id);
            for (const back of buildBacklinks(notes, active)) addEdge(back.id, active.id!);
        } else {
            for (const note of notes) {
                if (note.id === undefined) continue;
                for (const out of resolveWikiLinks(notes, note)) addEdge(note.id, out.id);
            }
        }

        // 2) 只保留**边上出现过的**节点（孤岛在全站模式下也画出来，否则看不出「它没连任何东西」）
        const degrees = new Map<number, number>();
        for (const edge of edges) {
            degrees.set(edge.from, (degrees.get(edge.from) ?? 0) + 1);
            degrees.set(edge.to, (degrees.get(edge.to) ?? 0) + 1);
        }
        const ids = new Set<number>(degrees.keys());
        if (localOnly && active?.id !== undefined) ids.add(active.id);
        else if (!localOnly) for (const n of notes) if (n.id !== undefined) ids.add(n.id);

        const nodes: GraphNode[] = [];
        if (active?.id !== undefined && ids.has(active.id)) {
            nodes.push({
                id: active.id,
                title: active.title || "无标题",
                degree: degrees.get(active.id) ?? 0,
                x: CENTER_X,
                y: CENTER_Y,
            });
        }
        // 环上的节点：按度数降序排，连得多的排在前面（视觉上更靠近 12 点方向）
        const ring = [...ids]
            .filter(id => id !== active?.id)
            .map(id => {
                const note = notes.find(n => n.id === id);
                return { id, title: note?.title || "无标题", degree: degrees.get(id) ?? 0 };
            })
            .sort((a, b) => b.degree - a.degree || a.title.localeCompare(b.title));
        ring.forEach((item, index) => {
            // 从 12 点方向开始顺时针铺开
            const angle = (index / Math.max(ring.length, 1)) * Math.PI * 2 - Math.PI / 2;
            nodes.push({
                ...item,
                x: CENTER_X + Math.cos(angle) * RADIUS,
                y: CENTER_Y + Math.sin(angle) * RADIUS,
            });
        });

        const byId = new Map(nodes.map(n => [n.id, n]));
        return { nodes, edges: edges.filter(e => byId.has(e.from) && byId.has(e.to)), byId };
    }, [notes, activeId, localOnly]);

    const connected = useMemo(() => {
        const set = new Set<number>();
        if (hover === null) return set;
        for (const edge of graph.edges) {
            if (edge.from === hover) set.add(edge.to);
            if (edge.to === hover) set.add(edge.from);
        }
        return set;
    }, [graph.edges, hover]);

    return (
        <Dialog
            open={open}
            onClose={onClose}
            maxWidth='md'
            fullWidth
            slotProps={{ paper: { sx: { borderRadius: 3 } } }}
        >
            <DialogTitle
                sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    fontSize: 15,
                    fontWeight: 600,
                    py: 1.5,
                }}
            >
                <HubIcon fontSize='small' sx={{ color: "var(--accent)" }} />
                <Box sx={{ flex: 1 }}>关系图谱</Box>
                <Button
                    size='small'
                    variant={localOnly ? "contained" : "outlined"}
                    data-graph-scope={localOnly ? "local" : "all"}
                    onClick={() => setLocalOnly(v => !v)}
                >
                    {localOnly ? "只看本文" : "看全部"}
                </Button>
                <IconButton aria-label='关闭图谱' size='small' onClick={onClose}>
                    <CloseIcon fontSize='small' />
                </IconButton>
            </DialogTitle>
            <DialogContent sx={{ pt: 0.5 }}>
                <Typography variant='caption' color='text.secondary' sx={{ display: "block", mb: 1 }}>
                    {localOnly
                        ? "当前笔记与它一跳之内相连的笔记；点节点就跳过去。"
                        : "全站所有笔记之间的双链；灰点是还没有任何链接的笔记。"}
                    共 {graph.nodes.length} 个节点、{graph.edges.length} 条连线。
                </Typography>
                <Box
                    data-graph='1'
                    sx={{
                        width: "100%",
                        overflow: "auto",
                        borderRadius: 2,
                        border: "1px solid rgba(128,128,128,0.16)",
                        bgcolor: "rgba(128,128,128,0.03)",
                    }}
                >
                    <svg
                        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
                        width='100%'
                        height={HEIGHT}
                        role='img'
                        aria-label='笔记双链关系图'
                    >
                        {/* 连线先画（在节点下面），命中高亮时加粗 */}
                        {graph.edges.map(edge => {
                            const a = graph.byId.get(edge.from);
                            const b = graph.byId.get(edge.to);
                            if (!a || !b) return null;
                            const lit =
                                hover !== null &&
                                (edge.from === hover || edge.to === hover);
                            return (
                                <line
                                    key={`${edge.from}-${edge.to}`}
                                    data-graph-edge={`${edge.from}-${edge.to}`}
                                    x1={a.x}
                                    y1={a.y}
                                    x2={b.x}
                                    y2={b.y}
                                    stroke={lit ? "var(--accent)" : "rgba(128,128,128,0.45)"}
                                    strokeWidth={lit ? 2 : 1}
                                />
                            );
                        })}
                        {graph.nodes.map(node => {
                            const isHover = hover === node.id;
                            const isNeighbor = connected.has(node.id);
                            const dim = hover !== null && !isHover && !isNeighbor;
                            return (
                                <g
                                    key={node.id}
                                    data-graph-node={node.id}
                                    onClick={() => onOpenNote(node.id)}
                                    onMouseEnter={() => setHover(node.id)}
                                    onMouseLeave={() => setHover(null)}
                                    style={{ cursor: "pointer" }}
                                    opacity={dim ? 0.3 : 1}
                                >
                                    <circle
                                        cx={node.x}
                                        cy={node.y}
                                        r={NODE_R + Math.min(node.degree, 6)}
                                        fill={
                                            isHover
                                                ? "var(--accent)"
                                                : node.degree === 0
                                                  ? "rgba(128,128,128,0.5)"
                                                  : "color-mix(in srgb, var(--accent) 55%, transparent)"
                                        }
                                        stroke='var(--accent)'
                                        strokeWidth={1}
                                    />
                                    <text
                                        x={node.x}
                                        y={node.y - NODE_R - 8}
                                        textAnchor='middle'
                                        fontSize={11}
                                        fill='currentColor'
                                    >
                                        {node.title.length > 10
                                            ? node.title.slice(0, 10) + "…"
                                            : node.title}
                                    </text>
                                </g>
                            );
                        })}
                    </svg>
                </Box>
                {graph.nodes.length === 0 && (
                    <Typography
                        data-graph-empty='1'
                        variant='body2'
                        color='text.secondary'
                        sx={{ textAlign: "center", py: 3 }}
                    >
                        还没有任何双链：在正文里写 [[笔记标题]] 就能连起来。
                    </Typography>
                )}
            </DialogContent>
        </Dialog>
    );
}
