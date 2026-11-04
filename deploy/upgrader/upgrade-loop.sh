#!/bin/sh
# ============================================================================
# NaviHive 升级器循环 —— docker-compose.yml 里 `upgrader` 服务的**执行体**。
#
# 2026-11（本次抽取）之前，这段 shell 以 block scalar 的形式内联在
# docker-compose.yml 的 `upgrader.command:` 里。抽成独立文件的原因：
#   ① 内联字符串没法被任何测试真正执行，只能做文本锚点断言 —— 而这是**唯一持有
#      docker.sock 的特权组件**，三个终态（done / rolled_back / rollback_failed）却
#      零行为覆盖；
#   ② 内联在 compose 里意味着「改一行脚本 = 改部署文件」，没人敢碰它；
#   ③ 抽成文件后 tests/upgraderLoop.test.ts 能用假 docker 真跑它。
#
# ⚠️ 同时说清楚这次抽取**没有**解决什么（别把没解决的写成解决了 —— 2026-11-04
# 那次事故正是「CHANGELOG 里写着 R05 生效了，线上其实跑着三天前的旧脚本」）：
#   · 本文件仍然是一份**要同步到部署目录**的普通文件，**没有**随镜像发布。同步负担
#     从「1 个文件（docker-compose.yml）」变成「2 个（compose + deploy/upgrader/
#     整个目录）」，而且线上部署目录与仓库目录是分离的（见 deploy/selfhost.md）。
#   · 所以「宿主机跑着旧脚本」这个失败模式**没有根治**，只是从**静默**变成了
#     **可测 + 可响亮失败**（脚本缺失 → compose 的存在性检查 exit 1；脚本陈旧 →
#     至少它现在有行为测试、有被 review 的可能）。
#   · 根治要靠版本握手：本脚本自报内容哈希、应用侧比对不一致就告警。那是另一件事。
#
# 职责：轮询共享卷里的 /spool/request（应用容器写），消费后执行
#   pull 目标镜像 → tag 成 navihive:latest → 给旧镜像打 navihive:previous 锚点
#   → compose 重建 navihive → 健康门禁 → （不健康则）回滚到 previous
# 并把每一阶段写进 /spool/state.json 供应用侧轮询展示。
#
# ⚠️ 这是**两份实现**之一。另一份是 server/upgradeHealth.ts 里的
# tagPreviousBeforeRecreate() / healthGuardAfterRecreate()，由 server/entry.ts 在
# 「应用容器直接持有 docker.sock」的 sock 模式下生成 shell 执行。两份实现必须含
# **同一组关键锚点**（navihive:previous / {{.Image}} / {{.State.Health.Status}} /
# 回滚用的那条完整 `docker compose ... up -d --force-recreate --no-deps navihive`），
# 由 tests/systemUpgradeGuard.test.ts 的「两条升级路径锚点一致」一组断言绑住：
# 改一边必须同步另一边，否则那边直接红。
# 本文件的行为（三态终局）由 tests/upgraderLoop.test.ts 用假 docker 真跑覆盖。
#
# ---- 终态相位语义（state.json 的 phase，UI 按这个渲染）----
#   pulling           正在拉取目标镜像
#   recreating        正在 compose 重建 navihive
#   done              升级成功：新容器通过了健康门禁（GUARD_OK 非空）
#   failed            升级失败且**没有**进入回滚：镜像拉取失败，或重建本身失败
#   rolled_back       升级失败但已自动回滚，且回滚命令 rc=0、回滚后旧容器二次探活 healthy
#   rollback_failed   回滚也失败（回滚命令 rc≠0，或回滚后旧容器仍不 healthy）→ 需人工介入
#
#   ⚠️ done 只能在健康门禁通过后写。回滚过却报 done 会让 UI 把"失败已回滚"显示成
#   "升级成功"——那正是 R05 要消灭的假成功。
#
# ---- 测试注入点（环境变量）----
# 下面四个变量**只为测试而存在**，默认值与原内联版逐字一致（不设 = 线上行为完全不变）：
#   NAVIHIVE_UPGRADER_SPOOL                   默认 /spool        状态/请求文件目录（挂载点）
#   NAVIHIVE_UPGRADER_POLL_SECONDS            默认 2             等请求文件的轮询间隔
#   NAVIHIVE_UPGRADER_HEALTH_POLL_SECONDS     默认 3             健康探活间隔
#   NAVIHIVE_UPGRADER_ONCE                    默认 空            非空 = 处理完一轮就退出
# 没有这些注入口，`while true` 的主循环 + `sleep 3` × 60 次探活会让行为测试跑不完；
# 而用 sed 改写脚本文本再跑，测的就不是仓库里这份文件了。
# ============================================================================
set -u

# ---- 测试注入点（见文件头，默认值 = 线上值）----
SPOOL_DIR="${NAVIHIVE_UPGRADER_SPOOL:-/spool}"
POLL_SECONDS="${NAVIHIVE_UPGRADER_POLL_SECONDS:-2}"
HEALTH_POLL_SECONDS="${NAVIHIVE_UPGRADER_HEALTH_POLL_SECONDS:-3}"
ONCE="${NAVIHIVE_UPGRADER_ONCE:-}"
ONCE_RAN=""

IMAGE="${NAVIHIVE_IMAGE}"
echo "[upgrader] 就绪：轮询 $SPOOL_DIR/request（image=$IMAGE）"
while true; do
  # 测试注入点：NAVIHIVE_UPGRADER_ONCE 非空时，第一轮处理完就退出（线上为空，永不触发）
  if [ -n "$ONCE" ] && [ -n "$ONCE_RAN" ]; then exit 0; fi
  if [ ! -f "$SPOOL_DIR/request" ]; then sleep "$POLL_SECONDS"; continue; fi
  rm -f "$SPOOL_DIR/request"
  ONCE_RAN=1
  started=$(date +%s)000
  printf '{"phase":"pulling","image":"%s","error":"","startedAt":%s,"finishedAt":0}' "$IMAGE" "$started" > "$SPOOL_DIR/state.json"
  echo "[upgrader] 拉取 $IMAGE"
  if ! docker pull "$IMAGE"; then
    printf '{"phase":"failed","image":"","error":"拉取镜像失败（详见 upgrader 容器日志）","startedAt":%s,"finishedAt":%s}' "$started" "$(date +%s)000" > "$SPOOL_DIR/state.json"
    continue
  fi
  docker tag "$IMAGE" navihive:latest 2>/dev/null || true
  # 升级前给当前（旧）镜像打回滚锚点：recreate 之后 latest 已是新镜像，旧镜像只剩这一份 ImageID
  PREV_ID=$(docker inspect --format='{{.Image}}' navihive 2>/dev/null || true)
  if [ -n "$PREV_ID" ]; then docker tag "$PREV_ID" navihive:previous 2>/dev/null || true; fi
  printf '{"phase":"recreating","image":"","error":"","startedAt":%s,"finishedAt":0}' "$started" > "$SPOOL_DIR/state.json"
  echo "[upgrader] 重建 navihive"
  if docker compose -f docker-compose.yml -p navihive up -d --force-recreate --no-deps navihive; then
    # ---- 健康门禁：重建后新容器必须 healthy，否则回滚 previous ----
    GUARD_OK=""
    for _i in $(seq 1 40); do
      ST=$(docker inspect --format='{{.State.Health.Status}}' navihive 2>/dev/null || echo starting)
      if [ "$ST" = "healthy" ]; then GUARD_OK=1; break; fi
      if [ "$ST" = "unhealthy" ]; then break; fi
      sleep "$HEALTH_POLL_SECONDS"
    done
    if [ -z "$GUARD_OK" ]; then
      echo "[upgrader] 新容器未在限期内 healthy（最后状态：$ST），回滚到 navihive:previous"
      docker tag navihive:previous navihive:latest 2>/dev/null || true
      # ---- 回滚命令：捕获返回码，不再裸跑完就无条件写 done（R05）----
      RB_OUT=$(docker compose -f docker-compose.yml -p navihive up -d --force-recreate --no-deps navihive 2>&1) ; RB_CODE=$?
      echo "$RB_OUT"
      # ---- 回滚后二次探活（20 × 3s）：确认旧容器真的 healthy ----
      RB_OK=""
      RB_ST="unknown"
      for _j in $(seq 1 20); do
        RB_ST=$(docker inspect --format='{{.State.Health.Status}}' navihive 2>/dev/null || echo starting)
        if [ "$RB_ST" = "healthy" ]; then RB_OK=1; break; fi
        if [ "$RB_ST" = "unhealthy" ]; then break; fi
        sleep "$HEALTH_POLL_SECONDS"
      done
      # classifyRollback 的 shell 展开：RB_CODE=0 且二次探活 healthy → rolled_back，否则 rollback_failed
      if [ "$RB_CODE" -eq 0 ] && [ -n "$RB_OK" ]; then
        RB_PHASE=rolled_back
        RB_MSG="升级失败，已自动回滚到上一版本，旧容器二次探活 healthy（详见 upgrader 容器日志）"
        ALERT_TEXT="[NavHive] 已成功回滚到上一版本：新容器未在限期内 healthy（门禁最后状态 $ST），回滚后旧容器二次探活 $RB_ST 为 healthy。请查 navihive-upgrader 与 navihive 日志。"
      else
        RB_PHASE=rollback_failed
        RB_MSG="回滚也失败，需人工介入：回滚 compose 退出码 $RB_CODE，回滚后二次探活最后状态 $RB_ST，请上服务器检查"
        ALERT_TEXT="[NavHive] 回滚失败，需人工介入：回滚 compose 退出码 $RB_CODE，二次探活最后状态 $RB_ST。站点可能仍在跑不健康的新版本，请立即上服务器检查。"
      fi
      printf '{"phase":"%s","image":"","error":"%s","startedAt":%s,"finishedAt":%s}' "$RB_PHASE" "$RB_MSG" "$started" "$(date +%s)000" > "$SPOOL_DIR/state.json"
      echo "[upgrader] 终态 $RB_PHASE： $RB_MSG"
      # 回滚通知（2026-11-01）：回滚是「升级失败且已自动兜底」的信号，运维必须知道
      # —— 置之不理的话，下一次升级可能还在同一个坑里再摔一遍。镜像里是 alpine 的
      # busybox wget（支持 --header/--post-data），够发这条 JSON。$ALERT_TEXT 由上面的
      # 分类分支给，只含中文/枚举值/数字，不含引号与反斜杠，直接内插进 JSON 是安全的；
      # 文案区分「已成功回滚」与「回滚失败，需人工介入」。
      # 没配 ALERT_WEBHOOK 就跳过；发送失败只留日志，绝不影响回滚本身。
      if [ -z "${ALERT_WEBHOOK:-}" ]; then
        echo "[upgrader] 未配置 ALERT_WEBHOOK，跳过回滚通知"
      else
        wget -qO- --header='Content-Type: application/json' \
          --post-data="{\"text\":\"$ALERT_TEXT\"}" \
          "${ALERT_WEBHOOK}" >/dev/null 2>&1 \
          || echo "[upgrader] 回滚通知发送失败（webhook 不可达？），不影响回滚结果"
      fi
    fi
    # 只有健康门禁通过（GUARD_OK 非空）才写 done；回滚分支已经在上面写了终态
    if [ -n "$GUARD_OK" ]; then
      printf '{"phase":"done","image":"","error":"","startedAt":%s,"finishedAt":%s}' "$started" "$(date +%s)000" > "$SPOOL_DIR/state.json"
      echo "[upgrader] 完成"
    fi
  else
    printf '{"phase":"failed","image":"","error":"重建失败（详见 upgrader 容器日志）","startedAt":%s,"finishedAt":%s}' "$started" "$(date +%s)000" > "$SPOOL_DIR/state.json"
    echo "[upgrader] 失败"
  fi
done
