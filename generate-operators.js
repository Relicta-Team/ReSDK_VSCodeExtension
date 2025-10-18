// Generate operators from commands.txt
const fs = require('fs');

const lines = fs.readFileSync('syntaxes/commands.txt', 'utf-8').split('\n');

const binaryOps = new Set();
const unaryOps = new Set();
const nularOps = new Set();

lines.forEach(line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    
    const prefix = trimmed.charAt(0);
    
    if (prefix === 'b' && trimmed.startsWith('b:')) {
        // Binary: b:TYPE operator TYPE
        const parts = trimmed.substring(2).split(/\s+/);
        if (parts.length >= 2) {
            const operator = parts[1].toLowerCase();
            binaryOps.add(operator);
        }
    } else if (prefix === 'u' && trimmed.startsWith('u:')) {
        // Unary: u:operator TYPE
        const parts = trimmed.substring(2).split(/\s+/);
        if (parts.length >= 1) {
            const operator = parts[0].toLowerCase();
            unaryOps.add(operator);
        }
    } else if (prefix === 'n' && trimmed.startsWith('n:')) {
        // Nular: n:operator
        const operator = trimmed.substring(2).toLowerCase();
        nularOps.add(operator);
    }
});

// Remove symbolic operators from sets (they're in grammar)
const symbols = new Set(['!=', '&&', '+', '-', '*', '/', '%', '==', '<', '>', '<=', '>=', '>>', '||', '^', ':', '!', 'not', 'and', 'or']);
symbols.forEach(s => {
    binaryOps.delete(s);
    unaryOps.delete(s);
});

console.log(`Extracted:
  Binary: ${binaryOps.size}
  Unary: ${unaryOps.size}
  Nular: ${nularOps.size}
`);

// Generate TypeScript file
const output = `/**
 * SQF Operators - AUTO-GENERATED from commands.txt
 * DO NOT EDIT MANUALLY - Run 'node generate-operators.js' to regenerate
 */

export const BINARY_OPERATORS = new Set<string>([
    // Symbolic operators (from grammar)
    "!=", "&&", "+", "-", "*", "/", "%", "==", "<", ">", "<=", ">=", ">>", "||", "^", ":", "and", "or", "else", "mod", "max", "min",
    
    // Binary commands from Arma 3
    ${Array.from(binaryOps).sort().map(op => `"${op}"`).join(', ')}
]);

export const UNARY_OPERATORS = new Set<string>([
    // Symbolic operators
    "+", "-", "!", "not",
    
    // Unary commands from Arma 3
    ${Array.from(unaryOps).sort().map(op => `"${op}"`).join(', ')}
]);

export const NULAR_OPERATORS = new Set<string>([
    // Nular commands from Arma 3
    ${Array.from(nularOps).sort().map(op => `"${op}"`).join(', ')}
]);

/**
 * Check if a token is a binary operator
 */
export function isBinaryOperator(token: string): boolean {
    return BINARY_OPERATORS.has(token.toLowerCase());
}

/**
 * Check if a token is a unary operator
 */
export function isUnaryOperator(token: string): boolean {
    return UNARY_OPERATORS.has(token.toLowerCase());
}

/**
 * Check if a token is a nular operator
 */
export function isNularOperator(token: string): boolean {
    return NULAR_OPERATORS.has(token.toLowerCase());
}

/**
 * Check if a token is any kind of operator
 */
export function isOperator(token: string): boolean {
    const lower = token.toLowerCase();
    return BINARY_OPERATORS.has(lower) || UNARY_OPERATORS.has(lower) || NULAR_OPERATORS.has(lower);
}
`;

fs.writeFileSync('src/parser/sqfOperators.ts', output);
console.log('✅ Generated src/parser/sqfOperators.ts');

