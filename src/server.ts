// ======================================================
// ReSDK Language Server - Minimal Version
// Ready for ANTLR integration
// ======================================================

import {
	createConnection,
	TextDocuments,
	ProposedFeatures,
	InitializeParams,
	DocumentSymbolParams,
	DocumentSymbol,
	TextDocumentSyncKind
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';

let connection = createConnection(ProposedFeatures.all);
let documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

connection.onInitialize((params: InitializeParams) => {
	connection.console.log('ReSDK Language Server initializing...');
	
	return {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			documentSymbolProvider: true
		}
	};
});

connection.onInitialized(async () => {
	connection.console.log('ReSDK Language Server ready! 🚀');
	connection.console.log('Waiting for ANTLR grammar...');
});

// Document Symbols - заглушка для ANTLR парсера
connection.onDocumentSymbol((params: DocumentSymbolParams): DocumentSymbol[] => {
	const doc = documents.get(params.textDocument.uri);
	if (!doc) return [];
	
	connection.console.log(`Parsing document: ${params.textDocument.uri}`);
	
	// TODO: Integrate ANTLR parser here
	// const ast = parseWithANTLR(doc.getText());
	// return astToDocumentSymbols(ast);
	
	return [];
});

documents.listen(connection);
connection.listen();
