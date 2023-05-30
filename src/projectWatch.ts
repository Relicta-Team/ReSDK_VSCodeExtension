import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { sourcePathFolder } from './config';

const scannedExtensions = [".interface",".sqf",".cpp",".h",".hpp"]

export async function init(context: vscode.ExtensionContext) {
	scanDirectory(sourcePathFolder);
}

function onFileChanged(filePath: string) {
    vscode.window.showInformationMessage(`Файл изменен: ${filePath}`);
}

// Отслеживание изменений в директории
function scanDirectory(directoryPath: string) {
	//console.debug(`Scandir:${directoryPath}`);

    fs.readdir(directoryPath, (err, files) => {
        if (err) {
            console.error(err);
            return;
        }

        for (const file of files) {
            const filePath = path.join(directoryPath, file);

            // Получение информации о файле
            fs.stat(filePath, (err, stats) => {
                if (err) {
                    console.error(err);
                    return;
                }

                if (stats.isDirectory()) {
                    // Если это директория, вызываем функцию рекурсивно
                    scanDirectory(filePath);
                } else if (stats.isFile()) {
					const fileExt = path.extname(filePath).toLocaleLowerCase();
					if (scannedExtensions.includes(fileExt))
					{
						console.log(`Added watcher ${path.relative(sourcePathFolder,filePath)}`);
						//console.log(filePath);

						// Если это файл, отслеживаем изменения
						fs.watch(filePath, (event, filename) => {
							if (event === 'change') {
								onFileChanged(filePath);
                            } else
                            if (event === 'rename')
                            {
                                //todo...
                            }
						});
					}
				}
                    
            });
        }
    });
}