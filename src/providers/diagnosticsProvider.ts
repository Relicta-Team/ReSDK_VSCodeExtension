/**
 * Diagnostics Provider for linting SQF code
 */

import {
    Diagnostic,
    DiagnosticSeverity,
    Range,
    TextDocument
} from 'vscode-languageserver/node';
import { CharStream, CommonTokenStream } from 'antlr4ng';
import { CustomSQFLexer } from '../parser/customSQFLexer';
import { SQFParser } from '../parser/generated/SQFParser';
import { PreprocessorLexer } from '../parser/generated/PreprocessorLexer';
import { PreprocessorParser } from '../parser/generated/PreprocessorParser';
import { DocumentParser } from '../parser/documentParser';

export class DiagnosticsProvider {
    private parser: DocumentParser;

    constructor() {
        this.parser = new DocumentParser();
    }

    /**
     * Provide diagnostics (syntax errors and warnings)
     */
    provideDiagnostics(document: TextDocument): Diagnostic[] {
        const text = document.getText();
        const diagnostics: Diagnostic[] = [];

        // Check preprocessor syntax
        diagnostics.push(...this.checkPreprocessorSyntax(text));

        // Check SQF syntax
        diagnostics.push(...this.checkSQFSyntax(text));

        // Check for semantic issues
        diagnostics.push(...this.checkSemanticIssues(text));

        return diagnostics;
    }

    /**
     * Check preprocessor syntax errors
     */
    private checkPreprocessorSyntax(text: string): Diagnostic[] {
        const diagnostics: Diagnostic[] = [];

        try {
            const inputStream = CharStream.fromString(text);
            const lexer = new PreprocessorLexer(inputStream);
            
            // Collect lexer errors
            lexer.removeErrorListeners();
            
            const tokenStream = new CommonTokenStream(lexer);
            const parser = new PreprocessorParser(tokenStream);

            // Collect parser errors - don't remove default listeners, just add custom one
            const errorListener = {
                syntaxError: (recognizer: any, offendingSymbol: any, line: number, charPositionInLine: number, msg: string) => {
                    diagnostics.push({
                        severity: DiagnosticSeverity.Error,
                        range: Range.create(
                            (line || 1) - 1,
                            charPositionInLine || 0,
                            (line || 1) - 1,
                            (charPositionInLine || 0) + (offendingSymbol?.text?.length || 1)
                        ),
                        message: `Preprocessor error: ${msg}`,
                        source: 'sqf-preprocessor'
                    });
                },
                reportAmbiguity: () => {},
                reportAttemptingFullContext: () => {},
                reportContextSensitivity: () => {}
            };
            
            parser.removeErrorListeners();
            parser.addErrorListener(errorListener);

            parser.start();
        } catch (error) {
            // Ignore parser crashes
        }

        return diagnostics;
    }

    /**
     * Check SQF syntax errors
     */
    private checkSQFSyntax(text: string): Diagnostic[] {
        const diagnostics: Diagnostic[] = [];

        try {
            const inputStream = CharStream.fromString(text);
            const lexer = new CustomSQFLexer(inputStream, []);
            
            // Collect lexer errors
            lexer.removeErrorListeners();
            
            const tokenStream = new CommonTokenStream(lexer);
            const parser = new SQFParser(tokenStream);

            // Collect parser errors
            const errorListener = {
                syntaxError: (recognizer: any, offendingSymbol: any, line: number, charPositionInLine: number, msg: string) => {
                    diagnostics.push({
                        severity: DiagnosticSeverity.Error,
                        range: Range.create(
                            (line || 1) - 1,
                            charPositionInLine || 0,
                            (line || 1) - 1,
                            (charPositionInLine || 0) + (offendingSymbol?.text?.length || 1)
                        ),
                        message: `Syntax error: ${msg}`,
                        source: 'sqf-parser'
                    });
                },
                reportAmbiguity: () => {},
                reportAttemptingFullContext: () => {},
                reportContextSensitivity: () => {}
            };

            parser.removeErrorListeners();
            parser.addErrorListener(errorListener);

            parser.start();
        } catch (error) {
            // Ignore parser crashes
        }

        return diagnostics;
    }

    /**
     * Check semantic issues (warnings)
     */
    private checkSemanticIssues(text: string): Diagnostic[] {
        const diagnostics: Diagnostic[] = [];

        try {
            const symbols = this.parser.parse(text);
            
            // Check for duplicate variable declarations with 'private' keyword
            this.checkDuplicatePrivateDeclarations(text, diagnostics);
            
            // Check for duplicate GLOBAL function/macro definitions only
            // Local functions (with _) can be redefined without warning
            const symbolNames = new Map<string, any>();
            const checkDuplicates = (syms: any[], parentName: string = '') => {
                syms.forEach(symbol => {
                    const fullName = parentName ? `${parentName}.${symbol.name}` : symbol.name;
                    
                    // Check for duplicate global functions and macros
                    // Skip local functions (starting with _)
                    const isGlobalFunction = symbol.type === 'function' && !symbol.name.startsWith('_');
                    const isMacro = symbol.type === 'macro' || symbol.type === 'macroFunction';
                    const isCheckableType = isGlobalFunction || isMacro;
                    
                    if (isCheckableType && symbolNames.has(fullName)) {
                        diagnostics.push({
                            severity: DiagnosticSeverity.Warning,
                            range: Range.create(
                                symbol.range.start.line,
                                symbol.range.start.character,
                                symbol.range.end.line,
                                symbol.range.end.character
                            ),
                            message: `Symbol '${symbol.name}' is already defined`,
                            source: 'sqf-linter'
                        });
                    } else if (isCheckableType) {
                        symbolNames.set(fullName, symbol);
                    }

                    if (symbol.children) {
                        checkDuplicates(symbol.children, fullName);
                    }
                });
            };

            checkDuplicates(symbols);
        } catch (error) {
            // Ignore semantic check errors
        }

        return diagnostics;
    }

    /**
     * Check for duplicate 'private' variable declarations using parser
     */
    private checkDuplicatePrivateDeclarations(text: string, diagnostics: Diagnostic[]): void {
        try {
            const inputStream = CharStream.fromString(text);
            const lexer = new CustomSQFLexer(inputStream, []);
            const tokenStream = new CommonTokenStream(lexer);
            const parser = new SQFParser(tokenStream);

            parser.removeErrorListeners();
            const tree = parser.start();

            // Track private declarations per scope
            const scopeStack: Map<string, { line: number; col: number }>[] = [new Map()];
            
            const checkNode = (node: any) => {
                if (!node) return;
                
                // Check if this is an assignment with PRIVATE keyword
                if (node.constructor.name === 'AssignmentContext') {
                    const hasPrivate = node.PRIVATE && node.PRIVATE() !== null;
                    const idToken = node.ID && node.ID();
                    
                    if (hasPrivate && idToken) {
                        const varName = idToken.symbol.text;
                        const currentScope = scopeStack[scopeStack.length - 1];
                        
                        if (currentScope.has(varName)) {
                            diagnostics.push({
                                severity: DiagnosticSeverity.Warning,
                                range: Range.create(
                                    (node.start.line || 1) - 1,
                                    node.start.column || 0,
                                    (node.stop.line || 1) - 1,
                                    (node.stop.column || 0) + (node.stop.text?.length || 0)
                                ),
                                message: `Variable '${varName}' is already declared with 'private'`,
                                source: 'sqf-linter'
                            });
                        } else {
                            currentScope.set(varName, {
                                line: (node.start.line || 1) - 1,
                                col: node.start.column || 0
                            });
                        }
                    }
                }
                
                // Create new scope for ANY inline code block {...}
                // InlineCode label generates class name like "InlineCodeContext"
                const nodeName = node.constructor.name;
                if (nodeName && nodeName.includes('InlineCode')) {
                    // This is an inline code block - create new scope
                    scopeStack.push(new Map());
                    if (node.children) {
                        node.children.forEach((child: any) => checkNode(child));
                    }
                    scopeStack.pop();
                    return;
                }
                
                // Recursively check children
                if (node.children) {
                    node.children.forEach((child: any) => checkNode(child));
                }
            };

            checkNode(tree);
        } catch (error) {
            // Ignore errors
        }
    }
}

