# grace-board — заметки проекта

Локальная канбан-диспетчерская для пайплайна grace-feature-dev. Zero-dependency
Node HTTP-сервер (`server.js`) + статический UI (`public/`), состояние в
`data/board.json`. Порт 4317, только 127.0.0.1.

## Дизайн
Источник: html
Ссылка: public/
- Токены и компоненты — `public/styles.css` (`:root`), референс-мокапы — `design/`.
- Новые поверхности дизайнятся на этих токенах, без переопределения существующих
  классов; правки держать синхронно в `public/` и (если нужен референс) в `design/`.
- Мокап поверхностей Plan Run: `design/plan-run-surfaces.html`.

## Инварианты
- **Два режима, не замена.** Движок поддерживает И одиночную карточку
  (`Task.planId: null` — как сегодня), И плановый прогон (Plan Run). Путь одиночной
  карточки не меняется по поведению — на живой доске десятки таких.
- Новые поля модели (`planId`, `dependsOn`, `autonomy`, `files`, `result`, `deploy`,
  `plan`) — аддитивные, с дефолтами; изменения `data/board.json` forward-only.
- Разметка GRACE в новом/тронутом коде: идиома `// region … # endregion` + `## @`,
  уже применённая в `FUNC_detectDirectives`/`FUNC_spawnRun`. Трейс-след — в
  существующий `DISPATCH_LOG` (ndjson), отдельный `app.log` не заводим.

## Текущая доработка
`PLAN-RUN-ROADMAP.md` — движок Plan Run. Bootstrap-сборка идёт этапами SD→S5 на
ветке `autodev/plan-run`, состояние прогона — `.grace-feature-dev/plan-run/board.json`
(источник правды, переживает /compact и передаётся между чатами через Resume).
