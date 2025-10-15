// ======================================================
// SQF Parser - ported from sqf-master/sqf/parser.py
// ======================================================

import { tokenize } from './tokenizer';
import {
    BaseType,
    SQFString,
    SQFNumber,
    SQFBoolean,
    Variable,
    Keyword,
    Namespace,
    Preprocessor,
    ParserKeyword,
    Comment,
    Space,
    Tab,
    EndOfLine,
    Statement,
    Code,
    SQFArray
} from './sqfTypes';
import { isKeyword, isNamespace, isPreprocessor, PREPROCESSORS } from './keywords';

/**
 * Convert raw token string to typed token
 */
function identifyToken(token: string): BaseType {
    // Whitespace
    if (token === ' ') return new Space();
    if (token === '\t') return new Tab();
    if (token === '\n' || token === '\r\n') return new EndOfLine(token);
    
    // Parentheses and brackets
    if (['(', ')', '[', ']', '{', '}', ',', ';'].includes(token)) {
        return new ParserKeyword(token);
    }
    
    // Booleans
    if (token === 'true') return new SQFBoolean(true);
    if (token === 'false') return new SQFBoolean(false);
    
    // Numbers
    const numValue = Number(token);
    if (!isNaN(numValue) && token.trim() !== '') {
        return new SQFNumber(numValue);
    }
    
    // Preprocessors
    if (isPreprocessor(token)) {
        return new Preprocessor(token);
    }
    
    // Namespaces
    if (isNamespace(token)) {
        return new Namespace(token);
    }
    
    // Keywords
    if (isKeyword(token)) {
        return new Keyword(token);
    }
    
    // Variables
    return new Variable(token);
}

/**
 * Parse strings and comments from tokens
 * Ported from parse_strings_and_comments() in parser.py
 */
export function parseStringsAndComments(allTokens: string[]): BaseType[] {
    const tokens: BaseType[] = [];
    let mode: 'string_double' | 'string_single' | 'comment_line' | 'comment_bulk' | null = null;
    let buffer = '';
    let inDouble = false;

    for (let i = 0; i < allTokens.length; i++) {
        const token = allTokens[i];

        if (mode === 'string_double') {
            buffer += token;
            if (token === '"') {
                if (inDouble) {
                    inDouble = false;
                } else if (i < allTokens.length - 1 && allTokens[i + 1] === '"') {
                    inDouble = true;
                } else {
                    tokens.push(new SQFString(buffer));
                    mode = null;
                    buffer = '';
                    inDouble = false;
                }
            }
        } else if (mode === 'string_single') {
            buffer += token;
            if (token === "'") {
                if (inDouble) {
                    inDouble = false;
                } else if (i < allTokens.length - 1 && allTokens[i + 1] === "'") {
                    inDouble = true;
                } else {
                    tokens.push(new SQFString(buffer));
                    mode = null;
                    buffer = '';
                    inDouble = false;
                }
            }
        } else if (mode === 'comment_bulk') {
            buffer += token;
            if (token === '*/') {
                tokens.push(new Comment(buffer));
                mode = null;
                buffer = '';
            }
        } else if (mode === 'comment_line') {
            buffer += token;
            if (token === '\n' || token === '\r\n') {
                tokens.push(new Comment(buffer));
                mode = null;
                buffer = '';
            }
        } else {
            // mode is null
            if (token === '"') {
                buffer = token;
                mode = 'string_double';
            } else if (token === "'") {
                buffer = token;
                mode = 'string_single';
            } else if (token === '/*') {
                buffer = token;
                mode = 'comment_bulk';
            } else if (token === '//') {
                buffer = token;
                mode = 'comment_line';
            } else {
                tokens.push(identifyToken(token));
            }
        }
    }

    // Handle unclosed strings/comments
    if (mode === 'comment_line' || mode === 'comment_bulk') {
        tokens.push(new Comment(buffer));
    } else if (mode !== null) {
        // String not closed - add as is
        tokens.push(new SQFString(buffer));
    }

    return tokens;
}

/**
 * Main parse function
 */
export function parse(text: string): Statement {
    // Step 1: Tokenize
    const rawTokens = tokenize(text);
    
    // Step 2: Parse strings and comments
    const tokens = parseStringsAndComments(rawTokens);
    
    // Step 3: Group into statement
    return new Statement(tokens);
}

/**
 * Find matching closing parenthesis/bracket/brace
 */
export function findMatchingClose(
    tokens: BaseType[],
    startIndex: number,
    openChar: string,
    closeChar: string
): number {
    let depth = 1;
    
    for (let i = startIndex + 1; i < tokens.length; i++) {
        const token = tokens[i];
        if (token instanceof ParserKeyword) {
            if (token.value === openChar) {
                depth++;
            } else if (token.value === closeChar) {
                depth--;
                if (depth === 0) {
                    return i;
                }
            }
        }
    }
    
    return -1; // Not found
}

/**
 * Extract tokens between parentheses
 */
export function extractBetween(
    tokens: BaseType[],
    startIndex: number,
    endIndex: number
): BaseType[] {
    return tokens.slice(startIndex + 1, endIndex);
}

