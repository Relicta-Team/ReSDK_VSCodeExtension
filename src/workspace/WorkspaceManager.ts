// ======================================================
// Workspace Manager - управление проектом
// ======================================================

import { readdirSync, existsSync, readFileSync } from 'fs';
import { join, extname } from 'path';
import { ReSDKParser } from '../parser/resdkParser';
import { SimpleTypeSystem } from '../typeSystem/SimpleTypeSystem';
import { BasicResolver } from '../typeResolver/BasicResolver';

export class WorkspaceManager {
    private typeSystem: SimpleTypeSystem;
    private resolver: BasicResolver;
    private workspaceRoots: string[];

    constructor(workspaceRoots: string[]) {
        this.workspaceRoots = workspaceRoots;
        this.typeSystem = new SimpleTypeSystem();
        this.resolver = new BasicResolver(this.typeSystem);
    }

    public async scanWorkspace(): Promise<void> {
        for (const root of this.workspaceRoots) {
            await this.scanDirectory(root);
        }
        
        const types = this.typeSystem.getAllTypes();
        console.log(`[WorkspaceManager] Indexed ${types.length} types`);
        
        // Показываем первые 5 типов для проверки
        console.log('[WorkspaceManager] Sample types:');
        types.slice(0, 5).forEach(t => {
            console.log(`  - ${t.kind}: ${t.name} (${t.members.size} members) at ${t.location.uri.split('/').pop()}`);
        });
    }

    private async scanDirectory(dir: string): Promise<void> {
        if (!existsSync(dir)) return;

        const entries = readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = join(dir, entry.name);

            if (entry.isDirectory()) {
                if (!this.shouldSkip(entry.name)) {
                    await this.scanDirectory(fullPath);
                }
            } else if (entry.isFile()) {
                if (this.isSourceFile(entry.name)) {
                    await this.scanFile(fullPath);
                }
            }
        }
    }

    private async scanFile(filePath: string): Promise<void> {
        try {
            const content = readFileSync(filePath, 'utf-8');
            const uri = this.pathToUri(filePath);
            
            const parser = new ReSDKParser(uri);
            const ast = parser.parseDocument(content);
            
            this.typeSystem.addDocument(ast);
        } catch (error) {
            // Skip files with errors
        }
    }

    public parseFile(uri: string, content: string): void {
        const parser = new ReSDKParser(uri);
        const ast = parser.parseDocument(content);
        this.typeSystem.addDocument(ast);
    }

    public getTypeSystem(): SimpleTypeSystem {
        return this.typeSystem;
    }

    public getResolver(): BasicResolver {
        return this.resolver;
    }

    private isSourceFile(fileName: string): boolean {
        const ext = extname(fileName).toLowerCase();
        return ['.sqf', '.hpp', '.interface'].includes(ext);
    }

    private shouldSkip(dirName: string): boolean {
        const skip = ['node_modules', '.git', '.vscode', 'out'];
        return skip.includes(dirName.toLowerCase());
    }

    private pathToUri(filePath: string): string {
        let uri = filePath;
        
        if (process.platform === 'win32') {
            uri = uri.replace(/\\/g, '/');
            if (!uri.startsWith('/')) {
                uri = '/' + uri;
            }
        }
        
        return 'file://' + uri;
    }
}

