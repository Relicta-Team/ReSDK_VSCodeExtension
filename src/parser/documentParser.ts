/**
 * Document parser that combines preprocessor and SQF parsing
 */

import { PreprocessorParserWrapper } from './preprocessorParser';
import { SQFParserWrapper } from './sqfParser';
import { SymbolInfo } from '../types/symbols';

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
        const symbols: SymbolInfo[] = [];
        const macroNames: string[] = [];

        // First pass: extract preprocessor macros
        try {
            const macros = this.preprocessorParser.parse(text);
            symbols.push(...macros);
            // Collect macro names for the SQF parser
            macroNames.push(...macros.map(m => m.name));
        } catch (error) {
            console.error('Error parsing preprocessor:', error);
        }

        // Second pass: extract SQF symbols (variables, functions)
        // Pass the macro names so the lexer can recognize them
        try {
            const sqfSymbols = this.sqfParser.parse(text, macroNames);
            symbols.push(...sqfSymbols);
        } catch (error) {
            console.error('Error parsing SQF:', error);
        }

        // Sort symbols by position
        symbols.sort((a, b) => {
            if (a.range.start.line !== b.range.start.line) {
                return a.range.start.line - b.range.start.line;
            }
            return a.range.start.character - b.range.start.character;
        });

        return symbols;
    }
}

