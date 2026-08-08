#!/usr/bin/env bash
#
# prepare-project.sh — подготовить проект к «тощему» запуску (lean context).
#
# ЗАЧЕМ. Доска запускает раны с `--setting-sources project --strict-mcp-config`, если
# проект несёт СВОИ копии пайплайна. Это снимает ~12k стартового контекста на сессию
# (пользовательские скиллы, глобальные субагенты, личный CLAUDE.md и хуки) — а платится
# этот контекст дважды: cache-write при старте и cache-read на КАЖДОМ шаге сессии.
#
# ЧЕМ ЭТО ОПАСНО, ЕСЛИ СДЕЛАТЬ НАПОЛОВИНУ. Тот же флаг прячет и пользовательские
# КОМАНДЫ. Первая строка промпта доски — слэш-команда, а неизвестная слэш-команда
# убивает ран целиком: `claude -p "/nope тема …"` отвечает «Unknown command: /nope»
# и остальной промпт не читает. Поэтому server.js включает lean ТОЛЬКО когда в проекте
# лежат все три вещи: skills/grace-feature-dev, agents/gfd-coder.md и commands/<команда>.md.
# Этот скрипт кладёт их все разом — не клади их по частям руками.
#
# Использование:
#   ./scripts/prepare-project.sh ~/Projects/health-intelligence
#   GRACE_COMMAND_NAME=grace-run ./scripts/prepare-project.sh <dir>     # имя команды доски
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO/.claude"
CMD="${GRACE_COMMAND_NAME:-grace-run}"
DST="${1:?укажи каталог проекта}"
DST="$(cd "$DST" && pwd)"

mkdir -p "$DST/.claude/commands" "$DST/.claude/agents" "$DST/.claude/skills"

link() {  # символическая ссылка на копию из репозитория: git pull в grace-board обновляет всех
  local src="$1" dst="$2"
  if [ -e "$dst" ] && [ ! -L "$dst" ]; then echo "  пропуск (лежит своё, не ссылка): $dst"; return; fi
  ln -sfn "$src" "$dst"; echo "  связано: $dst"
}

echo "Готовлю проект: $DST"
link "$SRC/commands/$CMD.md"             "$DST/.claude/commands/$CMD.md"
link "$SRC/commands/grace-feature-dev.md" "$DST/.claude/commands/grace-feature-dev.md"
link "$SRC/skills/grace-feature-dev"     "$DST/.claude/skills/grace-feature-dev"
for a in "$SRC"/agents/gfd-*.md; do link "$a" "$DST/.claude/agents/$(basename "$a")"; done

# .claude/ проекта — служебная оснастка контура, а не код продукта: она не должна попасть
# в коммит агента (он коммитит строго по card.files[], но исключение дешевле надежды).
EX="$DST/.git/info/exclude"
if [ -f "$EX" ] && ! grep -qx "/.claude/" "$EX" 2>/dev/null; then
  printf "\n# grace-board: локальная оснастка прогонов, не для коммита\n/.claude/\n" >> "$EX"
  echo "  добавлено в .git/info/exclude: /.claude/"
fi

echo "Готово. Проверь, что доска включила lean: в dispatch-log у нового запуска launch.lean === true."
