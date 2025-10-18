/**
 * Document parser that combines preprocessor and SQF parsing
 */

import { PreprocessorParserWrapper } from './preprocessorParser';
import { SQFParserWrapper } from './sqfParser';
import { SymbolInfo, SymbolType } from '../types/symbols';

export class DocumentParser {
    private preprocessorParser: PreprocessorParserWrapper;
    private sqfParser: SQFParserWrapper;

    constructor() {
        this.preprocessorParser = new PreprocessorParserWrapper();
        this.sqfParser = new SQFParserWrapper();
    }

    /**
     * Parse document and extract all symbols (macros, variables, functions)
     */
    parse(text: string): SymbolInfo[] {
        const allSymbols: SymbolInfo[] = [];
        const macroNames: string[] = [];

        // First pass: extract preprocessor macros
        try {
            const macros = this.preprocessorParser.parse(text);
            allSymbols.push(...macros);
            // Collect macro names for the SQF parser
            macroNames.push(...macros.map(m => m.name));
        } catch (error) {
            console.error('Error parsing preprocessor:', error);
        }

        // Second pass: extract SQF symbols (variables, functions)
        // Pass the macro names so the lexer can recognize them
        try {
            const sqfSymbols = this.sqfParser.parse(text, macroNames);
            allSymbols.push(...sqfSymbols);
        } catch (error) {
            console.error('Error parsing SQF:', error);
        }

        // Build hierarchy: symbols that are inside functions should be nested
        const rootSymbols = this.buildHierarchy(allSymbols);

        // Sort by position
        rootSymbols.sort((a, b) => {
            if (a.range.start.line !== b.range.start.line) {
                return a.range.start.line - b.range.start.line;
            }
            return a.range.start.character - b.range.start.character;
        });

        return rootSymbols;
    }

    /**
     * Build symbol hierarchy based on position ranges
     */
    private buildHierarchy(symbols: SymbolInfo[]): SymbolInfo[] {
        // Sort all symbols by start position
        const sorted = [...symbols].sort((a, b) => {
            if (a.range.start.line !== b.range.start.line) {
                return a.range.start.line - b.range.start.line;
            }
            return a.range.start.character - b.range.start.character;
        });

        const rootSymbols: SymbolInfo[] = [];

        for (const symbol of sorted) {
            // Find if this symbol is inside any function
            let parent: SymbolInfo | null = null;
            
            for (const potentialParent of sorted) {
                if (potentialParent.type === SymbolType.Function && 
                    potentialParent !== symbol &&
                    this.isInside(symbol, potentialParent)) {
                    // Find the most specific (innermost) parent
                    if (!parent || this.isInside(potentialParent, parent)) {
                        parent = potentialParent;
                    }
                }
            }

            if (parent) {
                // Add as child to parent
                if (!parent.children) {
                    parent.children = [];
                }
                parent.children.push(symbol);
            } else {
                // Add to root
                rootSymbols.push(symbol);
            }
        }

        return rootSymbols;
    }

    /**
     * Check if symbol 'child' is inside symbol 'parent' based on ranges
     */
    private isInside(child: SymbolInfo, parent: SymbolInfo): boolean {
        // Check if child's range is completely inside parent's range
        const childStart = child.range.start.line * 10000 + child.range.start.character;
        const childEnd = child.range.end.line * 10000 + child.range.end.character;
        const parentStart = parent.range.start.line * 10000 + parent.range.start.character;
        const parentEnd = parent.range.end.line * 10000 + parent.range.end.character;

        return childStart > parentStart && childEnd < parentEnd;
    }
}

