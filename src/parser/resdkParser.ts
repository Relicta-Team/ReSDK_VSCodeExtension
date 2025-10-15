// ======================================================
// ReSDK Parser - парсинг class/struct/func/var конструкций
// ======================================================

import { parse, findMatchingClose, extractBetween } from './sqfParser';
import { BaseType, Statement, Variable, Keyword, ParserKeyword, Comment, SQFString } from './sqfTypes';
import { DocumentAST, ClassDeclaration, StructDeclaration, ClassMember, StructMember } from './types';

export class ReSDKParser {
    private uri: string;
    private text: string;
    private tokens: BaseType[] = [];

    constructor(uri: string) {
        this.uri = uri;
        this.text = '';
    }

    public parseDocument(text: string): DocumentAST {
        this.text = text;
        const statement = parse(text);
        this.tokens = statement.content;

        const ast: DocumentAST = {
            uri: this.uri,
            includes: [],
            macros: [],
            classes: this.parseClasses(),
            structs: this.parseStructs(),
            globalFunctions: [],
            globalVariables: []
        };

        return ast;
    }

    private parseClasses(): ClassDeclaration[] {
        const classes: ClassDeclaration[] = [];

        for (let i = 0; i < this.tokens.length; i++) {
            const token = this.tokens[i];
            
            // Найти "class"
            if (token instanceof Keyword && token.value.toLowerCase() === 'class') {
                try {
                    const classDecl = this.parseClassAt(i);
                    if (classDecl) {
                        classes.push(classDecl);
                    }
                } catch (e) {
                    // Skip errors, continue parsing
                }
            }
        }

        return classes;
    }

    private parseClassAt(startIndex: number): ClassDeclaration | null {
        let i = startIndex + 1; // Skip 'class'

        // Expect '('
        if (!(this.tokens[i] instanceof ParserKeyword && (this.tokens[i] as ParserKeyword).value === '(')) {
            return null;
        }
        i++;

        // Get class name
        if (!(this.tokens[i] instanceof Variable)) {
            return null;
        }
        const className = (this.tokens[i] as Variable).name;
        i++;

        // Expect ')'
        if (!(this.tokens[i] instanceof ParserKeyword && (this.tokens[i] as ParserKeyword).value === ')')) {
            return null;
        }
        i++;

        // Parse extends (optional)
        let extendsName: string | undefined;
        if (i < this.tokens.length && 
            this.tokens[i] instanceof Keyword && 
            (this.tokens[i] as Keyword).value.toLowerCase() === 'extends') {
            i++; // Skip 'extends'
            
            if (this.tokens[i] instanceof ParserKeyword && (this.tokens[i] as ParserKeyword).value === '(') {
                i++;
                if (this.tokens[i] instanceof Variable) {
                    extendsName = (this.tokens[i] as Variable).name;
                    i++;
                }
                // Skip ')'
                if (this.tokens[i] instanceof ParserKeyword && (this.tokens[i] as ParserKeyword).value === ')') {
                    i++;
                }
            }
        }

        // Find endclass
        const endIndex = this.findEndclass(i);
        if (endIndex === -1) {
            console.warn(`[ReSDKParser] No endclass found for ${className}`);
            return null;
        }

        // Parse members between i and endIndex
        const members = this.parseClassMembers(i, endIndex);

        const lineNumber = this.getLineNumber(startIndex);

        return {
            type: 'ClassDeclaration',
            name: className,
            extends: extendsName,
            attributes: [],
            editorAttributes: [],
            members,
            range: {
                start: { line: lineNumber, character: 0 },
                end: { line: lineNumber, character: 0 }
            }
        };
    }

    private findEndclass(startIndex: number): number {
        let depth = 1;

        for (let i = startIndex; i < this.tokens.length; i++) {
            const token = this.tokens[i];
            
            if (token instanceof Keyword) {
                const value = token.value.toLowerCase();
                if (value === 'class') {
                    depth++;
                } else if (value === 'endclass') {
                    depth--;
                    if (depth === 0) {
                        return i;
                    }
                }
            }
        }

        return -1;
    }

    private parseClassMembers(startIndex: number, endIndex: number): ClassMember[] {
        const members: ClassMember[] = [];

        for (let i = startIndex; i < endIndex; i++) {
            const token = this.tokens[i];

            if (!(token instanceof Keyword)) continue;

            const keyword = token.value.toLowerCase();

            // func(name)
            if (keyword === 'func' || keyword === 'func_runtime') {
                const member = this.parseFuncAt(i);
                if (member) {
                    members.push(member);
                }
            }
            // getter_func(name, value)
            else if (keyword === 'getter_func') {
                const member = this.parseGetterFuncAt(i);
                if (member) {
                    members.push(member);
                }
            }
            // getterconst_func(name, value)
            else if (keyword === 'getterconst_func') {
                const member = this.parseGetterConstFuncAt(i);
                if (member) {
                    members.push(member);
                }
            }
            // var(name, value) and variants
            else if (keyword.startsWith('var')) {
                const member = this.parseVarAt(i, keyword);
                if (member) {
                    members.push(member);
                }
            }
        }

        return members;
    }

    private parseFuncAt(index: number): ClassMember | null {
        let i = index + 1; // Skip 'func'

        // Expect '('
        if (!(this.tokens[i] instanceof ParserKeyword && (this.tokens[i] as ParserKeyword).value === '(')) {
            return null;
        }
        i++;

        // Get function name
        let funcName: string;
        if (this.tokens[i] instanceof Variable) {
            funcName = (this.tokens[i] as Variable).name;
        } else if (this.tokens[i] instanceof SQFString) {
            funcName = (this.tokens[i] as SQFString).value;
        } else {
            return null;
        }

        const lineNumber = this.getLineNumber(index);

        return {
            type: 'FunctionDeclaration',
            name: funcName,
            body: '',
            editorAttributes: [],
            functionType: 'func',
            range: {
                start: { line: lineNumber, character: 0 },
                end: { line: lineNumber, character: 0 }
            }
        };
    }

    private parseGetterFuncAt(index: number): ClassMember | null {
        let i = index + 1; // Skip 'getter_func'

        // Expect '('
        if (!(this.tokens[i] instanceof ParserKeyword && (this.tokens[i] as ParserKeyword).value === '(')) {
            return null;
        }
        i++;

        // Get function name
        if (!(this.tokens[i] instanceof Variable)) {
            return null;
        }
        const funcName = (this.tokens[i] as Variable).name;

        const lineNumber = this.getLineNumber(index);

        return {
            type: 'GetterFunctionDeclaration',
            name: funcName,
            body: '',
            editorAttributes: [],
            range: {
                start: { line: lineNumber, character: 0 },
                end: { line: lineNumber, character: 0 }
            }
        };
    }

    private parseGetterConstFuncAt(index: number): ClassMember | null {
        let i = index + 1; // Skip 'getterconst_func'

        // Expect '('
        if (!(this.tokens[i] instanceof ParserKeyword && (this.tokens[i] as ParserKeyword).value === '(')) {
            return null;
        }
        i++;

        // Get function name
        if (!(this.tokens[i] instanceof Variable)) {
            return null;
        }
        const funcName = (this.tokens[i] as Variable).name;

        const lineNumber = this.getLineNumber(index);

        return {
            type: 'GetterConstFunctionDeclaration',
            name: funcName,
            value: '',
            editorAttributes: [],
            range: {
                start: { line: lineNumber, character: 0 },
                end: { line: lineNumber, character: 0 }
            }
        };
    }

    private parseVarAt(index: number, varType: string): ClassMember | null {
        let i = index + 1; // Skip 'var'

        // Expect '('
        if (!(this.tokens[i] instanceof ParserKeyword && (this.tokens[i] as ParserKeyword).value === '(')) {
            return null;
        }
        i++;

        // Get variable name
        if (!(this.tokens[i] instanceof Variable)) {
            return null;
        }
        const varName = (this.tokens[i] as Variable).name;

        const lineNumber = this.getLineNumber(index);

        return {
            type: 'VariableDeclaration',
            name: varName,
            value: '',
            varType: varType as any,
            editorAttributes: [],
            range: {
                start: { line: lineNumber, character: 0 },
                end: { line: lineNumber, character: 0 }
            }
        };
    }

    private parseStructs(): StructDeclaration[] {
        const structs: StructDeclaration[] = [];

        for (let i = 0; i < this.tokens.length; i++) {
            const token = this.tokens[i];
            
            // Найти "struct"
            if (token instanceof Keyword && token.value.toLowerCase() === 'struct') {
                try {
                    const structDecl = this.parseStructAt(i);
                    if (structDecl) {
                        structs.push(structDecl);
                    }
                } catch (e) {
                    // Skip errors, continue parsing
                }
            }
        }

        return structs;
    }

    private parseStructAt(startIndex: number): StructDeclaration | null {
        let i = startIndex + 1; // Skip 'struct'

        // Expect '('
        if (!(this.tokens[i] instanceof ParserKeyword && (this.tokens[i] as ParserKeyword).value === '(')) {
            return null;
        }
        i++;

        // Get struct name
        if (!(this.tokens[i] instanceof Variable)) {
            return null;
        }
        const structName = (this.tokens[i] as Variable).name;
        i++;

        // Expect ')'
        if (!(this.tokens[i] instanceof ParserKeyword && (this.tokens[i] as ParserKeyword).value === ')')) {
            return null;
        }
        i++;

        // Parse base (optional)
        let baseName: string | undefined;
        if (i < this.tokens.length && 
            this.tokens[i] instanceof Keyword && 
            (this.tokens[i] as Keyword).value.toLowerCase() === 'base') {
            i++; // Skip 'base'
            
            if (this.tokens[i] instanceof ParserKeyword && (this.tokens[i] as ParserKeyword).value === '(') {
                i++;
                if (this.tokens[i] instanceof Variable) {
                    baseName = (this.tokens[i] as Variable).name;
                }
            }
        }

        // Find endstruct
        const endIndex = this.findEndstruct(i);
        if (endIndex === -1) {
            return null;
        }

        // Parse members
        const members = this.parseStructMembers(i, endIndex);

        const lineNumber = this.getLineNumber(startIndex);

        return {
            type: 'StructDeclaration',
            name: structName,
            base: baseName,
            members,
            range: {
                start: { line: lineNumber, character: 0 },
                end: { line: lineNumber, character: 0 }
            }
        };
    }

    private findEndstruct(startIndex: number): number {
        let depth = 1;

        for (let i = startIndex; i < this.tokens.length; i++) {
            const token = this.tokens[i];
            
            if (token instanceof Keyword) {
                const value = token.value.toLowerCase();
                if (value === 'struct') {
                    depth++;
                } else if (value === 'endstruct') {
                    depth--;
                    if (depth === 0) {
                        return i;
                    }
                }
            }
        }

        return -1;
    }

    private parseStructMembers(startIndex: number, endIndex: number): StructMember[] {
        const members: StructMember[] = [];

        for (let i = startIndex; i < endIndex; i++) {
            const token = this.tokens[i];

            if (!(token instanceof Keyword)) continue;

            const keyword = token.value.toLowerCase();

            // def(name) or def_ret(name)
            if (keyword === 'def' || keyword === 'def_ret' || keyword === 'def_null') {
                const member = this.parseDefAt(i, keyword === 'def_ret');
                if (member) {
                    members.push(member);
                }
            }
        }

        return members;
    }

    private parseDefAt(index: number, isDefRet: boolean): StructMember | null {
        let i = index + 1; // Skip 'def'

        // Expect '('
        if (!(this.tokens[i] instanceof ParserKeyword && (this.tokens[i] as ParserKeyword).value === '(')) {
            return null;
        }
        i++;

        // Get member name
        if (!(this.tokens[i] instanceof Variable)) {
            return null;
        }
        const memberName = (this.tokens[i] as Variable).name;

        const lineNumber = this.getLineNumber(index);

        if (isDefRet) {
            return {
                type: 'DefRetDeclaration',
                name: memberName,
                value: '',
                range: {
                    start: { line: lineNumber, character: 0 },
                    end: { line: lineNumber, character: 0 }
                }
            };
        } else {
            return {
                type: 'DefDeclaration',
                name: memberName,
                value: '',
                isMethod: false,
                range: {
                    start: { line: lineNumber, character: 0 },
                    end: { line: lineNumber, character: 0 }
                }
            };
        }
    }

    private getLineNumber(tokenIndex: number): number {
        // Approximate line number by counting EndOfLine tokens
        let line = 0;
        for (let i = 0; i < tokenIndex && i < this.tokens.length; i++) {
            const token = this.tokens[i];
            if (token.toString().includes('\n')) {
                line++;
            }
        }
        return line;
    }
}

