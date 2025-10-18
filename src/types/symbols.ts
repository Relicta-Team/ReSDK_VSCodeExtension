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

