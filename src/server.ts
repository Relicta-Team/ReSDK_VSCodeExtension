import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CompletionItem,
  CompletionParams,
  CompletionItemKind,
  Diagnostic,
  DiagnosticSeverity,
  DidChangeConfigurationNotification,
  DocumentSymbolParams,
  Definition,
  Hover,
  InitializeParams,
  InitializeResult,
  Location,
  MarkupKind,
  Position,
  ReferenceParams,
  SignatureHelp,
  SignatureInformation,
  SymbolInformation,
  SymbolKind,
  TextDocumentPositionParams,
  TextEdit,
  TextDocumentSyncKind,
  createConnection,
  DidChangeWatchedFilesParams,
  ProposedFeatures,
  TextDocuments,
  WorkspaceSymbolParams
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";

import commandEntriesJson from "./generated/commands.json";
import {
  GET_INACTIVE_RANGES_REQUEST,
  GET_RESOLVED_CONTEXTS_REQUEST,
  InactiveRangesResponse,
  ResolvedContextsResponse
} from "./protocol";
import { computeInactiveRanges } from "./preprocessorAnalysis";
import {
  ResolvedContext,
  ResolvedContextsResult,
  WorkspaceFolderInfo,
  WorkspaceProject,
  buildWorkspaceProject,
  normalizeFsPath,
  resolveContexts,
  updateWorkspaceProjectFile
} from "./projectGraph";
import {
  WorkspaceSymbolIndex,
  IndexedSymbol,
  LocalReferenceInfo,
  LocalSymbolInfo,
  ReSdkOwnerRef,
  buildWorkspaceSymbolIndex,
  extractDocumentSymbols,
  extractDocumentFunctionSymbols,
  getDefinitionLocations,
  getVisibleMacroSymbols,
  getVisibleSymbolMatches,
  getReferenceLocations,
  getVisibleCompletionItems,
  getReSdkMemberCandidates,
  inferLocalFlowType,
  resolveIndexedTypeOwner,
  resolveReSdkMember,
  updateWorkspaceSymbolIndexFileFast
} from "./symbolIndex";
import {
  ReSdkExpression,
  ReSdkMemberReferenceNode,
  collectReSdkMemberReferences,
  findReSdkMemberReferenceAtOffset,
  macroCallNameEquals,
  macroCallNameIn,
  parseReSdkExpression
} from "./resdkExpressionAst";
import {
  buildMacroPreview,
  collectActiveDocumentMacros,
  getMacroInvocationArgumentsAtPosition
} from "./macroAnalysis";
import { analyzeLatentFaults } from "./latentAnalysis";

type CommandKind = "nular" | "function" | "operator";

type CommandEntry = {
  kind: CommandKind;
  name: string;
  returnType: string;
  leftType: string;
  rightType: string;
  leftLabel: string;
  rightLabel: string;
  description: string;
  example: string;
  exampleResult: string;
  category: string;
  sourceFile: string;
};

type RuntimeSettings = {
  evaluatorPath: string;
  rootPath: string;
  extensionsRoot: string;
  serverMode: boolean;
  maxSteps: number;
  diagnosticsTimeoutMs: number;
  validateOnSave: boolean;
  validateOnOpen: boolean;
};

type PathContextKind = "include" | "loadFile" | "importClient" | "importCommon" | "preprocess";

type PathCompletionContext = {
  kind: PathContextKind;
  rawPath: string;
  typedPath: string;
  replaceStart: number;
  replaceEnd: number;
};

type ResolvedPathReference = {
  kind: PathContextKind;
  rawPath: string;
  start: number;
  end: number;
};

const KEYWORDS = [
  "if",
  "then",
  "else",
  "for",
  "from",
  "to",
  "step",
  "do",
  "while",
  "switch",
  "case",
  "default",
  "private",
  "params",
  "call",
  "spawn",
  "try",
  "catch",
  "throw",
  "exitWith",
  "waitUntil",
  "scopeName",
  "breakOut"
] as const;

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const commandEntries = commandEntriesJson as CommandEntry[];
const commandsByName = new Map<string, CommandEntry[]>();
const completionItems: CompletionItem[] = [];
const defaultSettings: RuntimeSettings = {
  evaluatorPath: "",
  rootPath: "",
  extensionsRoot: "",
  serverMode: false,
  maxSteps: 1000000,
  diagnosticsTimeoutMs: 30000,
  validateOnSave: true,
  validateOnOpen: false
};

let hasConfigurationCapability = false;
let bundledEvaluatorPath = "";
let workspaceFolders: WorkspaceFolderInfo[] = [];
const settingsByWorkspace = new Map<string, Thenable<Partial<RuntimeSettings>>>();
const warnedExecutableWorkspaces = new Set<string>();
const projectByWorkspace = new Map<string, WorkspaceProject>();
const symbolIndexByWorkspace = new Map<string, WorkspaceSymbolIndex>();
const symbolIndexWarmupByWorkspace = new Set<string>();
const symbolIndexUpdateTimerByUri = new Map<string, NodeJS.Timeout>();
const symbolIndexRefinementTimerByWorkspace = new Map<string, NodeJS.Timeout>();
const preprocessCacheByKey = new Map<string, PreprocessJsonResult | null>();
const preprocessCacheByUri = new Map<string, PreprocessJsonResult>();
const documentSymbolsByUri = new Map<string, { version: number; symbols: IndexedSymbol[] }>();
const validationGenerationByUri = new Map<string, number>();
const validationQueueByUri = new Map<string, Promise<void>>();
const WORKSPACE_SYMBOL_INDEX_FILE_LIMIT = 500;
const LOCAL_ANALYSIS_FULL_DOCUMENT_LIMIT = 300_000;
const LOCAL_ANALYSIS_CONTEXT_LOOKBACK = 100_000;
const WORKSPACE_SYMBOL_INDEX_WARMUP_DELAY_MS = 1500;
const WORKSPACE_SYMBOL_INDEX_UPDATE_DEBOUNCE_MS = 750;
const WORKSPACE_SYMBOL_INDEX_REFINEMENT_DELAY_MS = 5000;

for (const entry of commandEntries) {
  const key = entry.name.toLowerCase();
  const overloads = commandsByName.get(key) ?? [];
  overloads.push(entry);
  commandsByName.set(key, overloads);
}

const completionNames = new Set<string>();
for (const entry of commandEntries) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name)) {
    continue;
  }

  const key = entry.name.toLowerCase();
  if (completionNames.has(key)) {
    continue;
  }

  completionNames.add(key);
  completionItems.push({
    label: entry.name,
    kind: CompletionItemKind.Function,
    detail: buildSignature(entry),
    documentation: entry.description || `Category: ${entry.category}`
  });
}

for (const keyword of KEYWORDS) {
  completionItems.push({
    label: keyword,
    kind: CompletionItemKind.Keyword
  });
}

function toFsPath(uri: string): string {
  return fileURLToPath(uri);
}

function formatType(typeName: string): string {
  const cleaned = typeName.trim();
  const exactMap: Record<string, string> = {
    GameAny: "ANY",
    GameArray: "ARRAY",
    GameBool: "BOOL",
    GameCode: "CODE",
    GameConfig: "CONFIG",
    GameControlType: "CONTROL",
    GameDisplayType: "DISPLAY",
    GameHashMap: "HASHMAP",
    GameNothing: "NOTHING",
    GameObjectType: "OBJECT",
    GameScript: "SCRIPT",
    GameScalar: "SCALAR",
    GameSide: "SIDE",
    GameString: "STRING",
    GameText: "TEXT",
    GameVoid: "VOID"
  };

  if (exactMap[cleaned]) {
    return exactMap[cleaned];
  }

  if (cleaned.startsWith("Game") && cleaned.length > 4) {
    return cleaned.slice(4).replace(/Type$/, "").toUpperCase();
  }

  return cleaned || "ANY";
}

function buildSignature(entry: CommandEntry): string {
  if (entry.kind === "nular") {
    return `${entry.name} -> ${formatType(entry.returnType)}`;
  }

  if (entry.kind === "function") {
    const parameter = entry.rightLabel || formatType(entry.rightType);
    return `${entry.name} ${parameter} -> ${formatType(entry.returnType)}`;
  }

  const left = entry.leftLabel || formatType(entry.leftType);
  const right = entry.rightLabel || formatType(entry.rightType);
  return `${left} ${entry.name} ${right} -> ${formatType(entry.returnType)}`;
}

function buildHover(overloads: CommandEntry[]): Hover {
  const blocks = overloads.map((entry) => {
    const lines = [`### ${buildSignature(entry)}`];
    if (entry.description) {
      lines.push(entry.description);
    }
    lines.push(`Category: \`${entry.category}\``);
    if (entry.example) {
      lines.push(`Example: \`${entry.example}\``);
    }
    if (entry.exampleResult) {
      lines.push(`Result: \`${entry.exampleResult}\``);
    }
    return lines.join("\n\n");
  });

  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: blocks.join("\n\n---\n\n")
    }
  };
}

function toWorkspaceDisplayPath(workspaceRoot: string | undefined, targetPath: string): string {
  if (!workspaceRoot) {
    return targetPath;
  }

  const relative = path.relative(workspaceRoot, targetPath);
  return relative && !relative.startsWith("..") ? relative.replace(/\//g, "\\") : targetPath;
}

function getIndexedSymbolScore(
  symbol: IndexedSymbol,
  currentFilePath: string,
  preferredContext: ResolvedContext | undefined
): number {
  let score = 0;
  if (normalizeFsPath(symbol.filePath) === normalizeFsPath(currentFilePath)) {
    score += 100;
  }
  if (preferredContext) {
    if (normalizeFsPath(symbol.filePath) === normalizeFsPath(preferredContext.targetFile)) {
      score += 80;
    }
    if (normalizeFsPath(symbol.filePath) === normalizeFsPath(preferredContext.ownerFile)) {
      score += 60;
    }
    if (normalizeFsPath(symbol.filePath) === normalizeFsPath(preferredContext.validationEntryFile)) {
      score += 40;
    }
    if (normalizeFsPath(symbol.filePath) === normalizeFsPath(preferredContext.rootFile)) {
      score += 20;
    }
  }
  return score;
}

function choosePreferredIndexedSymbol(
  symbols: IndexedSymbol[],
  currentFilePath: string,
  preferredContext: ResolvedContext | undefined
): IndexedSymbol {
  return symbols.reduce((best, candidate) => {
    const bestScore = getIndexedSymbolScore(best, currentFilePath, preferredContext);
    const candidateScore = getIndexedSymbolScore(candidate, currentFilePath, preferredContext);
    return candidateScore > bestScore ? candidate : best;
  });
}

function formatIndexedSymbolKind(kind: IndexedSymbol["kind"]): string {
  switch (kind) {
    case "macro":
      return "macro";
    case "globalFunction":
      return "global function";
    case "globalVariable":
      return "global variable";
    case "classType":
      return "class";
    case "structType":
      return "struct";
    case "classMethod":
      return "class method";
    case "classProperty":
      return "class property";
    case "structMember":
      return "struct member";
    default:
      return kind;
  }
}

function getSymbolKind(symbol: IndexedSymbol): SymbolKind {
  switch (symbol.kind) {
    case "macro":
      return SymbolKind.Constant;
    case "globalFunction":
      return SymbolKind.Function;
    case "globalVariable":
      return SymbolKind.Variable;
    case "classType":
      return SymbolKind.Class;
    case "structType":
      return SymbolKind.Struct;
    case "classMethod":
      return SymbolKind.Method;
    case "classProperty":
      return SymbolKind.Property;
    case "structMember":
      return SymbolKind.Field;
  }
}

function buildSymbolLocation(symbol: IndexedSymbol): Location {
  return Location.create(pathToFileURL(symbol.filePath).toString(), {
    start: { line: Math.max(0, symbol.line - 1), character: 0 },
    end: { line: Math.max(0, symbol.line - 1), character: Math.max(1, symbol.name.length) }
  });
}

function toSymbolInformation(symbol: IndexedSymbol, workspaceRoot: string | undefined): SymbolInformation {
  return {
    name: symbol.name,
    kind: getSymbolKind(symbol),
    location: buildSymbolLocation(symbol),
    containerName: workspaceRoot ? toWorkspaceDisplayPath(workspaceRoot, symbol.filePath) : symbol.filePath
  };
}

function formatMacroSignature(symbol: IndexedSymbol): string {
  const parameters = symbol.macroParameters ?? [];
  return parameters.length > 0
    ? `${symbol.name}(${parameters.join(", ")})`
    : symbol.name;
}

function formatFunctionSignature(symbol: IndexedSymbol): string {
  return symbol.signatureLabel ?? `${symbol.name}()`;
}

function formatLocalSymbolType(symbol: LocalSymbolInfo): string {
  return symbol.type ?? "unknown";
}

function formatLocalSymbolTypeAtPosition(
  symbolIndex: WorkspaceSymbolIndex | undefined,
  functionSymbol: IndexedSymbol,
  localSymbol: LocalSymbolInfo,
  offset: number
): string {
  return symbolIndex
    ? inferLocalFlowType(symbolIndex, functionSymbol, localSymbol, offset) ?? formatLocalSymbolType(localSymbol)
    : formatLocalSymbolType(localSymbol);
}

function getDocumentSymbols(document: TextDocument): IndexedSymbol[] {
  const cached = documentSymbolsByUri.get(document.uri);
  if (cached && cached.version === document.version) {
    return cached.symbols;
  }

  const symbols = extractDocumentSymbols(toFsPath(document.uri), document.getText());
  documentSymbolsByUri.set(document.uri, { version: document.version, symbols });
  return symbols;
}

function getDocumentFunctionSymbols(document: TextDocument): IndexedSymbol[] {
  return getDocumentSymbols(document).filter((symbol) =>
    symbol.kind === "globalFunction"
    || symbol.kind === "classMethod"
    || (symbol.kind === "structMember" && typeof symbol.bodyStartOffset === "number")
  );
}

function findMatchingClosingDelimiter(text: string, openIndex: number, openChar: string, closeChar: string): number {
  let depth = 0;
  let quote: string | undefined;
  let lineComment = false;
  let blockComment = false;

  for (let index = openIndex; index < text.length; ++index) {
    const current = text[index];
    const next = text[index + 1];

    if (lineComment) {
      if (current === "\n") {
        lineComment = false;
      }
      continue;
    }

    if (blockComment) {
      if (current === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }

    if (quote) {
      if (current === quote) {
        quote = undefined;
      }
      continue;
    }

    if (current === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (current === "\"" || current === "'") {
      quote = current;
      continue;
    }

    if (current === openChar) {
      depth += 1;
    } else if (current === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function offsetLocalSymbol(symbol: LocalSymbolInfo, offsetBase: number): LocalSymbolInfo {
  return {
    ...symbol,
    definitionStart: symbol.definitionStart + offsetBase,
    definitionEnd: symbol.definitionEnd + offsetBase,
    scopeStart: symbol.scopeStart + offsetBase,
    scopeEnd: symbol.scopeEnd + offsetBase
  };
}

function offsetLocalReference(reference: LocalReferenceInfo, offsetBase: number): LocalReferenceInfo {
  return {
    ...reference,
    start: reference.start + offsetBase,
    end: reference.end + offsetBase,
    definitionStart: reference.definitionStart === undefined ? undefined : reference.definitionStart + offsetBase,
    definitionEnd: reference.definitionEnd === undefined ? undefined : reference.definitionEnd + offsetBase,
    valueStart: reference.valueStart === undefined ? undefined : reference.valueStart + offsetBase,
    valueEnd: reference.valueEnd === undefined ? undefined : reference.valueEnd + offsetBase
  };
}

function offsetDocumentFunctionSymbol(symbol: IndexedSymbol, offsetBase: number, lineBase: number): IndexedSymbol {
  return {
    ...symbol,
    line: symbol.line + lineBase,
    bodyStartOffset: symbol.bodyStartOffset === undefined ? undefined : symbol.bodyStartOffset + offsetBase,
    bodyEndOffset: symbol.bodyEndOffset === undefined ? undefined : symbol.bodyEndOffset + offsetBase,
    localSymbols: symbol.localSymbols?.map((local) => offsetLocalSymbol(local, offsetBase)),
    localReferences: symbol.localReferences?.map((reference) => offsetLocalReference(reference, offsetBase))
  };
}

function getDocumentFunctionSymbolsNearPosition(document: TextDocument, position: Position): IndexedSymbol[] {
  const text = document.getText();
  if (text.length <= LOCAL_ANALYSIS_FULL_DOCUMENT_LIMIT) {
    return getDocumentFunctionSymbols(document);
  }

  const offset = document.offsetAt(position);
  const searchStart = Math.max(0, offset - LOCAL_ANALYSIS_CONTEXT_LOOKBACK);
  const prefix = text.slice(searchStart, offset);
  const functionPattern = /(?:^|\r?\n)([ \t]*(?:(?:extern|const)\s+)*(?:decl\([^)\r\n]*\)\s+)?[A-Za-z][A-Za-z0-9_]*\s*=\s*\{)/g;
  let match: RegExpExecArray | null;
  let lastMatch: RegExpExecArray | undefined;
  while ((match = functionPattern.exec(prefix)) !== null) {
    lastMatch = match;
  }
  if (!lastMatch) {
    return [];
  }

  const matchedText = lastMatch[1];
  const matchStart = searchStart + (lastMatch.index ?? 0) + lastMatch[0].indexOf(matchedText);
  const openBraceIndex = matchStart + matchedText.lastIndexOf("{");
  const closeBraceIndex = findMatchingClosingDelimiter(text, openBraceIndex, "{", "}");
  if (closeBraceIndex < offset) {
    return [];
  }

  const sliceStart = text.lastIndexOf("\n", matchStart) + 1;
  const sliceEnd = closeBraceIndex + 1;
  const lineBase = document.positionAt(sliceStart).line;
  return extractDocumentFunctionSymbols(toFsPath(document.uri), text.slice(sliceStart, sliceEnd))
    .map((symbol) => offsetDocumentFunctionSymbol(symbol, sliceStart, lineBase));
}

function isFunctionLikeSymbol(symbol: IndexedSymbol): boolean {
  return symbol.kind === "globalFunction"
    || symbol.kind === "classMethod"
    || (symbol.kind === "structMember" && typeof symbol.bodyStartOffset === "number");
}

function getEnclosingDocumentFunctionSymbol(document: TextDocument, position: Position, symbolIndex?: WorkspaceSymbolIndex): IndexedSymbol | undefined {
  const offset = document.offsetAt(position);
  const currentFile = normalizeFsPath(toFsPath(document.uri));
  const candidates = getDocumentFunctionSymbolsNearPosition(document, position)
    .filter((symbol) => normalizeFsPath(symbol.filePath) === currentFile
      && typeof symbol.bodyStartOffset === "number"
      && typeof symbol.bodyEndOffset === "number"
      && offset >= symbol.bodyStartOffset
      && offset <= symbol.bodyEndOffset)
    .sort((left, right) => (left.bodyEndOffset! - left.bodyStartOffset!) - (right.bodyEndOffset! - right.bodyStartOffset!));
  if (candidates[0]) {
    return candidates[0];
  }

  const indexedCandidates = symbolIndex?.all
    .filter((symbol) => isFunctionLikeSymbol(symbol)
      && normalizeFsPath(symbol.filePath) === currentFile
      && typeof symbol.bodyStartOffset === "number"
      && typeof symbol.bodyEndOffset === "number"
      && offset >= symbol.bodyStartOffset
      && offset <= symbol.bodyEndOffset)
    .sort((left, right) => (left.bodyEndOffset! - left.bodyStartOffset!) - (right.bodyEndOffset! - right.bodyStartOffset!));
  return indexedCandidates?.[0];
}

function compareLocalSymbolSpecificity(left: LocalSymbolInfo, right: LocalSymbolInfo): number {
  const leftScopeSize = left.scopeEnd - left.scopeStart;
  const rightScopeSize = right.scopeEnd - right.scopeStart;
  if (leftScopeSize !== rightScopeSize) {
    return leftScopeSize - rightScopeSize;
  }
  return right.definitionStart - left.definitionStart;
}

function isLocalSymbolVisibleAtOffset(symbol: LocalSymbolInfo, offset: number): boolean {
  return offset >= symbol.scopeStart && offset <= symbol.scopeEnd && (offset >= symbol.definitionStart || offset <= symbol.definitionEnd);
}

function getVisibleLocalSymbolsAtPosition(document: TextDocument, position: Position, symbolIndex?: WorkspaceSymbolIndex): { functionSymbol: IndexedSymbol; symbols: LocalSymbolInfo[] } | undefined {
  const functionSymbol = getEnclosingDocumentFunctionSymbol(document, position, symbolIndex);
  if (!functionSymbol?.localSymbols?.length) {
    return undefined;
  }

  const offset = document.offsetAt(position);
  const visibleByName = new Map<string, LocalSymbolInfo>();
  for (const symbol of functionSymbol.localSymbols) {
    if (!isLocalSymbolVisibleAtOffset(symbol, offset)) {
      continue;
    }

    const key = symbol.name.toLowerCase();
    const existing = visibleByName.get(key);
    if (!existing || compareLocalSymbolSpecificity(symbol, existing) < 0) {
      visibleByName.set(key, symbol);
    }
  }

  return { functionSymbol, symbols: Array.from(visibleByName.values()).sort((left, right) => left.name.localeCompare(right.name)) };
}

function buildLocalLocation(document: TextDocument, startOffset: number, endOffset: number): Location {
  return Location.create(document.uri, {
    start: document.positionAt(startOffset),
    end: document.positionAt(endOffset)
  });
}

function chooseDocumentSymbolForPosition(symbols: IndexedSymbol[], position: Position): IndexedSymbol {
  const line = position.line + 1;
  return [...symbols].sort((left, right) => {
    const leftExact = left.line === line ? 0 : 1;
    const rightExact = right.line === line ? 0 : 1;
    if (leftExact !== rightExact) {
      return leftExact - rightExact;
    }

    const leftPast = left.line <= line ? 0 : 1;
    const rightPast = right.line <= line ? 0 : 1;
    if (leftPast !== rightPast) {
      return leftPast - rightPast;
    }

    const leftDistance = Math.abs(line - left.line);
    const rightDistance = Math.abs(line - right.line);
    if (leftDistance !== rightDistance) {
      return leftDistance - rightDistance;
    }

    return right.line - left.line;
  })[0];
}

function buildDocumentSymbolHover(document: TextDocument, position: Position, token: string): Hover | null {
  const currentFilePath = normalizeFsPath(toFsPath(document.uri));
  const matchingSymbols = getDocumentSymbols(document)
    .filter((symbol) => normalizeFsPath(symbol.filePath) === currentFilePath && symbol.name.toLowerCase() === token.toLowerCase());
  if (matchingSymbols.length === 0) {
    return null;
  }

  const primary = chooseDocumentSymbolForPosition(matchingSymbols, position);
  const lines: string[] = [`### ${primary.kind === "globalFunction" ? formatFunctionSignature(primary) : primary.name}`];

  if (primary.kind === "macro") {
    const signature = formatMacroSignature(primary);
    const definitionText = primary.macroBody?.length
      ? `#define ${signature} ${primary.macroBody}`
      : `#define ${signature}`;
    lines.push(`Kind: \`macro\``);
    lines.push(`Definition:\n\n\`\`\`sqf\n${definitionText}\n\`\`\``);
  } else if (primary.kind === "globalFunction") {
    lines.push(`Kind: \`global function\``);
    lines.push(`Signature: \`${formatFunctionSignature(primary)}\``);
    if (primary.functionReturnType) {
      lines.push(`Returns: \`${primary.functionReturnType}\``);
    }
    if (primary.signatureSource) {
      lines.push(`Type source: \`${primary.signatureSource}\``);
    }
  } else {
    lines.push(`Kind: \`${formatIndexedSymbolKind(primary.kind)}\``);
    if (primary.functionReturnType) {
      lines.push(`Returns: \`${primary.functionReturnType}\``);
    } else if (primary.valueType) {
      lines.push(`Type: \`${primary.valueType}\``);
    }
    lines.push(`Detail: \`${primary.detail}\``);
  }

  lines.push(`Defined in current document at line \`${primary.line}\``);
  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: lines.join("\n\n")
    }
  };
}

function getLocalDefinitionMatch(document: TextDocument, position: Position, token: string, symbolIndex?: WorkspaceSymbolIndex): { functionSymbol: IndexedSymbol; localSymbol: LocalSymbolInfo } | undefined {
  const functionSymbol = getEnclosingDocumentFunctionSymbol(document, position, symbolIndex);
  if (!functionSymbol?.localSymbols?.length) {
    return undefined;
  }

  const offset = document.offsetAt(position);
  const directDefinition = functionSymbol.localSymbols
    .filter((symbol) => symbol.name.toLowerCase() === token.toLowerCase() && offset >= symbol.definitionStart && offset <= symbol.definitionEnd)
    .sort(compareLocalSymbolSpecificity)[0];
  if (directDefinition) {
    return { functionSymbol, localSymbol: directDefinition };
  }

  const directReference = functionSymbol.localReferences?.find((reference) => reference.name.toLowerCase() === token.toLowerCase() && offset >= reference.start && offset <= reference.end);
  if (directReference?.definitionStart !== undefined && directReference.definitionEnd !== undefined) {
    const matched = functionSymbol.localSymbols.find((symbol) =>
      symbol.name.toLowerCase() === directReference.name.toLowerCase()
      && symbol.definitionStart === directReference.definitionStart
      && symbol.definitionEnd === directReference.definitionEnd
    );
    if (matched) {
      return { functionSymbol, localSymbol: matched };
    }
  }

  const visible = getVisibleLocalSymbolsAtPosition(document, position, symbolIndex)?.symbols
    .filter((symbol) => symbol.name.toLowerCase() === token.toLowerCase())
    .sort(compareLocalSymbolSpecificity)[0];
  return visible ? { functionSymbol, localSymbol: visible } : undefined;
}

function getLocalReferenceLocations(document: TextDocument, position: Position, token: string, includeDeclaration: boolean, symbolIndex?: WorkspaceSymbolIndex): Location[] {
  const match = getLocalDefinitionMatch(document, position, token, symbolIndex);
  if (!match) {
    return [];
  }

  const locations: Location[] = [];
  if (includeDeclaration) {
    locations.push(buildLocalLocation(document, match.localSymbol.definitionStart, match.localSymbol.definitionEnd));
  }

  for (const reference of match.functionSymbol.localReferences ?? []) {
    if (reference.name.toLowerCase() !== match.localSymbol.name.toLowerCase()
      || reference.definitionStart !== match.localSymbol.definitionStart
      || reference.definitionEnd !== match.localSymbol.definitionEnd) {
      continue;
    }
    locations.push(buildLocalLocation(document, reference.start, reference.end));
  }

  return locations;
}

function getLocalSymbolMatch(document: TextDocument, position: Position, token: string, symbolIndex?: WorkspaceSymbolIndex): { functionSymbol: IndexedSymbol; localSymbol: LocalSymbolInfo } | undefined {
  return getLocalDefinitionMatch(document, position, token, symbolIndex);
}

function getLocalCompletionItems(document: TextDocument, position: Position, symbolIndex?: WorkspaceSymbolIndex): CompletionItem[] {
  const visible = getVisibleLocalSymbolsAtPosition(document, position, symbolIndex);
  if (!visible) {
    return [];
  }
  const offset = document.offsetAt(position);

  return visible.symbols.map((symbol) => ({
    label: symbol.name,
    kind: CompletionItemKind.Variable,
    detail: `${symbol.source} ${formatLocalSymbolTypeAtPosition(symbolIndex, visible.functionSymbol, symbol, offset)}`,
    documentation: visible.functionSymbol.signatureLabel
  }));
}

function countTopLevelCommas(text: string): number {
  let count = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote: string | undefined;

  for (let index = 0; index < text.length; ++index) {
    const current = text[index];
    if (quote) {
      if (current === quote) {
        quote = undefined;
      }
      continue;
    }

    if (current === '"' || current === "'") {
      quote = current;
      continue;
    }
    if (current === "(") parenDepth += 1;
    else if (current === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (current === "[") bracketDepth += 1;
    else if (current === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (current === "{") braceDepth += 1;
    else if (current === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (current === "," && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      count += 1;
    }
  }

  return count;
}

function findMatchingOpeningDelimiter(text: string, closeIndex: number, openChar: string, closeChar: string): number {
  let depth = 0;
  let quote: string | undefined;

  for (let index = closeIndex; index >= 0; --index) {
    const current = text[index];
    if (quote) {
      if (current === quote) {
        quote = undefined;
      }
      continue;
    }

    if (current === '"' || current === "'") {
      quote = current;
      continue;
    }

    if (current === closeChar) {
      depth += 1;
    } else if (current === openChar) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function getProjectFunctionCallContext(document: TextDocument, position: Position): { name: string; activeParameter: number } | undefined {
  const lineText = getLineText(document, position.line);
  const callPattern = /\b(call|spawn)\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
  let bestMatch: { name: string; activeParameter: number; rank: number } | undefined;

  let match: RegExpExecArray | null;
  while ((match = callPattern.exec(lineText)) !== null) {
    const operatorStart = match.index;
    const operatorText = match[1];
    const name = match[2];
    const functionStart = operatorStart + match[0].lastIndexOf(name);
    const functionEnd = functionStart + name.length;
    const operandText = lineText.slice(0, operatorStart).trimEnd();

    if (operandText.endsWith("]")) {
      const openIndex = findMatchingOpeningDelimiter(lineText.slice(0, operatorStart), operatorStart - 1, "[", "]");
      if (openIndex >= 0 && position.character >= openIndex && position.character <= operatorStart) {
        const insideText = lineText.slice(openIndex + 1, position.character);
        const activeParameter = insideText.trim() ? countTopLevelCommas(insideText) : 0;
        bestMatch = { name, activeParameter, rank: 2 };
      }
    }

    if (position.character >= functionStart && position.character <= functionEnd + 1) {
      bestMatch = {
        name,
        activeParameter: operatorText === "call" && operandText ? (operandText.startsWith("[") && operandText.endsWith("]") ? Math.max(0, countTopLevelCommas(operandText.slice(1, -1))) : 0) : 0,
        rank: 3
      };
    }
  }

  return bestMatch ? { name: bestMatch.name, activeParameter: bestMatch.activeParameter } : undefined;
}

function buildPreprocessMacroMap(
  preprocessResult: PreprocessJsonResult | null | undefined,
  symbolIndex: WorkspaceSymbolIndex,
  project: WorkspaceProject,
  preferredContext: ResolvedContext | undefined,
  currentFilePath: string
): { macroMap: Map<string, IndexedSymbol>; activeDefines: Set<string> } | undefined {
  if (!preprocessResult?.macros?.length) {
    return undefined;
  }

  const macroMap = new Map<string, IndexedSymbol>();
  for (const macro of preprocessResult.macros) {
    const name = macro.name?.trim();
    if (!name) {
      continue;
    }

    const indexedMatches = getVisibleSymbolMatches(symbolIndex, project, preferredContext, name)
      .filter((symbol) => symbol.kind === "macro");
    const indexedSymbol = indexedMatches.length > 0
      ? choosePreferredIndexedSymbol(indexedMatches, currentFilePath, preferredContext)
      : undefined;
    const parameters = indexedSymbol?.macroParameters;

    macroMap.set(name.toLowerCase(), {
      name,
      kind: "macro",
      filePath: indexedSymbol?.filePath ?? preprocessResult.resolvedTarget ?? currentFilePath,
      line: indexedSymbol?.line ?? 1,
      detail: parameters?.length
        ? `#define(${parameters.join(", ")})`
        : (macro.hasParams ? "#define(...)" : "#define"),
      macroParameters: parameters,
      macroBody: macro.value ?? indexedSymbol?.macroBody ?? ""
    });
  }

  return {
    macroMap,
    activeDefines: new Set(preprocessResult.activeDefines ?? [])
  };
}

function buildIndexedHover(
  document: TextDocument,
  position: Position,
  project: WorkspaceProject,
  symbolIndex: WorkspaceSymbolIndex,
  preferredContext: ResolvedContext | undefined,
  token: string,
  preprocessResult: PreprocessJsonResult | null | undefined
): Hover | null {
  const currentFilePath = toFsPath(document.uri);
  const matches = getVisibleSymbolMatches(symbolIndex, project, preferredContext, token);
  if (matches.length === 0) {
    return null;
  }

  const exactDocumentMatch = matches.find((symbol) =>
    normalizeFsPath(symbol.filePath) === normalizeFsPath(currentFilePath)
    && symbol.line === position.line + 1
  );
  const primary = exactDocumentMatch ?? choosePreferredIndexedSymbol(matches, currentFilePath, preferredContext);
  const workspaceRoot = preferredContext?.workspaceRoot ?? project.workspaceRoot;
  const primaryReturnType = inferKnownReSdkReturnType(primary) ?? primary.functionReturnType;
  const primarySignature = primary.signatureLabel && primaryReturnType
    ? primary.signatureLabel.replace(/\s*->\s*\S+\s*$/, ` -> ${primaryReturnType}`)
    : primary.signatureLabel;
  const lines: string[] = [`### ${primary.kind === "globalFunction" ? formatFunctionSignature(primary) : (primarySignature ?? primary.name)}`];
  let locationSymbol = primary;

  if (primary.kind === "macro") {
    const preprocessSnapshot = buildPreprocessMacroMap(preprocessResult, symbolIndex, project, preferredContext, currentFilePath);
    const visibleMacroSymbols = getVisibleMacroSymbols(symbolIndex, project, preferredContext);
    const visibleMacrosByName = preprocessSnapshot
      ? new Map<string, IndexedSymbol>(preprocessSnapshot.macroMap)
      : new Map<string, IndexedSymbol>();
    for (const symbol of visibleMacroSymbols) {
      if (normalizeFsPath(symbol.filePath) === normalizeFsPath(currentFilePath)) {
        continue;
      }
      const key = symbol.name.toLowerCase();
      const existing = visibleMacrosByName.get(key);
      if (!existing) {
        visibleMacrosByName.set(key, symbol);
        continue;
      }
      visibleMacrosByName.set(key, {
        ...choosePreferredIndexedSymbol([existing, symbol], currentFilePath, preferredContext),
        macroBody: existing.macroBody ?? symbol.macroBody,
        macroParameters: existing.macroParameters?.length ? existing.macroParameters : symbol.macroParameters
      });
    }

    const initialDefinedNames = preprocessSnapshot?.activeDefines?.size
      ? new Set(preprocessSnapshot.activeDefines)
      : new Set<string>(Array.from(visibleMacrosByName.values()).map((symbol) => symbol.name));
    for (const profileHint of preferredContext?.profileHints ?? []) {
      initialDefinedNames.add(profileHint);
    }

    const documentMacros = collectActiveDocumentMacros(document, position, initialDefinedNames, currentFilePath);
    for (const [key, symbol] of documentMacros) {
      visibleMacrosByName.set(key, symbol);
    }

    const resolvedPrimary = documentMacros.get(primary.name.toLowerCase())
      ?? visibleMacrosByName.get(primary.name.toLowerCase())
      ?? primary;
    locationSymbol = resolvedPrimary;
    const invocationArguments = getMacroInvocationArgumentsAtPosition(document, position, resolvedPrimary.name);
    const preview = buildMacroPreview(resolvedPrimary, invocationArguments, visibleMacrosByName);
    const signature = formatMacroSignature(resolvedPrimary);
    const definitionText = resolvedPrimary.macroBody?.length
      ? `#define ${signature} ${resolvedPrimary.macroBody}`
      : `#define ${signature}`;

    lines.push(`Kind: \`${formatIndexedSymbolKind(resolvedPrimary.kind)}\``);
    lines.push(`Definition:\n\n\`\`\`sqf\n${definitionText}\n\`\`\``);
    if (preview && preview !== resolvedPrimary.macroBody) {
      lines.push(`Preview:\n\n\`\`\`sqf\n${preview}\n\`\`\``);
    } else if (preview && (resolvedPrimary.macroParameters?.length ?? 0) > 0) {
      lines.push(`Preview:\n\n\`\`\`sqf\n${preview}\n\`\`\``);
    }
    lines.push(`Preprocess source: \`${preprocessSnapshot ? "backend snapshot" : "editor fallback"}\``);
  } else {
    lines.push(`Kind: \`${formatIndexedSymbolKind(primary.kind)}\``);
    if (primary.kind === "globalFunction") {
      lines.push(`Signature: \`${formatFunctionSignature(primary)}\``);
      if (primary.signatureSource) {
        lines.push(`Type source: \`${primary.signatureSource}\``);
      }
    } else {
      if (primaryReturnType) {
        lines.push(`Returns: \`${primaryReturnType}\``);
      } else if (primary.valueType) {
        lines.push(`Type: \`${primary.valueType}\``);
      }
      lines.push(`Detail: \`${primary.detail}\``);
    }
  }

  lines.push(`Defined in: \`${toWorkspaceDisplayPath(workspaceRoot, locationSymbol.filePath)}:${locationSymbol.line}\``);
  if (preferredContext) {
    lines.push(`Context: \`${preferredContext.label}\` | Profiles: \`${preferredContext.profileHints.join(", ")}\``);
  }

  const alternateDefinitions = matches
    .filter((symbol) => symbol !== primary)
    .map((symbol) => `\`${toWorkspaceDisplayPath(workspaceRoot, symbol.filePath)}:${symbol.line}\``);
  if (alternateDefinitions.length > 0) {
    lines.push(`Other visible definitions: ${alternateDefinitions.join(", ")}`);
  }

  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: lines.join("\n\n")
    }
  };
}

function getWordAtPosition(document: TextDocument, position: TextDocumentPositionParams["position"]): string | undefined {
  const lineText = document.getText({
    start: { line: position.line, character: 0 },
    end: { line: position.line, character: Number.MAX_SAFE_INTEGER }
  });

  const wordPattern = /[A-Za-z_][A-Za-z0-9_]*/g;
  let match: RegExpExecArray | null;
  while ((match = wordPattern.exec(lineText)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (position.character >= start && position.character <= end) {
      return match[0];
    }
  }

  return undefined;
}

function getTrailingIdentifier(document: TextDocument, position: TextDocumentPositionParams["position"]): string | undefined {
  const linePrefix = document.getText({
    start: { line: position.line, character: 0 },
    end: position
  });

  const match = /([A-Za-z_][A-Za-z0-9_]*)[^A-Za-z0-9_]*$/.exec(linePrefix);
  return match?.[1];
}

function getCommandCandidate(document: TextDocument, position: TextDocumentPositionParams["position"]): string | undefined {
  return getWordAtPosition(document, position) ?? getTrailingIdentifier(document, position);
}

function shouldSuppressProjectLookupForLocalCandidate(document: TextDocument, position: Position, token: string, symbolIndex?: WorkspaceSymbolIndex): boolean {
  return token.startsWith("_") && Boolean(getEnclosingDocumentFunctionSymbol(document, position, symbolIndex));
}

function getRuntimeCommandCallContext(document: TextDocument, position: Position): { name: string; activeParameter: number } | undefined {
  const linePrefix = document.getText({
    start: { line: position.line, character: 0 },
    end: position
  });
  const identifiers = [...linePrefix.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].reverse();
  for (const match of identifiers) {
    const name = match[0];
    if (!commandsByName.has(name.toLowerCase())) {
      continue;
    }
    const suffix = linePrefix.slice((match.index ?? 0) + name.length);
    return {
      name,
      activeParameter: suffix.includes(",") ? Math.max(0, countTopLevelCommas(suffix)) : 0
    };
  }
  return undefined;
}

function getLineText(document: TextDocument, line: number): string {
  return document.getText({
    start: { line, character: 0 },
    end: { line, character: Number.MAX_SAFE_INTEGER }
  });
}

type ReSdkMemberRole = "method" | "property" | "structMember";

type ReSdkMemberReference = {
  memberName: string;
  role: ReSdkMemberRole;
  owner?: ReSdkOwnerRef;
  receiver?: ReSdkExpression;
  sourceText: string;
};

function currentReSdkOwner(document: TextDocument, position: Position, symbolIndex?: WorkspaceSymbolIndex): ReSdkOwnerRef | undefined {
  const functionSymbol = getEnclosingDocumentFunctionSymbol(document, position, symbolIndex);
  return functionSymbol?.ownerName && functionSymbol.ownerKind
    ? { name: functionSymbol.ownerName, kind: functionSymbol.ownerKind }
    : undefined;
}

function inferReSdkOwnerFromExpression(
  symbolIndex: WorkspaceSymbolIndex,
  document: TextDocument,
  position: Position,
  expression: ReSdkExpression,
  seenLocals = new Set<string>()
): ReSdkOwnerRef | undefined {
  const currentOwner = currentReSdkOwner(document, position, symbolIndex);

  if (expression.kind === "identifier") {
    if (["self", "this", "_self"].includes(expression.name.toLowerCase())) {
      return currentOwner;
    }

    const localMatch = getVisibleLocalSymbolsAtPosition(document, position, symbolIndex)?.symbols
      .find((symbol) => symbol.name.toLowerCase() === expression.name.toLowerCase());
    if (localMatch) {
      if (seenLocals.has(localMatch.name.toLowerCase())) {
        return undefined;
      }
      seenLocals.add(localMatch.name.toLowerCase());

      const functionSymbol = getEnclosingDocumentFunctionSymbol(document, position, symbolIndex);
      const fromFlow = functionSymbol
        ? inferLocalOwnerFromFlow(symbolIndex, document, position, functionSymbol, localMatch, seenLocals)
        : undefined;
      if (fromFlow) {
        return fromFlow;
      }

      const directType = resolveIndexedTypeOwner(symbolIndex, localMatch.type);
      if (directType && !isWeakLocalType(localMatch.type)) {
        return directType;
      }

      return inferLocalOwnerFromUsage(symbolIndex, document, position, localMatch.name);
    }

    return resolveIndexedTypeOwner(symbolIndex, expression.name);
  }

  if (expression.kind === "macroCall") {
    if (macroCallNameEquals(expression, "new") && expression.args[0]?.kind === "identifier") {
      return resolveIndexedTypeOwner(symbolIndex, `class:${expression.args[0].name}`);
    }
    if (macroCallNameEquals(expression, "struct_new") && expression.args[0]?.kind === "identifier") {
      return resolveIndexedTypeOwner(symbolIndex, `struct:${expression.args[0].name}`);
    }
    if (macroCallNameIn(expression, ["getSelf"]) && expression.args[0]?.kind === "identifier" && currentOwner) {
      const property = resolveReSdkMember(symbolIndex, currentOwner, expression.args[0].name, "property");
      return resolveIndexedTypeOwner(symbolIndex, property?.valueType);
    }
    if (macroCallNameIn(expression, ["callSelf", "callSelfParams"]) && expression.args[0]?.kind === "identifier" && currentOwner) {
      const method = resolveReSdkMember(symbolIndex, currentOwner, expression.args[0].name, currentOwner.kind === "struct" ? "structMember" : "method");
      return resolveIndexedTypeOwner(symbolIndex, method?.functionReturnType);
    }
    if (macroCallNameIn(expression, ["callFunc", "callFuncParams", "allFunc", "allFuncParams"]) && expression.args[1]?.kind === "identifier") {
      const receiverOwner = expression.args[0] ? inferReSdkOwnerFromExpression(symbolIndex, document, position, expression.args[0], seenLocals) : undefined;
      const method = resolveMemberWithFallback(symbolIndex, receiverOwner, expression.args[1].name, "method");
      return resolveIndexedTypeOwner(symbolIndex, inferKnownReSdkReturnType(method) ?? method?.functionReturnType);
    }
    if (macroCallNameIn(expression, ["getVar", "setVar"]) && expression.args[1]?.kind === "identifier") {
      const receiverOwner = expression.args[0] ? inferReSdkOwnerFromExpression(symbolIndex, document, position, expression.args[0], seenLocals) : undefined;
      const property = resolveMemberWithFallback(symbolIndex, receiverOwner, expression.args[1].name, "property");
      return resolveIndexedTypeOwner(symbolIndex, property?.valueType);
    }
  }

  if (expression.kind === "infixMacro" && expression.args[0]?.kind === "identifier") {
    const receiverOwner = inferReSdkOwnerFromExpression(symbolIndex, document, position, expression.receiver, seenLocals);
    const member = resolveMemberWithFallback(symbolIndex, receiverOwner, expression.args[0].name, "structMember");
    return resolveIndexedTypeOwner(symbolIndex, member?.valueType ?? member?.functionReturnType);
  }

  if (expression.kind === "sequence") {
    for (let index = expression.items.length - 1; index >= 0; --index) {
      const inferred = inferReSdkOwnerFromExpression(symbolIndex, document, position, expression.items[index], seenLocals);
      if (inferred) {
        return inferred;
      }
    }
  }

  return undefined;
}

function isWeakLocalType(type: string | undefined): boolean {
  return !type || ["null", "nil", "object", "any", "any[]"].includes(type.toLowerCase());
}

function getReSdkMemberReferenceAtPosition(
  symbolIndex: WorkspaceSymbolIndex,
  document: TextDocument,
  position: Position
): ReSdkMemberReference | undefined {
  const lineText = getLineText(document, position.line);
  const lineStart = document.offsetAt({ line: position.line, character: 0 });
  const currentOwner = currentReSdkOwner(document, position, symbolIndex);
  const expression = parseReSdkExpression(lineText, lineStart);
  if (!expression) {
    return undefined;
  }
  const reference = findReSdkMemberReferenceAtOffset(expression, document.offsetAt(position));
  if (!reference) {
    return undefined;
  }
  return {
    memberName: reference.memberName,
    role: reference.role,
    owner: reference.receiver ? undefined : currentOwner,
    receiver: reference.receiver,
    sourceText: lineText
  };
}

function inferKnownReSdkReturnType(symbol: IndexedSymbol | undefined): string | undefined {
  return symbol?.functionReturnType;
}

function resolveMemberWithFallback(
  symbolIndex: WorkspaceSymbolIndex,
  owner: ReSdkOwnerRef | undefined,
  memberName: string,
  role: ReSdkMemberRole
): IndexedSymbol | undefined {
  const direct = resolveReSdkMember(symbolIndex, owner, memberName, role);
  if (direct) {
    return direct;
  }

  const candidates = getReSdkMemberCandidates(symbolIndex, memberName, role);
  return candidates.length === 1 ? candidates[0] : undefined;
}

function inferOwnerFromLocalExpressionRange(
  symbolIndex: WorkspaceSymbolIndex,
  document: TextDocument,
  position: Position,
  valueStart: number,
  valueEnd: number,
  seenLocals: Set<string>
): ReSdkOwnerRef | undefined {
  const expressionText = document.getText({
    start: document.positionAt(valueStart),
    end: document.positionAt(valueEnd)
  });
  const expression = parseReSdkExpression(expressionText, valueStart);
  return expression ? inferReSdkOwnerFromExpression(symbolIndex, document, position, expression, seenLocals) : undefined;
}

function inferLocalOwnerFromFlow(
  symbolIndex: WorkspaceSymbolIndex,
  document: TextDocument,
  position: Position,
  functionSymbol: IndexedSymbol,
  local: LocalSymbolInfo,
  seenLocals: Set<string>
): ReSdkOwnerRef | undefined {
  const offset = document.offsetAt(position);
  const candidates: Array<{ valueStart: number; valueEnd: number }> = [];

  if (local.valueStart !== undefined && local.valueEnd !== undefined && local.valueEnd <= offset) {
    candidates.push({ valueStart: local.valueStart, valueEnd: local.valueEnd });
  }

  for (const reference of functionSymbol.localReferences ?? []) {
    if (!reference.isWrite
      || reference.definitionStart !== local.definitionStart
      || reference.definitionEnd !== local.definitionEnd
      || reference.valueStart === undefined
      || reference.valueEnd === undefined
      || reference.valueEnd > offset) {
      continue;
    }
    candidates.push({ valueStart: reference.valueStart, valueEnd: reference.valueEnd });
  }

  candidates.sort((left, right) => right.valueEnd - left.valueEnd);
  for (const candidate of candidates) {
    const owner = inferOwnerFromLocalExpressionRange(symbolIndex, document, position, candidate.valueStart, candidate.valueEnd, new Set(seenLocals));
    if (owner) {
      return owner;
    }
  }

  return undefined;
}

function expressionIdentifierName(expression: ReSdkExpression | undefined): string | undefined {
  return expression?.kind === "identifier" ? expression.name : undefined;
}

function inferLocalOwnerFromUsage(
  symbolIndex: WorkspaceSymbolIndex,
  document: TextDocument,
  position: Position,
  localName: string
): ReSdkOwnerRef | undefined {
  const functionSymbol = getEnclosingDocumentFunctionSymbol(document, position, symbolIndex);
  if (functionSymbol?.bodyStartOffset === undefined || functionSymbol.bodyEndOffset === undefined) {
    return undefined;
  }

  const bodyText = document.getText({
    start: document.positionAt(functionSymbol.bodyStartOffset),
    end: document.positionAt(functionSymbol.bodyEndOffset)
  });
  const expression = parseReSdkExpression(bodyText, functionSymbol.bodyStartOffset);
  if (!expression) {
    return undefined;
  }

  const memberRefs = collectReSdkMemberReferences(expression)
    .filter((reference) => expressionIdentifierName(reference.receiver) === localName);
  if (memberRefs.length === 0) {
    return undefined;
  }

  const ownerScores = new Map<string, { owner: ReSdkOwnerRef; score: number }>();
  for (const reference of memberRefs) {
    const candidates = getReSdkMemberCandidates(symbolIndex, reference.memberName, reference.role);
    for (const candidate of candidates) {
      if (!candidate.ownerName || !candidate.ownerKind) {
        continue;
      }
      const owner: ReSdkOwnerRef = { name: candidate.ownerName, kind: candidate.ownerKind };
      const key = `${owner.kind}:${owner.name.toLowerCase()}`;
      const current = ownerScores.get(key) ?? { owner, score: 0 };
      current.score += 1;
      ownerScores.set(key, current);
    }
  }

  const requiredCount = new Set(memberRefs.map((reference) => `${reference.role}:${reference.memberName.toLowerCase()}`)).size;
  const viable = Array.from(ownerScores.values())
    .filter((entry) => entry.score >= requiredCount)
    .sort((left, right) => left.owner.name.length - right.owner.name.length);
  return viable[0]?.owner;
}

function resolveReSdkMemberReference(
  symbolIndex: WorkspaceSymbolIndex,
  document: TextDocument,
  position: Position,
  reference: ReSdkMemberReference
): IndexedSymbol | undefined {
  const owner = reference.owner ?? (reference.receiver
    ? inferReSdkOwnerFromExpression(symbolIndex, document, position, reference.receiver)
    : undefined);
  return resolveMemberWithFallback(symbolIndex, owner, reference.memberName, reference.role);
}

function buildTypedMemberHover(
  document: TextDocument,
  project: WorkspaceProject,
  preferredContext: ResolvedContext | undefined,
  symbol: IndexedSymbol
): Hover {
  const workspaceRoot = preferredContext?.workspaceRoot ?? project.workspaceRoot;
  const effectiveReturnType = inferKnownReSdkReturnType(symbol) ?? symbol.functionReturnType;
  const signatureLabel = symbol.signatureLabel && effectiveReturnType
    ? symbol.signatureLabel.replace(/\s*->\s*\S+\s*$/, ` -> ${effectiveReturnType}`)
    : (symbol.signatureLabel ?? symbol.name);
  const lines = [`### ${signatureLabel}`];
  lines.push(`Kind: \`${formatIndexedSymbolKind(symbol.kind)}\``);
  if (symbol.ownerName) {
    lines.push(`Owner: \`${symbol.ownerKind ?? "owner"} ${symbol.ownerName}\``);
  }
  if (effectiveReturnType) {
    lines.push(`Returns: \`${effectiveReturnType}\``);
  } else if (symbol.valueType) {
    lines.push(`Type: \`${symbol.valueType}\``);
  }
  lines.push(`Detail: \`${symbol.detail}\``);
  lines.push(`Defined in: \`${toWorkspaceDisplayPath(workspaceRoot, symbol.filePath)}:${symbol.line}\``);
  if (preferredContext) {
    lines.push(`Context: \`${preferredContext.label}\` | Profiles: \`${preferredContext.profileHints.join(", ")}\``);
  }
  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: lines.join("\n\n")
    }
  };
}

function getPathCompletionContext(document: TextDocument, position: Position): PathCompletionContext | undefined {
  const lineText = getLineText(document, position.line);
  const includePattern = /^\s*#include\s+([<"])([^>"\n]*)([>"])?/gm;
  for (const match of lineText.matchAll(includePattern)) {
    const rawPath = match[2];
    const start = (match.index ?? 0) + match[0].indexOf(rawPath);
    const end = start + rawPath.length;
    if (position.character < start || position.character > end + 1) {
      continue;
    }

    return {
      kind: "include",
      rawPath,
      typedPath: rawPath.slice(0, Math.max(0, position.character - start)),
      replaceStart: start,
      replaceEnd: end
    };
  }

  const callPattern = /\b(loadFile|importClient|importCommon|preprocessFile(?:LineNumbers)?)\s*\(\s*"([^"\n]*)(?:")?/g;
  const kindMap: Record<string, PathContextKind> = {
    loadFile: "loadFile",
    importClient: "importClient",
    importCommon: "importCommon",
    preprocessFile: "preprocess",
    preprocessFileLineNumbers: "preprocess"
  };

  for (const match of lineText.matchAll(callPattern)) {
    const rawPath = match[2];
    const start = (match.index ?? 0) + match[0].indexOf(rawPath);
    const end = start + rawPath.length;
    if (position.character < start || position.character > end + 1) {
      continue;
    }

    return {
      kind: kindMap[match[1]],
      rawPath,
      typedPath: rawPath.slice(0, Math.max(0, position.character - start)),
      replaceStart: start,
      replaceEnd: end
    };
  }

  const reference = getPathReferenceAtPosition(document, position);
  if (reference) {
    return {
      kind: reference.kind,
      rawPath: reference.rawPath,
      typedPath: reference.rawPath,
      replaceStart: reference.start,
      replaceEnd: reference.end
    };
  }

  return undefined;
}

function getPathReferenceAtPosition(document: TextDocument, position: Position): ResolvedPathReference | undefined {
  const lineText = getLineText(document, position.line);
  const references: ResolvedPathReference[] = [];

  const includePattern = /^\s*#include\s+([<"])([^>"\n]+)([>"])?/gm;
  for (const match of lineText.matchAll(includePattern)) {
    const rawPath = match[2];
    const start = (match.index ?? 0) + match[0].indexOf(rawPath);
    references.push({ kind: "include", rawPath, start, end: start + rawPath.length });
  }

  const callPattern = /\b(loadFile|importClient|importCommon|preprocessFile(?:LineNumbers)?)\s*\(\s*"([^"\n]+)"/g;
  const kindMap: Record<string, PathContextKind> = {
    loadFile: "loadFile",
    importClient: "importClient",
    importCommon: "importCommon",
    preprocessFile: "preprocess",
    preprocessFileLineNumbers: "preprocess"
  };
  for (const match of lineText.matchAll(callPattern)) {
    const rawPath = match[2];
    const start = (match.index ?? 0) + match[0].indexOf(rawPath);
    references.push({ kind: kindMap[match[1]], rawPath, start, end: start + rawPath.length });
  }

  return references.find((reference) => position.character >= reference.start && position.character <= reference.end);
}

function getWorkspaceForDocument(document: TextDocument): WorkspaceFolderInfo | undefined {
  const documentPath = normalizeFsPath(toFsPath(document.uri));
  return workspaceFolders.find((folder) => documentPath.startsWith(normalizeFsPath(folder.path)));
}

function getWorkspaceForPath(filePath: string): WorkspaceFolderInfo | undefined {
  const normalizedPath = normalizeFsPath(filePath);
  return workspaceFolders.find((folder) => normalizedPath.startsWith(normalizeFsPath(folder.path)));
}

function getWorkspaceProject(workspace: WorkspaceFolderInfo | undefined): WorkspaceProject | undefined {
  if (!workspace) {
    return undefined;
  }

  const key = normalizeFsPath(workspace.path);
  let project = projectByWorkspace.get(key);
  if (!project) {
    project = buildWorkspaceProject(workspace);
    projectByWorkspace.set(key, project);
  }
  return project;
}

function getWorkspaceSymbolIndex(workspace: WorkspaceFolderInfo | undefined): WorkspaceSymbolIndex | undefined {
  if (!workspace) {
    return undefined;
  }

  const key = normalizeFsPath(workspace.path);
  let index = symbolIndexByWorkspace.get(key);
  if (!index) {
    const project = getWorkspaceProject(workspace);
    if (!project) {
      return undefined;
    }
    const startedAt = Date.now();
    index = buildWorkspaceSymbolIndex(project);
    symbolIndexByWorkspace.set(key, index);
    connection.console.info(`Evaluator SQF workspace index ready: ${index.all.length} symbols from ${project.outgoing.size} files in ${Date.now() - startedAt} ms`);
  }
  return index;
}

function getCachedWorkspaceSymbolIndex(workspace: WorkspaceFolderInfo | undefined): WorkspaceSymbolIndex | undefined {
  if (!workspace) {
    return undefined;
  }
  return symbolIndexByWorkspace.get(normalizeFsPath(workspace.path));
}

function startWorkspaceSymbolIndexWarmup(workspace: WorkspaceFolderInfo | undefined): void {
  if (!workspace) {
    return;
  }

  const key = normalizeFsPath(workspace.path);
  if (symbolIndexByWorkspace.has(key) || symbolIndexWarmupByWorkspace.has(key)) {
    return;
  }

  symbolIndexWarmupByWorkspace.add(key);
  setTimeout(() => {
    try {
      getWorkspaceSymbolIndex(workspace);
    } catch (error) {
      connection.console.error(`Evaluator SQF workspace index warmup failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      symbolIndexWarmupByWorkspace.delete(key);
    }
  }, WORKSPACE_SYMBOL_INDEX_WARMUP_DELAY_MS);
}

function resolvePathTarget(project: WorkspaceProject, documentPath: string, kind: PathContextKind, rawPath: string): string | undefined {
  const normalizedPath = rawPath.replace(/\//g, "\\").trim();
  if (!normalizedPath) {
    return undefined;
  }

  if (/^[A-Za-z]:\\/.test(normalizedPath)) {
    return path.normalize(normalizedPath);
  }

  if (/^src[\\/]/i.test(normalizedPath)) {
    return path.normalize(path.join(project.workspaceRoot, normalizedPath));
  }

  if (kind === "importCommon") {
    return path.normalize(path.join(project.sourceRoot, "host", "CommonComponents", normalizedPath));
  }

  return path.normalize(path.join(path.dirname(documentPath), normalizedPath));
}

function buildPathCompletionItems(
  document: TextDocument,
  position: Position,
  context: PathCompletionContext,
  project: WorkspaceProject
): CompletionItem[] {
  const typedPath = context.typedPath.replace(/\//g, "\\");
  const lastSlash = Math.max(typedPath.lastIndexOf("\\"), typedPath.lastIndexOf("/"));
  const directoryPrefix = lastSlash >= 0 ? typedPath.slice(0, lastSlash + 1) : "";
  const filePrefix = lastSlash >= 0 ? typedPath.slice(lastSlash + 1) : typedPath;
  const documentPath = toFsPath(document.uri);
  const browseRoot = resolvePathTarget(project, documentPath, context.kind, directoryPrefix || ".");
  if (!browseRoot || !existsSync(browseRoot) || !statSync(browseRoot).isDirectory()) {
    return [];
  }

  const replacementRange = {
    start: { line: position.line, character: context.replaceStart },
    end: { line: position.line, character: context.replaceEnd }
  };

  const entries = readdirSync(browseRoot, { withFileTypes: true })
    .filter((entry) => entry.name.toLowerCase().startsWith(filePrefix.toLowerCase()))
    .sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) {
        return left.isDirectory() ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });

  return entries.map((entry) => {
    const suffix = entry.isDirectory() ? "\\" : "";
    const replacement = `${directoryPrefix}${entry.name}${suffix}`;
    return {
      label: `${entry.name}${suffix}`,
      kind: entry.isDirectory() ? CompletionItemKind.Folder : CompletionItemKind.File,
      textEdit: TextEdit.replace(replacementRange, replacement),
      detail: entry.isDirectory() ? "Directory" : "File"
    } satisfies CompletionItem;
  });
}

function scheduleWorkspaceIndexRefinement(workspace: WorkspaceFolderInfo): void {
  const workspaceKey = normalizeFsPath(workspace.path);
  const existing = symbolIndexRefinementTimerByWorkspace.get(workspaceKey);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(() => {
    symbolIndexRefinementTimerByWorkspace.delete(workspaceKey);
    const project = getWorkspaceProject(workspace);
    const previousIndex = symbolIndexByWorkspace.get(workspaceKey);
    if (!project || !previousIndex) {
      return;
    }

    const startedAt = Date.now();
    const nextIndex = buildWorkspaceSymbolIndex(project, previousIndex, []);
    symbolIndexByWorkspace.set(workspaceKey, nextIndex);
    connection.console.info(`Evaluator SQF workspace index refined: ${nextIndex.all.length} symbols in ${Date.now() - startedAt} ms`);
  }, WORKSPACE_SYMBOL_INDEX_REFINEMENT_DELAY_MS);
  symbolIndexRefinementTimerByWorkspace.set(workspaceKey, timer);
}

function updateWorkspaceProjectAndIndexByPath(filePath: string, text?: string, mode: "fast" | "refined" = "fast"): void {
  const workspace = getWorkspaceForPath(filePath);
  if (!workspace) {
    return;
  }

  const key = normalizeFsPath(workspace.path);
  const project = getWorkspaceProject(workspace);
  if (project) {
    updateWorkspaceProjectFile(project, filePath, text);
  }

  const previousIndex = symbolIndexByWorkspace.get(key);
  if (previousIndex && project) {
    const startedAt = Date.now();
    const nextIndex = mode === "fast"
      ? updateWorkspaceSymbolIndexFileFast(project, previousIndex, filePath, text)
      : buildWorkspaceSymbolIndex(
          project,
          previousIndex,
          [filePath],
          text === undefined ? undefined : new Map([[filePath, text]])
        );
    symbolIndexByWorkspace.set(key, nextIndex);
    connection.console.info(`Evaluator SQF workspace index ${mode === "fast" ? "patched" : "updated"}: ${toWorkspaceDisplayPath(project.workspaceRoot, filePath)} in ${Date.now() - startedAt} ms`);
    if (mode === "fast") {
      scheduleWorkspaceIndexRefinement(workspace);
    }
  } else {
    startWorkspaceSymbolIndexWarmup(workspace);
  }
  preprocessCacheByKey.clear();
  preprocessCacheByUri.clear();
}

function scheduleWorkspaceIndexUpdateForDocument(document: TextDocument): void {
  const filePath = toFsPath(document.uri);
  const workspace = getWorkspaceForDocument(document);
  if (!workspace) {
    return;
  }

  const workspaceKey = normalizeFsPath(workspace.path);
  if (!symbolIndexByWorkspace.has(workspaceKey)) {
    startWorkspaceSymbolIndexWarmup(workspace);
    return;
  }

  const existing = symbolIndexUpdateTimerByUri.get(document.uri);
  if (existing) {
    clearTimeout(existing);
  }
  const timer = setTimeout(() => {
    symbolIndexUpdateTimerByUri.delete(document.uri);
    const current = documents.get(document.uri);
    if (!current) {
      return;
    }
    updateWorkspaceProjectAndIndexByPath(filePath, current.getText());
  }, WORKSPACE_SYMBOL_INDEX_UPDATE_DEBOUNCE_MS);
  symbolIndexUpdateTimerByUri.set(document.uri, timer);
}

function getResolvedContextsForDocument(document: TextDocument): ResolvedContextsResult | undefined {
  const workspace = getWorkspaceForDocument(document);
  const project = getWorkspaceProject(workspace);
  if (!project) {
    return undefined;
  }

  return resolveContexts(project, toFsPath(document.uri));
}

function getPreferredResolvedContext(document: TextDocument): ResolvedContext | undefined {
  const resolved = getResolvedContextsForDocument(document);
  return resolved?.contexts.find((context) => context.preferred);
}

function shouldBuildWorkspaceSymbolIndex(project: WorkspaceProject | undefined): project is WorkspaceProject {
  return Boolean(
    project
    && project.workspaceKind !== "resdk"
    && project.outgoing.size <= WORKSPACE_SYMBOL_INDEX_FILE_LIMIT
  );
}

function getWorkspaceSymbolIndexIfCheap(
  workspace: WorkspaceFolderInfo | undefined,
  project: WorkspaceProject | undefined
): WorkspaceSymbolIndex | undefined {
  const cached = getCachedWorkspaceSymbolIndex(workspace);
  if (cached) {
    return cached;
  }

  if (!shouldBuildWorkspaceSymbolIndex(project)) {
    startWorkspaceSymbolIndexWarmup(workspace);
    return undefined;
  }

  return getWorkspaceSymbolIndex(workspace);
}

function findEvaluatorExecutable(workspacePath: string): string {
  const candidates = [
    path.join(workspacePath, "build", "x64", "Debug", "evaluator.exe"),
    path.join(workspacePath, "build", "x64", "Release", "evaluator.exe"),
    path.join(workspacePath, "build", "Debug", "evaluator.exe"),
    path.join(workspacePath, "build", "Release", "evaluator.exe")
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return "";
}

async function getSettings(document: TextDocument): Promise<RuntimeSettings> {
  const workspace = getWorkspaceForDocument(document);
  const workspaceKey = workspace?.path ?? "<single-file>";

  if (!hasConfigurationCapability) {
    return mergeSettings(defaultSettings, {}, workspace);
  }

  let cached = settingsByWorkspace.get(workspaceKey);
  if (!cached) {
    cached = connection.workspace.getConfiguration({
      scopeUri: document.uri,
      section: "evaluatorSqf"
    }) as Thenable<Partial<RuntimeSettings>>;
    settingsByWorkspace.set(workspaceKey, cached);
  }

  const configured = (await cached) ?? {};
  return mergeSettings(defaultSettings, configured, workspace);
}

function mergeSettings(base: RuntimeSettings, configured: Partial<RuntimeSettings>, workspace: WorkspaceFolderInfo | undefined): RuntimeSettings {
  const merged: RuntimeSettings = {
    ...base,
    ...configured
  };

  const project = getWorkspaceProject(workspace);
  const workspacePath = workspace?.path ?? "";
  merged.evaluatorPath = merged.evaluatorPath
    || (bundledEvaluatorPath && existsSync(bundledEvaluatorPath) ? bundledEvaluatorPath : "")
    || (workspacePath ? findEvaluatorExecutable(workspacePath) : "");
  merged.rootPath = merged.rootPath || project?.workspaceRoot || workspacePath;
  merged.maxSteps = Math.max(1, Number(merged.maxSteps) || base.maxSteps);
  merged.diagnosticsTimeoutMs = Math.max(1000, Number(merged.diagnosticsTimeoutMs) || base.diagnosticsTimeoutMs);
  return merged;
}

function shouldValidate(document: TextDocument): boolean {
  return document.languageId === "sqf" && document.uri.startsWith("file:");
}

type CheckJsonDiagnostic = {
  stage?: string;
  severity?: string;
  code?: number;
  message?: string;
  file?: string;
  line?: number;
  column?: number;
};

type CheckJsonResult = {
  ok?: boolean;
  entry?: string;
  resolvedEntry?: string;
  target?: string;
  resolvedTarget?: string;
  workspaceRoot?: string;
  profile?: string;
  diagnostics?: CheckJsonDiagnostic[];
  capturedLog?: string;
};

type PreprocessJsonMacro = {
  name?: string;
  value?: string;
  hasParams?: boolean;
};

type PreprocessJsonTraceEvent = {
  kind?: string;
  file?: string;
  depth?: number;
};

type PreprocessJsonResult = {
  ok?: boolean;
  entry?: string;
  resolvedEntry?: string;
  target?: string;
  resolvedTarget?: string;
  preprocessedFile?: string;
  workspaceRoot?: string;
  profile?: string;
  targetContextCaptured?: boolean;
  preprocessedText?: string;
  activeDefines?: string[];
  macros?: PreprocessJsonMacro[];
  resolvedFiles?: string[];
  includeTrace?: PreprocessJsonTraceEvent[];
  diagnostics?: CheckJsonDiagnostic[];
  capturedLog?: string;
};

async function runEvaluatorCommand(
  evaluatorPath: string,
  args: string[],
  cwd: string,
  timeoutMs = 30000
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve) => {
    const child = spawn(evaluatorPath, args, {
      cwd,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: { stdout: string; stderr: string; exitCode: number | null }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      stderr += `evaluator timed out after ${timeoutMs}ms`;
      try {
        child.kill();
      } catch {
        // Ignore process shutdown races.
      }
      finish({ stdout, stderr, exitCode: -2 });
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      stderr += error.message;
      finish({ stdout, stderr, exitCode: -1 });
    });
    child.on("close", (exitCode) => {
      finish({ stdout, stderr, exitCode });
    });
  });
}

function parseCheckJsonResult(stdout: string): CheckJsonResult | undefined {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed) as CheckJsonResult;
  } catch {
    return undefined;
  }
}

function parsePreprocessJsonResult(stdout: string): PreprocessJsonResult | undefined {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed) as PreprocessJsonResult;
  } catch {
    return undefined;
  }
}

function getFallbackPreprocessorDefines(
  symbolIndex: WorkspaceSymbolIndex | undefined,
  project: WorkspaceProject | undefined,
  preferredContext: ResolvedContext | undefined
): Set<string> {
  const baseDefines = new Set<string>();
  if (symbolIndex && project) {
    for (const symbol of getVisibleMacroSymbols(symbolIndex, project, preferredContext)) {
      baseDefines.add(symbol.name);
    }
  }
  for (const profileHint of preferredContext?.profileHints ?? []) {
    baseDefines.add(profileHint);
  }
  return baseDefines;
}

function getCachedDocumentPreprocessResult(document: TextDocument): PreprocessJsonResult | null {
  return preprocessCacheByUri.get(document.uri) ?? null;
}

async function getDocumentPreprocessResult(document: TextDocument): Promise<PreprocessJsonResult | null> {
  const workspace = getWorkspaceForDocument(document);
  const preferredContext = getPreferredResolvedContext(document);
  const settings = await getSettings(document);
  if (!workspace || !preferredContext || !settings.evaluatorPath || !existsSync(settings.evaluatorPath)) {
    return null;
  }

  const filePath = toFsPath(document.uri);
  const cwd = workspace.path;
  const validationFile = preferredContext.validationEntryFile && existsSync(preferredContext.validationEntryFile)
    ? preferredContext.validationEntryFile
    : filePath;
  const effectiveRootPath = settings.rootPath || preferredContext.workspaceRoot || workspace.path || path.dirname(validationFile);
  const profileHint = preferredContext.profileHints?.[0] ?? "DEBUG";
  const cacheKey = [
    normalizeFsPath(validationFile),
    normalizeFsPath(filePath),
    normalizeFsPath(effectiveRootPath),
    profileHint
  ].join("::");
  if (preprocessCacheByKey.has(cacheKey)) {
    return preprocessCacheByKey.get(cacheKey) ?? null;
  }

  const preprocessArgs = [
    "--preprocess",
    "--entry", validationFile,
    "--target", filePath,
    "--workspace-root", effectiveRootPath,
    "--profile", profileHint,
    "--json"
  ];
  if (settings.serverMode) {
    preprocessArgs.push("--server");
  }
  if (settings.extensionsRoot) {
    preprocessArgs.push("--extensions-root", settings.extensionsRoot);
  }

  const preprocessResult = await runEvaluatorCommand(settings.evaluatorPath, preprocessArgs, cwd);
  const parsed = parsePreprocessJsonResult(preprocessResult.stdout);
  preprocessCacheByKey.set(cacheKey, parsed ?? null);
  if (parsed) {
    preprocessCacheByUri.set(document.uri, parsed);
  }
  return parsed ?? null;
}

function extractCapturedDiagnostic(capturedLog: string | undefined): { file?: string; line?: number } | undefined {
  if (!capturedLog) {
    return undefined;
  }

  let captured: { file?: string; line?: number } | undefined;
  for (const rawLine of capturedLog.split(/\r?\n/)) {
    const line = rawLine.trim();
    const fileLineMatch = /^File\s+(.+),\s+line\s+(\d+)/.exec(line);
    if (fileLineMatch) {
      captured = {
        file: fileLineMatch[1],
        line: Number.parseInt(fileLineMatch[2], 10)
      };
      continue;
    }

    const preprocessMatch = /^Preprocessor failed on file\s+(.+?)\s+-\s+error\s+\d+\s+\(source\s+(.+?),\s+line\s+(\d+)\)/.exec(line);
    if (preprocessMatch) {
      const failedFile = preprocessMatch[1];
      const sourceFile = preprocessMatch[2];
      const sourceLine = Number.parseInt(preprocessMatch[3], 10);
      if (sourceLine > 0) {
        captured = {
          file: path.isAbsolute(sourceFile) ? sourceFile : path.join(path.dirname(failedFile), sourceFile),
          line: sourceLine
        };
      } else {
        captured = {
          file: failedFile,
          line: 1
        };
      }
    }
  }

  return captured;
}

function convertCheckDiagnostics(
  document: TextDocument,
  result: CheckJsonResult,
  contextLabel: string,
  validationFile: string
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const documentPath = normalizeFsPath(toFsPath(document.uri));
  const jsonDiagnostics = result.diagnostics ?? [];
  const capturedDiagnostic = extractCapturedDiagnostic(result.capturedLog);

  for (const entry of jsonDiagnostics) {
    const rawDiagnosticFile = entry.file ? normalizeFsPath(entry.file) : documentPath;
    const capturedFile = capturedDiagnostic?.file ? normalizeFsPath(capturedDiagnostic.file) : undefined;
    const useCapturedLocation = !!capturedFile
      && !!capturedDiagnostic?.line
      && capturedDiagnostic.line > 0
      && (entry.line ?? 1) <= 1;
    const diagnosticFile = useCapturedLocation ? capturedFile : rawDiagnosticFile;
    if (diagnosticFile !== documentPath) {
      continue;
    }

    const effectiveLine = useCapturedLocation ? capturedDiagnostic.line : entry.line;
    const lineNumber = Math.max(0, (effectiveLine ?? 1) - 1);
    const columnNumber = Math.max(0, entry.column ?? 0);
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      source: `evaluator (${contextLabel})`,
      code: entry.code,
      message: entry.message || "Check failed",
      range: {
        start: { line: lineNumber, character: columnNumber },
        end: { line: lineNumber, character: 1000 }
      }
    });
  }

  if (diagnostics.length > 0) {
    return diagnostics;
  }

  const capturedFallbackFile = capturedDiagnostic?.file ? normalizeFsPath(capturedDiagnostic.file) : undefined;
  if (result.ok === false && normalizeFsPath(validationFile) === documentPath && (!capturedFallbackFile || capturedFallbackFile === documentPath)) {
    const fallback = jsonDiagnostics[0];
    const fallbackLine = capturedDiagnostic?.line && capturedDiagnostic.line > 0 && (fallback?.line ?? 1) <= 1
      ? capturedDiagnostic.line
      : fallback?.line;
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      source: `evaluator (${contextLabel})`,
      code: fallback?.code,
      message: fallback?.message || result.capturedLog || "Check failed",
      range: {
        start: { line: Math.max(0, (fallbackLine ?? 1) - 1), character: Math.max(0, fallback?.column ?? 0) },
        end: { line: Math.max(0, (fallbackLine ?? 1) - 1), character: 1000 }
      }
    });
  }

  return diagnostics;
}

function parseDiagnostics(
  document: TextDocument,
  stdout: string,
  stderr: string,
  exitCode: number | null,
  contextLabel: string
): Diagnostic[] {
  const lines = stdout.split(/\r?\n/);
  const diagnostics: Diagnostic[] = [];
  let lastErrorMessage = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    if (trimmed.startsWith("Error ") && !trimmed.startsWith("Error in expression") && !trimmed.startsWith("Error position:")) {
      lastErrorMessage = trimmed.slice("Error ".length).trim();
      continue;
    }

    const fileMatch = trimmed.match(/^File\s+(.+),\s+line\s+(\d+)$/i);
    if (!fileMatch) {
      continue;
    }

    const filePath = normalizeFsPath(fileMatch[1]);
    const documentPath = normalizeFsPath(toFsPath(document.uri));
    if (filePath !== documentPath) {
      continue;
    }

    const lineNumber = Math.max(0, Number(fileMatch[2]) - 1);
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      source: `evaluator (${contextLabel})`,
      message: lastErrorMessage || `evaluator failed with exit code ${exitCode ?? -1}`,
      range: {
        start: { line: lineNumber, character: 0 },
        end: { line: lineNumber, character: 1000 }
      }
    });
  }

  if (diagnostics.length > 0 || !stdout.trim() && !stderr.trim()) {
    return diagnostics;
  }

  if ((exitCode ?? 0) !== 0) {
    const fallbackLine = lines.map((line) => line.trim()).filter(Boolean).at(-1) || stderr.trim() || `evaluator failed with exit code ${exitCode ?? -1}`;
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      source: `evaluator (${contextLabel})`,
      message: fallbackLine,
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1000 }
      }
    });
  }

  return diagnostics;
}

function mergePrimaryAndLatentDiagnostics(primary: Diagnostic[], latent: Diagnostic[]): Diagnostic[] {
  if (primary.length > 0) {
    return primary;
  }
  return latent;
}

function nextValidationGeneration(uri: string): number {
  const next = (validationGenerationByUri.get(uri) ?? 0) + 1;
  validationGenerationByUri.set(uri, next);
  return next;
}

function sendDiagnosticsIfCurrent(uri: string, generation: number, diagnostics: Diagnostic[]): void {
  if (validationGenerationByUri.get(uri) !== generation) {
    return;
  }
  connection.sendDiagnostics({ uri, diagnostics });
}

async function validateTextDocument(document: TextDocument, generation = nextValidationGeneration(document.uri)): Promise<void> {
  if (!shouldValidate(document)) {
    return;
  }

  const settings = await getSettings(document);
  const workspace = getWorkspaceForDocument(document);
  const workspaceKey = workspace?.path ?? "<single-file>";
  const resolvedContexts = getResolvedContextsForDocument(document);
  const preferredContext = resolvedContexts?.contexts.find((context) => context.preferred);

  if (!settings.evaluatorPath || !existsSync(settings.evaluatorPath)) {
    if (!warnedExecutableWorkspaces.has(workspaceKey)) {
      warnedExecutableWorkspaces.add(workspaceKey);
      void connection.window.showWarningMessage(
        "Evaluator SQF: could not find evaluator.exe. Set evaluatorSqf.evaluatorPath or build the runtime in this workspace."
      );
    }
    sendDiagnosticsIfCurrent(document.uri, generation, analyzeLatentFaults(document));
    return;
  }

  const filePath = toFsPath(document.uri);
  const validationFile = preferredContext?.validationEntryFile && existsSync(preferredContext.validationEntryFile)
    ? preferredContext.validationEntryFile
    : filePath;
  const effectiveRootPath = settings.rootPath || preferredContext?.workspaceRoot || workspace?.path || path.dirname(validationFile);
  const cwd = effectiveRootPath || workspace?.path || path.dirname(validationFile);
  const contextLabel = preferredContext?.label ?? path.basename(validationFile);
  const profileHint = preferredContext?.profileHints?.[0] ?? "DEBUG";

  const checkArgs = ["--check", "--entry", validationFile, "--target", filePath, "--workspace-root", effectiveRootPath, "--profile", profileHint, "--json"];
  if (settings.serverMode) {
    checkArgs.push("--server");
  }
  if (settings.extensionsRoot) {
    checkArgs.push("--extensions-root", settings.extensionsRoot);
  }

  const checkResult = await runEvaluatorCommand(settings.evaluatorPath, checkArgs, cwd, settings.diagnosticsTimeoutMs);
  const checkJson = parseCheckJsonResult(checkResult.stdout);
  if (checkJson) {
    const primaryDiagnostics = convertCheckDiagnostics(document, checkJson, contextLabel, validationFile);
    if (checkJson.ok !== false) {
      void getDocumentPreprocessResult(document);
    }
    sendDiagnosticsIfCurrent(document.uri, generation, mergePrimaryAndLatentDiagnostics(primaryDiagnostics, analyzeLatentFaults(document)));
    return;
  }

  const fallbackArgs = ["--file", validationFile, "--max-steps", String(settings.maxSteps)];
  if (settings.serverMode) {
    fallbackArgs.push("--server");
  }
  if (effectiveRootPath) {
    fallbackArgs.push("--root", effectiveRootPath);
  }
  if (settings.extensionsRoot) {
    fallbackArgs.push("--extensions-root", settings.extensionsRoot);
  }

  const fallbackResult = await runEvaluatorCommand(settings.evaluatorPath, fallbackArgs, cwd, settings.diagnosticsTimeoutMs);
  const primaryDiagnostics = parseDiagnostics(
    document,
    fallbackResult.stdout,
    fallbackResult.stderr,
    fallbackResult.exitCode,
    contextLabel
  );
  if (primaryDiagnostics.length === 0) {
    void getDocumentPreprocessResult(document);
  }
  sendDiagnosticsIfCurrent(document.uri, generation, mergePrimaryAndLatentDiagnostics(primaryDiagnostics, analyzeLatentFaults(document)));
}

function queueValidateTextDocument(document: TextDocument): Promise<void> {
  const uri = document.uri;
  const generation = nextValidationGeneration(uri);
  const previous = validationQueueByUri.get(uri) ?? Promise.resolve();
  const queued = previous
    .catch(() => undefined)
    .then(async () => {
      const currentDocument = documents.get(uri);
      if (!currentDocument || validationGenerationByUri.get(uri) !== generation) {
        return;
      }
      await validateTextDocument(currentDocument, generation);
    })
    .catch((error) => {
      connection.console.error(`Evaluator SQF diagnostics failed: ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => {
      if (validationQueueByUri.get(uri) === queued) {
        validationQueueByUri.delete(uri);
      }
    });
  validationQueueByUri.set(uri, queued);
  return queued;
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
  hasConfigurationCapability = Boolean(params.capabilities.workspace?.configuration);
  bundledEvaluatorPath = typeof params.initializationOptions?.bundledEvaluatorPath === "string"
    ? params.initializationOptions.bundledEvaluatorPath
    : "";
  workspaceFolders = (params.workspaceFolders ?? []).map((folder) => ({
    name: folder.name,
    path: toFsPath(folder.uri)
  }));

  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: TextDocumentSyncKind.Incremental,
        save: true
      },
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: ["\\", "/", ".", "\"", "<"]
      },
      definitionProvider: true,
      referencesProvider: true,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      hoverProvider: true,
      signatureHelpProvider: {
        triggerCharacters: [" ", "(", "[", ","]
      }
    }
  };
});

connection.onInitialized(() => {
  if (hasConfigurationCapability) {
    void connection.client.register(DidChangeConfigurationNotification.type, undefined);
  }
  for (const workspace of workspaceFolders) {
    startWorkspaceSymbolIndexWarmup(workspace);
  }
});

connection.onRequest(GET_RESOLVED_CONTEXTS_REQUEST, (params: { uri: string }): ResolvedContextsResponse | null => {
  if (!params?.uri) {
    return null;
  }

  const document = documents.get(params.uri);
  if (document) {
    return getResolvedContextsForDocument(document) ?? null;
  }

  try {
    const filePath = toFsPath(params.uri);
    const workspace = getWorkspaceForPath(filePath);
    const project = getWorkspaceProject(workspace);
    return project ? resolveContexts(project, filePath) : null;
  } catch {
    return null;
  }
});

connection.onRequest(GET_INACTIVE_RANGES_REQUEST, (params: { uri: string }): InactiveRangesResponse | null => {
  if (!params?.uri) {
    return null;
  }

  const document = documents.get(params.uri);
  if (!document) {
    return null;
  }

  const workspace = getWorkspaceForDocument(document);
  const project = getWorkspaceProject(workspace);
  const preferredContext = getPreferredResolvedContext(document);
  if (!project) {
    return { ranges: [] };
  }

  const preprocessResult = getCachedDocumentPreprocessResult(document);
  const baseDefines = preprocessResult?.activeDefines?.length
    ? new Set(preprocessResult.activeDefines)
    : getFallbackPreprocessorDefines(undefined, project, preferredContext);
  const ranges = computeInactiveRanges(document.getText(), baseDefines);
  return { ranges };
});

connection.onDocumentSymbol((params: DocumentSymbolParams): SymbolInformation[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }

  const workspace = getWorkspaceForDocument(document);
  const project = getWorkspaceProject(workspace);
  const workspaceRoot = project?.workspaceRoot ?? workspace?.path;
  return getDocumentSymbols(document).map((symbol) => toSymbolInformation(symbol, workspaceRoot));
});

connection.onWorkspaceSymbol((params: WorkspaceSymbolParams): SymbolInformation[] => {
  const query = params.query.trim().toLowerCase();
  const result: SymbolInformation[] = [];
  const maxResults = 250;

  for (const workspace of workspaceFolders) {
    const index = getWorkspaceSymbolIndex(workspace);
    const project = getWorkspaceProject(workspace);
    if (!index || !project) {
      continue;
    }

    const matches = index.all
      .filter((symbol) => !query || symbol.name.toLowerCase().includes(query))
      .sort((left, right) => left.name.localeCompare(right.name) || left.filePath.localeCompare(right.filePath) || left.line - right.line);
    for (const symbol of matches) {
      result.push(toSymbolInformation(symbol, project.workspaceRoot));
      if (result.length >= maxResults) {
        return result;
      }
    }
  }

  return result;
});

connection.onDidChangeConfiguration(async () => {
  settingsByWorkspace.clear();
  projectByWorkspace.clear();
  symbolIndexByWorkspace.clear();
  symbolIndexWarmupByWorkspace.clear();
  for (const timer of symbolIndexUpdateTimerByUri.values()) {
    clearTimeout(timer);
  }
  symbolIndexUpdateTimerByUri.clear();
  for (const timer of symbolIndexRefinementTimerByWorkspace.values()) {
    clearTimeout(timer);
  }
  symbolIndexRefinementTimerByWorkspace.clear();
  preprocessCacheByKey.clear();
  preprocessCacheByUri.clear();
  await Promise.all(documents.all()
    .filter((document) => shouldValidate(document))
    .map((document) => queueValidateTextDocument(document)));
});

connection.onDidChangeWatchedFiles((params: DidChangeWatchedFilesParams) => {
  for (const change of params.changes) {
    try {
      const filePath = toFsPath(change.uri);
      if (/\.(sqf|hpp|h|inc|interface)$/i.test(filePath)) {
        updateWorkspaceProjectAndIndexByPath(filePath);
      }
    } catch {
      // Ignore non-file URIs.
    }
  }
});

connection.onCompletion((params: CompletionParams) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return completionItems;
  }

  const pathContext = getPathCompletionContext(document, params.position);
  if (!pathContext) {
    const completionPrefix = getCommandCandidate(document, params.position) ?? "";
    const workspace = getWorkspaceForDocument(document);
    const project = getWorkspaceProject(workspace);
    const symbolIndex = getWorkspaceSymbolIndexIfCheap(workspace, project);
    const preferredContext = symbolIndex ? getPreferredResolvedContext(document) : undefined;
    const localItems = completionPrefix.startsWith("_") ? getLocalCompletionItems(document, params.position, symbolIndex) : [];
    return symbolIndex && project
      ? [...localItems, ...getVisibleCompletionItems(symbolIndex, project, preferredContext), ...completionItems]
      : [...localItems, ...completionItems];
  }

  const workspace = getWorkspaceForDocument(document);
  const project = getWorkspaceProject(workspace);
  if (!project) {
    return [];
  }

  return buildPathCompletionItems(document, params.position, pathContext, project);
});

connection.onDefinition((params): Definition | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }

  const reference = getPathReferenceAtPosition(document, params.position);
  if (!reference) {
    const token = getWordAtPosition(document, params.position);
    if (!token) {
      return null;
    }
    const workspace = getWorkspaceForDocument(document);
    const project = getWorkspaceProject(workspace);
    const symbolIndex = getWorkspaceSymbolIndexIfCheap(workspace, project);
    const preferredContext = symbolIndex ? getPreferredResolvedContext(document) : undefined;
    if (!symbolIndex || !project) {
      return null;
    }
    const localMatch = getLocalDefinitionMatch(document, params.position, token, symbolIndex);
    if (localMatch) {
      return buildLocalLocation(document, localMatch.localSymbol.definitionStart, localMatch.localSymbol.definitionEnd);
    }
    if (shouldSuppressProjectLookupForLocalCandidate(document, params.position, token, symbolIndex)) {
      return null;
    }
    const memberReference = getReSdkMemberReferenceAtPosition(symbolIndex, document, params.position);
    if (memberReference) {
      const memberSymbol = resolveReSdkMemberReference(symbolIndex, document, params.position, memberReference);
      return memberSymbol
        ? Location.create(pathToFileURL(memberSymbol.filePath).toString(), {
          start: { line: Math.max(0, memberSymbol.line - 1), character: 0 },
          end: { line: Math.max(0, memberSymbol.line - 1), character: 0 }
        })
        : null;
    }
    const locations = getDefinitionLocations(symbolIndex, project, preferredContext, token);
    return locations.length > 0 ? locations : null;
  }

  const workspace = getWorkspaceForDocument(document);
  const project = getWorkspaceProject(workspace);
  if (!project) {
    return null;
  }

  const resolvedTarget = resolvePathTarget(project, toFsPath(document.uri), reference.kind, reference.rawPath);
  if (!resolvedTarget || !existsSync(resolvedTarget) || !statSync(resolvedTarget).isFile()) {
    return null;
  }

  return Location.create(pathToFileURL(resolvedTarget).toString(), {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 }
  });
});

connection.onReferences((params: ReferenceParams): Location[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }

  const token = getWordAtPosition(document, params.position);
  if (!token) {
    return [];
  }

  const workspace = getWorkspaceForDocument(document);
  const project = getWorkspaceProject(workspace);
  const symbolIndex = getWorkspaceSymbolIndexIfCheap(workspace, project);
  const preferredContext = symbolIndex ? getPreferredResolvedContext(document) : undefined;
  if (!project || !symbolIndex) {
    return [];
  }

  const localLocations = getLocalReferenceLocations(document, params.position, token, params.context.includeDeclaration, symbolIndex);
  if (localLocations.length > 0) {
    return localLocations;
  }
  if (shouldSuppressProjectLookupForLocalCandidate(document, params.position, token, symbolIndex)) {
    return [];
  }

  return getReferenceLocations(symbolIndex, project, preferredContext, token, params.context.includeDeclaration);
});

connection.onHover(async (params): Promise<Hover | null> => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }

  const candidate = getCommandCandidate(document, params.position);
  if (!candidate) {
    return null;
  }

  const workspace = getWorkspaceForDocument(document);
  const project = getWorkspaceProject(workspace);
  const symbolIndex = getWorkspaceSymbolIndexIfCheap(workspace, project);
  const preferredContext = symbolIndex ? getPreferredResolvedContext(document) : undefined;

  const localMatch = getLocalSymbolMatch(document, params.position, candidate, symbolIndex);
  if (localMatch) {
    const flowOwner = project && symbolIndex
      ? inferLocalOwnerFromFlow(symbolIndex, document, params.position, localMatch.functionSymbol, localMatch.localSymbol, new Set<string>())
      : undefined;
    const localType = flowOwner
      ? `${flowOwner.kind}:${flowOwner.name}`
      : formatLocalSymbolTypeAtPosition(symbolIndex, localMatch.functionSymbol, localMatch.localSymbol, document.offsetAt(params.position));
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: [
          `### ${localMatch.localSymbol.name}: ${localType}`,
          `Kind: \`local variable\``,
          `Source: \`${localMatch.localSymbol.source}\``,
          `Function: \`${formatFunctionSignature(localMatch.functionSymbol)}\``
        ].join("\n\n")
      }
    };
  }

  if (project && symbolIndex) {
    const memberReference = getReSdkMemberReferenceAtPosition(symbolIndex, document, params.position);
    if (memberReference) {
      const memberSymbol = resolveReSdkMemberReference(symbolIndex, document, params.position, memberReference);
      return memberSymbol ? buildTypedMemberHover(document, project, preferredContext, memberSymbol) : null;
    }
  }

  if (project && symbolIndex) {
    if (!shouldSuppressProjectLookupForLocalCandidate(document, params.position, candidate, symbolIndex)) {
      const indexedHover = buildIndexedHover(document, params.position, project, symbolIndex, preferredContext, candidate, null);
      if (indexedHover) {
        return indexedHover;
      }
    }
  }

  const documentSymbolHover = buildDocumentSymbolHover(document, params.position, candidate);
  if (documentSymbolHover) {
    return documentSymbolHover;
  }

  const overloads = commandsByName.get(candidate.toLowerCase());
  if (overloads) {
    return buildHover(overloads);
  }

  return null;
});

connection.onSignatureHelp((params): SignatureHelp | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }

  const projectCall = getProjectFunctionCallContext(document, params.position);
  if (projectCall) {
    const projectMatches = getDocumentSymbols(document)
      .filter((symbol) => symbol.kind === "globalFunction");
    if (projectMatches.length > 0) {
      const primary = projectMatches.find((symbol) => symbol.name.toLowerCase() === projectCall.name.toLowerCase());
      if (primary) {
        return {
          signatures: [SignatureInformation.create(
            formatFunctionSignature(primary),
            primary.signatureSource ? `Project function (${primary.signatureSource})` : "Project function"
          )],
          activeSignature: 0,
          activeParameter: projectCall.activeParameter
        };
      }
    }
  }

  const commandCall = getRuntimeCommandCallContext(document, params.position);
  if (!commandCall) {
    return null;
  }

  const overloads = commandsByName.get(commandCall.name.toLowerCase());
  if (!overloads || overloads.length === 0) {
    return null;
  }

  const signatures = overloads.map((entry) => SignatureInformation.create(
    buildSignature(entry),
    entry.description || `Category: ${entry.category}`
  ));

  return {
    signatures,
    activeSignature: 0,
    activeParameter: commandCall.activeParameter
  };
});

documents.onDidOpen(async (change) => {
  const settings = await getSettings(change.document);
  if (settings.validateOnOpen) {
    await queueValidateTextDocument(change.document);
  }
});

documents.onDidChangeContent((change) => {
  preprocessCacheByUri.delete(change.document.uri);
  documentSymbolsByUri.delete(change.document.uri);
  scheduleWorkspaceIndexUpdateForDocument(change.document);
});

documents.onDidSave(async (change) => {
  documentSymbolsByUri.delete(change.document.uri);
  const pendingIndexUpdate = symbolIndexUpdateTimerByUri.get(change.document.uri);
  if (pendingIndexUpdate) {
    clearTimeout(pendingIndexUpdate);
    symbolIndexUpdateTimerByUri.delete(change.document.uri);
  }
  updateWorkspaceProjectAndIndexByPath(toFsPath(change.document.uri), change.document.getText());
  const settings = await getSettings(change.document);
  if (settings.validateOnSave) {
    await queueValidateTextDocument(change.document);
  }
});

documents.onDidClose((change) => {
  preprocessCacheByUri.delete(change.document.uri);
  documentSymbolsByUri.delete(change.document.uri);
  const pendingIndexUpdate = symbolIndexUpdateTimerByUri.get(change.document.uri);
  if (pendingIndexUpdate) {
    clearTimeout(pendingIndexUpdate);
    symbolIndexUpdateTimerByUri.delete(change.document.uri);
  }
  validationGenerationByUri.delete(change.document.uri);
  connection.sendDiagnostics({ uri: change.document.uri, diagnostics: [] });
});

documents.listen(connection);
connection.listen();
