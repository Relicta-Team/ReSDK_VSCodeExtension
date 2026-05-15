import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";

export type WorkspaceFolderInfo = {
  name: string;
  path: string;
};

export type GraphEdgeKind = "include" | "loadFile" | "importClient" | "importCommon" | "preprocess" | "componentInclude";
export type ProjectRootKind = "runtime" | "host" | "client" | "editor" | "tests";
export type ContextKind = "standalone" | "host" | "client" | "editor" | "tests" | "shared";
export type WorkspaceKind = "generic" | "resdk";

type GraphEdge = {
  from: string;
  to: string;
  kind: GraphEdgeKind;
};

type ProjectRoot = {
  kind: ProjectRootKind;
  filePath: string;
};

type ModuleOwnerKind = "registered" | "inferred";

type ModuleOwner = {
  kind: ModuleOwnerKind;
  rootKind: ProjectRootKind;
  contextKind: ContextKind;
  rootFile: string;
  entryFile: string;
  moduleDir: string;
};

type ChainInfo = {
  files: string[];
  edgeKinds: GraphEdgeKind[];
};

export type ResolvedContext = {
  id: string;
  label: string;
  detail: string;
  contextKind: ContextKind;
  rootKind: ProjectRootKind;
  workspaceKind: WorkspaceKind;
  workspaceRoot: string;
  rootFile: string;
  validationEntryFile: string;
  ownerFile: string;
  targetFile: string;
  chain: string[];
  edgeKinds: GraphEdgeKind[];
  confidence: "high" | "medium" | "low";
  preferred: boolean;
  profileHints: string[];
};

export type ResolvedContextsResult = {
  workspaceKind: WorkspaceKind;
  workspaceRoot: string;
  preferredContextId: string;
  contexts: ResolvedContext[];
};

export type WorkspaceProject = {
  folder: WorkspaceFolderInfo;
  workspaceKind: WorkspaceKind;
  workspaceRoot: string;
  sourceRoot: string;
  roots: ProjectRoot[];
  outgoing: Map<string, GraphEdge[]>;
  moduleOwners: ModuleOwner[];
};

export function collectReachableFiles(project: WorkspaceProject, startFile: string): Set<string> {
  const normalizedStart = path.normalize(startFile);
  const reachable = new Set<string>();
  const pending = [normalizedStart];

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (reachable.has(current)) {
      continue;
    }

    reachable.add(current);
    for (const edge of project.outgoing.get(current) ?? []) {
      if (!reachable.has(edge.to)) {
        pending.push(edge.to);
      }
    }
  }

  return reachable;
}

const GRAPH_FILE_PATTERN = /\.(sqf|hpp|h|inc|interface)$/i;
const EXECUTABLE_BOUNDARY_PATTERN = /(?:^|\\)(?:fn_init\.sqf|Editor_init\.sqf|Init\.sqf|init\.sqf|.*_init\.sqf|.*Init\.sqf)$/i;

export function normalizeFsPath(inputPath: string): string {
  return path.normalize(inputPath).toLowerCase();
}

function hasFile(targetPath: string): boolean {
  return existsSync(targetPath) && statSync(targetPath).isFile();
}

function hasDirectory(targetPath: string): boolean {
  return existsSync(targetPath) && statSync(targetPath).isDirectory();
}

function canonicalizeFilePath(targetPath: string): string {
  const normalizedPath = path.normalize(targetPath);
  try {
    return realpathSync.native(normalizedPath);
  } catch {
    return normalizedPath;
  }
}

function toDisplayPath(workspaceRoot: string, targetPath: string): string {
  const relative = path.relative(workspaceRoot, targetPath);
  return relative && !relative.startsWith("..") ? relative.replace(/\//g, "\\") : targetPath;
}

function detectResdkRoot(folderPath: string): string | undefined {
  const normalizedFolder = path.normalize(folderPath);
  const sourceCandidate = path.join(normalizedFolder, "Src", "fn_init.sqf");
  if (hasFile(sourceCandidate)) {
    return normalizedFolder;
  }

  const directSourceCandidate = path.join(normalizedFolder, "fn_init.sqf");
  const parentCandidate = path.dirname(normalizedFolder);
  if (hasFile(directSourceCandidate) && hasFile(path.join(parentCandidate, "initServer.sqf"))) {
    return parentCandidate;
  }

  return undefined;
}

function collectGraphFiles(rootPath: string): string[] {
  if (!hasDirectory(rootPath)) {
    return [];
  }

  const result: string[] = [];
  const pending = [rootPath];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }

      if (entry.isFile() && GRAPH_FILE_PATTERN.test(entry.name)) {
        result.push(canonicalizeFilePath(fullPath));
      }
    }
  }

  result.sort((left, right) => left.localeCompare(right));
  return result;
}

function resolveProjectPath(project: WorkspaceProject, sourceFile: string, rawTarget: string, kind: GraphEdgeKind): string | undefined {
  if (!rawTarget) {
    return undefined;
  }

  const normalizedSpec = rawTarget.replace(/\//g, "\\").trim();
  if (!normalizedSpec) {
    return undefined;
  }

  let resolvedPath = "";
  if (/^[A-Za-z]:\\/.test(normalizedSpec)) {
    resolvedPath = normalizedSpec;
  } else if (/^src[\\/]/i.test(normalizedSpec)) {
    resolvedPath = path.join(project.workspaceRoot, normalizedSpec);
  } else if (kind === "importCommon") {
    resolvedPath = path.join(project.sourceRoot, "host", "CommonComponents", normalizedSpec);
  } else {
    resolvedPath = path.join(path.dirname(sourceFile), normalizedSpec);
  }

  const normalizedResolvedPath = canonicalizeFilePath(resolvedPath);
  if (!GRAPH_FILE_PATTERN.test(normalizedResolvedPath)) {
    return undefined;
  }

  return normalizedResolvedPath;
}

function extractGraphEdges(project: WorkspaceProject, sourceFile: string, text: string): GraphEdge[] {
  const edges: GraphEdge[] = [];

  const includePattern = /^\s*#include\s+[<"]([^>"]+)[>"]/gm;
  for (const match of text.matchAll(includePattern)) {
    const target = resolveProjectPath(project, sourceFile, match[1], "include");
    if (target && hasFile(target)) {
      edges.push({ from: sourceFile, to: target, kind: "include" });
    }
  }

  const loadFilePattern = /\bloadFile\s*\(\s*"([^"]+)"\s*\)/g;
  for (const match of text.matchAll(loadFilePattern)) {
    const target = resolveProjectPath(project, sourceFile, match[1], "loadFile");
    if (target && hasFile(target)) {
      edges.push({ from: sourceFile, to: target, kind: "loadFile" });
    }
  }

  const bareLoadFilePattern = /\bloadFile\s+"([^"]+)"/gi;
  for (const match of text.matchAll(bareLoadFilePattern)) {
    const target = resolveProjectPath(project, sourceFile, match[1], "loadFile");
    if (target && hasFile(target)) {
      edges.push({ from: sourceFile, to: target, kind: "loadFile" });
    }
  }

  const importClientPattern = /\bimportClient\s*\(\s*"([^"]+)"\s*\)/g;
  for (const match of text.matchAll(importClientPattern)) {
    const target = resolveProjectPath(project, sourceFile, match[1], "importClient");
    if (target && hasFile(target)) {
      edges.push({ from: sourceFile, to: target, kind: "importClient" });
    }
  }

  const importCommonPattern = /\bimportCommon\s*\(\s*"([^"]+)"\s*\)/g;
  for (const match of text.matchAll(importCommonPattern)) {
    const target = resolveProjectPath(project, sourceFile, match[1], "importCommon");
    if (target && hasFile(target)) {
      edges.push({ from: sourceFile, to: target, kind: "importCommon" });
    }
  }

  const preprocessPatterns = [
    /\b(?:preprocessFileLineNumbers|preprocessFile)\s*\(\s*"([^"]+)"\s*\)/g,
    /\b(?:preprocessFileLineNumbers|preprocessFile)\s+"([^"]+)"/g,
    /\b__pragma_preprocess\s*\(\s*"([^"]+)"\s*\)/g
  ];
  for (const pattern of preprocessPatterns) {
    for (const match of text.matchAll(pattern)) {
      const target = resolveProjectPath(project, sourceFile, match[1], "preprocess");
      if (target && hasFile(target)) {
        edges.push({ from: sourceFile, to: target, kind: "preprocess" });
      }
    }
  }

  const componentIncludePattern = /componentInit\(([^)]+)\)\s*\r?\n\s*#include\s+[<"]([^>"]+)[>"]/g;
  for (const match of text.matchAll(componentIncludePattern)) {
    const target = resolveProjectPath(project, sourceFile, match[2], "componentInclude");
    if (target && hasFile(target)) {
      edges.push({ from: sourceFile, to: target, kind: "componentInclude" });
    }
  }

  return edges;
}

function discoverRoots(project: WorkspaceProject): ProjectRoot[] {
  const roots: Array<{ kind: ProjectRootKind; filePath: string }> = [
    { kind: "runtime", filePath: path.join(project.sourceRoot, "fn_init.sqf") },
    { kind: "host", filePath: path.join(project.sourceRoot, "host", "init.sqf") },
    { kind: "client", filePath: path.join(project.sourceRoot, "client", "Init.sqf") },
    { kind: "editor", filePath: path.join(project.sourceRoot, "Editor", "Editor_init.sqf") },
    { kind: "tests", filePath: path.join(project.sourceRoot, "vm_fn_init_tests_bootstrap.sqf") }
  ];

  return roots
    .map((root) => ({ ...root, filePath: canonicalizeFilePath(root.filePath) }))
    .filter((root) => hasFile(root.filePath));
}

function isPathInDirectory(targetPath: string, directoryPath: string): boolean {
  const normalizedTarget = normalizeFsPath(targetPath);
  let normalizedDirectory = normalizeFsPath(directoryPath);
  if (!normalizedDirectory.endsWith(path.sep)) {
    normalizedDirectory += path.sep;
  }
  return normalizedTarget.startsWith(normalizedDirectory);
}

function isProjectRootFile(project: WorkspaceProject, targetFile: string): boolean {
  const normalizedTarget = normalizeFsPath(targetFile);
  return project.roots.some((root) => normalizeFsPath(root.filePath) === normalizedTarget);
}

function isBroadModuleDirectory(project: WorkspaceProject, moduleDir: string): boolean {
  const normalizedDir = normalizeFsPath(moduleDir);
  const broadDirs = [
    project.sourceRoot,
    path.join(project.sourceRoot, "host"),
    path.join(project.sourceRoot, "client"),
    path.join(project.sourceRoot, "Editor")
  ].map(normalizeFsPath);

  return broadDirs.includes(normalizedDir);
}

function pushModuleOwner(
  owners: ModuleOwner[],
  seen: Set<string>,
  owner: ModuleOwner
): void {
  const key = [
    owner.kind,
    owner.rootKind,
    normalizeFsPath(owner.rootFile),
    normalizeFsPath(owner.entryFile),
    normalizeFsPath(owner.moduleDir)
  ].join("::");
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  owners.push(owner);
}

function getFallbackRootKindAndContext(project: WorkspaceProject, targetFile: string): { rootKind: ProjectRootKind; contextKind: ContextKind } {
  if (project.workspaceKind !== "resdk") {
    return { rootKind: "runtime", contextKind: "standalone" };
  }

  const normalizedTarget = normalizeFsPath(targetFile);
  const clientMarker = normalizeFsPath(path.join(project.sourceRoot, "client"));
  const editorMarker = normalizeFsPath(path.join(project.sourceRoot, "Editor"));
  const testMarker = normalizeFsPath(path.join(project.sourceRoot, "host", "UnitTests"));
  const sharedMarker = normalizeFsPath(path.join(project.sourceRoot, "host", "CommonComponents"));

  if (normalizedTarget.startsWith(clientMarker)) {
    return { rootKind: "client", contextKind: "client" };
  }
  if (normalizedTarget.startsWith(editorMarker)) {
    return { rootKind: "editor", contextKind: "editor" };
  }
  if (normalizedTarget.startsWith(testMarker)) {
    return { rootKind: "tests", contextKind: "tests" };
  }
  if (normalizedTarget.startsWith(sharedMarker)) {
    return { rootKind: "runtime", contextKind: "shared" };
  }
  return { rootKind: "host", contextKind: "host" };
}

function findRootFile(project: WorkspaceProject, rootKind: ProjectRootKind, fallbackFile: string): string {
  return project.roots.find((root) => root.kind === rootKind)?.filePath ?? fallbackFile;
}

function discoverModuleOwners(project: WorkspaceProject): ModuleOwner[] {
  if (project.workspaceKind !== "resdk") {
    return [];
  }

  const owners: ModuleOwner[] = [];
  const seen = new Set<string>();
  const registeredEdgeKinds = new Set<GraphEdgeKind>(["loadFile", "importClient", "importCommon", "componentInclude"]);

  for (const root of project.roots) {
    const pending = [root.filePath];
    const visited = new Set<string>();

    while (pending.length > 0) {
      const current = pending.pop()!;
      const currentKey = normalizeFsPath(current);
      if (visited.has(currentKey)) {
        continue;
      }
      visited.add(currentKey);

      for (const edge of project.outgoing.get(current) ?? []) {
        const isLoaderInclude = edge.kind === "include" && path.basename(edge.to).toLowerCase() === "loader.hpp";
        if ((registeredEdgeKinds.has(edge.kind) || isLoaderInclude) && !isProjectRootFile(project, edge.to)) {
          const moduleDir = path.dirname(edge.to);
          if (!isBroadModuleDirectory(project, moduleDir)) {
            const contextKind = determineContextKind(project, root, edge.to, [root.filePath, edge.to]);
            pushModuleOwner(owners, seen, {
              kind: "registered",
              rootKind: root.kind,
              contextKind,
              rootFile: root.filePath,
              entryFile: edge.to,
              moduleDir
            });
          }
        }

        if (!visited.has(normalizeFsPath(edge.to))) {
          pending.push(edge.to);
        }
      }
    }
  }

  for (const filePath of project.outgoing.keys()) {
    if (!filePath.toLowerCase().endsWith(".sqf") || !EXECUTABLE_BOUNDARY_PATTERN.test(filePath) || isProjectRootFile(project, filePath)) {
      continue;
    }

    const moduleDir = path.dirname(filePath);
    if (isBroadModuleDirectory(project, moduleDir)) {
      continue;
    }

    const { rootKind, contextKind } = getFallbackRootKindAndContext(project, filePath);
    pushModuleOwner(owners, seen, {
      kind: "inferred",
      rootKind,
      contextKind,
      rootFile: findRootFile(project, rootKind, filePath),
      entryFile: filePath,
      moduleDir
    });
  }

  owners.sort((left, right) => {
    const dirLengthDiff = right.moduleDir.length - left.moduleDir.length;
    if (dirLengthDiff !== 0) {
      return dirLengthDiff;
    }
    if (left.kind !== right.kind) {
      return left.kind === "registered" ? -1 : 1;
    }
    return left.entryFile.localeCompare(right.entryFile);
  });

  return owners;
}

export function buildWorkspaceProject(folder: WorkspaceFolderInfo): WorkspaceProject {
  const resdkRoot = detectResdkRoot(folder.path);
  const workspaceKind: WorkspaceKind = resdkRoot ? "resdk" : "generic";
  const workspaceRoot = canonicalizeFilePath(resdkRoot ?? folder.path);
  const sourceRoot = canonicalizeFilePath(workspaceKind === "resdk" ? path.join(workspaceRoot, "Src") : workspaceRoot);

  const project: WorkspaceProject = {
    folder,
    workspaceKind,
    workspaceRoot,
    sourceRoot,
    roots: [],
    outgoing: new Map<string, GraphEdge[]>(),
    moduleOwners: []
  };

  for (const filePath of collectGraphFiles(sourceRoot)) {
    const text = readFileSync(filePath, "utf8");
    project.outgoing.set(filePath, extractGraphEdges(project, filePath, text));
  }

  project.roots = discoverRoots(project);
  project.moduleOwners = discoverModuleOwners(project);
  return project;
}

export function updateWorkspaceProjectFile(project: WorkspaceProject, filePath: string, text?: string): void {
  const normalizedPath = canonicalizeFilePath(filePath);
  const normalizedSourceRoot = normalizeFsPath(project.sourceRoot);
  if (!normalizeFsPath(normalizedPath).startsWith(normalizedSourceRoot) || !GRAPH_FILE_PATTERN.test(normalizedPath)) {
    return;
  }

  if (text === undefined && !hasFile(normalizedPath)) {
    project.outgoing.delete(normalizedPath);
  } else {
    const sourceText = text ?? readFileSync(normalizedPath, "utf8");
    project.outgoing.set(normalizedPath, extractGraphEdges(project, normalizedPath, sourceText));
  }

  project.roots = discoverRoots(project);
  project.moduleOwners = discoverModuleOwners(project);
}

function findShortestChain(project: WorkspaceProject, rootFile: string, targetFile: string): ChainInfo | undefined {
  if (rootFile === targetFile) {
    return { files: [rootFile], edgeKinds: [] };
  }

  const queue = [rootFile];
  const visited = new Set<string>([rootFile]);
  const previous = new Map<string, { parent: string; edgeKind: GraphEdgeKind }>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of project.outgoing.get(current) ?? []) {
      if (visited.has(edge.to)) {
        continue;
      }

      visited.add(edge.to);
      previous.set(edge.to, { parent: current, edgeKind: edge.kind });
      if (edge.to === targetFile) {
        const files = [targetFile];
        const edgeKinds: GraphEdgeKind[] = [];
        let cursor = targetFile;
        while (cursor !== rootFile) {
          const prev = previous.get(cursor);
          if (!prev) {
            break;
          }
          edgeKinds.push(prev.edgeKind);
          files.push(prev.parent);
          cursor = prev.parent;
        }
        files.reverse();
        edgeKinds.reverse();
        return { files, edgeKinds };
      }

      queue.push(edge.to);
    }
  }

  return undefined;
}

function chooseValidationEntryFile(chain: string[], targetFile: string): string {
  for (let index = chain.length - 1; index >= 0; --index) {
    const candidate = chain[index];
    if (candidate !== targetFile && candidate.toLowerCase().endsWith(".sqf") && EXECUTABLE_BOUNDARY_PATTERN.test(candidate)) {
      return candidate;
    }
  }

  for (let index = chain.length - 1; index >= 0; --index) {
    const candidate = chain[index];
    if (candidate.toLowerCase().endsWith(".sqf")) {
      return candidate;
    }
  }

  return targetFile;
}

function determineContextKind(project: WorkspaceProject, root: ProjectRoot, targetFile: string, chain: string[]): ContextKind {
  if (project.workspaceKind !== "resdk") {
    return "standalone";
  }

  const normalizedTarget = normalizeFsPath(targetFile);
  const sharedMarker = normalizeFsPath(path.join(project.sourceRoot, "host", "CommonComponents"));
  const clientMarker = normalizeFsPath(path.join(project.sourceRoot, "client"));
  const editorMarker = normalizeFsPath(path.join(project.sourceRoot, "Editor"));
  const testMarker = normalizeFsPath(path.join(project.sourceRoot, "host", "UnitTests"));

  if (normalizedTarget.startsWith(editorMarker)) {
    return "editor";
  }

  if (normalizedTarget.startsWith(testMarker) || root.kind === "tests") {
    return "tests";
  }

  if (normalizedTarget.startsWith(clientMarker) || root.kind === "client") {
    return "client";
  }

  if (normalizedTarget.startsWith(sharedMarker)) {
    if (chain.some((filePath) => normalizeFsPath(filePath) === normalizeFsPath(path.join(project.sourceRoot, "Editor", "Editor_init.sqf")))) {
      return "editor";
    }
    return "shared";
  }

  if (root.kind === "editor") {
    return "editor";
  }

  return "host";
}

function getProfileHints(contextKind: ContextKind, rootKind: ProjectRootKind): string[] {
  if (contextKind === "editor") {
    return ["DEBUG", "EDITOR"];
  }

  if (contextKind === "tests") {
    return ["DEBUG", "RBUILDER"];
  }

  if (contextKind === "client") {
    return ["DEBUG"];
  }

  if (contextKind === "shared") {
    return rootKind === "tests" ? ["DEBUG", "RBUILDER"] : ["DEBUG"];
  }

  return ["DEBUG"];
}

function getContextScore(project: WorkspaceProject, targetFile: string, context: Omit<ResolvedContext, "preferred">): number {
  const normalizedTarget = normalizeFsPath(targetFile);
  let score = 0;

  if (project.workspaceKind === "generic") {
    score += 10;
  }

  if (normalizedTarget.includes("\\editor\\") && context.contextKind === "editor") {
    score += 100;
  }
  if (normalizedTarget.includes("\\client\\") && context.contextKind === "client") {
    score += 100;
  }
  if (normalizedTarget.includes("\\host\\unittests\\") && context.contextKind === "tests") {
    score += 100;
  }
  if (normalizedTarget.includes("\\host\\commoncomponents\\") && context.contextKind === "shared") {
    score += 100;
  }

  if (context.rootKind === "editor") {
    score += 30;
  }
  if (context.rootKind === "tests") {
    score += 20;
  }
  if (context.validationEntryFile === targetFile) {
    score += 15;
  }

  score += Math.max(0, 25 - context.chain.length);
  score += context.ownerFile !== targetFile ? 5 : 0;
  if (context.detail.startsWith("module:")) {
    score -= context.confidence === "medium" ? 20 : 30;
  }
  if (context.detail.startsWith("heuristic:")) {
    score -= 40;
  }
  return score;
}

function findBestModuleOwner(project: WorkspaceProject, targetFile: string): ModuleOwner | undefined {
  const normalizedTarget = normalizeFsPath(targetFile);
  let bestOwner: ModuleOwner | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const owner of project.moduleOwners) {
    const normalizedEntry = normalizeFsPath(owner.entryFile);
    if (normalizedTarget !== normalizedEntry && !isPathInDirectory(targetFile, owner.moduleDir)) {
      continue;
    }

    let score = owner.moduleDir.length;
    if (owner.kind === "registered") {
      score += 20;
    }
    if (normalizedTarget === normalizedEntry) {
      score += 50;
    }

    if (score > bestScore) {
      bestScore = score;
      bestOwner = owner;
    }
  }

  return bestOwner;
}

function pushModuleOwnerContext(
  contexts: Array<Omit<ResolvedContext, "preferred">>,
  project: WorkspaceProject,
  targetFile: string,
  owner: ModuleOwner
): void {
  const validationEntryFile = owner.contextKind === "editor" ? owner.rootFile : owner.entryFile;
  if (!hasFile(validationEntryFile)) {
    return;
  }

  const id = `module::${owner.kind}::${normalizeFsPath(validationEntryFile)}::${normalizeFsPath(owner.entryFile)}::${normalizeFsPath(targetFile)}`;
  if (contexts.some((context) => context.id === id)) {
    return;
  }

  const detailKind = owner.kind === "registered" ? "registered" : "inferred";
  contexts.push({
    id,
    label: `${owner.contextKind} via ${path.basename(validationEntryFile)}`,
    detail: `module: ${detailKind}: ${toDisplayPath(project.workspaceRoot, validationEntryFile)} -> ${toDisplayPath(project.workspaceRoot, owner.entryFile)} -> ${toDisplayPath(project.workspaceRoot, targetFile)}`,
    contextKind: owner.contextKind,
    rootKind: owner.rootKind,
    workspaceKind: project.workspaceKind,
    workspaceRoot: project.workspaceRoot,
    rootFile: owner.rootFile,
    validationEntryFile,
    ownerFile: owner.entryFile,
    targetFile,
    chain: [
      toDisplayPath(project.workspaceRoot, owner.rootFile),
      toDisplayPath(project.workspaceRoot, owner.entryFile),
      toDisplayPath(project.workspaceRoot, targetFile)
    ],
    edgeKinds: [],
    confidence: "medium",
    profileHints: getProfileHints(owner.contextKind, owner.rootKind)
  });
}

function pushHeuristicContext(
  contexts: Array<Omit<ResolvedContext, "preferred">>,
  project: WorkspaceProject,
  targetFile: string,
  rootKind: ProjectRootKind,
  contextKind: ContextKind,
  validationEntryFile: string
): void {
  if (!hasFile(validationEntryFile)) {
    return;
  }

  const id = `heuristic::${normalizeFsPath(validationEntryFile)}::${normalizeFsPath(targetFile)}`;
  if (contexts.some((context) => context.id === id)) {
    return;
  }

  contexts.push({
    id,
    label: `${contextKind} via ${path.basename(validationEntryFile)}`,
    detail: `heuristic: ${toDisplayPath(project.workspaceRoot, validationEntryFile)} -> ${toDisplayPath(project.workspaceRoot, targetFile)}`,
    contextKind,
    rootKind,
    workspaceKind: project.workspaceKind,
    workspaceRoot: project.workspaceRoot,
    rootFile: validationEntryFile,
    validationEntryFile,
    ownerFile: validationEntryFile,
    targetFile,
    chain: [toDisplayPath(project.workspaceRoot, validationEntryFile), toDisplayPath(project.workspaceRoot, targetFile)],
    edgeKinds: [],
    confidence: "low",
    profileHints: getProfileHints(contextKind, rootKind)
  });
}

function addHeuristicContexts(project: WorkspaceProject, targetFile: string, contexts: Array<Omit<ResolvedContext, "preferred">>): void {
  if (project.workspaceKind !== "resdk") {
    return;
  }

  const moduleOwner = findBestModuleOwner(project, targetFile);
  if (moduleOwner) {
    pushModuleOwnerContext(contexts, project, targetFile, moduleOwner);
    return;
  }

  const normalizedTarget = normalizeFsPath(targetFile);
  const clientMarker = normalizeFsPath(path.join(project.sourceRoot, "client"));
  const editorMarker = normalizeFsPath(path.join(project.sourceRoot, "Editor"));
  const hostMarker = normalizeFsPath(path.join(project.sourceRoot, "host"));
  const sharedMarker = normalizeFsPath(path.join(project.sourceRoot, "host", "CommonComponents"));

  if (normalizedTarget.startsWith(clientMarker)) {
    pushHeuristicContext(contexts, project, targetFile, "client", "client", path.join(project.sourceRoot, "client", "Init.sqf"));
    return;
  }

  if (normalizedTarget.startsWith(editorMarker)) {
    pushHeuristicContext(contexts, project, targetFile, "editor", "editor", path.join(project.sourceRoot, "Editor", "Editor_init.sqf"));
    return;
  }

  if (normalizedTarget.startsWith(sharedMarker)) {
    pushHeuristicContext(contexts, project, targetFile, "runtime", "shared", path.join(project.sourceRoot, "fn_init.sqf"));
    pushHeuristicContext(contexts, project, targetFile, "editor", "editor", path.join(project.sourceRoot, "Editor", "Editor_init.sqf"));
    return;
  }

  if (normalizedTarget.startsWith(hostMarker)) {
    pushHeuristicContext(contexts, project, targetFile, "host", "host", path.join(project.sourceRoot, "host", "init.sqf"));
  }
}

export function resolveContexts(project: WorkspaceProject, targetFile: string): ResolvedContextsResult {
  const normalizedTarget = path.normalize(targetFile);
  const contexts: Array<Omit<ResolvedContext, "preferred">> = [];

  for (const root of project.roots) {
    const chain = findShortestChain(project, root.filePath, normalizedTarget);
    if (!chain) {
      continue;
    }

    const ownerFile = chain.files.length > 1 ? chain.files[chain.files.length - 2] : normalizedTarget;
    const contextKind = determineContextKind(project, root, normalizedTarget, chain.files);
    const validationEntryFile = contextKind === "editor" ? root.filePath : chooseValidationEntryFile(chain.files, normalizedTarget);
    const profileHints = getProfileHints(contextKind, root.kind);
    const label = `${contextKind} via ${path.basename(validationEntryFile)}`;
    const detail = `${toDisplayPath(project.workspaceRoot, root.filePath)} -> ${toDisplayPath(project.workspaceRoot, normalizedTarget)}`;
    const confidence: "high" | "medium" | "low" = contextKind === "shared" ? "medium" : "high";

    contexts.push({
      id: `${normalizeFsPath(root.filePath)}::${normalizeFsPath(validationEntryFile)}::${normalizeFsPath(normalizedTarget)}`,
      label,
      detail,
      contextKind,
      rootKind: root.kind,
      workspaceKind: project.workspaceKind,
      workspaceRoot: project.workspaceRoot,
      rootFile: root.filePath,
      validationEntryFile,
      ownerFile,
      targetFile: normalizedTarget,
      chain: chain.files.map((filePath) => toDisplayPath(project.workspaceRoot, filePath)),
      edgeKinds: chain.edgeKinds,
      confidence,
      profileHints
    });
  }

  addHeuristicContexts(project, normalizedTarget, contexts);

  if (contexts.length === 0) {
    contexts.push({
      id: `standalone::${normalizeFsPath(normalizedTarget)}`,
      label: `standalone via ${path.basename(normalizedTarget)}`,
      detail: toDisplayPath(project.workspaceRoot, normalizedTarget),
      contextKind: project.workspaceKind === "resdk" ? "host" : "standalone",
      rootKind: "host",
      workspaceKind: project.workspaceKind,
      workspaceRoot: project.workspaceRoot,
      rootFile: normalizedTarget,
      validationEntryFile: normalizedTarget,
      ownerFile: normalizedTarget,
      targetFile: normalizedTarget,
      chain: [toDisplayPath(project.workspaceRoot, normalizedTarget)],
      edgeKinds: [],
      confidence: "low",
      profileHints: ["DEBUG"]
    });
  }

  let preferredContextId = contexts[0].id;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const context of contexts) {
    const score = getContextScore(project, normalizedTarget, context);
    if (score > bestScore) {
      bestScore = score;
      preferredContextId = context.id;
    }
  }

  return {
    workspaceKind: project.workspaceKind,
    workspaceRoot: project.workspaceRoot,
    preferredContextId,
    contexts: contexts.map((context) => ({
      ...context,
      preferred: context.id === preferredContextId
    }))
  };
}
