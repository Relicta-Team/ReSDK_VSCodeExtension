/**
 * Document Symbol Provider for outline view
 */

import { 
    DocumentSymbol, 
    SymbolKind, 
    Range, 
    TextDocument 
} from 'vscode-languageserver/node';
import { DocumentParser } from '../parser/documentParser';
import { SymbolInfo, SymbolType } from '../types/symbols';

export class DocumentSymbolProvider {
    private parser: DocumentParser;

    constructor() {
        this.parser = new DocumentParser();
    }

    /**
     * Provide document symbols for outline view
     */
    provideDocumentSymbols(document: TextDocument): DocumentSymbol[] {
        const text = document.getText();
        const symbols = this.parser.parse(text);
        
        return symbols.map(symbol => this.convertToDocumentSymbol(symbol));
    }

    /**
     * Convert internal SymbolInfo to LSP DocumentSymbol
     */
    private convertToDocumentSymbol(symbol: SymbolInfo): DocumentSymbol {
        return DocumentSymbol.create(
            symbol.name,
            symbol.detail || '',
            this.getSymbolKind(symbol.type),
            Range.create(
                symbol.range.start.line,
                symbol.range.start.character,
                symbol.range.end.line,
                symbol.range.end.character
            ),
            Range.create(
                symbol.selectionRange.start.line,
                symbol.selectionRange.start.character,
                symbol.selectionRange.end.line,
                symbol.selectionRange.end.character
            ),
            symbol.children?.map(child => this.convertToDocumentSymbol(child))
        );
    }

    /**
     * Map internal symbol type to LSP SymbolKind
     */
    private getSymbolKind(type: SymbolType): SymbolKind {
        switch (type) {
            case SymbolType.Function:
                return SymbolKind.Function;
            case SymbolType.Macro:
                return SymbolKind.Constant;
            case SymbolType.LocalVariable:
                return SymbolKind.Variable;
            case SymbolType.GlobalVariable:
                return SymbolKind.Variable;
            case SymbolType.Variable:
            default:
                return SymbolKind.Variable;
        }
    }
}

