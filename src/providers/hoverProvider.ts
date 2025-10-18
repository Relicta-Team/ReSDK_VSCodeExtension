/**
 * Hover Provider for showing function signatures and documentation
 */

import {
    Hover,
    MarkupContent,
    MarkupKind,
    Position,
    TextDocument
} from 'vscode-languageserver/node';
import { DocumentParser } from '../parser/documentParser';
import { SymbolInfo, SymbolType } from '../types/symbols';
import { extractPrecedingComment } from '../parser/commentExtractor';
import { formatParameters } from '../parser/parameterExtractor';

export class HoverProvider {
    private parser: DocumentParser;

    constructor() {
        this.parser = new DocumentParser();
    }

    /**
     * Provide hover information at cursor position
     */
    provideHover(document: TextDocument, position: Position): Hover | null {
        const text = document.getText();
        const symbols = this.parser.parse(text);

        // Find symbol at cursor position
        const symbol = this.findSymbolAtPosition(symbols, position);
        
        if (!symbol) {
            return null;
        }

        return this.createHover(symbol, text);
    }

    /**
     * Find symbol at given position (including nested symbols)
     */
    private findSymbolAtPosition(symbols: SymbolInfo[], position: Position): SymbolInfo | null {
        for (const symbol of symbols) {
            // Check if position is in selection range (symbol name)
            if (this.isPositionInRange(position, symbol.selectionRange)) {
                return symbol;
            }

            // Check children recursively
            if (symbol.children) {
                const childSymbol = this.findSymbolAtPosition(symbol.children, position);
                if (childSymbol) {
                    return childSymbol;
                }
            }
        }

        return null;
    }

    /**
     * Check if position is within range
     */
    private isPositionInRange(position: Position, range: { start: { line: number; character: number }; end: { line: number; character: number } }): boolean {
        if (position.line < range.start.line || position.line > range.end.line) {
            return false;
        }

        if (position.line === range.start.line && position.character < range.start.character) {
            return false;
        }

        if (position.line === range.end.line && position.character > range.end.character) {
            return false;
        }

        return true;
    }

    /**
     * Create hover content for a symbol
     */
    private createHover(symbol: SymbolInfo, documentText: string): Hover {
        const parts: string[] = [];

        // Add symbol signature
        if (symbol.type === SymbolType.Function) {
            const params = symbol.parameters ? formatParameters(symbol.parameters) : '(_this)';
            parts.push(`\`\`\`sqf\n${symbol.name}${params}\n\`\`\``);
        } else if (symbol.type === SymbolType.MacroFunction) {
            const params = symbol.parameters ? formatParameters(symbol.parameters) : '()';
            parts.push(`\`\`\`sqf\n#define ${symbol.name}${params}\n\`\`\``);
        } else if (symbol.type === SymbolType.Macro) {
            parts.push(`\`\`\`sqf\n#define ${symbol.name}\n\`\`\``);
        } else if (symbol.type === SymbolType.LocalVariable) {
            parts.push(`\`\`\`sqf\nprivate ${symbol.name}\n\`\`\``);
        } else if (symbol.type === SymbolType.GlobalVariable) {
            parts.push(`\`\`\`sqf\n${symbol.name}\n\`\`\``);
        }

        // Add comment documentation if exists
        const comment = extractPrecedingComment(documentText, symbol.range.start.line);
        if (comment) {
            parts.push('---');
            parts.push(comment);
        }

        const content: MarkupContent = {
            kind: MarkupKind.Markdown,
            value: parts.join('\n\n')
        };

        return {
            contents: content
        };
    }
}

