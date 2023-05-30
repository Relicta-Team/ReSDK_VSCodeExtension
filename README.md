# resdk-vscode README

Описание

## Features

- Подсветка синтаксиса
- Автодополнение путей заголовочных файлов


## TODO

- Автодобавление заголовков с релативными путями
 - можно прыгать по директориям (сделано)
 - Генерировать карту заголовочных файлов
  	vscode.workspace.onDidCreateFiles(event => {event.files})
	vscode.workspace.onDidDeleteFiles(event => {event.files})
 там путь проекта
 - сканировать все хедеры и их имена добавлять (описание полного пути) 

- Сканер классов, функций с автодополнением
	- автодополнение можно подсмотреть тут: https://github.com/loganch/AutoIt-VSCode
- Языковой сервер
- Брейкпоинты
- Улучшение подсветки

## Credits

Подсветка синтаксиса: https://github.com/blackfisch/VSCode_SQF
