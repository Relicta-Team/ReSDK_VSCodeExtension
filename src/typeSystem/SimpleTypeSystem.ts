// ======================================================
// Simple Type System для ReSDK
// ======================================================

import { DocumentAST, ClassDeclaration, StructDeclaration } from '../parser/types';

export interface TypeInfo {
    name: string;
    kind: 'class' | 'struct';
    parent?: string;
    members: Map<string, MemberInfo>;
    location: {
        uri: string;
        line: number;
    };
}

export interface MemberInfo {
    name: string;
    kind: 'method' | 'field';
    declaringType: string;
    location: {
        uri: string;
        line: number;
    };
}

export class SimpleTypeSystem {
    private types: Map<string, TypeInfo> = new Map();

    public clear(): void {
        this.types.clear();
    }

    public addDocument(ast: DocumentAST): void {
        // Add classes
        for (const classDecl of ast.classes) {
            const members = new Map<string, MemberInfo>();
            
            for (const member of classDecl.members) {
                const memberName = member.name.toLowerCase();
                members.set(memberName, {
                    name: member.name,
                    kind: member.type.includes('Function') ? 'method' : 'field',
                    declaringType: classDecl.name,
                    location: {
                        uri: ast.uri,
                        line: member.range.start.line
                    }
                });
            }

            this.types.set(classDecl.name.toLowerCase(), {
                name: classDecl.name,
                kind: 'class',
                parent: classDecl.extends?.toLowerCase(),
                members,
                location: {
                    uri: ast.uri,
                    line: classDecl.range.start.line
                }
            });
        }

        // Add structs
        for (const structDecl of ast.structs) {
            const members = new Map<string, MemberInfo>();
            
            for (const member of structDecl.members) {
                members.set(member.name, {
                    name: member.name,
                    kind: 'field',
                    declaringType: structDecl.name,
                    location: {
                        uri: ast.uri,
                        line: member.range.start.line
                    }
                });
            }

            this.types.set(structDecl.name, {
                name: structDecl.name,
                kind: 'struct',
                parent: structDecl.base,
                members,
                location: {
                    uri: ast.uri,
                    line: structDecl.range.start.line
                }
            });
        }
    }

    public findType(typeName: string): TypeInfo | undefined {
        return this.types.get(typeName.toLowerCase()) || this.types.get(typeName);
    }

    public findMember(typeName: string, memberName: string): MemberInfo | undefined {
        const typeInfo = this.findType(typeName);
        if (!typeInfo) return undefined;

        const memberKey = typeInfo.kind === 'class' ? memberName.toLowerCase() : memberName;
        return typeInfo.members.get(memberKey);
    }

    public getAllTypes(): TypeInfo[] {
        return Array.from(this.types.values());
    }
}

