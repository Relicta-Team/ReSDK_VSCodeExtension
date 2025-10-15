# ReSDK VSCode Extension

Расширение для разработки на ReSDK Framework - модификации для Arma 3.

## Features

### ✅ Реализовано

- ✨ **Подсветка синтаксиса** - полная поддержка SQF и ReSDK макросов
- 📝 **Автодополнение путей** - автодополнение заголовочных файлов
- 🔍 **Language Server Protocol (LSP)** - полноценная поддержка IDE функций:
  - **Go to Definition** (F12) - переход к определению классов, структур, функций, полей
  - **Find References** (Shift+F12) - поиск всех использований символа
  - **Document Symbols** (Ctrl+Shift+O) - просмотр структуры файла
  - **Hover Information** - показ типов и документации при наведении
  - **Type Inference** - автоматический вывод типов переменных
  - **Smart Navigation** - навигация через getVar/setVar/callFunc макросы
- 🏗️ **Workspace Indexing** - индексация всего проекта для быстрого поиска
- 🔗 **Include Resolution** - разрешение #include зависимостей

### 📖 Подробная документация

Полное описание LSP функций: [LSP_FEATURES.md](./LSP_FEATURES.md)

### 🚀 Быстрый старт

1. Установите расширение
2. Откройте проект ReSDK в VS Code
3. LSP автоматически начнёт индексацию проекта
4. Используйте:
   - `F12` для перехода к определениям
   - `Shift+F12` для поиска использований
   - `Ctrl+Shift+O` для просмотра символов файла

### 💡 Примеры

```sqf
// Переход к определению класса
_item = new(Item);  // F12 на Item

// Переход к полю через макрос
getVar(_item, model);  // F12 на model → переход к var(model,...)

// Вывод типов
_mob = new(Mob);  // Hover покажет: Type: Mob
```

## TODO

### Запланировано

- [ ] Автодополнение (IntelliSense) для классов и методов
- [ ] Signature Help - подсказки параметров функций
- [ ] Code Actions - быстрые исправления
- [ ] Semantic Highlighting - улучшенная подсветка
- [ ] Refactoring - переименование символов
- [ ] Lint правила для ReSDK стиля кода
- [ ] Брейкпоинты для отладки

## Credits

Подсветка синтаксиса: https://github.com/blackfisch/VSCode_SQF
