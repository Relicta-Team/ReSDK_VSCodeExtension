/**
 * SQF Language Server
 */

import {
    createConnection,
    TextDocuments,
    ProposedFeatures,
    InitializeParams,
    InitializeResult,
    TextDocumentSyncKind,
    DocumentSymbolParams,
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';
import { DocumentSymbolProvider } from '../providers/documentSymbolProvider';

// Create a connection for the server
const connection = createConnection(ProposedFeatures.all);

// Create a document manager
const documents = new TextDocuments(TextDocument);

// Create document symbol provider
const documentSymbolProvider = new DocumentSymbolProvider();

// Initialize server
connection.onInitialize((params: InitializeParams): InitializeResult => {
    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            documentSymbolProvider: true
        }
    };
});

// Handle document symbol requests (for outline view)
connection.onDocumentSymbol((params: DocumentSymbolParams) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
        return [];
    }

    try {
        return documentSymbolProvider.provideDocumentSymbols(document);
    } catch (error) {
        console.error('Error providing document symbols:', error);
        return [];
    }
});

// Listen on the connection
documents.listen(connection);
connection.listen();

