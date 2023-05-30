import * as vscode from 'vscode';
import * as childProcess from 'child_process';
//import * as config from './config';

interface ActionTreeEntry {
    label: string;
    command?: string;
    children?: ActionTreeEntry[];
}

export async function init(context: vscode.ExtensionContext) {

	const actions: ActionTreeEntry[] = [];

	var cmdName = 'extension.'+ "SomeCommand";
	var helloPrintCmd = "extension.HelloPrint"

	var rootEntry = { label: "Root", command: cmdName , children: [{
		label: "Compile",
		//command: cmdName
	}] };
    //actions.push(rootEntry);
	
	for (let index = 0; index <= 10; index++) {
		var action = {
			label: "Элемент "+index,
			command: helloPrintCmd+index
		};
		actions.push(action);
		const commandCallback = (currentAction: ActionTreeEntry) => {
			return () => {
				// Use closure to access the unique value of `currentAction`
				vscode.window.showInformationMessage("Pressed on " + currentAction.label);
			};
		};
		context.subscriptions.push(vscode.commands.registerCommand(action.command ? action.command : "", commandCallback(action)));
	}

	

	var shellPath = 'C:\\Windows\\System32\\WindowsPowershell\\v1.0\\powershell.exe';
	context.subscriptions.push(vscode.commands.registerCommand(cmdName, () => {
		for (const terminal of vscode.window.terminals) {
			if (terminal.name == "Compile") {
				console.log('skip run', cmdName);
				//return;
			}
		}

		console.log('run', cmdName);
		var work = vscode.workspace.workspaceFolders
		var fs = ''
		if (work)
			fs = work[0].uri.fsPath
		
		console.log('ws',fs)

		//работает но любой код возврата пиздык
		//
		const actionInstance = vscode.window.createTerminal({
			name: "SOMELABLE",
			shellPath: shellPath,
			shellArgs: "buildType=DEBUG cli",
			cwd: fs+"/..",
			hideFromUser: false
		});

		actionInstance.show(true);
		
	}));


    const actionsTree = vscode.window.createTreeView('resdkActions', { treeDataProvider: new ActionTree(actions) });
    context.subscriptions.push(actionsTree);
}

class ActionTree implements vscode.TreeDataProvider<ActionTreeEntry> {
    constructor(private _actions: ActionTreeEntry[]) {
    }

    getChildren(element?: ActionTreeEntry): ActionTreeEntry[] {
        return element ? element.children ?? [] : this._actions;
    }

    getTreeItem(element: ActionTreeEntry): vscode.TreeItem {
        return {
            label: element.label,
            tooltip: `Run ${element.label}`,
            collapsibleState: element.children ? vscode.TreeItemCollapsibleState.Collapsed : undefined,
            command: element.command ? { command: element.command, title: element.label } : undefined
        }
    }
}

function winToWslPath(winPath: string): string {
    let wslPath = winPath;
    if (wslPath[1] == ':')
        wslPath = '/mnt/' + wslPath[0].toLowerCase() + wslPath.substr(2);
    wslPath = wslPath.replace(/\\/g, '/');
    return wslPath;
}
