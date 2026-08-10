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
# ОТКУДА БЕРУТСЯ СКИЛЛ И АГЕНТЫ. По умолчанию — из этого репозитория (он источник правды).
# Но если машина живёт на своём снимке пайплайна (например, на боксе ~/.claude-libs/grace
# старше репозитория), подготовка проекта НЕ должна заодно подменить контракт verify/review
# посреди партии: укажи GRACE_LIB_SRC и получишь ровно то же, что видят нетощие раны.
# Команда всегда берётся из репозитория — в снимках её нет по определению (B6).
#
# Использование:
#   ./scripts/prepare-project.sh ~/Projects/health-intelligence
#   GRACE_COMMAND_NAME=grace-run ./scripts/prepare-project.sh <dir>     # имя команды доски
#   GRACE_LIB_SRC=~/.claude-libs/grace ./scripts/prepare-project.sh <dir>
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO/.claude"
LIB="${GRACE_LIB_SRC:-$SRC}"
CMD="${GRACE_COMMAND_NAME:-grace-run}"
DST="${1:?укажи каталог проекта}"
DST="$(cd "$DST" && pwd)"

mkdir -p "$DST/.claude/commands" "$DST/.claude/agents" "$DST/.claude/skills" "$DST/.claude/scripts"

# A3.5 · Д4: своя копия — это ДРЕЙФ, а не настройка, пока владелец не сказал обратного. Раньше
# скрипт молча её пропускал, и проект годами ехал на июньских правилах (инцидент серии: старый
# скилл перебил команду → 31 прогон без единого кодера). Теперь пропуск ГРОМКИЙ, а `gb preflight`
# ставит по этому же поводу блокер `stale-skill`. GRACE_FORCE=1 — заменить копию ссылкой.
STALE=0
link() {  # символическая ссылка на копию из репозитория: git pull в grace-board обновляет всех
  local src="$1" dst="$2"
  if [ -e "$dst" ] && [ ! -L "$dst" ]; then
    if [ "${GRACE_FORCE:-0}" = "1" ]; then
      rm -rf "$dst"; ln -sfn "$src" "$dst"; echo "  ЗАМЕНЕНО своё на ссылку (GRACE_FORCE=1): $dst"; return
    fi
    if diff -rq "$src" "$dst" >/dev/null 2>&1; then echo "  своё, но совпадает с эталоном: $dst"; return; fi
    echo "  ⚠ УСТАРЕЛО (лежит своё и отличается от эталона): $dst"
    STALE=$((STALE+1)); return
  fi
  ln -sfn "$src" "$dst"; echo "  связано: $dst"
}

echo "Готовлю проект: $DST"
echo "  команда из: $SRC/commands · скилл и агенты из: $LIB"
link "$SRC/commands/$CMD.md"              "$DST/.claude/commands/$CMD.md"
link "$SRC/commands/grace-feature-dev.md" "$DST/.claude/commands/grace-feature-dev.md"
link "$LIB/skills/grace-feature-dev"      "$DST/.claude/skills/grace-feature-dev"
for a in "$LIB"/agents/gfd-*.md; do link "$a" "$DST/.claude/agents/$(basename "$a")"; done
# A3.2: линтер разметки — детерминированная замена ревьюеру «Conventions / GRACE markup».
# Команда зовёт его по пути .claude/scripts/, поэтому он обязан лежать в проекте, а не в репо доски.
link "$REPO/scripts/grace-lint.mjs"       "$DST/.claude/scripts/grace-lint.mjs"

# .claude/ проекта — служебная оснастка контура, а не код продукта: она не должна попасть
# в коммит агента (он коммитит строго по card.files[], но исключение дешевле надежды).
EX="$DST/.git/info/exclude"
if [ -f "$EX" ] && ! grep -qx "/.claude/" "$EX" 2>/dev/null; then
  printf "\n# grace-board: локальная оснастка прогонов, не для коммита\n/.claude/\n" >> "$EX"
  echo "  добавлено в .git/info/exclude: /.claude/"
fi

echo "Готово. Проверь, что доска включила lean: в dispatch-log у нового запуска launch.lean === true."
if [ "$STALE" -gt 0 ]; then
  echo ""
  echo "⚠ Устаревших собственных копий: $STALE. Прогон читает ИМЕННО их, а не эталон."
  echo "  Заменить ссылками:  GRACE_FORCE=1 $0 $DST"
  echo "  Оставить сознательно — тогда блокер stale-skill в 'gb preflight' будет виден каждый раз."
  exit 4
fi
