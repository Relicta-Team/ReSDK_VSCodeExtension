/**
 * SQF parser wrapper for extracting variables and functions
 */

import { CharStream, CommonTokenStream, ParserRuleContext } from 'antlr4ng';
import { CustomSQFLexer } from './customSQFLexer';
import { SQFParser, AssignmentContext, BinaryExpressionContext, NularExpressionContext, InlineCodeContext } from './generated/SQFParser';
import { SQFVisitor } from './generated/SQFVisitor';
import { SymbolInfo, SymbolType, isLocalVariable, ParameterInfo } from '../types/symbols';
import { AbstractParseTreeVisitor } from 'antlr4ng';
import { extractParameters } from './parameterExtractor';

export class SQFSymbolVisitor extends AbstractParseTreeVisitor<void> implements SQFVisitor<void> {
    private symbols: SymbolInfo[] = [];
    private scopeStack: Set<string>[] = [new Set()]; // Stack of scopes

    getSymbols(): SymbolInfo[] {
        return this.symbols;
    }

    private getCurrentScope(): Set<string> {
        return this.scopeStack[this.scopeStack.length - 1];
    }

    private pushScope(): void {
        this.scopeStack.push(new Set());
    }

    private popScope(): void {
        this.scopeStack.pop();
    }

    visitAssignment(ctx: AssignmentContext): void {
        // Extract variable name from ID or macro
        const idToken = ctx.ID();
        const macroToken = ctx.macro(0);
        
        let varName: string | undefined;
        let startToken: any;
        
        if (idToken) {
            varName = idToken.symbol.text;
            startToken = idToken.symbol;
        } else if (macroToken) {
            // For now, skip macros in assignments
            this.visitChildren(ctx);
            return;
        }
        
        if (!varName) {
            this.visitChildren(ctx);
            return;
        }

        // Check if it's a function assignment (right side is InlineCode)
        const rightSide = ctx.binaryExpression() || ctx.macro(1);
        let isFunction = false;
        
        if (rightSide && rightSide instanceof ParserRuleContext) {
            // Check if the right side contains inline code (curly braces)
            isFunction = this.containsInlineCode(rightSide);
        }

        const isPrivate = ctx.PRIVATE() !== null;
        
        // Determine symbol type
        let symbolType: SymbolType;
        if (isFunction) {
            symbolType = SymbolType.Function;
        } else if (isPrivate || isLocalVariable(varName)) {
            // Variables with 'private' keyword or starting with '_' are local
            symbolType = SymbolType.LocalVariable;
        } else {
            symbolType = SymbolType.GlobalVariable;
        }

        const currentScope = this.getCurrentScope();
        
        // For non-function variables: skip reassignments
        if (!isFunction && currentScope.has(varName)) {
            this.visitChildren(ctx);
            return;
        }

        // Skip local variables WITHOUT 'private' keyword from outline
        // Show: global variables, all functions, macros, and private variables
        if (symbolType === SymbolType.LocalVariable && !isPrivate) {
            currentScope.add(varName);
            this.visitChildren(ctx);
            return;
        }

        // Extract parameters if this is a function
        let parameters: ParameterInfo[] | undefined;
        if (isFunction && rightSide) {
            const functionBody = rightSide.getText();
            parameters = extractParameters(functionBody);
        }

        const symbol: SymbolInfo = {
            name: varName,
            type: symbolType,
            range: {
                start: {
                    line: (ctx.start?.line || 1) - 1,
                    character: ctx.start?.column || 0
                },
                end: {
                    line: (ctx.stop?.line || 1) - 1,
                    character: (ctx.stop?.column || 0) + (ctx.stop?.text?.length || 0)
                }
            },
            selectionRange: {
                start: {
                    line: (startToken?.line || 1) - 1,
                    character: startToken?.column || 0
                },
                end: {
                    line: (startToken?.line || 1) - 1,
                    character: (startToken?.column || 0) + varName.length
                }
            },
            detail: isPrivate ? 'private' : 
                    (symbolType === SymbolType.LocalVariable || isLocalVariable(varName) ? 'local' : 'global'),
            children: [],
            parameters: parameters
        };

        // Add symbol to flat list - hierarchy will be built later
        this.symbols.push(symbol);
        
        // Track definition in current scope
        currentScope.add(varName);
        
        // Visit children - scope will be created by visitInlineCode if needed
        this.visitChildren(ctx);
    }

    /**
     * Visit inline code blocks - create new scope for each
     */
    visitInlineCode(ctx: InlineCodeContext): void {
        // Create new scope for this code block
        this.pushScope();
        this.visitChildren(ctx);
        this.popScope();
    }

    private containsInlineCode(ctx: ParserRuleContext): boolean {
        // Check if context or any child contains InlineCode (C_B_O ... C_B_C)
        const text = ctx.getText();
        // Simple heuristic: if it starts with '{' and ends with '}', it's likely inline code
        return text.startsWith('{') && text.endsWith('}');
    }

    defaultResult(): void {
        return;
    }

    protected aggregateResult(aggregate: void, nextResult: void): void {
        return;
    }
}

export class SQFParserWrapper {
    private macroNames: string[] = [];

    /**
     * Add macro names that should be recognized by the lexer
     */
    addMacroNames(names: string[]): void {
        this.macroNames.push(...names);
    }

    parse(text: string, additionalMacros: string[] = []): SymbolInfo[] {
        try {
            const inputStream = CharStream.fromString(text);
            const allMacros = [...this.macroNames, ...additionalMacros];
            const lexer = new CustomSQFLexer(inputStream, allMacros);
            const tokenStream = new CommonTokenStream(lexer);
            const parser = new SQFParser(tokenStream);
            
            // Don't remove error listeners - just silence them with noop
            // parser.removeErrorListeners();
            
            const tree = parser.start();
            const visitor = new SQFSymbolVisitor();
            visitor.visit(tree);
            
            return visitor.getSymbols();
        } catch (error) {
            console.error('SQF parsing error:', error);
            return [];
        }
    }
}

