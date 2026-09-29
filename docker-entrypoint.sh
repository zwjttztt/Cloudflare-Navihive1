#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# NaviHive 容器入口
#
# 做三件事，然后把控制权交给 wrangler dev --local：
#   1. 找到 @cloudflare/vite-plugin 生成的 dist/<worker>/wrangler.json
#   2. 由环境变量渲染出 .dev.vars（AUTH_SECRET 没给就生成一份存进持久卷）
#   3. 启动 Worker，本地状态写进 --persist-to
# ---------------------------------------------------------------------------
set -euo pipefail

APP_DIR="${APP_DIR:-/app}"
# 持久卷挂载点：D1 本地状态与自动生成的 AUTH_SECRET 都存在这儿
DATA_DIR="${DATA_DIR:-/data}"
PERSIST_DIR="${PERSIST_DIR:-${DATA_DIR}/wrangler-state}"
PORT="${PORT:-8787}"
IP="${IP:-0.0.0.0}"

cd "$APP_DIR"

# --- 1. 定位构建产物里的 Wrangler 配置 -------------------------------------
CONFIG="$(find "$APP_DIR/dist" -maxdepth 2 -name wrangler.json | head -n 1)"
if [ -z "$CONFIG" ]; then
    echo "[entrypoint] 找不到 dist/*/wrangler.json —— 镜像里的构建产物缺失，请重新 build" >&2
    exit 1
fi
CONFIG_DIR="$(dirname "$CONFIG")"
echo "[entrypoint] 使用配置：$CONFIG"

# --- 2. 凭据 ---------------------------------------------------------------
# AUTH_SECRET 用来加密库里的站点密码与 WebDAV 口令。
# 千万不能让它每次启动都变：一变，库里已经加密的东西就解不开了。
# 所以没显式给时，生成一份存进持久卷，之后一直复用。
if [ -z "${AUTH_SECRET:-}" ]; then
    if [ -f "${DATA_DIR}/auth-secret" ]; then
        AUTH_SECRET="$(cat "${DATA_DIR}/auth-secret")"
        echo "[entrypoint] 复用持久卷里已有的 AUTH_SECRET"
    else
        AUTH_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
        mkdir -p "$DATA_DIR"
        (umask 077; printf '%s\n' "$AUTH_SECRET" > "${DATA_DIR}/auth-secret")
        chmod 600 "${DATA_DIR}/auth-secret" || true
        echo "[entrypoint] 已生成随机 AUTH_SECRET 并存到 ${DATA_DIR}/auth-secret（请备份该卷）"
    fi
fi

# 初始管理员密码。注意：只有库里还没有凭据的「第一次」才生效，
# 之后一律以数据库为准（改密码走站内「更多选项 → 账号管理」）。
if [ -z "${AUTH_PASSWORD:-}" ]; then
    AUTH_PASSWORD="$(node -e "console.log(require('crypto').randomBytes(9).toString('base64'))")"
    echo "[entrypoint] ============================================" >&2
    echo "[entrypoint] 未设置 AUTH_PASSWORD，已生成随机初始密码：" >&2
    echo "[entrypoint]   用户名：${AUTH_USERNAME:-admin}" >&2
    echo "[entrypoint]   密  码：${AUTH_PASSWORD}" >&2
    echo "[entrypoint] 登录后请立刻到「更多选项 → 账号管理」改掉。" >&2
    echo "[entrypoint] ============================================" >&2
fi

AUTH_ENABLED="${AUTH_ENABLED:-true}"
AUTH_USERNAME="${AUTH_USERNAME:-admin}"

# --- 3. 渲染 .dev.vars -----------------------------------------------------
# wrangler 在本地模式下从 .dev.vars 读变量；不同版本查找位置略有出入，
# 这里 cwd 与配置所在目录各写一份，两边都能命中。
render_dev_vars() {
    local target="$1"
    {
        printf 'AUTH_ENABLED=%s\n' "$AUTH_ENABLED"
        printf 'AUTH_USERNAME=%s\n' "$AUTH_USERNAME"
        printf 'AUTH_PASSWORD=%s\n' "$AUTH_PASSWORD"
        printf 'AUTH_SECRET=%s\n' "$AUTH_SECRET"
        if [ -n "${AUTH_RECOVERY_PUBLIC_KEY:-}" ]; then
            printf 'AUTH_RECOVERY_PUBLIC_KEY=%s\n' "$AUTH_RECOVERY_PUBLIC_KEY"
        fi
        if [ -n "${NAVIHIVE_TRUST_XFF:-}" ]; then
            printf 'NAVIHIVE_TRUST_XFF=%s\n' "$NAVIHIVE_TRUST_XFF"
        fi
    } > "$target"
    chmod 600 "$target"
}

render_dev_vars "$APP_DIR/.dev.vars"
render_dev_vars "$CONFIG_DIR/.dev.vars"

mkdir -p "$PERSIST_DIR"

echo "[entrypoint] 启动 Worker：http://${IP}:${PORT}  （本地状态：$PERSIST_DIR）"
exec "${APP_DIR}/node_modules/.bin/wrangler" dev \
    -c "$CONFIG" \
    --local \
    --ip "$IP" \
    --port "$PORT" \
    --persist-to "$PERSIST_DIR" \
    --log-level info
