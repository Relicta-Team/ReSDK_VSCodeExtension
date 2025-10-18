/**
 * Symbol types for SQF language
 */

export enum SymbolType {
    Variable = 'variable',
    Function = 'function',
    Macro = 'macro',
    MacroFunction = 'macroFunction',
    LocalVariable = 'localVariable',
    GlobalVariable = 'globalVariable'
}

export interface ParameterInfo {
    name: string;
    isOptional: boolean;
}

export interface SymbolInfo {
    name: string;
    type: SymbolType;
    range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
    };
    selectionRange: {
        start: { line: number; character: number };
        end: { line: number; character: number };
    };
    detail?: string;
    children?: SymbolInfo[];
    parameters?: ParameterInfo[];  // Function parameters extracted from params [...]
}

export interface Position {
    line: number;
    character: number;
}

export interface Range {
    start: Position;
    end: Position;
}

export function isLocalVariable(name: string): boolean {
    return name.startsWith('_');
}

export function isGlobalVariable(name: string): boolean {
    return !name.startsWith('_') && name === name.toUpperCase();
}

