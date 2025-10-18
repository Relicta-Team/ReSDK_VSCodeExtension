/**
 * VS Code Extension client for SQF Language Server
 */

import * as path from 'path';
import { workspace, ExtensionContext } from 'vscode';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient;

export function activate(context: ExtensionContext) {
    // The server is implemented in node
    const serverModule = context.asAbsolutePath(
        path.join('out', 'server', 'server.js')
    );

    // The debug options for the server
    const debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };

    // If the extension is launched in debug mode then the debug server options are used
    // Otherwise the run options are used
    const serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: {
            module: serverModule,
            transport: TransportKind.ipc,
            options: debugOptions
        }
    };

    // Options to control the language client
    const clientOptions: LanguageClientOptions = {
        // Register the server for SQF and related file types
        documentSelector: [
            { scheme: 'file', language: 'sqf' },
            { scheme: 'file', language: 'ext' },
            { scheme: 'file', pattern: '**/*.sqf' },
            { scheme: 'file', pattern: '**/*.h' },
            { scheme: 'file', pattern: '**/*.hpp' }
        ],
        synchronize: {
            // Notify the server about file changes to '.sqf', '.h', '.hpp' files contained in the workspace
            fileEvents: workspace.createFileSystemWatcher('**/*.{sqf,h,hpp}')
        }
    };

    // Create the language client and start the client
    client = new LanguageClient(
        'sqfLanguageServer',
        'SQF Language Server',
        serverOptions,
        clientOptions
    );

    // Start the client. This will also launch the server
    client.start();
}

export function deactivate(): Thenable<void> | undefined {
    if (!client) {
        return undefined;
    }
    return client.stop();
}

