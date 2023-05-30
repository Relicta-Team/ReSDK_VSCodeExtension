// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as actions from './actions'
import * as projectWatch from './projectWatch'
import * as config from './config'

import * as lserv from './client'

import * as header_autocomplete from './headers_autocomplete'

export let extensionName = ""

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	try {
		init(context);
	} catch (error) {
		vscode.window.showErrorMessage(`${error}`);
	}
}

async function init(context: vscode.ExtensionContext) {

	//await lserv.initialize(context);

	extensionName = context.extension.packageJSON.displayName;
	
	vscode.debug.onDidChangeBreakpoints(event => {
		const addedBreakpoints = event.added;
		if (addedBreakpoints.length > 0) {
			// Выполнить действия при добавлении брейкпойнтов
		}
	});

	header_autocomplete.activate(context);

	// await config.init(context);
	// await actions.init(context);
	// await projectWatch.init(context);

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Extension loaded');
	vscode.window.showInformationMessage("Loaded: " + extensionName);

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	let disposable = vscode.commands.registerCommand('resdk-vscode.helloWorld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from ReSDK_VSCode!');
		vscode.window.showErrorMessage("FUCK!!!");
	});

	context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() {
	lserv.deactivate();
}
