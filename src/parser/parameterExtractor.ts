/**
 * Extract function parameters from SQF code
 */

import { ParameterInfo } from '../types/symbols';

/**
 * Extract parameters from function body
 * Looks for: params ["_x", "_y", ["_opt", defaultValue]]
 */
export function extractParameters(functionBody: string): ParameterInfo[] | undefined {
    // Look for params [...] statement - need to match brackets correctly
    const paramsStart = functionBody.search(/params\s*\[/i);
    
    if (paramsStart === -1) {
        // No params found - function uses _this
        return undefined;
    }

    // Find the matching closing bracket
    const startBracket = functionBody.indexOf('[', paramsStart);
    let depth = 1;
    let endBracket = startBracket + 1;
    let inString = false;
    let stringChar = '';

    while (endBracket < functionBody.length && depth > 0) {
        const char = functionBody[endBracket];
        const prevChar = endBracket > 0 ? functionBody[endBracket - 1] : '';

        if ((char === '"' || char === "'") && prevChar !== '\\') {
            if (!inString) {
                inString = true;
                stringChar = char;
            } else if (char === stringChar) {
                inString = false;
            }
        }

        if (!inString) {
            if (char === '[') depth++;
            else if (char === ']') depth--;
        }

        endBracket++;
    }

    const paramsContent = functionBody.substring(startBracket + 1, endBracket - 1);
    const parameters: ParameterInfo[] = [];

    // Parse parameter list manually to handle nested arrays
    let depth2 = 0;
    let current = '';
    let inString2 = false;
    let stringChar2 = '';

    for (let i = 0; i < paramsContent.length; i++) {
        const char = paramsContent[i];
        const prevChar = i > 0 ? paramsContent[i - 1] : '';

        // Track string boundaries
        if ((char === '"' || char === "'") && prevChar !== '\\') {
            if (!inString2) {
                inString2 = true;
                stringChar2 = char;
            } else if (char === stringChar2) {
                inString2 = false;
            }
        }

        if (!inString2) {
            if (char === '[') depth2++;
            else if (char === ']') depth2--;
            else if (char === ',' && depth2 === 0) {
                // Found parameter separator at top level
                const param = parseParameter(current.trim());
                if (param) parameters.push(param);
                current = '';
                continue;
            }
        }

        current += char;
    }

    // Don't forget the last parameter
    const param = parseParameter(current.trim());
    if (param) parameters.push(param);

    return parameters.length > 0 ? parameters : undefined;
}

/**
 * Parse a single parameter entry
 * Can be: "_x" (required) or ["_x", default] (optional)
 */
function parseParameter(paramStr: string): ParameterInfo | null {
    paramStr = paramStr.trim();
    
    // If it's a simple string: "_x" or '_x' (required parameter)
    const simpleMatch = paramStr.match(/^["'](_\w+)["']$/);
    if (simpleMatch) {
        return { name: simpleMatch[1], isOptional: false };
    }

    // If it's an array: ["_x", ...] or ['_x', ...] (optional parameter)
    const arrayMatch = paramStr.match(/^\[["'](_\w+)["']/);
    if (arrayMatch) {
        return { name: arrayMatch[1], isOptional: true };
    }

    return null;
}

/**
 * Format parameters for display
 * Returns: (param1, param2?, ...)
 */
export function formatParameters(parameters: ParameterInfo[] | undefined): string {
    if (!parameters || parameters.length === 0) {
        return '(_this)';
    }
    
    const formatted = parameters.map(p => p.isOptional ? `${p.name}?` : p.name);
    return `(${formatted.join(', ')})`;
}

