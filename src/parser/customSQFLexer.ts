/**
 * Custom SQF Lexer with dynamic operator recognition
 * Adapts the original Java approach for TypeScript
 */

import { CharStream, Token, CommonToken } from 'antlr4ng';
import { SQFLexer } from './generated/SQFLexer';
import { SQFParser } from './generated/SQFParser';
import { isBinaryOperator, isUnaryOperator } from './sqfOperators';

export class CustomSQFLexer extends SQFLexer {
    private macroNames: Set<string>;

    constructor(input: CharStream, macroNames: string[] = []) {
        super(input);
        this.macroNames = new Set(macroNames.map(name => name.toLowerCase()));
    }

    /**
     * Add macro name to the list
     */
    addMacroName(name: string): void {
        this.macroNames.add(name.toLowerCase());
    }

    /**
     * Override emit to reclassify tokens before they're emitted
     */
    override emit(): Token {
        // Check the current token type BEFORE calling super.emit()
        // because emit() creates the token based on this.type
        if (this.type === SQFLexer.ID) {
            const text = this.text;
            if (text) {
                const lowerText = text.toLowerCase();
                
                // Check if it's a macro name
                if (this.macroNames.has(lowerText)) {
                    this.type = SQFParser.MACRO_NAME;
                }
                // Check if it's a binary operator
                else if (isBinaryOperator(lowerText)) {
                    this.type = SQFParser.BINARY_OPERATOR;
                }
                // Check if it's a unary operator
                else if (isUnaryOperator(lowerText)) {
                    this.type = SQFParser.UNARY_OPERATOR;
                }
            }
        }
        
        return super.emit();
    }
}

