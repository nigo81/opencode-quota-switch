#!/bin/zsh
# 把本地仓库装进 OpenCode 的 TUI 插件缓存。
#
# 为什么不用 `opencode plugin add <git-url>`：宿主那条路径会卡在它内部的
# bun "git dep preparation" 上并报 NpmInstallFailedError: git dep preparation failed
# （npm 1.3.14 与 bun 1.3.14 单独装同一个 git 依赖都能成功，故是宿主安装器的 bug）。
# 缓存注入走的是宿主加载 npm 插件时本来就会读的目录，实测可用。
#
# 用法：
#   ./install.sh            安装/同步（改了代码重跑即可生效，重启 OpenCode 后可见）
#   ./install.sh --check    只检查状态，不写入
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
PKG="opencode-quota-switch"
CACHE="$HOME/.cache/opencode/npm/${PKG}@latest"
CLI="$HOME/.config/opencode/cli.json"
# 时间戳目录名只需稳定且唯一，宿主按包名解析
STAMP=9999999999999
TARGET="$CACHE/$STAMP/node_modules/$PKG"

if [ ! -f "$REPO/dist/tui.js" ]; then
  echo "✗ $REPO/dist/tui.js 不存在，先执行：npm install && npm run build" >&2
  exit 1
fi

if [ "${1:-}" = "--check" ]; then
  echo "仓库      : $REPO"
  echo "dist/tui.js: $(test -f "$REPO/dist/tui.js" && echo "存在 ($(wc -c < "$REPO/dist/tui.js" | tr -d ' ') bytes)" || echo "缺失")"
  echo "缓存软链  : $(test -L "$TARGET" && readlink "$TARGET" || echo '未建立')"
  echo "cli.json  : $(python3 -c "import json;print(json.load(open('$CLI'))['plugins'])")"
  exit 0
fi

mkdir -p "$CACHE/$STAMP/node_modules"
ln -sfn "$REPO" "$TARGET"
echo "✓ 缓存软链已建立: $TARGET → $REPO"

# 确保 cli.json 里是裸包名
python3 - "$CLI" "$PKG" <<'PY'
import json, sys
path, pkg = sys.argv[1], sys.argv[2]
cfg = json.load(open(path))
plugins = cfg.get("plugins", [])
plugins = [p for p in plugins if not (isinstance(p, str) and (p == pkg or "quota-switch" in p))]
if pkg not in plugins:
    plugins.append(pkg)
cfg["plugins"] = plugins
json.dump(cfg, open(path, "w"), ensure_ascii=False, indent=2)
print("✓ cli.json plugins =", plugins)
PY

echo "✓ 完成。重启 OpenCode 客户端后生效。"
