# ReSDK Extension

ReSDK Extension добавляет в VS Code поддержку ReSDK/Arma 3 SQF-проектов: подсветку синтаксиса, навигацию по проекту, автодополнение, анализ макросов и диагностику через встроенный evaluator.

## Возможности

- Подсветка синтаксиса SQF для `.sqf`, `.interface`, `.inc` и ReSDK header-style файлов.
- Поддержка грамматик для `description.ext` и `.hpp`.
- Автоматическое определение ReSDK-проекта по типовым структурам workspace.
- Встроенный SQF language server.
- Диагностика SQF-файлов через bundled evaluator runtime.
- Проверка SQF-файлов при сохранении.
- Определение compile context для ReSDK-скриптов.
- Индикатор текущего validation context в status bar.
- Команда для просмотра и копирования найденных compile contexts.
- Подсветка неактивных блоков препроцессора.
- Автодополнение SQF runtime-команд.
- Hover-документация и сигнатуры SQF-команд.
- Индексация символов проекта: функций, макросов, классов, методов, свойств и структур.
- Go to Definition для проектных символов.
- Find References для проектных символов.
- Автодополнение путей для `#include`, preprocess-вызовов и ReSDK import-style путей.
- Анализ локальных переменных внутри функций.
- Hover-информация по локальным переменным и проектным символам.
- Разрешение ReSDK class/struct member expressions.
- Автодополнение include-файлов для ReSDK/C-like include statements.
- Отдельная ReSDK-панель в Activity Bar для проектных действий.

## Встроенный evaluator

Расширение поставляется со встроенным Windows x64 `evaluator.exe`, поэтому диагностика работает из коробки на Windows без ручной сборки evaluator.

Если нужно использовать свой бинарник evaluator, укажите путь в настройке:

```json
"evaluatorSqf.evaluatorPath": "C:/path/to/evaluator.exe"
```

## Команды

- `ReSDK Evaluator: Restart Language Server` - перезапускает language server.
- `ReSDK Evaluator: Show Resolved Contexts` - показывает найденные compile contexts для текущего SQF-файла и позволяет скопировать выбранный context.

## Настройки

- `evaluatorSqf.evaluatorPath` - путь к custom `evaluator.exe`.
- `evaluatorSqf.rootPath` - корневая папка скриптов, передаваемая evaluator.
- `evaluatorSqf.extensionsRoot` - путь к папке extensions.
- `evaluatorSqf.serverMode` - включает evaluator server mode.
- `evaluatorSqf.maxSteps` - максимальное число шагов выполнения evaluator.
- `evaluatorSqf.diagnosticsTimeoutMs` - таймаут диагностики.
- `evaluatorSqf.validateOnSave` - запускать диагностику при сохранении SQF-файлов.
- `evaluatorSqf.validateOnOpen` - запускать диагностику при открытии SQF-файлов.
- `evaluatorSqf.traceServer` - уровень трассировки обмена между VS Code и language server.

## Поддержка платформ

Диагностика через встроенный evaluator сейчас рассчитана на Windows x64, потому что в расширение включен `evaluator.exe`.

Редакторские функции language server работают внутри VS Code, но для полноценной диагностики на других платформах потребуется совместимый evaluator-бинарник, указанный через `evaluatorSqf.evaluatorPath`.

## Credits

Подсветка синтаксиса основана на [VSCode_SQF](https://github.com/blackfisch/VSCode_SQF).
