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

import { useEffect, useMemo, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import CloseIcon from "@mui/icons-material/Close";
import HubIcon from "@mui/icons-material/Hub";
import type { Note, NoteFolder, NoteTag } from "../API/types";
import { resolveWikiLinks, extractWikiLinks } from "../utils/noteWikiLink";
import TextField from "@mui/material/TextField";
import { readActiveAccount, scopedKey } from "../utils/accountScope";

function graphPreference(key: string): string | null {
    try { return localStorage.getItem(scopedKey(`notes.graph.${key}`, readActiveAccount())); }
    catch { return null; }
}

export interface NoteGraphDialogProps {
    open: boolean;
    notes: Note[];
    folders?: NoteFolder[];
    tags?: NoteTag[];
    noteTags?: Record<number, number[]>;
    /** 当前笔记（图谱以它为中心；没有就退化成「全站图」的第一种布局） */
    activeId?: number | null;
    onOpenNote: (id: number) => void;
    onCreateNote?: (title: string) => void;
    onClose: () => void;
}

interface GraphNode {
    id: number;
    title: string;
    degree: number;
    unresolved?: boolean;
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
    folders = [],
    tags = [],
    noteTags = {},
    activeId,
    onOpenNote,
    onCreateNote,
    onClose,
}: NoteGraphDialogProps) {
    /** true = 只画当前笔记的邻域；false = 全站所有笔记（含孤岛） */
    const [localOnly, setLocalOnly] = useState(() => graphPreference("localOnly") !== "false");
    /** 邻域模式的跳数（N9）：1 = 直接邻居（原有行为），2/3 = 沿双链再往外走几跳 */
    const [depth, setDepth] = useState(() => Math.max(1, Math.min(3, Number(graphPreference("depth")) || 1)));
    const [hover, setHover] = useState<number | null>(null);
    const [query, setQuery] = useState("");
    const [groupBy, setGroupBy] = useState<"none" | "folder" | "tag">(() => {
        const value = graphPreference("groupBy"); return value === "folder" || value === "tag" ? value : "none";
    });
    const [folderFilter, setFolderFilter] = useState(() => graphPreference("folderFilter") ?? "");
    const [tagFilter, setTagFilter] = useState(() => graphPreference("tagFilter") ?? "");
    const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 1 });
    const [positions, setPositions] = useState<Record<number, { x: number; y: number }>>({});
    const drag = useRef<{ id: number | null; x: number; y: number; moved: boolean } | null>(null);
    const suppressClick = useRef(false);
    const pointers = useRef(new Map<number, { x: number; y: number }>());
    const pinchDistance = useRef<number | null>(null);
    useEffect(() => {
        try {
            for (const [key, value] of Object.entries({ groupBy, localOnly, depth, folderFilter, tagFilter })) {
                localStorage.setItem(scopedKey(`notes.graph.${key}`, readActiveAccount()), String(value));
            }
        } catch { /* Storage may be unavailable. */ }
    }, [groupBy, localOnly, depth, folderFilter, tagFilter]);
    const nodeColor = (id: number) => {
        const note = notes.find(n => n.id === id);
        const color = groupBy === "folder" ? folders.find(f => f.id === note?.folder_id)?.color
            : groupBy === "tag" ? tags.find(t => noteTags[id]?.includes(t.id!))?.color : null;
        return typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color) ? color : "var(--accent)";
    };

    const graph = useMemo(() => {
        const active = activeId === null || activeId === undefined
            ? null
            : notes.find(n => n.id === activeId) ?? null;

        // 1) 先算出「谁连谁」：出链 + 入链都算一条边（无向，图上不区分方向）。
        // 全量算一次：邻域模式按跳数过滤、全站模式直接用，同一份边表两个模式不吃两遍。
        const edges: { from: number; to: number }[] = [];
        const seen = new Set<string>();
        const addEdge = (from: number, to: number) => {
            if (from === to) return;
            const key = from < to ? `${from}-${to}` : `${to}-${from}`;
            if (seen.has(key)) return;
            seen.add(key);
            edges.push({ from, to });
        };
        const knownTitles = new Set(notes.map(n => n.title.trim().toLowerCase()));
        const unresolved = new Map<number, string>();
        const missingIds = new Map<string, number>();
        let nextMissingId = -1;
        for (const note of notes) {
            if (note.id === undefined) continue;
            for (const out of resolveWikiLinks(notes, note)) addEdge(note.id, out.id);
            for (const title of extractWikiLinks(note.content)) {
                const key = title.trim().toLowerCase();
                if (!key || knownTitles.has(key)) continue;
                let id = missingIds.get(key);
                if (id === undefined) {
                    id = nextMissingId--;
                    missingIds.set(key, id);
                    unresolved.set(id, title.trim());
                }
                addEdge(note.id, id);
            }
        }

        // 2) 邻域模式：从当前笔记 BFS depth 跳，收集可达节点，只留两端都在集合里的边；
        //    全站模式：全部边 + 全部笔记（含孤岛，否则看不出「它没连任何东西」）。
        let keep: Set<number>;
        if (localOnly && active?.id !== undefined) {
            const adj = new Map<number, number[]>();
            for (const e of edges) {
                if (!adj.has(e.from)) adj.set(e.from, []);
                if (!adj.has(e.to)) adj.set(e.to, []);
                adj.get(e.from)!.push(e.to);
                adj.get(e.to)!.push(e.from);
            }
            keep = new Set<number>([active.id]);
            let frontier = [active.id];
            for (let d = 0; d < depth; d++) {
                const next: number[] = [];
                for (const id of frontier) {
                    for (const nb of adj.get(id) ?? []) {
                        if (!keep.has(nb)) {
                            keep.add(nb);
                            next.push(nb);
                        }
                    }
                }
                frontier = next;
            }
        } else {
            keep = new Set<number>();
            for (const e of edges) {
                keep.add(e.from);
                keep.add(e.to);
            }
            for (const n of notes) if (n.id !== undefined) keep.add(n.id);
        }

        // 3) 过滤出要画的边与节点
        const drawn = localOnly && active ? edges.filter(e => keep.has(e.from) && keep.has(e.to)) : edges;
        const degrees = new Map<number, number>();
        for (const edge of drawn) {
            degrees.set(edge.from, (degrees.get(edge.from) ?? 0) + 1);
            degrees.set(edge.to, (degrees.get(edge.to) ?? 0) + 1);
        }
        const ids = new Set<number>(degrees.keys());
        if (localOnly && active?.id !== undefined) ids.add(active.id);
        else for (const n of notes) if (n.id !== undefined) ids.add(n.id);

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
                return { id, title: unresolved.get(id) || note?.title || "无标题", unresolved: unresolved.has(id), degree: degrees.get(id) ?? 0 };
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

        const filtered = nodes.filter(n => n.title.toLowerCase().includes(query.toLowerCase())
            && (!folderFilter || String(notes.find(note => note.id === n.id)?.folder_id) === folderFilter)
            && (!tagFilter || noteTags[n.id]?.includes(Number(tagFilter))));
        const limited = filtered.slice(0, 350);
        const byId = new Map(limited.map(n => [n.id, n]));
        return { nodes: limited, truncated: filtered.length > 350, edges: drawn.filter(e => byId.has(e.from) && byId.has(e.to)), byId };
    }, [notes, activeId, localOnly, depth, query, folderFilter, tagFilter, noteTags]);

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
                {/* N9 邻域跳数：只在「只看本文」下有意义（全站模式下隐藏） */}
                {localOnly && (
                    <Box sx={{ display: "flex", gap: 0.25 }}>
                        {[1, 2, 3].map(d => (
                            <Button
                                key={d}
                                size='small'
                                data-graph-depth={d}
                                variant={depth === d ? "contained" : "text"}
                                sx={{ minWidth: 32, px: 0.5 }}
                                onClick={() => setDepth(d)}
                            >
                                {d}跳
                            </Button>
                        ))}
                    </Box>
                )}
                <IconButton aria-label='关闭图谱' size='small' onClick={onClose}>
                    <CloseIcon fontSize='small' />
                </IconButton>
            </DialogTitle>
            <DialogContent sx={{ pt: 0.5 }}>
                <TextField size='small' fullWidth value={query} onChange={e => setQuery(e.target.value)} label='筛选节点标题' />
                <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", my: 1 }}>
                    <label>着色 <select aria-label='图谱着色' value={groupBy} onChange={e => setGroupBy(e.target.value as typeof groupBy)}><option value='none'>默认</option><option value='folder'>文件夹</option><option value='tag'>标签</option></select></label>
                    <label>文件夹 <select aria-label='图谱文件夹过滤' value={folderFilter} onChange={e => setFolderFilter(e.target.value)}><option value=''>全部</option>{folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
                    <label>标签 <select aria-label='图谱标签过滤' value={tagFilter} onChange={e => setTagFilter(e.target.value)}><option value=''>全部</option>{tags.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
                    <Button size='small' aria-label='图谱缩小' onClick={() => setCamera(c => ({ ...c, zoom: Math.max(0.25, c.zoom / 1.2) }))}>−</Button>
                    <Button size='small' aria-label='图谱放大' onClick={() => setCamera(c => ({ ...c, zoom: Math.min(4, c.zoom * 1.2) }))}>+</Button>
                    <Button size='small' onClick={() => { setCamera({ x: 0, y: 0, zoom: 1 }); setPositions({}); }}>重置视图</Button>
                </Box>
                {graph.truncated && <Typography role='status'>节点过多，仅展示前 350 个，请缩小范围。</Typography>}
                <Typography variant='caption'>虚线节点代表未创建的链接目标，点击或按 Enter 可创建笔记。</Typography>
                <Typography variant='caption' color='text.secondary' sx={{ display: "block", mb: 1 }}>
                    {localOnly
                        ? depth === 1
                            ? "当前笔记与它一跳之内相连的笔记；点节点就跳过去。"
                            : `当前笔记沿双链往外 ${depth} 跳之内的笔记；点节点就跳过去。`
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
                        style={{ touchAction: "none" }}
                        onWheel={e => setCamera(c => ({ ...c, zoom: Math.min(4, Math.max(0.25, c.zoom * (e.deltaY > 0 ? 0.9 : 1.1))) }))}
                        onPointerDown={e => {
                            pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
                            if (pointers.current.size === 2) {
                                const [a, b] = [...pointers.current.values()];
                                pinchDistance.current = Math.hypot(a.x - b.x, a.y - b.y);
                                drag.current = null;
                                suppressClick.current = true;
                                e.currentTarget.setPointerCapture?.(e.pointerId);
                                return;
                            }
                            const element = (e.target as Element).closest("[data-graph-node]");
                            drag.current = { id: element ? Number(element.getAttribute("data-graph-node")) : null, x: e.clientX, y: e.clientY, moved: false };
                            suppressClick.current = false;
                            e.currentTarget.setPointerCapture?.(e.pointerId);
                        }}
                        onPointerMove={e => {
                            if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
                            if (pointers.current.size >= 2) {
                                const [a, b] = [...pointers.current.values()];
                                const distance = Math.hypot(a.x - b.x, a.y - b.y);
                                const previous = pinchDistance.current;
                                if (previous && distance) setCamera(c => ({ ...c, zoom: Math.max(0.25, Math.min(4, c.zoom * distance / previous)) }));
                                pinchDistance.current = distance;
                                return;
                            }
                            const state = drag.current;
                            if (!state) return;
                            const scale = WIDTH / (e.currentTarget.getBoundingClientRect().width || WIDTH);
                            const dx = (e.clientX - state.x) * scale, dy = (e.clientY - state.y) * scale;
                            if (Math.abs(dx) + Math.abs(dy) > 2) state.moved = true;
                            state.x = e.clientX; state.y = e.clientY;
                            if (state.id === null) setCamera(c => ({ ...c, x: c.x + dx, y: c.y + dy }));
                            else {
                                const node = graph.byId.get(state.id);
                                if (node) setPositions(p => ({ ...p, [node.id]: { x: (p[node.id]?.x ?? node.x) + dx / camera.zoom, y: (p[node.id]?.y ?? node.y) + dy / camera.zoom } }));
                            }
                        }}
                        onPointerUp={e => { pointers.current.delete(e.pointerId); pinchDistance.current = null; suppressClick.current = suppressClick.current || (drag.current?.moved ?? false); drag.current = null; }}
                        onPointerCancel={e => { pointers.current.delete(e.pointerId); pinchDistance.current = null; drag.current = null; suppressClick.current = true; }}
                    >
                        <g transform={`translate(${camera.x} ${camera.y}) scale(${camera.zoom})`}>
                        {/* 连线先画（在节点下面），命中高亮时加粗 */}
                        {graph.edges.map(edge => {
                            const a = positions[edge.from] ?? graph.byId.get(edge.from);
                            const b = positions[edge.to] ?? graph.byId.get(edge.to);
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
                                    transform={positions[node.id] ? `translate(${positions[node.id].x - node.x} ${positions[node.id].y - node.y})` : undefined}
                                    data-graph-node={node.id}
                                    role='button'
                                    tabIndex={0}
                                    aria-label={node.unresolved ? `创建笔记 ${node.title}` : `打开笔记 ${node.title}`}
                                    aria-disabled={node.unresolved && !onCreateNote ? true : undefined}
                                    data-graph-unresolved={node.unresolved ? "1" : undefined}
                                    onClick={() => { if (!suppressClick.current) { if (node.unresolved) onCreateNote?.(node.title); else onOpenNote(node.id); } }}
                                    onKeyDown={e => {
                                        if (e.key === "Enter" || e.key === " ") {
                                            e.preventDefault();
                                            if (node.unresolved) onCreateNote?.(node.title);
                                            else onOpenNote(node.id);
                                        }
                                    }}
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
                                                : node.degree === 0 && groupBy === "none"
                                                  ? "rgba(128,128,128,0.5)"
                                                  : nodeColor(node.id)
                                        }
                                        stroke={nodeColor(node.id)}
                                        strokeWidth={1}
                                        strokeDasharray={node.unresolved ? "3 3" : undefined}
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
                        </g>
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
