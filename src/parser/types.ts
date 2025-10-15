// ======================================================
// AST Node Types for ReSDK Language Parser
// ======================================================

export interface Position {
    line: number;
    character: number;
}

export interface Range {
    start: Position;
    end: Position;
}

export interface Location {
    uri: string;
    range: Range;
}

// Base AST Node
export interface ASTNode {
    type: string;
    range: Range;
}

// =============== Top-level Declarations ===============

export interface ClassDeclaration extends ASTNode {
    type: 'ClassDeclaration';
    name: string;
    extends?: string;
    attributes: string[];
    editorAttributes: EditorAttribute[];
    members: ClassMember[];
    documentation?: string;
}

export interface StructDeclaration extends ASTNode {
    type: 'StructDeclaration';
    name: string;
    base?: string;
    members: StructMember[];
}

export interface GlobalFunctionDeclaration extends ASTNode {
    type: 'GlobalFunctionDeclaration';
    name: string;
    body: string;
}

export interface GlobalVariableDeclaration extends ASTNode {
    type: 'GlobalVariableDeclaration';
    name: string;
    value: string;
}

export interface MacroDefinition extends ASTNode {
    type: 'MacroDefinition';
    name: string;
    parameters?: string[];
    value: string;
}

export interface IncludeDirective extends ASTNode {
    type: 'IncludeDirective';
    path: string;
    isAngleBracket: boolean; // true for <path>, false for "path"
}

// =============== Class Members ===============

export type ClassMember = 
    | FunctionDeclaration 
    | VariableDeclaration 
    | GetterFunctionDeclaration
    | GetterConstFunctionDeclaration;

export interface FunctionDeclaration extends ASTNode {
    type: 'FunctionDeclaration';
    name: string;
    body: string;
    editorAttributes: EditorAttribute[];
    functionType: 'func' | 'func_runtime';
    documentation?: string;
}

export interface GetterFunctionDeclaration extends ASTNode {
    type: 'GetterFunctionDeclaration';
    name: string;
    body: string;
    editorAttributes: EditorAttribute[];
    documentation?: string;
}

export interface GetterConstFunctionDeclaration extends ASTNode {
    type: 'GetterConstFunctionDeclaration';
    name: string;
    value: string;
    editorAttributes: EditorAttribute[];
    documentation?: string;
}

export interface VariableDeclaration extends ASTNode {
    type: 'VariableDeclaration';
    name: string;
    value: string;
    varType: 'var' | 'var_num' | 'var_str' | 'var_bool' | 'var_array' | 'var_obj' | 'var_vobj' | 'var_hashmap' | 'var_handle' | 'var_exprval';
    editorAttributes: EditorAttribute[];
    documentation?: string;
}

export interface EditorAttribute {
    name: string;
    value?: string;
}

// =============== Struct Members ===============

export type StructMember = DefDeclaration | DefRetDeclaration;

export interface DefDeclaration extends ASTNode {
    type: 'DefDeclaration';
    name: string;
    value: string;
    isMethod: boolean; // true if value is code block
}

export interface DefRetDeclaration extends ASTNode {
    type: 'DefRetDeclaration';
    name: string;
    value: string;
}

// =============== Document AST ===============

export interface DocumentAST {
    uri: string;
    includes: IncludeDirective[];
    macros: MacroDefinition[];
    classes: ClassDeclaration[];
    structs: StructDeclaration[];
    globalFunctions: GlobalFunctionDeclaration[];
    globalVariables: GlobalVariableDeclaration[];
}

// =============== Symbol Information ===============

export interface SymbolInfo {
    name: string;
    kind: SymbolKind;
    location: Location;
    containerName?: string; // For class/struct members
    detail?: string;
    caseSensitive: boolean; // true for structs, false for OOP classes
}

export enum SymbolKind {
    Class = 'Class',
    Struct = 'Struct',
    Function = 'Function',
    Method = 'Method',
    Variable = 'Variable',
    Field = 'Field',
    Macro = 'Macro',
    GlobalFunction = 'GlobalFunction',
    GlobalVariable = 'GlobalVariable'
}

// =============== Type Inference ===============

export interface InferredType {
    typeName: string;
    confidence: TypeConfidence;
    source: TypeSource;
}

export enum TypeConfidence {
    High = 'high',      // From explicit instantiation
    Medium = 'medium',  // From assignment or return
    Low = 'low'         // From heuristic guess
}

export enum TypeSource {
    New = 'new',                    // new(Type)
    Instantiate = 'instantiate',    // instantiate("Type")
    StructNew = 'struct_new',       // struct_new(Type)
    Assignment = 'assignment',      // var = someType
    Return = 'return',              // return from function
    Parameter = 'parameter',        // function parameter
    Heuristic = 'heuristic'         // Best guess
}

