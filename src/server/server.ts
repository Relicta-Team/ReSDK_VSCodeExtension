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
    TextDocumentChangeEvent,
    HoverParams
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';
import { DocumentSymbolProvider } from '../providers/documentSymbolProvider';
import { DiagnosticsProvider } from '../providers/diagnosticsProvider';
import { HoverProvider } from '../providers/hoverProvider';

// Create a connection for the server
const connection = createConnection(ProposedFeatures.all);

// Create a document manager
const documents = new TextDocuments(TextDocument);

// Create providers
const documentSymbolProvider = new DocumentSymbolProvider();
const diagnosticsProvider = new DiagnosticsProvider();
const hoverProvider = new HoverProvider();

// Initialize server
connection.onInitialize((params: InitializeParams): InitializeResult => {
    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            documentSymbolProvider: true,
            hoverProvider: true
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

// Handle hover requests
connection.onHover((params: HoverParams) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
        return null;
    }

    try {
        return hoverProvider.provideHover(document, params.position);
    } catch (error) {
        console.error('Error providing hover:', error);
        return null;
    }
});

// Validate document and send diagnostics
async function validateDocument(document: TextDocument): Promise<void> {
    try {
        const diagnostics = diagnosticsProvider.provideDiagnostics(document);
        connection.sendDiagnostics({ uri: document.uri, diagnostics });
    } catch (error) {
        console.error('Error validating document:', error);
    }
}

// Validate on document open/change
documents.onDidOpen((event: TextDocumentChangeEvent<TextDocument>) => {
    validateDocument(event.document);
});

documents.onDidChangeContent((event: TextDocumentChangeEvent<TextDocument>) => {
    validateDocument(event.document);
});

// Clear diagnostics on document close
documents.onDidClose((event) => {
    connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

// Listen on the connection
documents.listen(connection);
connection.listen();

