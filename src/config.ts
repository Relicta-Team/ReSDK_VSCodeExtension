import * as vscode from 'vscode';
import * as fs from 'fs';

export let sourcePathFolder: string;

export async function init(context: vscode.ExtensionContext) {
	while (sourcePathFolder === undefined)
	{
		let srcPath: string | undefined;
		if (vscode.workspace.workspaceFolders) {
            for (const folder of vscode.workspace.workspaceFolders) {
                if (folder.uri.scheme == 'file') {
					
					
                    srcPath = vscode.workspace.getConfiguration('resdk', folder).get<string>('projectpath');
                    if (srcPath) {
                        console.log('some workspace found', srcPath);
						if (!fs.existsSync(srcPath) || !fs.lstatSync(srcPath).isDirectory())
						{
							await vscode.window.showErrorMessage('Ошибка конфигурации. Неверный путь: ' + srcPath, "Открыть конфиг","Отмена").then((answer?: string) => {
								if (answer === "Открыть конфиг") {
									vscode.commands.executeCommand('workbench.action.openGlobalSettings');
								}
							});
							break;
						}
                    }
                   
                    break;
                }
            }
        }

		if (!srcPath)
		{
			await vscode.window.showErrorMessage('Ошибка конфигурации', "Открыть конфиг","Отмена").then((answer?: string) => {
				if (answer === "Открыть конфиг") {
					vscode.commands.executeCommand('workbench.action.openGlobalSettings');
				}
			});
		} else {
			sourcePathFolder = srcPath;
		}
		
	}
}