---
# Конфиг проекта для прогонов grace-feature-dev (design §3.2). КОММИТИТСЯ.
# Правила: только то, чего агент не узнает из кода за 30 секунд · никаких указаний
# «как писать код» (это CLAUDE.md) · каждая строка проверяема · лимит 4000 символов ·
# секретов нет — только ИМЕНА переменных · адреса стендов и машинные пути → local.md.
product: Доска                       # имя продукта в теме карточки (папка — grace-board)
repo_root: .                         # приложение живёт в корне репозитория
stack: { lang: js, runtime: node>=18, deps: none, ui: vanilla, store: json-file }
commands:                            # относительные, без хостов
  typecheck: node --check server.js
  test:                              # пусто = тестов в репозитории нет
  build:                             # пусто = сборки нет, сервер запускается из исходника
  dev: node server.js
  smoke:                             # пусто = приёмка ограничится typecheck
stand:
  is_production: false               # доска локальная (127.0.0.1), боевого стенда нет
  # url / deploy_cmd / rollback_cmd — в local.md
deploy_policy: { pr: always, merge: manual, deploy: off }
plan_approval: human                 # human | auto-if-no-questions (design §1.6)
---

## Пути (относительно репозитория)
- состояние доски: data/board.json (в .gitignore, бэкапы board.json.bak.<шаг>)
- трейс-лог: data/dispatch-log.ndjson (ndjson; отдельный app.log не заводим)
- вложения карточек: data/uploads/<cardId>/
- требования прогонов: docs/plans/
- макеты-референсы: design/
- живой UI: public/ (index.html · app.js · styles.css)
- конфиги прогонов целевых проектов: <проект>/.grace-feature-dev/<slug>/board.json

## env — только имена
GRACE_BOARD_PORT, GRACE_PROJECTS_ROOT, GRACE_CLAUDE_BIN, GRACE_BIN_PATH,
GRACE_AUTORUN, GRACE_STALL_MIN.
Значения — в .env (не в git), образец — .env.example

## Расписания
- тик супервизора: каждые 2 с (syncFromPipeline)
- порог зависания станции: 120 мин (GRACE_STALL_MIN), потом авто-исцеление → blocked
- окно доверия liveness после старта рана: 15 с

## Константы
- колонки: backlog, todo, asking, implementing, verifying, reviewing, ready, blocked
- терминальная колонка: ready · рабочие (супервизор следит): todo, implementing, verifying, reviewing
- rigor: off | grace · autonomy: ask | auto
- порт доски: 4317, хост только 127.0.0.1
- лимиты: описание 50000 симв., вложение 8 МБ, тело запроса 16 МБ

## Источники правды
1. PLAN-RUN-ROADMAP.md — движок Plan Run, git-модель, манифест релиза (главный)
2. docs/DESIGN-*.md — утверждённые проекты доработок
3. CLAUDE.md — инварианты и разметка GRACE
4. design/*.html — референс-мокапы (могут отставать от public/)
