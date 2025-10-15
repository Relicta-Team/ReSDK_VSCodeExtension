// ======================================================
// Basic Type Resolver - pattern matching для вывода типов
// ======================================================

import { SimpleTypeSystem } from '../typeSystem/SimpleTypeSystem';

export interface InferredType {
    typeName: string;
    confidence: 'high' | 'medium' | 'low';
}

export class BasicResolver {
    private typeSystem: SimpleTypeSystem;

    constructor(typeSystem: SimpleTypeSystem) {
        this.typeSystem = typeSystem;
    }

    /**
     * Infer type from expression
     */
    public inferType(expression: string): InferredType | null {
        const trimmed = expression.trim();

        // new(ClassName)
        const newMatch = trimmed.match(/new\s*\(\s*(\w+)\s*\)/i);
        if (newMatch) {
            return {
                typeName: newMatch[1],
                confidence: 'high'
            };
        }

        // instantiate("TypeName")
        const instantiateMatch = trimmed.match(/instantiate\s*\(\s*["'](\w+)["']\s*\)/i);
        if (instantiateMatch) {
            return {
                typeName: instantiateMatch[1],
                confidence: 'high'
            };
        }

        // struct_new(StructName)
        const structNewMatch = trimmed.match(/struct_new\s*\(\s*(\w+)\s*\)/i);
        if (structNewMatch) {
            return {
                typeName: structNewMatch[1],
                confidence: 'high'
            };
        }

        return null;
    }

    /**
     * Find variable type in file content
     */
    public inferVariableType(varName: string, fileContent: string): InferredType | null {
        const patterns = [
            new RegExp(`${this.escapeRegex(varName)}\\s*=\\s*new\\s*\\(\\s*(\\w+)\\s*\\)`, 'i'),
            new RegExp(`${this.escapeRegex(varName)}\\s*=\\s*instantiate\\s*\\(\\s*["'](\\w+)["']\\s*\\)`, 'i'),
            new RegExp(`${this.escapeRegex(varName)}\\s*=\\s*struct_new\\s*\\(\\s*(\\w+)\\s*\\)`, 'i')
        ];

        for (const pattern of patterns) {
            const match = fileContent.match(pattern);
            if (match) {
                return this.inferType(match[0]);
            }
        }

        return null;
    }

    /**
     * Find member access context
     */
    public findMemberAccess(line: string, charPosition: number): {
        memberName: string;
        objectName: string;
    } | null {
        // getVar(_obj, fieldName)
        const getVarMatch = line.match(/(?:get|set)Var\s*\(\s*([_\w]+)\s*,\s*(\w+)/i);
        if (getVarMatch) {
            return {
                objectName: getVarMatch[1],
                memberName: getVarMatch[2]
            };
        }

        // callFunc(_obj, methodName)
        const callFuncMatch = line.match(/callFunc(?:Params)?\s*\(\s*([_\w]+)\s*,\s*(\w+)/i);
        if (callFuncMatch) {
            return {
                objectName: callFuncMatch[1],
                memberName: callFuncMatch[2]
            };
        }

        // getSelf(fieldName)
        const getSelfMatch = line.match(/(?:get|set)Self\s*\(\s*(\w+)/i);
        if (getSelfMatch) {
            return {
                objectName: 'this',
                memberName: getSelfMatch[1]
            };
        }

        return null;
    }

    private escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}

