import * as path from 'path';
import { ExtensionContext, StatusBarAlignment, window, StatusBarItem, Selection, workspace, TextEditor, commands, ProgressLocation } from 'vscode';

import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient;

export async function initialize(context: ExtensionContext) {

	// The server is implemented in node
	let serverModule = context.asAbsolutePath(
		path.join('out', 'server.js')
	);
	// The debug options for the server
	// --inspect=12221: runs the server in Node's Inspector mode so VS Code can attach to the server for debugging
	let debugOptions = { execArgv: ['--nolazy', '--inspect=12221'] };

	// If the extension is launched in debug mode then the debug server options are used
	// Otherwise the run options are used
	let serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
			options: debugOptions
		}
	};

	// Options to control the language client
	let clientOptions: LanguageClientOptions = {
		// Register the server for plain text documents
		documentSelector: ['sqf', 'plaintext', 'txt'],
		synchronize: {
			// Notify the server about file changes to '.clientrc files contained in the workspace
			fileEvents: workspace.createFileSystemWatcher('**/.clientrc')
		}
	};

	// Create the language client and start the client.
	client = new LanguageClient(
		'ReSDKLangServer',
		'ReSDK Language Server',
		serverOptions,
		clientOptions
	);

	// Start the client. This will also launch the server
	client.start();
	
	await window.withProgress({
		location: ProgressLocation.Notification,
		title: "Await client",
		cancellable: false
	}, async (progress, token) => {
		token.onCancellationRequested(() => {
			console.log("Progress canceled");
		});

		progress.report({ increment: 0, message: "Wait client started" });
		
		while (!client.isRunning()) {
			await new Promise<void>(resolve => setTimeout(resolve, 2000));
		
			if (client.isRunning()) {
				progress.report({ increment: 90, message: "Client started!"});
				await new Promise<void>(resolve => setTimeout(resolve, 1000));
				break;
			}
		
			progress.report({ increment: 50, message: "Client not running..." });
		}
		
		console.log("Extension: ACTIVATE LANGSERV");
		
		// const p = new Promise<void>(resolve => {
		// 	// Debug print
		// 	console.log("Extension: ACTIVATE LANGSERV");
		// });

		// return p;
	});
	
}

export function deactivate(): Thenable<void> | undefined {
	console.log("Extension: DEACTIVATE LANGSERV");
	if (!client) {
		return undefined;
	}
	return client.stop();
}