/**
 * Preprocessor parser wrapper for extracting #define macros and other preprocessor directives
 */

import { CharStream, CommonTokenStream } from 'antlr4ng';
import { PreprocessorLexer } from './generated/PreprocessorLexer';
import { PreprocessorParser, DefineContext } from './generated/PreprocessorParser';
import { PreprocessorVisitor } from './generated/PreprocessorVisitor';
import { SymbolInfo, SymbolType } from '../types/symbols';
import { AbstractParseTreeVisitor } from 'antlr4ng';

export class PreprocessorSymbolVisitor extends AbstractParseTreeVisitor<SymbolInfo[]> implements PreprocessorVisitor<SymbolInfo[]> {
    private symbols: SymbolInfo[] = [];

    defaultResult(): SymbolInfo[] {
        return this.symbols;
    }

    visitDefine(ctx: DefineContext): SymbolInfo[] {
        const name = ctx._name?.text;
        if (name) {
            const startToken = ctx._name;
            const stopToken = ctx.stop || ctx._name;
            
            // Check if this is a macro function (has parameters)
            const hasMacroArgs = ctx.macroArgs() !== null;
            const symbolType = hasMacroArgs ? SymbolType.MacroFunction : SymbolType.Macro;
            const detail = hasMacroArgs ? 'macro function' : 'macro';
            
            this.symbols.push({
                name: name,
                type: symbolType,
                range: {
                    start: {
                        line: (startToken?.line || 1) - 1,
                        character: (startToken?.column || 0)
                    },
                    end: {
                        line: (stopToken?.line || 1) - 1,
                        character: (stopToken?.column || 0) + (stopToken?.text?.length || 0)
                    }
                },
                selectionRange: {
                    start: {
                        line: (startToken?.line || 1) - 1,
                        character: (startToken?.column || 0)
                    },
                    end: {
                        line: (startToken?.line || 1) - 1,
                        character: (startToken?.column || 0) + name.length
                    }
                },
                detail: detail,
                children: []
            });
        }
        return this.visitChildren(ctx) || this.symbols;
    }

    protected aggregateResult(aggregate: SymbolInfo[], nextResult: SymbolInfo[]): SymbolInfo[] {
        return aggregate;
    }
}

export class PreprocessorParserWrapper {
    parse(text: string): SymbolInfo[] {
        try {
            const inputStream = CharStream.fromString(text);
            const lexer = new PreprocessorLexer(inputStream);
            const tokenStream = new CommonTokenStream(lexer);
            const parser = new PreprocessorParser(tokenStream);
            
            // Don't remove error listeners - causes issues with antlr4ng
            // parser.removeErrorListeners();
            
            const tree = parser.start();
            const visitor = new PreprocessorSymbolVisitor();
            visitor.visit(tree);
            
            return visitor.defaultResult();
        } catch (error) {
            console.error('Preprocessor parsing error:', error);
            return [];
        }
    }
}

