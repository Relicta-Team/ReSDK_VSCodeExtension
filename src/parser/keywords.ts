// ======================================================
// SQF Keywords - ported from sqf-master/sqf/keywords.py
// ======================================================

// Keywords that are not commands, but part of the language
export const KEYWORDS = new Set([
    '=', '\\',
    // Preprocessors
    '##', '#define', '#ifdef', '#ifndef', '#undef', '#include', '#else', '#endif'
]);

export const PREPROCESSORS_UNARY = new Set(['#ifdef', '#ifndef', '#undef', '#include']);
export const PREPROCESSORS_NULLARY = new Set(['#else', '#endif']);
export const PREPROCESSORS = new Set(['##', '#define', ...PREPROCESSORS_UNARY, ...PREPROCESSORS_NULLARY]);

// Common SQF operators
export const OP_ARITHMETIC = ['+', '-', '*', '/', '%', 'mod', '^', 'max', 'floor'];
export const OP_LOGICAL = ['&&', 'and', '||', 'or'];
export const OP_COMPARISON = ['==', 'isequalto', '!=', '<', '>', '<=', '>=', '>>', 'isnotequalto'];

// Namespaces
export const NAMESPACES = new Set([
    'missionnamespace',
    'profilenamespace', 
    'uinamespace',
    'parsingnamespace',
    'localnamespace'
]);

// Common SQF keywords (case-insensitive)
export const SQF_KEYWORDS = new Set([
    // Control flow
    'if', 'then', 'else', 'exitwith',
    'while', 'do', 'for', 'from', 'to', 'step',
    'switch', 'case', 'default',
    // Common commands
    'private', 'params', 'call', 'spawn',
    'true', 'false', 'nil',
    // ReSDK extensions
    'class', 'endclass', 'extends', 'attribute',
    'struct', 'endstruct', 'base',
    'func', 'func_runtime', 'var', 'def', 'def_ret',
    'getter_func', 'getterconst_func',
    'var_num', 'var_str', 'var_bool', 'var_array',
    'var_obj', 'var_vobj', 'var_hashmap', 'var_handle',
    'editor_attribute', 'node_class', 'node_met',
    'verbList'
]);

/**
 * Check if token is a keyword
 */
export function isKeyword(token: string): boolean {
    return SQF_KEYWORDS.has(token.toLowerCase()) || KEYWORDS.has(token);
}

/**
 * Check if token is a namespace
 */
export function isNamespace(token: string): boolean {
    return NAMESPACES.has(token.toLowerCase());
}

/**
 * Check if token is a preprocessor
 */
export function isPreprocessor(token: string): boolean {
    return PREPROCESSORS.has(token);
}

