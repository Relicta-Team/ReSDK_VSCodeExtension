import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  CompletionItem,
  CompletionItemKind,
  Location
} from "vscode-languageserver/node";

import { ResolvedContext, WorkspaceProject, collectReachableFiles, normalizeFsPath } from "./projectGraph";
import {
  SqfAstBlock,
  SqfAstExpression,
  SqfAstParameter,
  SqfAstStatement,
  parseSqfBlock
} from "./sqfAst";
import commandEntriesJson from "./generated/commands.json";

export type IndexedSymbolKind =
  | "macro"
  | "globalFunction"
  | "globalVariable"
  | "classType"
  | "structType"
  | "classMethod"
  | "classProperty"
  | "structMember";

export type ReSdkOwnerKind = "class" | "struct";

export type ReSdkOwnerRef = {
  name: string;
  kind: ReSdkOwnerKind;
};

export type FunctionParameter = {
  name: string;
  type?: string;
  typeSource?: "decl" | "default" | "inferred";
  optional?: boolean;
  defaultValue?: string;
};

export type LocalSymbolInfo = {
  name: string;
  type?: string;
  source: "param" | "assignment";
  definitionStart: number;
  definitionEnd: number;
  valueStart?: number;
  valueEnd?: number;
  scopeStart: number;
  scopeEnd: number;
};

export type LocalReferenceInfo = {
  name: string;
  start: number;
  end: number;
  definitionStart?: number;
  definitionEnd?: number;
  valueStart?: number;
  valueEnd?: number;
  isWrite: boolean;
};

export type IndexedSymbol = {
  name: string;
  kind: IndexedSymbolKind;
  filePath: string;
  line: number;
  detail: string;
  ownerName?: string;
  ownerKind?: ReSdkOwnerKind;
  baseName?: string;
  valueType?: string;
  memberMacro?: string;
  macroParameters?: string[];
  macroBody?: string;
  functionParameters?: FunctionParameter[];
  functionReturnType?: string;
  signatureLabel?: string;
  signatureSource?: "decl" | "params" | "inferred";
  functionAst?: SqfAstBlock;
  bodyStartOffset?: number;
  bodyEndOffset?: number;
  localSymbols?: LocalSymbolInfo[];
  localReferences?: LocalReferenceInfo[];
};

export type ReSdkTypeInfo = {
  name: string;
  kind: ReSdkOwnerKind;
  baseName?: string;
  symbol?: IndexedSymbol;
  methodsByLowerName: Map<string, IndexedSymbol[]>;
  propertiesByLowerName: Map<string, IndexedSymbol[]>;
  membersByLowerName: Map<string, IndexedSymbol[]>;
};

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

const commandEntries = commandEntriesJson as CommandEntry[];
const commandEntriesByName = new Map<string, CommandEntry[]>();
for (const entry of commandEntries) {
  const key = entry.name.toLowerCase();
  const entries = commandEntriesByName.get(key) ?? [];
  entries.push(entry);
  commandEntriesByName.set(key, entries);
}

export type WorkspaceSymbolIndex = {
  all: IndexedSymbol[];
  byLowerName: Map<string, IndexedSymbol[]>;
  typesByLowerName: Map<string, ReSdkTypeInfo>;
  rawFileSymbolsByPath: Map<string, IndexedSymbol[]>;
};

const DEEP_FUNCTION_ANALYSIS_BODY_LIMIT = 120_000;

const intrinsicGlobalFunctionReturnTypes = new Map<string, string>([
  ["atmos_debug_createsphere", "object"],
  ["creategameobjectinworld", "class:GameObject"],
  ["getgameobjectonposition", "class:GameObject[]"],
  ["model_getpitchbankyaw", "vector3"],
  ["model_getpitchbankyawaccurate", "vector3"],
  ["randomposition", "vector3"],
  ["randomradius", "vector3"]
]);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildLocation(filePath: string, line: number, character: number): Location {
  return Location.create(pathToFileURL(filePath).toString(), {
    start: { line: Math.max(0, line - 1), character },
    end: { line: Math.max(0, line - 1), character }
  });
}

function pushSymbol(target: IndexedSymbol[], item: IndexedSymbol): void {
  if (target.some((existing) => existing.kind === item.kind && existing.name === item.name && existing.filePath === item.filePath && existing.line === item.line)) {
    return;
  }
  target.push(item);
}

function splitTopLevel(input: string, separator: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let angleDepth = 0;
  let quote: string | undefined;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < input.length; ++index) {
    const current = input[index];
    const next = input[index + 1];

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
    else if (current === "<") angleDepth += 1;
    else if (current === ">") angleDepth = Math.max(0, angleDepth - 1);
    else if (
      current === separator
      && parenDepth === 0
      && bracketDepth === 0
      && braceDepth === 0
      && angleDepth === 0
    ) {
      parts.push(input.slice(start, index));
      start = index + 1;
    }
  }

  parts.push(input.slice(start));
  return parts;
}

function findMatchingBrace(text: string, openBraceIndex: number): number {
  let depth = 0;
  let quote: string | undefined;
  let lineComment = false;
  let blockComment = false;

  for (let index = openBraceIndex; index < text.length; ++index) {
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
    if (current === '"' || current === "'") {
      quote = current;
      continue;
    }

    if (current === "{") {
      depth += 1;
    } else if (current === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function isTopLevelOffset(text: string, targetOffset: number): boolean {
  let braceDepth = 0;
  let quote: string | undefined;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < targetOffset && index < text.length; ++index) {
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
    if (current === '"' || current === "'") {
      quote = current;
      continue;
    }

    if (current === "{") {
      braceDepth += 1;
    } else if (current === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
    }
  }

  return braceDepth === 0;
}

function computeTopLevelLineStarts(text: string, lineOffsets: number[]): boolean[] {
  const result = new Array<boolean>(lineOffsets.length).fill(false);
  let nextLineIndex = 0;
  let braceDepth = 0;
  let quote: string | undefined;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index <= text.length; ++index) {
    while (nextLineIndex < lineOffsets.length && index === lineOffsets[nextLineIndex]) {
      result[nextLineIndex] = braceDepth === 0;
      nextLineIndex += 1;
    }
    if (index >= text.length) {
      break;
    }

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
    if (current === '"' || current === "'") {
      quote = current;
      continue;
    }

    if (current === "{") {
      braceDepth += 1;
    } else if (current === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
    }
  }

  return result;
}

function lineNumberForOffset(lineOffsets: number[], offset: number): number {
  let low = 0;
  let high = lineOffsets.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lineOffsets[mid] <= offset) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return Math.max(1, high + 1);
}

function lineTextForOffset(lines: string[], lineOffsets: number[], offset: number): string {
  return lines[lineNumberForOffset(lineOffsets, offset) - 1] ?? "";
}

function hasTopLevelSemicolon(text: string): boolean {
  let parenDepth = 0;
  let bracketDepth = 0;
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
    else if (current === ";" && parenDepth === 0 && bracketDepth === 0) return true;
  }
  return false;
}

function findDeclNearLine(lines: string[], lineIndex: number): string | undefined {
  for (let index = lineIndex; index >= 0; --index) {
    const trimmed = lines[index].trim();
    if (!trimmed || trimmed.startsWith("//")) {
      continue;
    }

    const declMatch = /^(?:(?:extern|const)\s+)*decl\((.*)\)\s*$/.exec(trimmed);
    if (declMatch) {
      return declMatch[1].trim();
    }

    break;
  }

  return undefined;
}

function parseDeclSignature(declText: string | undefined): { returnType?: string; parameterTypes: string[] } {
  if (!declText) {
    return { parameterTypes: [] };
  }

  let parenIndex = -1;
  let angleDepth = 0;
  let bracketDepth = 0;
  for (let index = 0; index < declText.length; ++index) {
    const current = declText[index];
    if (current === "<") angleDepth += 1;
    else if (current === ">") angleDepth = Math.max(0, angleDepth - 1);
    else if (current === "[") bracketDepth += 1;
    else if (current === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (current === "(" && angleDepth === 0 && bracketDepth === 0) {
      parenIndex = index;
      break;
    }
  }

  if (parenIndex < 0 || !declText.endsWith(")")) {
    return {
      returnType: declText.trim() || undefined,
      parameterTypes: []
    };
  }

  const returnType = declText.slice(0, parenIndex).trim() || undefined;
  const parameterText = declText.slice(parenIndex + 1, -1).trim();
  return {
    returnType,
    parameterTypes: parameterText
      ? splitTopLevel(parameterText, ";").map((entry) => entry.trim()).filter(Boolean)
      : []
  };
}

function inferLiteralType(expression: string): string | undefined {
  const trimmed = expression.trim();
  if (!trimmed) {
    return undefined;
  }

  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return "string";
  }
  if (/^(true|false)$/i.test(trimmed)) {
    return "bool";
  }
  if (/^-?\d+$/.test(trimmed)) {
    return "int";
  }
  if (/^-?(?:\d+\.\d*|\d*\.\d+)$/.test(trimmed)) {
    return "float";
  }
  if (/^\[.*\]$/s.test(trimmed)) {
    return "any[]";
  }
  if (/^\{.*\}$/s.test(trimmed)) {
    return "code";
  }
  if (/^createHashMap\b/i.test(trimmed)) {
    return "map<any;any>";
  }
  if (/^vec3\s*\(/i.test(trimmed)) {
    return "vector3";
  }
  if (/^vec4\s*\(/i.test(trimmed)) {
    return "vector4";
  }
  if (/^vec2\s*\(/i.test(trimmed)) {
    return "any[]";
  }
  const classNewMatch = /^new\s*\(\s*([A-Za-z_][A-Za-z0-9_:]*)\s*\)$/i.exec(trimmed);
  if (classNewMatch) {
    return `class:${classNewMatch[1]}`;
  }
  const structNewMatch = /^struct_new\s*\(\s*([A-Za-z_][A-Za-z0-9_:]*)\s*\)$/i.exec(trimmed);
  if (structNewMatch) {
    return `struct:${structNewMatch[1]}`;
  }
  if (/^(objNull|nullPtr)\b/i.test(trimmed)) {
    return "object";
  }
  if (/(?:==|!=|>=|<=|>|<)/.test(trimmed) || /^!/.test(trimmed) || /\b(?:and|or|isNull|isNullVar|isEqualTo|in)\b/.test(trimmed)) {
    return "bool";
  }

  return undefined;
}

function stripOuterParens(expression: string): string {
  let trimmed = expression.trim();
  while (trimmed.startsWith("(") && trimmed.endsWith(")")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) {
      break;
    }

    let depth = 0;
    let balanced = true;
    for (let index = 0; index < trimmed.length; ++index) {
      const current = trimmed[index];
      if (current === "(") depth += 1;
      else if (current === ")") depth -= 1;

      if (depth === 0 && index < trimmed.length - 1) {
        balanced = false;
        break;
      }
    }
    if (!balanced || depth !== 0) {
      break;
    }

    trimmed = inner;
  }
  return trimmed;
}

function findTopLevelOperator(expression: string, operators: string[]): { left: string; operator: string; right: string } | undefined {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let angleDepth = 0;
  let quote: string | undefined;

  for (let index = 0; index < expression.length; ++index) {
    const current = expression[index];
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
    else if (current === "<") angleDepth += 1;
    else if (current === ">") angleDepth = Math.max(0, angleDepth - 1);

    if (parenDepth !== 0 || bracketDepth !== 0 || braceDepth !== 0 || angleDepth !== 0) {
      continue;
    }

    for (const operator of operators) {
      if (expression.slice(index, index + operator.length) !== operator) {
        continue;
      }

      const left = expression.slice(0, index).trim();
      const right = expression.slice(index + operator.length).trim();
      if (!left || !right) {
        continue;
      }
      return { left, operator, right };
    }
  }

  return undefined;
}

function mergeNumericTypes(leftType: string | undefined, rightType: string | undefined, operator: string): string | undefined {
  const numericTypes = new Set(["int", "float"]);
  if (!leftType || !rightType || !numericTypes.has(leftType) || !numericTypes.has(rightType)) {
    return undefined;
  }

  if (operator === "/" || leftType === "float" || rightType === "float") {
    return "float";
  }
  return "int";
}

function normalizeRuntimeType(type: string | undefined): string | undefined {
  if (!type) {
    return undefined;
  }
  const normalized = type.trim().toLowerCase();
  if (!normalized || normalized === "gameany") return undefined;
  if (normalized === "gamebool") return "bool";
  if (normalized === "gamescalar") return "float";
  if (normalized === "gamestring") return "string";
  if (normalized === "widget") return "widget";
  if (normalized === "display") return "display";
  if (normalized === "map") return "map<any;any>";
  if (normalized === "array") return "any[]";
  if (normalized === "gamearray") return "any[]";
  if (normalized === "gamehashmap") return "map<any;any>";
  if (normalized === "gamecode") return "code";
  if (normalized === "gamenothing") return "nil";
  if (normalized === "gameobjecttype") return "object";
  if (normalized === "gameconfig") return "config";
  if (normalized === "gamescript") return "thread_handle";
  if (normalized === "gamenamespace") return "namespace";
  if (normalized === "gamedisplaytype") return "display";
  if (normalized === "gamecontroltype") return "control";
  if (normalized === "gametext") return "string";
  return undefined;
}

function localTypeToRuntimeType(type: string | undefined): string | undefined {
  if (!type) {
    return undefined;
  }
  const normalized = type.trim().toLowerCase();
  if (normalized === "bool") return "GameBool";
  if (normalized === "int" || normalized === "float" || normalized === "number") return "GameScalar";
  if (normalized === "string") return "GameString";
  if (normalized === "code") return "GameCode";
  if (normalized === "config") return "GameConfig";
  if (normalized === "namespace") return "GameNamespace";
  if (normalized === "display") return "GameDisplayType";
  if (normalized === "control" || normalized === "widget") return "GameControlType";
  if (normalized === "thread_handle") return "GameScript";
  if (normalized === "object" || normalized === "null" || normalized.startsWith("class:") || normalized.startsWith("struct:")) return "GameObjectType";
  if (normalized.startsWith("map<")) return "GameHashMap";
  if (normalized.endsWith("[]") || normalized === "vector3" || normalized === "vector4") return "GameArray";
  return undefined;
}

function runtimeTypeMatches(expected: string | undefined, actual: string | undefined): boolean {
  if (!expected || expected === "GameAny" || !actual) {
    return true;
  }
  if (expected === actual) {
    return true;
  }
  return expected === "GameArray" && (actual === "GameArray" || actual === "GameHashMap");
}

function commandOperandScore(entry: CommandEntry, leftType: string | undefined, rightType: string | undefined): number {
  const expectedLeft = entry.leftType || undefined;
  const expectedRight = entry.rightType || undefined;
  const actualLeft = localTypeToRuntimeType(leftType);
  const actualRight = localTypeToRuntimeType(rightType);
  if (!runtimeTypeMatches(expectedLeft, actualLeft) || !runtimeTypeMatches(expectedRight, actualRight)) {
    return -1;
  }
  let score = 0;
  if (expectedLeft && actualLeft && expectedLeft === actualLeft) score += 2;
  else if (expectedLeft && actualLeft) score += 1;
  if (expectedRight && actualRight && expectedRight === actualRight) score += 2;
  else if (expectedRight && actualRight) score += 1;
  return score;
}

function inferRegisteredCommandReturnType(
  name: string,
  kind: CommandKind,
  leftType?: string,
  rightType?: string
): string | undefined {
  const syntheticReturnType = inferSyntheticCommandReturnType(name, kind, leftType, rightType);
  const entries = (commandEntriesByName.get(name.toLowerCase()) ?? []).filter((entry) => entry.kind === kind);
  if (entries.length === 0) {
    return syntheticReturnType;
  }

  const scored = entries
    .map((entry) => ({ entry, score: commandOperandScore(entry, leftType, rightType) }))
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => right.score - left.score);
  const bestScore = scored[0]?.score;
  const candidates = bestScore === undefined
    ? entries
    : scored.filter((entry) => entry.score === bestScore).map((entry) => entry.entry);
  const returnTypes = Array.from(new Set(candidates.map((entry) => normalizeRuntimeType(entry.returnType)).filter((type): type is string => !!type)));
  return returnTypes.length === 1 ? returnTypes[0] : syntheticReturnType;
}

function inferSyntheticCommandReturnType(
  name: string,
  kind: CommandKind,
  leftType?: string,
  rightType?: string
): string | undefined {
  const loweredName = name.toLowerCase();
  if (kind === "function") {
    if ([
      "agltoasl",
      "asltoagl",
      "asltoatl",
      "atltoasl",
      "boundingcenter",
      "eyepos",
      "getpos",
      "getposagl",
      "getposasl",
      "getposatl",
      "getposatlvisual",
      "getposvisual",
      "screentoworld",
      "vectordir",
      "vectordirvisual",
      "vectornormalized",
      "vectorup",
      "vectorupvisual"
    ].includes(loweredName)) {
      return "vector3";
    }
    if (["worldtoscreen"].includes(loweredName)) {
      return "vector3";
    }
    if (["createdisplay", "finddisplay"].includes(loweredName)) {
      return "display";
    }
    if (["displayctrl"].includes(loweredName)) {
      return "widget";
    }
    if (["createlocation", "createvehicle", "nearestobject"].includes(loweredName)) {
      return "object";
    }
    if (["ctrltext", "typeof", "typename", "str"].includes(loweredName)) {
      return "string";
    }
    if (["parsenumber", "random"].includes(loweredName)) {
      return "float";
    }
    if (["count"].includes(loweredName)) {
      return "int";
    }
  }
  if (kind === "operator") {
    if (["vectoradd", "vectordiff", "vectormultiply", "vectorcrossproduct"].includes(loweredName)) {
      return "vector3";
    }
    if (loweredName === "vectordistance" || loweredName === "vectordistancesqr") {
      return "float";
    }
    if (loweredName === "getvariable") {
      return rightType && rightType !== "any[]" ? rightType : "any";
    }
    if (loweredName === "select") {
      if (leftType === "vector3" || leftType === "vector4") {
        return "float";
      }
      return extractContainerValueFromType(leftType) ?? (leftType === "any[]" ? "any" : undefined);
    }
  }
  if (kind === "nular") {
    if (["getedendisplay"].includes(loweredName)) {
      return "display";
    }
    if (["missionnamespace", "profilenamespace", "uinamespace"].includes(loweredName)) {
      return "namespace";
    }
  }
  return undefined;
}

function getLiteralOrIdentifierText(expression: SqfAstExpression | undefined): string | undefined {
  if (!expression) {
    return undefined;
  }
  if (expression.kind === "identifier") {
    return /^[A-Z][A-Za-z0-9_:]*$/.test(expression.name) ? expression.name : undefined;
  }
  if (expression.kind === "string") {
    return expression.value;
  }
  return undefined;
}

function inferIntrinsicMacroReturnType(expression: SqfAstExpression & { kind: "macroCall" }): string | undefined {
  const loweredName = expression.name.toLowerCase();
  if (loweredName === "nullptr") {
    return "null";
  }
  if (loweredName === "typegetfromobject" || loweredName === "typegetfromstring") {
    return "object";
  }
  if (loweredName === "createmesh" || loweredName === "mem_alloc") {
    return "object";
  }
  if (loweredName === "mem_get") {
    return "any[]";
  }
  if (loweredName === "refcreate") {
    const valueType = expression.args[0] ? inferAstExpressionType(expression.args[0], new Map(), new Map()) : undefined;
    return valueType ? `${valueType}[]` : "any[]";
  }
  if (loweredName === "pointer_new" || loweredName === "generateptr") {
    return "string";
  }
  if (loweredName === "instantiate") {
    const className = getLiteralOrIdentifierText(expression.args[0]);
    return className ? `class:${className}` : "object";
  }
  if (loweredName === "vec3") {
    return "vector3";
  }
  if (loweredName === "vec4") {
    return "vector4";
  }
  if (loweredName === "vec2") {
    return "any[]";
  }
  if (loweredName === "rand" || loweredName === "parsenumber") {
    return "float";
  }
  if (loweredName === "randint" || loweredName === "floor" || loweredName === "ceil" || loweredName === "round") {
    return "int";
  }
  if (loweredName === "startupdateparams" || loweredName === "startupdate") {
    return "thread_handle";
  }
  return undefined;
}

function inferExpressionType(
  expression: string,
  knownTypes: Map<string, string>,
  functionReturnTypes: Map<string, string>
): string | undefined {
  const literalType = inferLiteralType(expression);
  if (literalType) {
    return literalType;
  }

  const trimmed = stripOuterParens(expression);
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    return knownTypes.get(trimmed);
  }

  const projectCallMatch = /^(?:\[[\s\S]*\]|[A-Za-z_][A-Za-z0-9_]*)\s+(?:call|spawn)\s+([A-Za-z_][A-Za-z0-9_]*)$/i.exec(trimmed);
  if (projectCallMatch) {
    return functionReturnTypes.get(projectCallMatch[1].toLowerCase());
  }

  const nularCallMatch = /^call\s+([A-Za-z_][A-Za-z0-9_]*)$/i.exec(trimmed);
  if (nularCallMatch) {
    return functionReturnTypes.get(nularCallMatch[1].toLowerCase());
  }

  const unaryCommandMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s+([\s\S]+)$/i.exec(trimmed);
  if (unaryCommandMatch && !["if", "while", "switch", "for", "foreach"].includes(unaryCommandMatch[1].toLowerCase())) {
    const argumentType = inferExpressionType(unaryCommandMatch[2], knownTypes, functionReturnTypes);
    const commandReturnType = inferRegisteredCommandReturnType(unaryCommandMatch[1], "function", undefined, argumentType);
    if (commandReturnType) {
      return commandReturnType;
    }
  }

  const selectMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s+select\s+.+$/i.exec(trimmed);
  if (selectMatch) {
    const sourceType = knownTypes.get(selectMatch[1]);
    if (sourceType === "vector3" || sourceType === "vector4") {
      return "float";
    }
  }

  const arithmetic = findTopLevelOperator(trimmed, ["==", "!=", ">=", "<=", ">", "<", "+", "-", "*", "/"]);
  if (arithmetic) {
    const leftType = inferExpressionType(arithmetic.left, knownTypes, functionReturnTypes);
    const rightType = inferExpressionType(arithmetic.right, knownTypes, functionReturnTypes);
    const registeredReturnType = inferRegisteredCommandReturnType(arithmetic.operator, "operator", leftType, rightType);
    if (registeredReturnType) {
      return registeredReturnType;
    }

    if (["==", "!=", ">=", "<=", ">", "<"].includes(arithmetic.operator)) {
      return "bool";
    }

    if (arithmetic.operator === "+" && leftType === "string" && rightType === "string") {
      return "string";
    }

    return mergeNumericTypes(leftType, rightType, arithmetic.operator);
  }

  const logical = findTopLevelOperator(trimmed, [" and ", " or "]);
  if (logical) {
    return "bool";
  }

  const ifcheckMatch = /^ifcheck\s*\(([\s\S]*)\)$/i.exec(trimmed);
  if (ifcheckMatch) {
    const args = splitTopLevel(ifcheckMatch[1], ",").map((entry) => entry.trim());
    return chooseBestSpecificType([
      args[1] ? inferExpressionType(args[1], knownTypes, functionReturnTypes) : undefined,
      args[2] ? inferExpressionType(args[2], knownTypes, functionReturnTypes) : undefined
    ]);
  }

  return undefined;
}

function inferAstExpressionType(
  expression: SqfAstExpression,
  knownTypes: Map<string, string>,
  functionReturnTypes: Map<string, string>
): string | undefined {
  switch (expression.kind) {
    case "identifier":
      if (expression.name.toLowerCase() === "nullptr") {
        return "null";
      }
      if (/^LOOT_COMPARE_/i.test(expression.name)) {
        return "string";
      }
      if (/^INV_LIST_/i.test(expression.name)) {
        return "enum.InventorySlot[]";
      }
      if (/^INV_/i.test(expression.name)) {
        return "enum.InventorySlot";
      }
      return knownTypes.get(expression.name) ?? inferRegisteredCommandReturnType(expression.name, "nular");
    case "string":
      return "string";
    case "number":
      return expression.raw.includes(".") ? "float" : "int";
    case "boolean":
      return "bool";
    case "array": {
      const elementTypes = expression.elements.map((element) => inferAstExpressionType(element, knownTypes, functionReturnTypes));
      if (expression.elements.length === 3 && elementTypes.every((type) => type === "int" || type === "float")) {
        return "vector3";
      }
      if (expression.elements.length === 4 && elementTypes.every((type) => type === "int" || type === "float")) {
        return "vector4";
      }
      return "any[]";
    }
    case "code":
      return "code";
    case "unknown":
      return inferLiteralType(expression.raw);
    case "unary": {
      const operandType = inferAstExpressionType(expression.operand, knownTypes, functionReturnTypes);
      const operator = expression.operator.toLowerCase();
      if (operator === "!" || operator === "not") {
        return "bool";
      }
      if (operator === "-" && (operandType === "int" || operandType === "float")) {
        return operandType;
      }
      if (operator === "floor" || operator === "ceil" || operator === "round") {
        return "int";
      }
      if (operator === "parsenumber") {
        return "float";
      }
      if (operator === "pick" || operator === "selectrandom") {
        return expression.operand.kind === "array"
          ? chooseBestSpecificType(expression.operand.elements.map((element) => inferAstExpressionType(element, knownTypes, functionReturnTypes)))
          : extractContainerValueFromType(operandType);
      }
      return inferRegisteredCommandReturnType(expression.operator, "function", undefined, operandType);
    }
    case "binary": {
      const leftType = inferAstExpressionType(expression.left, knownTypes, functionReturnTypes);
      const rightType = inferAstExpressionType(expression.right, knownTypes, functionReturnTypes);
      const operator = expression.operator.toLowerCase();
      if (expression.operator === "and" || expression.operator === "or") {
        return "bool";
      }
      if (operator === "getordefault" && expression.right.kind === "array") {
        const defaultValue = expression.right.elements[1];
        const defaultType = defaultValue ? inferAstExpressionType(defaultValue, knownTypes, functionReturnTypes) : undefined;
        return defaultType === "null" || defaultType === "nil" ? "object" : defaultType ?? "object";
      }
      if (operator === "nearobjects" || operator === "nearentities") {
        return "object[]";
      }
      if (operator === "getvariable" && expression.right.kind === "array") {
        return inferAstExpressionType(expression.right.elements[1] ?? expression.right, knownTypes, functionReturnTypes) ?? "any";
      }
      if (operator === "get" || operator === "getvariable") {
        return "object";
      }
      const registeredReturnType = inferRegisteredCommandReturnType(expression.operator, "operator", leftType, rightType);
      if (registeredReturnType) {
        return registeredReturnType;
      }
      if (["==", "!=", ">=", "<=", ">", "<"].includes(expression.operator)) {
        return "bool";
      }
      if (expression.operator === "+" && leftType === "string" && rightType === "string") {
        return "string";
      }
      if ((expression.operator === "%" || expression.operator === "mod") && leftType && rightType) {
        return mergeNumericTypes(leftType, rightType, expression.operator);
      }
      return mergeNumericTypes(leftType, rightType, expression.operator);
    }
    case "macroCall": {
      const loweredName = expression.name.toLowerCase();
      if (isBooleanLikeMacroName(loweredName)) {
        return "bool";
      }
      if (loweredName === "ifcheck") {
        return chooseBestSpecificType([
          expression.args[1] ? inferAstExpressionType(expression.args[1], knownTypes, functionReturnTypes) : undefined,
          expression.args[2] ? inferAstExpressionType(expression.args[2], knownTypes, functionReturnTypes) : undefined
        ]);
      }
      const intrinsicType = inferIntrinsicMacroReturnType(expression);
      if (intrinsicType) {
        return intrinsicType;
      }
      const argumentType = expression.args[0] ? inferAstExpressionType(expression.args[0], knownTypes, functionReturnTypes) : undefined;
      const registeredReturnType = inferRegisteredCommandReturnType(expression.name, expression.args.length > 0 ? "function" : "nular", undefined, argumentType);
      if (registeredReturnType) {
        return registeredReturnType;
      }
      return functionReturnTypes.get(loweredName);
    }
    case "select": {
      const sourceType = inferAstExpressionType(expression.source, knownTypes, functionReturnTypes);
      return sourceType === "vector3" || sourceType === "vector4"
        ? "float"
        : extractContainerValueFromType(sourceType) ?? (sourceType === "any[]" ? "any" : undefined);
    }
    case "invoke": {
      if (expression.operator === "spawn") {
        return "thread_handle";
      }
      if (expression.callee.kind === "identifier") {
        return functionReturnTypes.get(expression.callee.name.toLowerCase()) ?? intrinsicGlobalFunctionReturnTypes.get(expression.callee.name.toLowerCase()) ?? "any";
      }
      return "any";
    }
    case "exitWith":
      return inferAstBlockReturnType(expression.block, knownTypes, functionReturnTypes);
    case "if": {
      const thenType = inferAstBlockReturnType(expression.thenBlock, knownTypes, functionReturnTypes);
      const elseType = expression.elseBlock ? inferAstBlockReturnType(expression.elseBlock, knownTypes, functionReturnTypes) : undefined;
      return thenType && elseType && thenType === elseType ? thenType : undefined;
    }
  }
}

function isBooleanLikeMacroName(loweredName: string): boolean {
  return loweredName === "isnullobject"
    || loweredName === "isnullreference"
    || loweredName === "isnullvar"
    || loweredName === "isnull"
    || loweredName === "isnil"
    || loweredName === "equals"
    || loweredName === "not_equals"
    || loweredName === "equaltypes"
    || loweredName === "array_exists"
    || loweredName === "isimplementfunc"
    || loweredName === "isimplementclass"
    || loweredName === "isinstance"
    || loweredName === "typehasvar"
    || loweredName === "prob"
    || loweredName.startsWith("istype")
    || loweredName.startsWith("isType".toLowerCase());
}

function isNullLikeType(type: string | undefined): boolean {
  return type === "null" || type === "nil" || type === "object" || /^class:(?:object|any)$/i.test(type ?? "");
}

function isPrimitiveTypeName(type: string | undefined): boolean {
  const lowered = type?.trim().toLowerCase();
  return !!lowered && [
    "any",
    "bool",
    "boolean",
    "int",
    "float",
    "number",
    "string",
    "code",
    "object",
    "null",
    "nil",
    "vector3",
    "vector4",
    "control",
    "display",
    "config",
    "namespace",
    "thread_handle"
  ].includes(lowered);
}

function typeSpecificity(type: string): number {
  if (/^(class|struct):/i.test(type)) return 3;
  if (type === "vector3" || type === "vector4") return 3;
  if (type.startsWith("map<") || type.endsWith("[]")) return 2;
  if (type && type !== "object" && type !== "any" && type !== "any[]") return 1;
  return 0;
}

function chooseBestSpecificType(types: Array<string | undefined>): string | undefined {
  const unique = Array.from(new Set(types.filter((type): type is string => !!type && !isNullLikeType(type))));
  if (unique.length === 0) {
    return undefined;
  }
  unique.sort((left, right) => typeSpecificity(right) - typeSpecificity(left) || left.length - right.length);
  return unique[0];
}

function chooseDominantType(types: Array<string | undefined>): string | undefined {
  const counts = new Map<string, number>();
  for (const type of types) {
    if (!type || isNullLikeType(type)) {
      continue;
    }
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const candidates = Array.from(counts.entries());
  if (candidates.length === 0) {
    return undefined;
  }
  candidates.sort((left, right) =>
    right[1] - left[1]
    || typeSpecificity(right[0]) - typeSpecificity(left[0])
    || left[0].length - right[0].length
  );
  return candidates[0][0];
}

function parseEncodedOwnerType(type: string | undefined): ReSdkOwnerRef | undefined {
  const match = /^(class|struct):([A-Za-z_][A-Za-z0-9_:]*)$/i.exec(type?.trim() ?? "");
  return match
    ? { kind: match[1].toLowerCase() as ReSdkOwnerKind, name: match[2] }
    : undefined;
}

function getOwnerAncestry(index: WorkspaceSymbolIndex, owner: ReSdkOwnerRef): ReSdkOwnerRef[] {
  const cache = ownerAncestryCache.get(index) ?? new Map<string, ReSdkOwnerRef[]>();
  const cacheKey = typeIndexKey(owner);
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const result: ReSdkOwnerRef[] = [];
  let current: ReSdkOwnerRef | undefined = owner;
  const visited = new Set<string>();
  while (current && !visited.has(typeIndexKey(current))) {
    visited.add(typeIndexKey(current));
    result.push(current);
    const info = index.typesByLowerName.get(typeIndexKey(current));
    current = info?.baseName ? resolveIndexedTypeOwner(index, `${current.kind}:${info.baseName}`) : undefined;
  }
  cache.set(cacheKey, result);
  ownerAncestryCache.set(index, cache);
  return result;
}

function getCommonOwnerType(index: WorkspaceSymbolIndex, types: string[]): string | undefined {
  const owners = types.map((type) => parseEncodedOwnerType(type)).filter((owner): owner is ReSdkOwnerRef => !!owner);
  if (owners.length === 0 || owners.length !== types.length) {
    return undefined;
  }

  const firstAncestry = getOwnerAncestry(index, owners[0]);
  for (const candidate of firstAncestry) {
    if (owners.every((owner) => getOwnerAncestry(index, owner).some((entry) => typeIndexKey(entry) === typeIndexKey(candidate)))) {
      return encodeOwnerType(candidate);
    }
  }
  return undefined;
}

function hasDerivedTypes(index: WorkspaceSymbolIndex, owner: ReSdkOwnerRef): boolean {
  const ownerKey = typeIndexKey(owner);
  const cache = derivedTypeCache.get(index) ?? new Map<string, boolean>();
  const cached = cache.get(ownerKey);
  if (cached !== undefined) {
    return cached;
  }

  for (const info of index.typesByLowerName.values()) {
    if (!info.baseName || info.kind !== owner.kind) {
      continue;
    }
    const base = resolveIndexedTypeOwner(index, `${info.kind}:${info.baseName}`);
    if (base && typeIndexKey(base) === ownerKey) {
      cache.set(ownerKey, true);
      derivedTypeCache.set(index, cache);
      return true;
    }
  }
  cache.set(ownerKey, false);
  derivedTypeCache.set(index, cache);
  return false;
}

function chooseDominantParameterType(types: Array<string | undefined>, index: WorkspaceSymbolIndex): string | undefined {
  const candidates = types.filter((type): type is string => !!type && !isNullLikeType(type));
  if (candidates.length === 0) {
    return undefined;
  }

  const ownerTypes = candidates.filter((type) => !!parseEncodedOwnerType(type));
  const nonOwnerTypes = candidates.filter((type) => !parseEncodedOwnerType(type));
  if (ownerTypes.length > 0 && nonOwnerTypes.length > 0) {
    return chooseDominantType(nonOwnerTypes);
  }
  if (ownerTypes.length > 1) {
    return getCommonOwnerType(index, ownerTypes) ?? chooseDominantType(ownerTypes);
  }
  return chooseDominantType(candidates);
}

function chooseParameterInferenceType(usageType: string | undefined, callInferredType: string | undefined): string | undefined {
  if (!callInferredType || callInferredType === "any" || callInferredType === "any[]") {
    return usageType ?? callInferredType;
  }
  if (!usageType) {
    return callInferredType;
  }
  if (parseEncodedOwnerType(usageType) && !parseEncodedOwnerType(callInferredType)) {
    return usageType;
  }
  return callInferredType;
}

function choosePrimitiveUsageType(types: string[]): string | undefined {
  const nonGeneric = types.filter((type) => !["any", "any[]", "object"].includes(type));
  return chooseDominantType(nonGeneric) ?? chooseDominantType(types) ?? chooseBestSpecificType(types);
}

function inferShallowNonLocalType(expression: SqfAstExpression, index: WorkspaceSymbolIndex): string | undefined {
  if (expression.kind === "identifier") {
    return inferIndexedIdentifierType(index, expression.name) ?? inferRegisteredCommandReturnType(expression.name, "nular");
  }
  return inferAstExpressionType(expression, new Map(), new Map());
}

function getMacroIdentifierArg(expression: SqfAstExpression | undefined): string | undefined {
  return expression?.kind === "identifier" ? expression.name : undefined;
}

function getSelfPropertyName(expression: SqfAstExpression | undefined): string | undefined {
  return expression?.kind === "macroCall" && expression.name.toLowerCase() === "getself"
    ? getMacroIdentifierArg(expression.args[0])
    : undefined;
}

function getLocalSymbolType(symbol: IndexedSymbol, localName: string, index: WorkspaceSymbolIndex): string | undefined {
  const direct = symbol.localSymbols?.find((local) => local.name.toLowerCase() === localName.toLowerCase())?.type
    ?? symbol.functionParameters?.find((parameter) => parameter.name.toLowerCase() === localName.toLowerCase())?.type;
  if (direct && !["object", "any", "any[]", "null", "nil"].includes(direct)) {
    return direct;
  }
  return inferLocalTypeFromMemberUsage(symbol, localName, index) ?? direct;
}

function inferIndexedIdentifierType(index: WorkspaceSymbolIndex, name: string): string | undefined {
  const loweredName = name.toLowerCase();
  if (loweredName === "nullptr") {
    return "null";
  }
  if (/^LOOT_COMPARE_/i.test(name)) {
    return "string";
  }
  if (/^INV_LIST_/i.test(name)) {
    return "enum.InventorySlot[]";
  }
  if (/^INV_/i.test(name)) {
    return "enum.InventorySlot";
  }

  for (const symbol of index.byLowerName.get(loweredName) ?? []) {
    if (symbol.kind === "macro" && !symbol.macroParameters?.length && symbol.valueType) {
      return symbol.valueType;
    }
    if (symbol.kind === "macro" && !symbol.macroParameters?.length && symbol.macroBody) {
      const type = inferExpressionType(symbol.macroBody, new Map(), new Map());
      if (type) {
        return type;
      }
    }
    if (symbol.kind === "globalVariable" && symbol.valueType) {
      return symbol.valueType;
    }
  }
  return inferRegisteredCommandReturnType(name, "nular");
}

const localUsageTypeCache = new WeakMap<WorkspaceSymbolIndex, Map<string, string | undefined>>();
const propertyContainerValueTypeCache = new WeakMap<WorkspaceSymbolIndex, Map<string, string | undefined>>();
const propertyContainerKeyTypeCache = new WeakMap<WorkspaceSymbolIndex, Map<string, string | undefined>>();
const typeVarValueTypeCache = new WeakMap<WorkspaceSymbolIndex, Map<string, string | undefined>>();
const ownerAncestryCache = new WeakMap<WorkspaceSymbolIndex, Map<string, ReSdkOwnerRef[]>>();
const derivedTypeCache = new WeakMap<WorkspaceSymbolIndex, Map<string, boolean>>();

function getCachedInference(cache: WeakMap<WorkspaceSymbolIndex, Map<string, string | undefined>>, index: WorkspaceSymbolIndex, key: string): string | undefined {
  return cache.get(index)?.get(key);
}

function hasCachedInference(cache: WeakMap<WorkspaceSymbolIndex, Map<string, string | undefined>>, index: WorkspaceSymbolIndex, key: string): boolean {
  return cache.get(index)?.has(key) ?? false;
}

function setCachedInference(cache: WeakMap<WorkspaceSymbolIndex, Map<string, string | undefined>>, index: WorkspaceSymbolIndex, key: string, value: string | undefined): string | undefined {
  const map = cache.get(index) ?? new Map<string, string | undefined>();
  map.set(key, value);
  cache.set(index, map);
  return value;
}

type MemberRequirement = {
  name: string;
  role: "method" | "property" | "structMember";
};

function collectLocalMemberRequirements(
  expression: SqfAstExpression,
  localName: string,
  requirements: MemberRequirement[]
): void {
  switch (expression.kind) {
    case "macroCall": {
      const macroName = expression.name.toLowerCase();
      const receiverName = getMacroIdentifierArg(expression.args[0]);
      const memberName = getMacroIdentifierArg(expression.args[1]);
      if (receiverName?.toLowerCase() === localName.toLowerCase() && memberName) {
        if (macroName === "callfunc" || macroName === "callfuncparams" || macroName === "allfunc" || macroName === "allfuncparams") {
          requirements.push({ name: memberName, role: "method" });
        } else if (macroName === "getvar" || macroName === "setvar") {
          requirements.push({ name: memberName, role: "property" });
        }
      }
      for (const argument of expression.args) {
        collectLocalMemberRequirements(argument, localName, requirements);
      }
      return;
    }
    case "array":
      for (const element of expression.elements) {
        collectLocalMemberRequirements(element, localName, requirements);
      }
      return;
    case "code":
      for (const statement of expression.block.statements) {
        if (statement.kind === "assignment" || statement.kind === "expression") {
          collectLocalMemberRequirements(statement.expression, localName, requirements);
        }
      }
      return;
    case "unary":
      collectLocalMemberRequirements(expression.operand, localName, requirements);
      return;
    case "binary":
      if (expression.right.kind === "macroCall" && isLocalIdentifier(expression.left, localName)) {
        const operator = expression.operator.toLowerCase();
        const memberName = getMacroIdentifierArg(expression.right.args[0]);
        if (memberName && (operator === "callp" || operator === "callv")) {
          requirements.push({ name: memberName, role: "structMember" });
        } else if (memberName && (operator === "getv" || operator === "setv")) {
          requirements.push({ name: memberName, role: "structMember" });
        }
      }
      collectLocalMemberRequirements(expression.left, localName, requirements);
      collectLocalMemberRequirements(expression.right, localName, requirements);
      return;
    case "invoke":
      if (expression.target) {
        collectLocalMemberRequirements(expression.target, localName, requirements);
      }
      collectLocalMemberRequirements(expression.callee, localName, requirements);
      return;
    case "select":
      collectLocalMemberRequirements(expression.source, localName, requirements);
      collectLocalMemberRequirements(expression.index, localName, requirements);
      return;
    case "exitWith":
      if (expression.condition) {
        collectLocalMemberRequirements(expression.condition, localName, requirements);
      }
      for (const statement of expression.block.statements) {
        if (statement.kind === "assignment" || statement.kind === "expression") {
          collectLocalMemberRequirements(statement.expression, localName, requirements);
        }
      }
      return;
    case "if":
      collectLocalMemberRequirements(expression.condition, localName, requirements);
      for (const block of [expression.thenBlock, expression.elseBlock].filter((entry): entry is SqfAstBlock => !!entry)) {
        for (const statement of block.statements) {
          if (statement.kind === "assignment" || statement.kind === "expression") {
            collectLocalMemberRequirements(statement.expression, localName, requirements);
          }
        }
      }
      return;
    case "identifier":
    case "string":
    case "number":
    case "boolean":
    case "unknown":
      return;
  }
}

function isLocalIdentifier(expression: SqfAstExpression, localName: string): boolean {
  return expression.kind === "identifier" && expression.name.toLowerCase() === localName.toLowerCase();
}

function collectLocalPrimitiveTypeHints(
  expression: SqfAstExpression,
  localName: string,
  symbol: IndexedSymbol,
  index: WorkspaceSymbolIndex,
  hints: string[]
): void {
  const pushComparableHint = (candidate: SqfAstExpression, other: SqfAstExpression) => {
    if (!isLocalIdentifier(candidate, localName)) {
      return;
    }
    const otherType = inferAstExpressionType(other, new Map(), new Map());
    if (otherType && otherType !== "null" && otherType !== "nil") {
      hints.push(otherType);
    }
  };
  const pushCallArgumentHints = (target: IndexedSymbol | undefined, args: SqfAstExpression[]) => {
    if (!target?.functionParameters?.length) {
      return;
    }
    const callableParameters = target.functionParameters
      .map((parameter, parameterIndex) => ({ parameter, parameterIndex }))
      .filter((entry) => !isPseudoThisParameter(entry.parameter.name));
    args.forEach((argument, argumentIndex) => {
      if (isLocalIdentifier(argument, localName)) {
        const parameterType = callableParameters[argumentIndex]?.parameter.type ?? target.functionParameters?.[argumentIndex]?.type;
        const typeSource = callableParameters[argumentIndex]?.parameter.typeSource ?? target.functionParameters?.[argumentIndex]?.typeSource;
        const ownerType = parseEncodedOwnerType(parameterType);
        if (parameterType && (typeSource === "decl" || !ownerType || hasDerivedTypes(index, ownerType))) {
          hints.push(parameterType);
        }
      }
    });
  };

  switch (expression.kind) {
    case "macroCall": {
      const loweredName = expression.name.toLowerCase();
      if ((loweredName === "callselfparams" || loweredName === "callself") && expression.args[0]?.kind === "identifier" && symbol.ownerName && symbol.ownerKind) {
        const target = resolveReSdkMember(index, { name: symbol.ownerName, kind: symbol.ownerKind }, expression.args[0].name, symbol.ownerKind === "struct" ? "structMember" : "method");
        pushCallArgumentHints(target, loweredName === "callselfparams" ? flattenArgExpression(expression.args[1]) : []);
      } else if ((loweredName === "callfuncparams" || loweredName === "callfunc" || loweredName === "allfuncparams" || loweredName === "allfunc") && expression.args[1]?.kind === "identifier") {
        const receiverOwner = inferDirectOwnerFromExpression(expression.args[0], symbol, index);
        const target = resolveReSdkMember(index, receiverOwner, expression.args[1].name, receiverOwner?.kind === "struct" ? "structMember" : "method");
        pushCallArgumentHints(target, loweredName.endsWith("params") ? flattenArgExpression(expression.args[2]) : []);
      }
      if ((loweredName === "equals" || loweredName === "not_equals" || loweredName === "equaltypes") && expression.args.length >= 2) {
        pushComparableHint(expression.args[0], expression.args[1]);
        pushComparableHint(expression.args[1], expression.args[0]);
      }
      if (loweredName === "array_exists" && isLocalIdentifier(expression.args[1], localName)) {
        const collectionName = expression.args[0]?.kind === "identifier" ? expression.args[0].name : "";
        hints.push(/^INV_LIST_/i.test(collectionName) ? "enum.InventorySlot" : "int");
      }
      if (loweredName === "setself" && expression.args[1] && isLocalIdentifier(expression.args[1], localName) && symbol.ownerName && symbol.ownerKind) {
        const propertyName = getMacroIdentifierArg(expression.args[0]);
        const property = propertyName ? resolveReSdkMember(index, { name: symbol.ownerName, kind: symbol.ownerKind }, propertyName, "property") : undefined;
        if (property?.valueType) {
          hints.push(property.valueType);
        }
      }
      if (loweredName === "setvar" && expression.args[2] && isLocalIdentifier(expression.args[2], localName)) {
        const propertyName = getMacroIdentifierArg(expression.args[1]);
        const receiverOwner = inferDirectOwnerFromExpression(expression.args[0], symbol, index);
        const property = propertyName ? resolveReSdkMember(index, receiverOwner, propertyName, "property") : undefined;
        if (property?.valueType) {
          hints.push(property.valueType);
        }
      }
      for (const argument of expression.args) {
        collectLocalPrimitiveTypeHints(argument, localName, symbol, index, hints);
      }
      return;
    }
    case "binary": {
      const operator = expression.operator.toLowerCase();
      if ((operator === "callp" || operator === "callv") && expression.right.kind === "macroCall") {
        const memberName = getMacroIdentifierArg(expression.right.args[0]);
        const receiverOwner = inferDirectOwnerFromExpression(expression.left, symbol, index);
        const target = memberName
          ? resolveReSdkMember(index, receiverOwner, memberName, receiverOwner?.kind === "struct" ? "structMember" : "method")
          : undefined;
        pushCallArgumentHints(target, operator === "callp" ? expression.right.args.slice(1).flatMap(flattenArgExpression) : []);
      }
      if (operator === "setv" && expression.right.kind === "macroCall" && expression.right.args[1] && isLocalIdentifier(expression.right.args[1], localName)) {
        const receiverOwner = inferDirectOwnerFromExpression(expression.left, symbol, index) ?? inferAstOwnerFromExpressionWithIndex(expression.left, symbol, index);
        const memberName = getMacroIdentifierArg(expression.right.args[0]);
        const member = memberName
          ? resolveReSdkMember(index, receiverOwner, memberName, "structMember")
          : undefined;
        if (member?.valueType) {
          hints.push(member.valueType);
        }
      }
      if (["==", "!=", ">=", "<=", ">", "<"].includes(expression.operator) || operator === "max" || operator === "min") {
        pushComparableHint(expression.left, expression.right);
        pushComparableHint(expression.right, expression.left);
      }
      if (operator === "+") {
        const leftIsLocal = isLocalIdentifier(expression.left, localName);
        const rightIsLocal = isLocalIdentifier(expression.right, localName);
        const otherType = leftIsLocal
          ? inferShallowNonLocalType(expression.right, index)
          : rightIsLocal
            ? inferShallowNonLocalType(expression.left, index)
            : undefined;
        if ((leftIsLocal || rightIsLocal) && otherType === "string") {
          hints.push("string");
        } else if (leftIsLocal || rightIsLocal) {
          hints.push("float");
        }
      } else if (["-", "*", "/", "%", "mod", "^", "max", "min"].includes(operator)) {
        if (isLocalIdentifier(expression.left, localName) || isLocalIdentifier(expression.right, localName)) {
          hints.push("float");
        }
      }
      if (["pushback", "pushbackunique", "append", "findif", "resize", "reverse"].includes(operator) && isLocalIdentifier(expression.left, localName)) {
        hints.push("any[]");
      }
      if (["deleteat", "select"].includes(operator)) {
        if (isLocalIdentifier(expression.left, localName)) {
          hints.push("any[]");
        }
        if (isLocalIdentifier(expression.right, localName)) {
          hints.push("int");
        }
      }
      if (operator === "set" && isLocalIdentifier(expression.left, localName)) {
        hints.push("any[]");
      }
      if (operator === "set" && expression.right.kind === "array") {
        if (expression.right.elements[0] && isLocalIdentifier(expression.right.elements[0], localName)) {
          hints.push("int");
        }
      }
      if (operator === "get" && isLocalIdentifier(expression.left, localName)) {
        hints.push("map<any;any>");
      }
      if ((operator === "get" || operator === "getordefault") && expression.right.kind === "array" && expression.right.elements[0] && isLocalIdentifier(expression.right.elements[0], localName)) {
        const keyType = inferContainerKeyType(expression.left, symbol, index);
        if (keyType) {
          hints.push(keyType);
        }
      }
      if (operator === "in" && isLocalIdentifier(expression.right, localName)) {
        hints.push("map<any;any>");
      }
      if (operator === "in" && isLocalIdentifier(expression.left, localName) && expression.right.kind === "identifier" && /^INV_LIST_/i.test(expression.right.name)) {
        hints.push("enum.InventorySlot");
      }
      if (operator === "foreach" && isLocalIdentifier(expression.right, localName)) {
        hints.push("any[]");
      }
      if ((operator === "nearobjects" || operator === "nearentities") && isLocalIdentifier(expression.right, localName)) {
        hints.push("float");
      }
      if ((operator === "nearobjects" || operator === "nearentities") && isLocalIdentifier(expression.left, localName)) {
        hints.push("object");
      }
      if (operator === "select" && isLocalIdentifier(expression.left, localName) && expression.right.kind === "number" && ["0", "1", "2"].includes(expression.right.raw)) {
        hints.push("vector3");
      }
      collectLocalPrimitiveTypeHints(expression.left, localName, symbol, index, hints);
      collectLocalPrimitiveTypeHints(expression.right, localName, symbol, index, hints);
      return;
    }
    case "unary":
      if ((expression.operator === "!" || expression.operator === "not") && isLocalIdentifier(expression.operand, localName)) {
        hints.push("bool");
      }
      if (["count", "reverse", "selectrandom", "pick"].includes(expression.operator.toLowerCase()) && isLocalIdentifier(expression.operand, localName)) {
        hints.push("any[]");
      }
      collectLocalPrimitiveTypeHints(expression.operand, localName, symbol, index, hints);
      return;
    case "array":
      for (const element of expression.elements) {
        collectLocalPrimitiveTypeHints(element, localName, symbol, index, hints);
      }
      return;
    case "code":
      for (const statement of expression.block.statements) {
        if (statement.kind === "assignment" || statement.kind === "expression") {
          collectLocalPrimitiveTypeHints(statement.expression, localName, symbol, index, hints);
        }
      }
      return;
    case "invoke":
      if (expression.target) {
        collectLocalPrimitiveTypeHints(expression.target, localName, symbol, index, hints);
      }
      collectLocalPrimitiveTypeHints(expression.callee, localName, symbol, index, hints);
      return;
    case "select":
      if (isLocalIdentifier(expression.source, localName)) {
        hints.push(expression.index.kind === "number" && ["0", "1", "2"].includes(expression.index.raw) ? "vector3" : "any[]");
      }
      if (isLocalIdentifier(expression.index, localName)) {
        hints.push("int");
      }
      collectLocalPrimitiveTypeHints(expression.source, localName, symbol, index, hints);
      collectLocalPrimitiveTypeHints(expression.index, localName, symbol, index, hints);
      return;
    case "exitWith":
      if (expression.condition) {
        collectLocalPrimitiveTypeHints(expression.condition, localName, symbol, index, hints);
      }
      for (const statement of expression.block.statements) {
        if (statement.kind === "assignment" || statement.kind === "expression") {
          collectLocalPrimitiveTypeHints(statement.expression, localName, symbol, index, hints);
        }
      }
      return;
    case "if":
      collectLocalPrimitiveTypeHints(expression.condition, localName, symbol, index, hints);
      for (const block of [expression.thenBlock, expression.elseBlock].filter((entry): entry is SqfAstBlock => !!entry)) {
        for (const statement of block.statements) {
          if (statement.kind === "assignment" || statement.kind === "expression") {
            collectLocalPrimitiveTypeHints(statement.expression, localName, symbol, index, hints);
          }
        }
      }
      return;
    case "identifier":
    case "string":
    case "number":
    case "boolean":
    case "unknown":
      return;
  }
}

function inferLocalTypeFromMemberUsage(symbol: IndexedSymbol, localName: string, index: WorkspaceSymbolIndex): string | undefined {
  if (!symbol.functionAst) {
    return undefined;
  }

  const cacheKey = `${symbol.filePath}:${symbol.line}:${symbol.name}:${localName.toLowerCase()}`;
  if (hasCachedInference(localUsageTypeCache, index, cacheKey)) {
    return getCachedInference(localUsageTypeCache, index, cacheKey);
  }

  const requirements: MemberRequirement[] = [];
  const primitiveHints: string[] = [];
  for (const statement of symbol.functionAst.statements) {
    if (statement.kind === "assignment" || statement.kind === "expression") {
      collectLocalMemberRequirements(statement.expression, localName, requirements);
      collectLocalPrimitiveTypeHints(statement.expression, localName, symbol, index, primitiveHints);
    }
  }

  const uniqueRequirements = Array.from(
    new Map(requirements.map((requirement) => [`${requirement.role}:${requirement.name.toLowerCase()}`, requirement])).values()
  );
  if (uniqueRequirements.length === 0) {
    return setCachedInference(localUsageTypeCache, index, cacheKey, choosePrimitiveUsageType(primitiveHints));
  }

  const candidateCounts = new Map<string, number>();
  for (const requirement of uniqueRequirements) {
    candidateCounts.set(`${requirement.role}:${requirement.name.toLowerCase()}`, getReSdkMemberCandidates(index, requirement.name, requirement.role).length);
  }

  const candidates: Array<{ owner: ReSdkOwnerRef; score: number; uniqueScore: number }> = [];
  const seedCandidates = uniqueRequirements.flatMap((requirement) => getReSdkMemberCandidates(index, requirement.name, requirement.role));
  const seenOwners = new Set<string>();
  for (const seedCandidate of seedCandidates) {
    if (!seedCandidate.ownerName || !seedCandidate.ownerKind) {
      continue;
    }
    const owner: ReSdkOwnerRef = { name: seedCandidate.ownerName, kind: seedCandidate.ownerKind };
    const ownerKey = typeIndexKey(owner);
    if (seenOwners.has(ownerKey)) {
      continue;
    }
    seenOwners.add(ownerKey);
    let score = 0;
    let uniqueScore = 0;
    for (const requirement of uniqueRequirements) {
      if (resolveReSdkMember(index, owner, requirement.name, requirement.role)) {
        const count = candidateCounts.get(`${requirement.role}:${requirement.name.toLowerCase()}`) ?? 1;
        score += 1 / Math.max(1, count);
        if (count === 1) {
          uniqueScore += 1;
        }
      }
    }
    if (score > 0) {
      candidates.push({ owner, score, uniqueScore });
    }
  }

  const fullMatches = candidates.filter((candidate) => candidate.score === uniqueRequirements.length);
  const matches = fullMatches.length > 0
    ? fullMatches
    : candidates.filter((candidate) => candidate.uniqueScore > 0);
  if (matches.length === 0) {
    return setCachedInference(localUsageTypeCache, index, cacheKey, undefined);
  }
  matches.sort((left, right) =>
    right.uniqueScore - left.uniqueScore
    || right.score - left.score
    || getTypeInheritanceDepth(index, left.owner) - getTypeInheritanceDepth(index, right.owner)
    || left.owner.name.length - right.owner.name.length
  );
  return setCachedInference(localUsageTypeCache, index, cacheKey, chooseBestSpecificType([`${matches[0].owner.kind}:${matches[0].owner.name}`, ...primitiveHints]));
}

function collectTypeVarWriteTypes(
  expression: SqfAstExpression,
  varName: string,
  method: IndexedSymbol,
  index: WorkspaceSymbolIndex,
  types: string[]
): void {
  switch (expression.kind) {
    case "macroCall": {
      const loweredName = expression.name.toLowerCase();
      const currentVarName = getMacroIdentifierArg(expression.args[1]);
      if (loweredName === "typesetvar" && currentVarName?.toLowerCase() === varName.toLowerCase() && expression.args[2]) {
        const valueType = inferAstExpressionTypeWithIndex(expression.args[2], method, index);
        if (valueType) {
          types.push(valueType);
        }
      }
      for (const argument of expression.args) {
        collectTypeVarWriteTypes(argument, varName, method, index, types);
      }
      return;
    }
    case "array":
      for (const element of expression.elements) {
        collectTypeVarWriteTypes(element, varName, method, index, types);
      }
      return;
    case "code":
      for (const statement of expression.block.statements) {
        if (statement.kind === "assignment" || statement.kind === "expression") {
          collectTypeVarWriteTypes(statement.expression, varName, method, index, types);
        }
      }
      return;
    case "unary":
      collectTypeVarWriteTypes(expression.operand, varName, method, index, types);
      return;
    case "binary":
      collectTypeVarWriteTypes(expression.left, varName, method, index, types);
      collectTypeVarWriteTypes(expression.right, varName, method, index, types);
      return;
    case "invoke":
      if (expression.target) {
        collectTypeVarWriteTypes(expression.target, varName, method, index, types);
      }
      collectTypeVarWriteTypes(expression.callee, varName, method, index, types);
      return;
    case "select":
      collectTypeVarWriteTypes(expression.source, varName, method, index, types);
      collectTypeVarWriteTypes(expression.index, varName, method, index, types);
      return;
    case "exitWith":
      if (expression.condition) {
        collectTypeVarWriteTypes(expression.condition, varName, method, index, types);
      }
      for (const statement of expression.block.statements) {
        if (statement.kind === "assignment" || statement.kind === "expression") {
          collectTypeVarWriteTypes(statement.expression, varName, method, index, types);
        }
      }
      return;
    case "if":
      collectTypeVarWriteTypes(expression.condition, varName, method, index, types);
      for (const block of [expression.thenBlock, expression.elseBlock].filter((entry): entry is SqfAstBlock => !!entry)) {
        for (const statement of block.statements) {
          if (statement.kind === "assignment" || statement.kind === "expression") {
            collectTypeVarWriteTypes(statement.expression, varName, method, index, types);
          }
        }
      }
      return;
    case "identifier":
    case "string":
    case "number":
    case "boolean":
    case "unknown":
      return;
  }
}

function inferTypeVarValueType(index: WorkspaceSymbolIndex, varName: string): string | undefined {
  const cacheKey = varName.toLowerCase();
  if (hasCachedInference(typeVarValueTypeCache, index, cacheKey)) {
    return getCachedInference(typeVarValueTypeCache, index, cacheKey);
  }

  const types: string[] = [];
  for (const symbol of index.all) {
    if (!symbol.functionAst) {
      continue;
    }
    for (const statement of symbol.functionAst.statements) {
      if (statement.kind === "assignment" || statement.kind === "expression") {
        collectTypeVarWriteTypes(statement.expression, varName, symbol, index, types);
      }
    }
  }

  return setCachedInference(typeVarValueTypeCache, index, cacheKey, chooseBestSpecificType(types));
}

function getTypeInheritanceDepth(index: WorkspaceSymbolIndex, owner: ReSdkOwnerRef): number {
  let depth = 0;
  let current: ReSdkOwnerRef | undefined = owner;
  const visited = new Set<string>();
  while (current && !visited.has(typeIndexKey(current))) {
    visited.add(typeIndexKey(current));
    const info = index.typesByLowerName.get(typeIndexKey(current));
    if (!info?.baseName) {
      break;
    }
    const next = resolveIndexedTypeOwner(index, `${current.kind}:${info.baseName}`);
    if (!next) {
      break;
    }
    depth += 1;
    current = next;
  }
  return depth;
}

function inferAssignedLocalTypeBeforeOffset(
  symbol: IndexedSymbol,
  localName: string,
  offset: number,
  index: WorkspaceSymbolIndex
): string | undefined {
  if (!symbol.functionAst) {
    return undefined;
  }
  const candidate = (symbol.localSymbols ?? [])
    .filter((local) =>
      local.source === "assignment"
      && local.name.toLowerCase() === localName.toLowerCase()
      && local.valueStart !== undefined
      && local.valueEnd !== undefined
      && local.valueEnd <= offset
    )
    .sort((left, right) => (right.valueEnd ?? 0) - (left.valueEnd ?? 0))[0];
  if (candidate?.valueStart === undefined || candidate.valueEnd === undefined) {
    return undefined;
  }

  const expression = findExpressionInBlockAtRange(symbol.functionAst, candidate.valueStart, candidate.valueEnd);
  if (!expression || (expression.kind === "identifier" && expression.name.toLowerCase() === localName.toLowerCase())) {
    return undefined;
  }
  return inferAstExpressionTypeWithIndex(expression, symbol, index);
}

function inferAstExpressionTypeWithIndex(
  expression: SqfAstExpression,
  symbol: IndexedSymbol,
  index: WorkspaceSymbolIndex
): string | undefined {
  switch (expression.kind) {
    case "identifier":
      if (expression.name.toLowerCase() === "nullptr") {
        return "null";
      }
      if (/^INV_LIST_/i.test(expression.name)) {
        return "enum.InventorySlot[]";
      }
      if (/^INV_/i.test(expression.name)) {
        return "enum.InventorySlot";
      }
      return getLocalSymbolType(symbol, expression.name, index)
        ?? inferAssignedLocalTypeBeforeOffset(symbol, expression.name, expression.start, index)
        ?? inferIndexedIdentifierType(index, expression.name);
    case "binary": {
      const operator = expression.operator.toLowerCase();
      if (operator === "and" || operator === "or" || ["==", "!=", ">=", "<=", ">", "<"].includes(expression.operator)) {
        return "bool";
      }
      if ((operator === "callp" || operator === "callv") && expression.right.kind === "macroCall") {
        const memberName = getMacroIdentifierArg(expression.right.args[0]);
        const receiverOwner = inferAstOwnerFromExpressionWithIndex(expression.left, symbol, index);
        const member = memberName
          ? resolveReSdkMember(index, receiverOwner, memberName, receiverOwner?.kind === "struct" ? "structMember" : "method")
          : undefined;
        return member?.functionReturnType ?? member?.valueType;
      }
      if ((operator === "getv" || operator === "setv") && expression.right.kind === "macroCall") {
        const memberName = getMacroIdentifierArg(expression.right.args[0]);
        const receiverOwner = inferAstOwnerFromExpressionWithIndex(expression.left, symbol, index);
        const member = memberName
          ? resolveReSdkMember(index, receiverOwner, memberName, receiverOwner?.kind === "struct" ? "structMember" : "property")
          : undefined;
        return member?.valueType ?? member?.functionReturnType;
      }
      if ((operator === "getordefault" || operator === "get") && expression.left) {
        const containerType = inferContainerValueType(expression.left, symbol, index);
        const fallbackType = expression.right.kind === "array"
          ? inferAstExpressionTypeWithIndex(expression.right.elements[1] ?? expression.right, symbol, index)
          : undefined;
        return chooseBestSpecificType([containerType, fallbackType]) ?? containerType ?? fallbackType;
      }
      if (operator === "nearobjects" || operator === "nearentities") {
        return "object[]";
      }
      const leftType = inferAstExpressionTypeWithIndex(expression.left, symbol, index);
      const rightType = inferAstExpressionTypeWithIndex(expression.right, symbol, index);
      const registeredReturnType = inferRegisteredCommandReturnType(expression.operator, "operator", leftType, rightType);
      if (registeredReturnType) {
        return registeredReturnType;
      }
      if (expression.operator === "+" && leftType === "string" && rightType === "string") {
        return "string";
      }
      return mergeNumericTypes(leftType, rightType, expression.operator)
        ?? inferAstExpressionType(expression, new Map(), new Map());
    }
    case "unary":
      if (expression.operator === "!" || expression.operator === "not") {
        return "bool";
      }
      if (expression.operator === "-") {
        return inferAstExpressionType(expression, new Map(), new Map());
      }
      if (expression.operator.toLowerCase() === "pick" || expression.operator.toLowerCase() === "selectrandom") {
        const operandType = inferAstExpressionTypeWithIndex(expression.operand, symbol, index);
        return expression.operand.kind === "array"
          ? chooseBestSpecificType(expression.operand.elements.map((element) => inferAstExpressionTypeWithIndex(element, symbol, index)))
          : extractContainerValueFromType(operandType);
      }
      return inferRegisteredCommandReturnType(
        expression.operator,
        "function",
        undefined,
        inferAstExpressionTypeWithIndex(expression.operand, symbol, index)
      ) ?? inferAstExpressionType(expression, new Map(), new Map());
    case "array": {
      const elementTypes = expression.elements.map((element) => inferAstExpressionTypeWithIndex(element, symbol, index));
      if (expression.elements.length === 3 && elementTypes.every((type) => type === "int" || type === "float")) {
        return "vector3";
      }
      if (expression.elements.length === 4 && elementTypes.every((type) => type === "int" || type === "float")) {
        return "vector4";
      }
      const uniqueElementTypes = Array.from(new Set(elementTypes.filter((type): type is string => !!type)));
      if (uniqueElementTypes.length === 1 && uniqueElementTypes[0] !== "any") {
        return `${uniqueElementTypes[0]}[]`;
      }
      return "any[]";
    }
    case "select": {
      const sourceType = inferAstExpressionTypeWithIndex(expression.source, symbol, index);
      return sourceType === "vector3" || sourceType === "vector4"
        ? "float"
        : extractContainerValueFromType(sourceType) ?? (sourceType === "any[]" ? "any" : undefined);
    }
    case "if": {
      const thenType = inferAstBlockReturnTypeWithIndex(expression.thenBlock, symbol, index);
      const elseType = expression.elseBlock ? inferAstBlockReturnTypeWithIndex(expression.elseBlock, symbol, index) : undefined;
      return thenType && elseType && thenType === elseType ? thenType : undefined;
    }
    case "exitWith":
      return inferAstBlockReturnTypeWithIndex(expression.block, symbol, index);
    case "invoke":
      if (expression.operator === "spawn") {
        return "thread_handle";
      }
      if (expression.callee.kind === "identifier") {
        return intrinsicGlobalFunctionReturnTypes.get(expression.callee.name.toLowerCase()) ?? inferIndexedIdentifierType(index, expression.callee.name) ?? "any";
      }
      return inferAstExpressionType(expression, new Map(), new Map()) ?? "any";
    case "macroCall":
      if (isBooleanLikeMacroName(expression.name.toLowerCase())) {
        return "bool";
      }
      if (expression.name.toLowerCase() === "ifcheck") {
        return chooseBestSpecificType([
          expression.args[1] ? inferAstExpressionTypeWithIndex(expression.args[1], symbol, index) : undefined,
          expression.args[2] ? inferAstExpressionTypeWithIndex(expression.args[2], symbol, index) : undefined
        ]);
      }
      if ((expression.name.toLowerCase() === "struct_new" || expression.name.toLowerCase() === "struct_newp") && expression.args[0]?.kind === "identifier") {
        return `struct:${expression.args[0].name}`;
      }
      if ((expression.name.toLowerCase() === "new" || expression.name.toLowerCase() === "newp") && expression.args[0]?.kind === "identifier") {
        return `class:${expression.args[0].name}`;
      }
      if (expression.name.toLowerCase() === "super" && symbol.ownerName && symbol.ownerKind) {
        const info = index.typesByLowerName.get(typeIndexKey({ name: symbol.ownerName, kind: symbol.ownerKind }));
        const baseOwner = info?.baseName ? resolveIndexedTypeOwner(index, `${symbol.ownerKind}:${info.baseName}`) : undefined;
        const baseMethod = resolveReSdkMember(index, baseOwner, symbol.name, symbol.ownerKind === "struct" ? "structMember" : "method");
        if (baseMethod?.functionReturnType) {
          return baseMethod.functionReturnType;
        }
      }
      const intrinsicType = inferIntrinsicMacroReturnType(expression);
      if (intrinsicType) {
        return intrinsicType;
      }
      const argumentType = expression.args[0] ? inferAstExpressionTypeWithIndex(expression.args[0], symbol, index) : undefined;
      const registeredReturnType = inferRegisteredCommandReturnType(expression.name, expression.args.length > 0 ? "function" : "nular", undefined, argumentType);
      if (registeredReturnType) {
        return registeredReturnType;
      }
      if (expression.name.toLowerCase() === "callself" || expression.name.toLowerCase() === "callselfparams") {
        const memberName = getMacroIdentifierArg(expression.args[0]);
        if (memberName && symbol.ownerName && symbol.ownerKind) {
          return resolveReSdkMember(index, { name: symbol.ownerName, kind: symbol.ownerKind }, memberName, symbol.ownerKind === "struct" ? "structMember" : "method")?.functionReturnType;
        }
      }
      if (expression.name.toLowerCase() === "getself") {
        const propertyName = getMacroIdentifierArg(expression.args[0]);
        if (propertyName && symbol.ownerName && symbol.ownerKind) {
          return resolveReSdkMember(index, { name: symbol.ownerName, kind: symbol.ownerKind }, propertyName, "property")?.valueType;
        }
      }
      if ((expression.name.toLowerCase() === "callfunc" || expression.name.toLowerCase() === "callfuncparams") && expression.args[1]?.kind === "identifier") {
        const receiverOwner = inferAstOwnerFromExpressionWithIndex(expression.args[0], symbol, index);
        const method = resolveReSdkMember(index, receiverOwner, expression.args[1].name, "method");
        return method?.functionReturnType;
      }
      if ((expression.name.toLowerCase() === "getvar" || expression.name.toLowerCase() === "setvar") && expression.args[1]?.kind === "identifier") {
        const receiverOwner = inferAstOwnerFromExpressionWithIndex(expression.args[0], symbol, index);
        const property = resolveReSdkMember(index, receiverOwner, expression.args[1].name, "property");
        return property?.valueType;
      }
      if (expression.name.toLowerCase() === "typegetvar") {
        const varName = getMacroIdentifierArg(expression.args[1]);
        return varName ? inferTypeVarValueType(index, varName) : undefined;
      }
      if (expression.name.toLowerCase() === "typegetfromobject" || expression.name.toLowerCase() === "typegetfromstring") {
        return "object";
      }
      if (expression.name.toLowerCase() === "startupdateparams" || expression.name.toLowerCase() === "startupdate") {
        return "thread_handle";
      }
      return inferAstExpressionType(expression, new Map(), new Map());
    default:
      return inferAstExpressionType(expression, new Map(), new Map());
  }
}

function inferAstBlockReturnTypeWithIndex(block: SqfAstBlock, symbol: IndexedSymbol, index: WorkspaceSymbolIndex): string | undefined {
  const candidates = block.statements
    .filter((statement): statement is Extract<SqfAstStatement, { kind: "expression" }> => statement.kind === "expression")
    .map((statement) => inferAstExpressionTypeWithIndex(statement.expression, symbol, index))
    .filter((type): type is string => !!type);
  const unique = Array.from(new Set(candidates));
  return unique.length === 1 ? unique[0] : undefined;
}

function inferAstOwnerFromExpressionWithIndex(
  expression: SqfAstExpression | undefined,
  symbol: IndexedSymbol,
  index: WorkspaceSymbolIndex
): ReSdkOwnerRef | undefined {
  if (!expression) {
    return undefined;
  }
  if (expression.kind === "identifier") {
    if (["self", "this", "_self"].includes(expression.name.toLowerCase()) && symbol.ownerName && symbol.ownerKind) {
      return { name: symbol.ownerName, kind: symbol.ownerKind };
    }
    const localType = getLocalSymbolType(symbol, expression.name, index);
    return resolveIndexedTypeOwner(index, localType);
  }
  if (expression.kind === "macroCall") {
    const loweredName = expression.name.toLowerCase();
    if ((loweredName === "callself" || loweredName === "callselfparams") && expression.args[0]?.kind === "identifier" && symbol.ownerName && symbol.ownerKind) {
      const method = resolveReSdkMember(index, { name: symbol.ownerName, kind: symbol.ownerKind }, expression.args[0].name, symbol.ownerKind === "struct" ? "structMember" : "method");
      return resolveIndexedTypeOwner(index, method?.functionReturnType);
    }
    if ((loweredName === "callfunc" || loweredName === "callfuncparams") && expression.args[1]?.kind === "identifier") {
      const receiverOwner = inferAstOwnerFromExpressionWithIndex(expression.args[0], symbol, index);
      const method = resolveReSdkMember(index, receiverOwner, expression.args[1].name, "method");
      return resolveIndexedTypeOwner(index, method?.functionReturnType);
    }
    if ((loweredName === "getvar" || loweredName === "setvar") && expression.args[1]?.kind === "identifier") {
      const receiverOwner = inferAstOwnerFromExpressionWithIndex(expression.args[0], symbol, index);
      const property = resolveReSdkMember(index, receiverOwner, expression.args[1].name, "property");
      return resolveIndexedTypeOwner(index, property?.valueType);
    }
    if ((loweredName === "new" || loweredName === "newp") && expression.args[0]?.kind === "identifier") {
      return resolveIndexedTypeOwner(index, `class:${expression.args[0].name}`);
    }
    if ((loweredName === "struct_new" || loweredName === "struct_newp") && expression.args[0]?.kind === "identifier") {
      return resolveIndexedTypeOwner(index, `struct:${expression.args[0].name}`);
    }
  }
  return resolveIndexedTypeOwner(index, inferAstExpressionTypeWithIndex(expression, symbol, index));
}

function extractContainerValueFromType(type: string | undefined): string | undefined {
  if (!type) {
    return undefined;
  }
  const mapMatch = /^map<[^;>]+;([^>]+)>$/i.exec(type.trim());
  if (mapMatch) {
    return mapMatch[1].trim();
  }
  const arrayMatch = /^(.+)\[\]$/i.exec(type.trim());
  return arrayMatch?.[1].trim();
}

function extractContainerKeyFromType(type: string | undefined): string | undefined {
  if (!type) {
    return undefined;
  }
  const mapMatch = /^map<([^;>]+);[^>]+>$/i.exec(type.trim());
  return mapMatch?.[1].trim();
}

function inferContainerValueType(
  expression: SqfAstExpression,
  symbol: IndexedSymbol,
  index: WorkspaceSymbolIndex
): string | undefined {
  const propertyName = getSelfPropertyName(expression);
  if (propertyName && symbol.ownerName && symbol.ownerKind) {
    return inferOwnerPropertyContainerValueType(index, { name: symbol.ownerName, kind: symbol.ownerKind }, propertyName);
  }
  return undefined;
}

function inferContainerKeyType(
  expression: SqfAstExpression,
  symbol: IndexedSymbol,
  index: WorkspaceSymbolIndex
): string | undefined {
  const propertyName = getSelfPropertyName(expression);
  if (propertyName && symbol.ownerName && symbol.ownerKind) {
    return inferOwnerPropertyContainerKeyType(index, { name: symbol.ownerName, kind: symbol.ownerKind }, propertyName);
  }
  return undefined;
}

function collectPropertyAliases(block: SqfAstBlock, propertyName: string): Set<string> {
  const aliases = new Set<string>();
  for (const statement of block.statements) {
    if (statement.kind !== "assignment") {
      continue;
    }
    if (getSelfPropertyName(statement.expression)?.toLowerCase() === propertyName.toLowerCase()) {
      aliases.add(statement.name.toLowerCase());
    }
  }
  return aliases;
}

function isPropertyContainerExpression(expression: SqfAstExpression, propertyName: string, aliases: Set<string>): boolean {
  if (getSelfPropertyName(expression)?.toLowerCase() === propertyName.toLowerCase()) {
    return true;
  }
  return expression.kind === "identifier" && aliases.has(expression.name.toLowerCase());
}

function inferContainerWriteElementType(
  expression: SqfAstExpression,
  method: IndexedSymbol,
  index: WorkspaceSymbolIndex
): string | undefined {
  if (expression.kind === "identifier") {
    if (/^INV_LIST_/i.test(expression.name)) {
      return "enum.InventorySlot[]";
    }
    if (/^INV_/i.test(expression.name)) {
      return "enum.InventorySlot";
    }
    return getDirectLocalSymbolType(method, expression.name) ?? inferRegisteredCommandReturnType(expression.name, "nular");
  }
  return inferAstExpressionTypeWithIndex(expression, method, index);
}

function collectContainerWriteTypes(
  expression: SqfAstExpression,
  propertyName: string,
  aliases: Set<string>,
  method: IndexedSymbol,
  index: WorkspaceSymbolIndex,
  types: string[],
  elementIndex: number
): void {
  switch (expression.kind) {
    case "binary":
      if (expression.operator.toLowerCase() === "set" && isPropertyContainerExpression(expression.left, propertyName, aliases) && expression.right.kind === "array") {
        const elementType = inferContainerWriteElementType(expression.right.elements[elementIndex] ?? expression.right, method, index);
        if (elementType) {
          types.push(elementType);
        }
      }
      collectContainerWriteTypes(expression.left, propertyName, aliases, method, index, types, elementIndex);
      collectContainerWriteTypes(expression.right, propertyName, aliases, method, index, types, elementIndex);
      return;
    case "macroCall":
      for (const argument of expression.args) {
        collectContainerWriteTypes(argument, propertyName, aliases, method, index, types, elementIndex);
      }
      return;
    case "array":
      for (const element of expression.elements) {
        collectContainerWriteTypes(element, propertyName, aliases, method, index, types, elementIndex);
      }
      return;
    case "code":
      collectMethodContainerWriteTypes(expression.block, propertyName, aliases, method, index, types, elementIndex);
      return;
    case "unary":
      collectContainerWriteTypes(expression.operand, propertyName, aliases, method, index, types, elementIndex);
      return;
    case "invoke":
      if (expression.target) {
        collectContainerWriteTypes(expression.target, propertyName, aliases, method, index, types, elementIndex);
      }
      collectContainerWriteTypes(expression.callee, propertyName, aliases, method, index, types, elementIndex);
      return;
    case "select":
      collectContainerWriteTypes(expression.source, propertyName, aliases, method, index, types, elementIndex);
      collectContainerWriteTypes(expression.index, propertyName, aliases, method, index, types, elementIndex);
      return;
    case "exitWith":
      if (expression.condition) {
        collectContainerWriteTypes(expression.condition, propertyName, aliases, method, index, types, elementIndex);
      }
      collectMethodContainerWriteTypes(expression.block, propertyName, aliases, method, index, types, elementIndex);
      return;
    case "if":
      collectContainerWriteTypes(expression.condition, propertyName, aliases, method, index, types, elementIndex);
      collectMethodContainerWriteTypes(expression.thenBlock, propertyName, aliases, method, index, types, elementIndex);
      if (expression.elseBlock) {
        collectMethodContainerWriteTypes(expression.elseBlock, propertyName, aliases, method, index, types, elementIndex);
      }
      return;
    case "identifier":
    case "string":
    case "number":
    case "boolean":
    case "unknown":
      return;
  }
}

function collectMethodContainerWriteTypes(
  block: SqfAstBlock,
  propertyName: string,
  aliases: Set<string>,
  method: IndexedSymbol,
  index: WorkspaceSymbolIndex,
  types: string[],
  elementIndex: number
): void {
  for (const statement of block.statements) {
    if (statement.kind === "assignment") {
      collectContainerWriteTypes(statement.expression, propertyName, aliases, method, index, types, elementIndex);
    } else if (statement.kind === "expression") {
      collectContainerWriteTypes(statement.expression, propertyName, aliases, method, index, types, elementIndex);
    }
  }
}

function inferOwnerPropertyContainerValueType(
  index: WorkspaceSymbolIndex,
  owner: ReSdkOwnerRef,
  propertyName: string
): string | undefined {
  const cacheKey = `${owner.kind}:${owner.name.toLowerCase()}:${propertyName.toLowerCase()}`;
  if (hasCachedInference(propertyContainerValueTypeCache, index, cacheKey)) {
    return getCachedInference(propertyContainerValueTypeCache, index, cacheKey);
  }

  const property = resolveReSdkMember(index, owner, propertyName, "property");
  const propertyValueType = extractContainerValueFromType(property?.valueType);
  if (propertyValueType && propertyValueType.toLowerCase() !== "any") {
    return setCachedInference(propertyContainerValueTypeCache, index, cacheKey, propertyValueType);
  }

  const info = index.typesByLowerName.get(typeIndexKey(owner));
  const methods = info?.methodsByLowerName ? Array.from(info.methodsByLowerName.values()).flat() : [];
  const writeTypes: string[] = [];
  for (const method of methods) {
    if (!method.functionAst) {
      continue;
    }
    const aliases = collectPropertyAliases(method.functionAst, propertyName);
    collectMethodContainerWriteTypes(method.functionAst, propertyName, aliases, method, index, writeTypes, 1);
  }

  return setCachedInference(propertyContainerValueTypeCache, index, cacheKey, chooseBestSpecificType(writeTypes));
}

function inferOwnerPropertyContainerKeyType(
  index: WorkspaceSymbolIndex,
  owner: ReSdkOwnerRef,
  propertyName: string
): string | undefined {
  const cacheKey = `${owner.kind}:${owner.name.toLowerCase()}:${propertyName.toLowerCase()}`;
  if (hasCachedInference(propertyContainerKeyTypeCache, index, cacheKey)) {
    return getCachedInference(propertyContainerKeyTypeCache, index, cacheKey);
  }

  const property = resolveReSdkMember(index, owner, propertyName, "property");
  const propertyKeyType = extractContainerKeyFromType(property?.valueType);
  if (propertyKeyType && propertyKeyType.toLowerCase() !== "any") {
    return setCachedInference(propertyContainerKeyTypeCache, index, cacheKey, propertyKeyType);
  }

  const info = index.typesByLowerName.get(typeIndexKey(owner));
  const methods = info?.methodsByLowerName ? Array.from(info.methodsByLowerName.values()).flat() : [];
  const writeTypes: string[] = [];
  for (const method of methods) {
    if (!method.functionAst) {
      continue;
    }
    const aliases = collectPropertyAliases(method.functionAst, propertyName);
    collectMethodContainerWriteTypes(method.functionAst, propertyName, aliases, method, index, writeTypes, 0);
  }

  return setCachedInference(propertyContainerKeyTypeCache, index, cacheKey, chooseDominantParameterType(writeTypes, index));
}

function findReturnExpressions(block: SqfAstBlock): SqfAstExpression[] {
  const result: SqfAstExpression[] = [];
  for (const statement of block.statements) {
    if (statement.kind !== "expression") {
      continue;
    }
    if (statement.expression.kind === "macroCall" && /^(?:objparams|ctxparams)(?:_\d+)?$/i.test(statement.expression.name)) {
      continue;
    }
    result.push(statement.expression);
  }
  return result;
}

function findExpressionAtRange(expression: SqfAstExpression, start: number, end: number): SqfAstExpression | undefined {
  if (expression.start === start && expression.end === end) {
    return expression;
  }
  switch (expression.kind) {
    case "array":
      for (const element of expression.elements) {
        const found = findExpressionAtRange(element, start, end);
        if (found) return found;
      }
      return undefined;
    case "code":
      return findExpressionInBlockAtRange(expression.block, start, end);
    case "unary":
      return findExpressionAtRange(expression.operand, start, end);
    case "binary":
      return findExpressionAtRange(expression.left, start, end) ?? findExpressionAtRange(expression.right, start, end);
    case "macroCall":
      for (const argument of expression.args) {
        const found = findExpressionAtRange(argument, start, end);
        if (found) return found;
      }
      return undefined;
    case "invoke":
      return (expression.target ? findExpressionAtRange(expression.target, start, end) : undefined)
        ?? findExpressionAtRange(expression.callee, start, end);
    case "select":
      return findExpressionAtRange(expression.source, start, end) ?? findExpressionAtRange(expression.index, start, end);
    case "exitWith":
      return (expression.condition ? findExpressionAtRange(expression.condition, start, end) : undefined)
        ?? findExpressionInBlockAtRange(expression.block, start, end);
    case "if":
      return findExpressionAtRange(expression.condition, start, end)
        ?? findExpressionInBlockAtRange(expression.thenBlock, start, end)
        ?? (expression.elseBlock ? findExpressionInBlockAtRange(expression.elseBlock, start, end) : undefined);
    case "identifier":
    case "string":
    case "number":
    case "boolean":
    case "unknown":
      return undefined;
  }
}

function findExpressionInBlockAtRange(block: SqfAstBlock, start: number, end: number): SqfAstExpression | undefined {
  for (const statement of block.statements) {
    if (statement.kind === "assignment") {
      const found = findExpressionAtRange(statement.expression, start, end);
      if (found) return found;
    } else if (statement.kind === "expression") {
      const found = findExpressionAtRange(statement.expression, start, end);
      if (found) return found;
    } else if (statement.kind === "params") {
      for (const parameter of statement.parameters) {
        if (parameter.defaultValue) {
          const found = findExpressionAtRange(parameter.defaultValue, start, end);
          if (found) return found;
        }
      }
    }
  }
  return undefined;
}

export function inferLocalFlowType(
  index: WorkspaceSymbolIndex,
  functionSymbol: IndexedSymbol,
  local: LocalSymbolInfo,
  offset: number
): string | undefined {
  if (!functionSymbol.functionAst) {
    return local.type;
  }

  const candidates: Array<{ valueStart: number; valueEnd: number }> = [];
  const offsetIsOnDefinition = offset >= local.definitionStart && offset <= local.definitionEnd;
  if (local.valueStart !== undefined && local.valueEnd !== undefined && (local.valueEnd <= offset || offsetIsOnDefinition)) {
    candidates.push({ valueStart: local.valueStart, valueEnd: local.valueEnd });
  }
  for (const reference of functionSymbol.localReferences ?? []) {
    const offsetIsOnWrite = offset >= reference.start && offset <= reference.end;
    if (!reference.isWrite
      || reference.definitionStart !== local.definitionStart
      || reference.definitionEnd !== local.definitionEnd
      || reference.valueStart === undefined
      || reference.valueEnd === undefined
      || (reference.valueEnd > offset && !offsetIsOnWrite)) {
      continue;
    }
    candidates.push({ valueStart: reference.valueStart, valueEnd: reference.valueEnd });
  }

  candidates.sort((left, right) => right.valueEnd - left.valueEnd);
  for (const candidate of candidates) {
    const expression = findExpressionInBlockAtRange(functionSymbol.functionAst, candidate.valueStart, candidate.valueEnd);
    if (!expression) {
      continue;
    }
    const inferred = inferAstExpressionTypeWithIndex(expression, functionSymbol, index);
    if (inferred) {
      return inferred;
    }
  }

  const usageType = inferLocalTypeFromMemberUsage(functionSymbol, local.name, index);
  if (usageType) {
    return usageType;
  }
  return local.type ?? (local.source === "param" ? "any" : undefined);
}

function inferReSdkMemberReturnType(symbol: IndexedSymbol, index: WorkspaceSymbolIndex): string | undefined {
  if (!symbol.functionAst || !symbol.ownerName || !symbol.ownerKind) {
    return undefined;
  }

  const returnTypes = findReturnExpressions(symbol.functionAst)
    .map((expression) => inferAstExpressionTypeWithIndex(expression, symbol, index));
  return chooseBestSpecificType(returnTypes);
}

function hasIndexedReturnInferenceCandidate(expression: SqfAstExpression): boolean {
  switch (expression.kind) {
    case "binary":
      if ((expression.operator.toLowerCase() === "getordefault" || expression.operator.toLowerCase() === "get") && !!getSelfPropertyName(expression.left)) {
        return true;
      }
      return hasIndexedReturnInferenceCandidate(expression.left) || hasIndexedReturnInferenceCandidate(expression.right);
    case "array":
      return expression.elements.some(hasIndexedReturnInferenceCandidate);
    case "code":
      return expression.block.statements.some((statement) =>
        (statement.kind === "assignment" || statement.kind === "expression") && hasIndexedReturnInferenceCandidate(statement.expression)
      );
    case "unary":
      return hasIndexedReturnInferenceCandidate(expression.operand);
    case "macroCall":
      return expression.args.some(hasIndexedReturnInferenceCandidate);
    case "invoke":
      return (!!expression.target && hasIndexedReturnInferenceCandidate(expression.target)) || hasIndexedReturnInferenceCandidate(expression.callee);
    case "select":
      return hasIndexedReturnInferenceCandidate(expression.source) || hasIndexedReturnInferenceCandidate(expression.index);
    case "exitWith":
      return (!!expression.condition && hasIndexedReturnInferenceCandidate(expression.condition))
        || expression.block.statements.some((statement) => (statement.kind === "assignment" || statement.kind === "expression") && hasIndexedReturnInferenceCandidate(statement.expression));
    case "if":
      return hasIndexedReturnInferenceCandidate(expression.condition)
        || expression.thenBlock.statements.some((statement) => (statement.kind === "assignment" || statement.kind === "expression") && hasIndexedReturnInferenceCandidate(statement.expression))
        || !!expression.elseBlock?.statements.some((statement) => (statement.kind === "assignment" || statement.kind === "expression") && hasIndexedReturnInferenceCandidate(statement.expression));
    case "identifier":
    case "string":
    case "number":
    case "boolean":
    case "unknown":
      return false;
  }
}

function needsIndexedReturnInference(symbol: IndexedSymbol): boolean {
  if ((symbol.kind !== "classMethod" && symbol.kind !== "structMember") || !symbol.functionAst) {
    return false;
  }
  if (symbol.signatureSource === "decl" && symbol.functionReturnType) {
    return false;
  }
  if (symbol.functionReturnType && !["object", "any", "any[]"].includes(symbol.functionReturnType)) {
    return false;
  }
  const returnExpressions = findReturnExpressions(symbol.functionAst);
  if (returnExpressions.some(hasIndexedReturnInferenceCandidate)) {
    return true;
  }
  return !symbol.functionReturnType && returnExpressions.some((expression) => {
    if (expression.kind !== "identifier") {
      return false;
    }
    const assignment = (symbol.localSymbols ?? [])
      .filter((local) =>
        local.source === "assignment"
        && local.name.toLowerCase() === expression.name.toLowerCase()
        && local.valueStart !== undefined
        && local.valueEnd !== undefined
        && local.valueEnd <= expression.start
      )
      .sort((left, right) => (right.valueEnd ?? 0) - (left.valueEnd ?? 0))[0];
    if (assignment?.valueStart === undefined || assignment.valueEnd === undefined) {
      return false;
    }
    const assignedExpression = findExpressionInBlockAtRange(symbol.functionAst!, assignment.valueStart, assignment.valueEnd);
    return !!assignedExpression && (hasIndexedReturnInferenceCandidate(assignedExpression) || isGetterLikeReSdkCall(assignedExpression));
  });
}

function isGetterLikeReSdkCall(expression: SqfAstExpression): boolean {
  if (expression.kind !== "macroCall" || !/^(?:callself|callselfparams|callfunc|callfuncparams|allfunc|allfuncparams)$/i.test(expression.name)) {
    return false;
  }
  const memberExpression = /^callself/i.test(expression.name) ? expression.args[0] : expression.args[1];
  const memberName = getMacroIdentifierArg(memberExpression);
  return !!memberName && /^(?:get|find|select|pick)/i.test(memberName);
}

function extractParametersFromAst(block: SqfAstBlock): SqfAstParameter[] {
  for (const statement of block.statements) {
    if (statement.kind === "params") {
      return statement.parameters;
    }
  }
  return [];
}

function analyzeAstBlock(
  block: SqfAstBlock,
  initialTypes: Map<string, string>,
  functionReturnTypes: Map<string, string>
): { knownTypes: Map<string, string>; returnCandidates: string[] } {
  const knownTypes = new Map(initialTypes);
  const returnCandidates: string[] = [];

  for (const statement of block.statements) {
    if (statement.kind === "assignment") {
      const inferredType = inferAstExpressionType(statement.expression, knownTypes, functionReturnTypes);
      if (inferredType) {
        knownTypes.set(statement.name, inferredType);
      }
      continue;
    }

    if (statement.kind === "expression") {
      const inferredType = inferAstExpressionType(statement.expression, knownTypes, functionReturnTypes);
      if (inferredType && statement.expression.kind !== "code") {
        returnCandidates.push(inferredType);
      }
    }
  }

  return { knownTypes, returnCandidates };
}

function pushBindingToStack(stacks: Map<string, LocalSymbolInfo[]>, binding: LocalSymbolInfo): void {
  const key = binding.name.toLowerCase();
  const bucket = stacks.get(key) ?? [];
  bucket.push(binding);
  stacks.set(key, bucket);
}

function popBindingFromStack(stacks: Map<string, LocalSymbolInfo[]>, binding: LocalSymbolInfo): void {
  const key = binding.name.toLowerCase();
  const bucket = stacks.get(key);
  if (!bucket) {
    return;
  }
  const index = bucket.lastIndexOf(binding);
  if (index >= 0) {
    bucket.splice(index, 1);
  }
  if (bucket.length === 0) {
    stacks.delete(key);
  }
}

function resolveCurrentBinding(stacks: Map<string, LocalSymbolInfo[]>, name: string): LocalSymbolInfo | undefined {
  const bucket = stacks.get(name.toLowerCase());
  return bucket?.[bucket.length - 1];
}

function collectLocalReferencesFromExpression(
  expression: SqfAstExpression,
  knownTypes: Map<string, string>,
  functionReturnTypes: Map<string, string>,
  stacks: Map<string, LocalSymbolInfo[]>,
  symbols: LocalSymbolInfo[],
  references: LocalReferenceInfo[]
): void {
  switch (expression.kind) {
    case "identifier": {
      if (!expression.name.startsWith("_")) {
        return;
      }
      const binding = resolveCurrentBinding(stacks, expression.name);
      if (binding) {
        references.push({
          name: expression.name,
          start: expression.start,
          end: expression.end,
          definitionStart: binding.definitionStart,
          definitionEnd: binding.definitionEnd,
          isWrite: false
        });
      }
      return;
    }
    case "array":
      for (const element of expression.elements) {
        collectLocalReferencesFromExpression(element, knownTypes, functionReturnTypes, stacks, symbols, references);
      }
      return;
    case "code":
      collectLocalScopeData(expression.block, new Map(knownTypes), functionReturnTypes, stacks, symbols, references);
      return;
    case "unary":
      collectLocalReferencesFromExpression(expression.operand, knownTypes, functionReturnTypes, stacks, symbols, references);
      return;
    case "binary":
      if (expression.operator.toLowerCase() === "foreach" && expression.left.kind === "code") {
        collectForEachExpressionScope(expression, knownTypes, functionReturnTypes, stacks, symbols, references);
        return;
      }
      collectLocalReferencesFromExpression(expression.left, knownTypes, functionReturnTypes, stacks, symbols, references);
      collectLocalReferencesFromExpression(expression.right, knownTypes, functionReturnTypes, stacks, symbols, references);
      return;
    case "macroCall":
      for (const argument of expression.args) {
        collectLocalReferencesFromExpression(argument, knownTypes, functionReturnTypes, stacks, symbols, references);
      }
      return;
    case "invoke":
      if (expression.target) {
        collectLocalReferencesFromExpression(expression.target, knownTypes, functionReturnTypes, stacks, symbols, references);
      }
      collectLocalReferencesFromExpression(expression.callee, knownTypes, functionReturnTypes, stacks, symbols, references);
      return;
    case "select":
      collectLocalReferencesFromExpression(expression.source, knownTypes, functionReturnTypes, stacks, symbols, references);
      collectLocalReferencesFromExpression(expression.index, knownTypes, functionReturnTypes, stacks, symbols, references);
      return;
    case "exitWith":
      if (expression.condition) {
        collectLocalReferencesFromExpression(expression.condition, knownTypes, functionReturnTypes, stacks, symbols, references);
      }
      collectLocalScopeData(expression.block, new Map(knownTypes), functionReturnTypes, stacks, symbols, references);
      return;
    case "if":
      collectLocalReferencesFromExpression(expression.condition, knownTypes, functionReturnTypes, stacks, symbols, references);
      collectLocalScopeData(expression.thenBlock, new Map(knownTypes), functionReturnTypes, stacks, symbols, references);
      if (expression.elseBlock) {
        collectLocalScopeData(expression.elseBlock, new Map(knownTypes), functionReturnTypes, stacks, symbols, references);
      }
      return;
    case "string":
    case "number":
    case "boolean":
    case "unknown":
      return;
  }
}

function inferForEachElementType(
  collection: SqfAstExpression,
  knownTypes: Map<string, string>,
  functionReturnTypes: Map<string, string>
): string | undefined {
  if (collection.kind === "array") {
    return chooseBestSpecificType(collection.elements.map((element) => inferAstExpressionType(element, knownTypes, functionReturnTypes)));
  }

  const collectionType = inferAstExpressionType(collection, knownTypes, functionReturnTypes);
  if (collectionType === "vector3" || collectionType === "vector4") {
    return "float";
  }
  return extractContainerValueFromType(collectionType);
}

function collectForEachExpressionScope(
  expression: Extract<SqfAstExpression, { kind: "binary" }>,
  knownTypes: Map<string, string>,
  functionReturnTypes: Map<string, string>,
  stacks: Map<string, LocalSymbolInfo[]>,
  symbols: LocalSymbolInfo[],
  references: LocalReferenceInfo[]
): void {
  collectLocalReferencesFromExpression(expression.right, knownTypes, functionReturnTypes, stacks, symbols, references);
  if (expression.left.kind !== "code") {
    collectLocalReferencesFromExpression(expression.left, knownTypes, functionReturnTypes, stacks, symbols, references);
    return;
  }

  const loopKnownTypes = new Map(knownTypes);
  const elementType = inferForEachElementType(expression.right, knownTypes, functionReturnTypes) ?? "any";
  const loopBindings: LocalSymbolInfo[] = [
    {
      name: "_x",
      type: elementType,
      source: "param",
      definitionStart: expression.left.block.start,
      definitionEnd: expression.left.block.start,
      scopeStart: expression.left.block.start,
      scopeEnd: expression.left.block.end,
    },
    {
      name: "_forEachIndex",
      type: "int",
      source: "param",
      definitionStart: expression.left.block.start,
      definitionEnd: expression.left.block.start,
      scopeStart: expression.left.block.start,
      scopeEnd: expression.left.block.end,
    }
  ];

  if (elementType) {
    loopKnownTypes.set("_x", elementType);
  }
  loopKnownTypes.set("_forEachIndex", "int");
  for (const binding of loopBindings) {
    symbols.push(binding);
    pushBindingToStack(stacks, binding);
  }
  collectLocalScopeData(expression.left.block, loopKnownTypes, functionReturnTypes, stacks, symbols, references);
  for (let index = loopBindings.length - 1; index >= 0; --index) {
    popBindingFromStack(stacks, loopBindings[index]);
  }
}

function collectLocalScopeData(
  block: SqfAstBlock,
  knownTypes: Map<string, string>,
  functionReturnTypes: Map<string, string>,
  stacks: Map<string, LocalSymbolInfo[]>,
  symbols: LocalSymbolInfo[],
  references: LocalReferenceInfo[]
): void {
  const scopeBindings: LocalSymbolInfo[] = [];

  for (const statement of block.statements) {
    if (statement.kind === "params") {
      for (const parameter of statement.parameters) {
        const parameterType = knownTypes.get(parameter.name)
          ?? (parameter.defaultValue ? inferAstExpressionType(parameter.defaultValue, knownTypes, functionReturnTypes) : undefined)
          ?? "any";
        if (parameterType) {
          knownTypes.set(parameter.name, parameterType);
        }
        const binding: LocalSymbolInfo = {
          name: parameter.name,
          type: parameterType,
          source: "param",
          definitionStart: parameter.start,
          definitionEnd: parameter.end,
          scopeStart: block.start,
          scopeEnd: block.end,
        };
        symbols.push(binding);
        scopeBindings.push(binding);
        pushBindingToStack(stacks, binding);
      }
      continue;
    }

    if (statement.kind === "private") {
      for (const local of statement.names) {
        const binding: LocalSymbolInfo = {
          name: local.name,
          source: "assignment",
          definitionStart: local.start,
          definitionEnd: local.end,
          scopeStart: block.start,
          scopeEnd: block.end,
        };
        symbols.push(binding);
        scopeBindings.push(binding);
        pushBindingToStack(stacks, binding);
      }
      continue;
    }

    if (statement.kind === "assignment") {
      collectLocalReferencesFromExpression(statement.expression, knownTypes, functionReturnTypes, stacks, symbols, references);
      const inferredType = inferAstExpressionType(statement.expression, knownTypes, functionReturnTypes);
      if (inferredType) {
        knownTypes.set(statement.name, inferredType);
      }

      if (!(statement.isPrivate || statement.name.startsWith("_"))) {
        continue;
      }

      const existingBinding = resolveCurrentBinding(stacks, statement.name);
      const createsBinding = statement.isPrivate || !existingBinding;
      if (createsBinding) {
        const binding: LocalSymbolInfo = {
          name: statement.name,
          type: inferredType,
          source: "assignment",
          definitionStart: statement.nameStart,
          definitionEnd: statement.nameEnd,
          valueStart: statement.expression.start,
          valueEnd: statement.expression.end,
          scopeStart: block.start,
          scopeEnd: block.end,
        };
        symbols.push(binding);
        scopeBindings.push(binding);
        pushBindingToStack(stacks, binding);
      } else if (existingBinding) {
        references.push({
          name: statement.name,
          start: statement.nameStart,
          end: statement.nameEnd,
          definitionStart: existingBinding.definitionStart,
          definitionEnd: existingBinding.definitionEnd,
          valueStart: statement.expression.start,
          valueEnd: statement.expression.end,
          isWrite: true
        });
      }
      continue;
    }

    collectLocalReferencesFromExpression(statement.expression, knownTypes, functionReturnTypes, stacks, symbols, references);
  }

  for (let index = scopeBindings.length - 1; index >= 0; --index) {
    popBindingFromStack(stacks, scopeBindings[index]);
  }
}

function collectLocalSymbols(
  block: SqfAstBlock,
  functionParameters: FunctionParameter[],
  functionReturnTypes: Map<string, string>,
  initialKnownTypes?: Map<string, string>
): { symbols: LocalSymbolInfo[]; references: LocalReferenceInfo[] } {
  const symbols: LocalSymbolInfo[] = [];
  const references: LocalReferenceInfo[] = [];
  const knownTypes = new Map<string, string>(initialKnownTypes);
  for (const parameter of functionParameters) {
    if (parameter.type) {
      knownTypes.set(parameter.name, parameter.type);
    }
  }

  collectLocalScopeData(block, knownTypes, functionReturnTypes, new Map(), symbols, references);
  symbols.sort((left, right) => left.name.localeCompare(right.name) || left.definitionStart - right.definitionStart);
  references.sort((left, right) => left.start - right.start);
  return { symbols, references };
}

function inferAstBlockReturnType(
  block: SqfAstBlock,
  initialTypes: Map<string, string>,
  functionReturnTypes: Map<string, string>
): string | undefined {
  const { returnCandidates } = analyzeAstBlock(block, initialTypes, functionReturnTypes);
  const uniqueCandidates = Array.from(new Set(returnCandidates));
  return uniqueCandidates.length === 1 ? uniqueCandidates[0] : undefined;
}

function parseParamsStatement(statement: string): Array<{ name: string; optional?: boolean; defaultValue?: string }> {
  const trimmed = statement.trim();
  const paramsMatch = /^(?:_this\s+)?params\b/.exec(trimmed);
  if (!paramsMatch) {
    return [];
  }

  const startBracket = trimmed.indexOf("[", paramsMatch[0].length);
  const endBracket = trimmed.lastIndexOf("]");
  if (startBracket < 0 || endBracket <= startBracket) {
    return [];
  }

  const content = trimmed.slice(startBracket + 1, endBracket);
  const entries = splitTopLevel(content, ",").map((entry) => entry.trim()).filter(Boolean);
  const parameters: Array<{ name: string; optional?: boolean; defaultValue?: string }> = [];

  for (const entry of entries) {
    const directMatch = /^(?:"([^"]+)"|'([^']+)')$/.exec(entry);
    if (directMatch) {
      parameters.push({ name: directMatch[1] || directMatch[2] });
      continue;
    }

    if (entry.startsWith("[") && entry.endsWith("]")) {
      const parts = splitTopLevel(entry.slice(1, -1), ",").map((part) => part.trim()).filter(Boolean);
      const nameMatch = parts[0] ? /^(?:"([^"]+)"|'([^']+)')$/.exec(parts[0]) : undefined;
      if (!nameMatch) {
        continue;
      }

      parameters.push({
        name: nameMatch[1] || nameMatch[2],
        optional: parts.length > 1,
        defaultValue: parts[1]
      });
    }
  }

  return parameters;
}

function formatFunctionSignature(name: string, parameters: FunctionParameter[] | undefined, returnType: string | undefined): string {
  const parameterText = (parameters ?? [])
    .map((parameter) => `${parameter.name}${parameter.type ? `: ${parameter.type}` : ""}`)
    .join(", ");
  return `${name}(${parameterText})${returnType ? ` -> ${returnType}` : ""}`;
}

function buildFunctionSymbol(
  filePath: string,
  line: number,
  name: string,
  body: string,
  declText: string | undefined,
  bodyStartOffset: number,
  bodyEndOffset: number
): IndexedSymbol {
  const declSignature = parseDeclSignature(declText);
  if (body.length > DEEP_FUNCTION_ANALYSIS_BODY_LIMIT) {
    const functionParameters: FunctionParameter[] = declSignature.parameterTypes.map((type, index) => ({
      name: `_arg${index + 1}`,
      type,
      typeSource: "decl"
    }));
    const functionReturnType = declSignature.returnType;
    const signatureSource: IndexedSymbol["signatureSource"] = functionReturnType || functionParameters.length > 0 ? "decl" : undefined;
    return {
      name,
      kind: "globalFunction",
      filePath,
      line,
      detail: signatureSource ? `global function (${signatureSource})` : "global function",
      functionParameters,
      functionReturnType,
      signatureLabel: formatFunctionSignature(name, functionParameters, functionReturnType),
      signatureSource,
      bodyStartOffset,
      bodyEndOffset
    };
  }

  const functionAst = parseSqfBlock(body, bodyStartOffset);
  const parsedParams = extractParametersFromAst(functionAst);
  const emptyFunctionReturnTypes = new Map<string, string>();

  const functionParameters: FunctionParameter[] = parsedParams.map((parameter, index) => ({
    name: parameter.name,
    type: declSignature.parameterTypes[index] || (parameter.defaultValue ? inferAstExpressionType(parameter.defaultValue, new Map(), emptyFunctionReturnTypes) : undefined) || "any",
    typeSource: declSignature.parameterTypes[index] ? "decl" : parameter.defaultValue ? "default" : "inferred",
    optional: parameter.optional,
    defaultValue: parameter.defaultValue?.kind === "unknown" ? parameter.defaultValue.raw : undefined
  }));

  for (let index = functionParameters.length; index < declSignature.parameterTypes.length; ++index) {
    functionParameters.push({
      name: `_arg${index + 1}`,
      type: declSignature.parameterTypes[index],
      typeSource: "decl"
    });
  }

  const knownTypes = new Map<string, string>();
  for (const parameter of functionParameters) {
    if (parameter.type) {
      knownTypes.set(parameter.name, parameter.type);
    }
  }

  const analysis = analyzeAstBlock(functionAst, knownTypes, emptyFunctionReturnTypes);
  const inferredReturnCandidates = analysis.returnCandidates;
  const uniqueInferredReturnCandidates = Array.from(new Set(inferredReturnCandidates));
  const inferredReturnType = uniqueInferredReturnCandidates.length === 1 ? uniqueInferredReturnCandidates[0] : undefined;
  const functionReturnType = declSignature.returnType || inferredReturnType;
  const localScopeData = collectLocalSymbols(functionAst, functionParameters, emptyFunctionReturnTypes);
  const signatureSource: IndexedSymbol["signatureSource"] = declSignature.returnType || declSignature.parameterTypes.length > 0
    ? "decl"
    : functionParameters.length > 0
      ? "params"
      : inferredReturnType
        ? "inferred"
        : undefined;
  const signatureLabel = formatFunctionSignature(name, functionParameters, functionReturnType);

  return {
    name,
    kind: "globalFunction",
    filePath,
    line,
    detail: signatureSource === "decl"
      ? `global function (${signatureSource})`
      : functionReturnType || functionParameters.length > 0
        ? `global function (${signatureSource ?? "inferred"})`
        : "global function",
    functionParameters,
    functionReturnType,
    signatureLabel,
    signatureSource,
    functionAst,
    bodyStartOffset,
    bodyEndOffset,
    localSymbols: localScopeData.symbols,
    localReferences: localScopeData.references
  };
}

function buildMacroGeneratedFunctionSymbol(filePath: string, line: number, name: string, macroName: string): IndexedSymbol {
  return {
    name,
    kind: "globalFunction",
    filePath,
    line,
    detail: `macro-generated global function (${macroName})`,
    signatureLabel: `${name}()`,
    signatureSource: "inferred"
  };
}

function buildDslFunctionSymbol(filePath: string, line: number, name: string, detail: string): IndexedSymbol {
  return {
    name,
    kind: "globalFunction",
    filePath,
    line,
    detail,
    signatureLabel: `${name}()`,
    signatureSource: "inferred"
  };
}

function buildGlobalVariableSymbol(filePath: string, line: number, name: string): IndexedSymbol {
  return {
    name,
    kind: "globalVariable",
    filePath,
    line,
    detail: "global variable"
  };
}

function buildGlobalVariableSymbolWithType(filePath: string, line: number, name: string, expressionText: string | undefined): IndexedSymbol {
  const tempAst = expressionText ? parseSqfBlock(`__tmp = ${expressionText};`) : undefined;
  const tempStatement = tempAst?.statements[0];
  const expression = tempStatement?.kind === "assignment"
    ? tempStatement.expression
    : expressionText
      ? { kind: "unknown" as const, raw: expressionText, start: 0, end: expressionText.length }
      : undefined;
  const valueType = expression ? inferAstExpressionType(expression, new Map(), new Map()) : undefined;
  return {
    ...buildGlobalVariableSymbol(filePath, line, name),
    valueType,
    detail: valueType ? `global variable: ${valueType}` : "global variable"
  };
}

function encodeOwnerType(owner: ReSdkOwnerRef): string {
  return `${owner.kind}:${owner.name}`;
}

function inferPropertyMacroDefaultType(macroName: string): string | undefined {
  switch (macroName.toLowerCase()) {
    case "var_bool":
      return "bool";
    case "var_num":
    case "var_int":
      return "int";
    case "var_float":
      return "float";
    case "var_str":
    case "var_string":
      return "string";
    case "var_array":
      return "any[]";
    case "var_hashmap":
    case "var_map":
      return "map<any;any>";
    case "var_obj":
      return "object";
    case "var_code":
      return "code";
    case "var_vec3":
    case "var_vector":
      return "vector3";
    case "var_vec4":
      return "vector4";
    case "var_handle":
      return "thread_handle";
    default:
      return undefined;
  }
}

function inferGetterNameReturnType(name: string): string | undefined {
  if (/^(?:is|has|can|should|allow|dispose|enabled|need)[A-Z_]/.test(name)) {
    return "bool";
  }
  if (/^(?:get)?(?:name|desc|description|text|message|sound|model|path|uid|id|color)$/i.test(name)
    || /(?:Name|Desc|Description|Text|Message|Sound|Model|Path|Uid|Id|Color)$/.test(name)) {
    return "string";
  }
  if (/(?:Count|Index|Amount|Delay|Time|Coef|Modifier|Prob|Chance|Weight|Distance|Range|Size|Age|Level|Score|Bonus|Id)$/.test(name)) {
    return "int";
  }
  if (/(?:Pos|Position|Vector|Normal)$/.test(name)) {
    return "vector3";
  }
  if (/(?:List|Array|Categories|Types|Sounds|Data)$/.test(name)) {
    return "any[]";
  }
  return undefined;
}

function inferGetterMacroReturnType(name: string, macroName: string, macroArgs: string[]): string | undefined {
  const loweredMacro = macroName.toLowerCase();
  if (loweredMacro !== "getter_func" && loweredMacro !== "getterconst_func") {
    return undefined;
  }

  const expression = macroArgs.length > 1 ? macroArgs.slice(1).join(", ") : undefined;
  return (expression ? inferExpressionType(expression, new Map(), new Map()) : undefined)
    ?? inferGetterNameReturnType(name);
}

function extractMacroArgsFromLine(lineText: string, macroName: string): string[] {
  const macroIndex = lineText.indexOf(`${macroName}(`);
  if (macroIndex < 0) {
    return [];
  }

  const openParen = lineText.indexOf("(", macroIndex + macroName.length);
  if (openParen < 0) {
    return [];
  }

  let depth = 0;
  for (let index = openParen; index < lineText.length; ++index) {
    const current = lineText[index];
    if (current === "(") {
      depth += 1;
    } else if (current === ")") {
      depth -= 1;
      if (depth === 0) {
        return splitTopLevel(lineText.slice(openParen + 1, index), ",").map((entry) => entry.trim());
      }
    }
  }

  return [];
}

function extractSimpleTrailingTypeComment(rawLine: string): string | undefined {
  const commentIndex = rawLine.indexOf("//");
  if (commentIndex < 0) {
    return undefined;
  }
  const comment = rawLine.slice(commentIndex + 2).trim();
  if (/^[A-Za-z_][A-Za-z0-9_:]*(?:\[\])?$/.test(comment)) {
    return comment;
  }
  const loweredComment = comment.toLowerCase();
  if (/\b(?:type\s*name|typename|name|path|tag)\b/.test(loweredComment)) {
    return "string";
  }
  if (/\b(?:list|array)\b/.test(loweredComment)) {
    return "any[]";
  }
  return undefined;
}

function inferMemberNameTypeFromName(name: string): string | undefined {
  const lowered = name.toLowerCase();
  if (/^(?:class|classname|type|typename|model|path|name|tag|idname)$/.test(lowered) || /(?:class|classname|type|typename|model|path|name|tag)$/.test(lowered)) {
    return "string";
  }
  if (/^(?:id|idx|index|count|amount|chance|radius|distance|time|delay|size|level|stage|slot|quality|health|hp|min|max|weight|volume)$/.test(lowered)
    || /(?:id|idx|index|count|amount|chance|radius|distance|time|delay|size|level|stage|slot|quality|health|hp|min|max|weight|volume)$/.test(lowered)) {
    return "int";
  }
  if (/^(?:is|has|can|allow|enabled|active|visible|locked|open|closed|ready|only|need|needs)[A-Z_]/.test(name)
    || /^(?:is|has|can|allow|enabled|active|visible|locked|open|closed|ready|only|need|needs)_/i.test(name)) {
    return "bool";
  }
  if (/(?:list|array|items|objects|children|content|methods|params)$/.test(lowered)) {
    return "any[]";
  }
  if (/(?:map|hashmap|data|storage|cache|dict|lookup)$/.test(lowered)) {
    return "map<any;any>";
  }
  if (/(?:pos|position|offset|vector|dir)$/.test(lowered)) {
    return "vector3";
  }
  return undefined;
}

function extractDslDefaultValue(lineText: string, macroName: string): string | undefined {
  const macroIndex = lineText.indexOf(`${macroName}(`);
  if (macroIndex < 0) {
    return undefined;
  }
  const openParen = lineText.indexOf("(", macroIndex + macroName.length);
  if (openParen < 0) {
    return undefined;
  }
  let depth = 0;
  for (let index = openParen; index < lineText.length; ++index) {
    const current = lineText[index];
    if (current === "(") {
      depth += 1;
    } else if (current === ")") {
      depth -= 1;
      if (depth === 0) {
        const value = lineText.slice(index + 1).replace(/;[ \t]*$/, "").trim();
        return value || undefined;
      }
    }
  }
  return undefined;
}

function findDslBody(
  text: string,
  lineOffsets: number[],
  lineIndex: number
): { body: string; bodyStartOffset: number; bodyEndOffset: number } | undefined {
  const lineStart = lineOffsets[lineIndex] ?? 0;
  const openBraceIndex = text.indexOf("{", lineStart);
  if (openBraceIndex < 0) {
    return undefined;
  }

  const betweenLineAndBrace = text.slice(lineStart, openBraceIndex);
  if (/\r?\n[ \t]*(?:decl|def|class|struct|endclass|endstruct)\b/.test(betweenLineAndBrace)) {
    return undefined;
  }

  if (hasTopLevelSemicolon(betweenLineAndBrace)) {
    return undefined;
  }

  const openBraceLine = lineNumberForOffset(lineOffsets, openBraceIndex);
  if (openBraceLine > lineIndex + 4) {
    return undefined;
  }

  const closeBraceIndex = findMatchingBrace(text, openBraceIndex);
  if (closeBraceIndex < 0) {
    return undefined;
  }

  return {
    body: text.slice(openBraceIndex + 1, closeBraceIndex),
    bodyStartOffset: openBraceIndex + 1,
    bodyEndOffset: closeBraceIndex
  };
}

function extractObjParamsFromBody(
  body: string,
  bodyStartOffset: number,
  bodyEndOffset: number,
  declTypes: string[]
): { parameters: FunctionParameter[]; symbols: LocalSymbolInfo[] } {
  const parameters: FunctionParameter[] = [];
  const symbols: LocalSymbolInfo[] = [];
  const seen = new Set<string>();
  const pattern = /\b(?:objParams|ctxParams)(?:_\d+)?\s*\(([^)\r\n]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const args = splitTopLevel(match[1], ",")
      .map((entry) => entry.trim())
      .filter((entry) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry));
    for (const arg of args) {
      const lowered = arg.toLowerCase();
      if (seen.has(lowered)) {
        continue;
      }
      seen.add(lowered);
      const argOffset = bodyStartOffset + (match.index ?? 0) + match[0].indexOf(arg);
      const parameter: FunctionParameter = {
        name: arg,
        type: declTypes[parameters.length],
        typeSource: declTypes[parameters.length] ? "decl" : undefined
      };
      parameters.push(parameter);
      symbols.push({
        name: arg,
        type: parameter.type,
        source: "param",
        definitionStart: argOffset,
        definitionEnd: argOffset + arg.length,
        scopeStart: bodyStartOffset,
        scopeEnd: bodyEndOffset
      });
    }
  }

  return { parameters, symbols };
}

function mergeLocalSymbols(left: LocalSymbolInfo[], right: LocalSymbolInfo[]): LocalSymbolInfo[] {
  const result: LocalSymbolInfo[] = [];
  const seen = new Set<string>();
  for (const symbol of [...left, ...right]) {
    const key = `${symbol.name.toLowerCase()}:${symbol.definitionStart}:${symbol.definitionEnd}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(symbol);
  }
  return result.sort((first, second) => first.name.localeCompare(second.name) || first.definitionStart - second.definitionStart);
}

function buildMemberSymbol(
  filePath: string,
  line: number,
  name: string,
  owner: ReSdkOwnerRef,
  kind: "classMethod" | "classProperty" | "structMember",
  macroName: string,
  lineText: string,
  bodyInfo?: { body: string; bodyStartOffset: number; bodyEndOffset: number },
  declText?: string
): IndexedSymbol {
  const detailKind = kind === "classMethod" ? "class method" : kind === "classProperty" ? "class property" : "struct member";
  const macroArgs = extractMacroArgsFromLine(lineText, macroName);
  const declSignature = parseDeclSignature(declText);
  if (declSignature.returnType?.toLowerCase() === "override") {
    declSignature.returnType = undefined;
  }
  const valueType = (kind === "classProperty" && macroArgs.length > 1
    ? inferExpressionType(macroArgs.slice(1).join(", "), new Map(), new Map())
    : kind === "classProperty"
      ? inferPropertyMacroDefaultType(macroName)
    : kind === "structMember" && !bodyInfo && declSignature.returnType && declSignature.returnType.toLowerCase() !== "override"
      ? declSignature.returnType
      : kind === "structMember" && !bodyInfo && macroName.toLowerCase() === "def_null"
        ? "null"
        : kind === "structMember" && !bodyInfo
          ? (() => {
              const defaultValue = extractDslDefaultValue(lineText, macroName);
              if (!defaultValue || defaultValue.startsWith("//")) {
                return undefined;
              }
              return inferExpressionType(defaultValue, new Map(), new Map());
            })()
      : undefined)
    ?? (kind === "classProperty" || (kind === "structMember" && !bodyInfo) ? inferMemberNameTypeFromName(name) : undefined);
  const baseSymbol: IndexedSymbol = {
    name,
    kind,
    filePath,
    line,
    detail: `${detailKind} (${owner.name}, ${macroName})`,
    ownerName: owner.name,
    ownerKind: owner.kind,
    valueType,
    memberMacro: macroName,
    signatureLabel: kind === "classMethod" || kind === "structMember" ? `${name}()` : undefined,
    signatureSource: kind === "classMethod" || kind === "structMember" ? "inferred" : undefined
  };

  if (!bodyInfo || (kind !== "classMethod" && kind !== "structMember")) {
    if (kind === "classMethod") {
      const functionReturnType = declSignature.returnType || inferGetterMacroReturnType(name, macroName, macroArgs);
      if (functionReturnType || declSignature.parameterTypes.length > 0) {
        const functionParameters: FunctionParameter[] = declSignature.parameterTypes.map((type, index) => ({
          name: `_arg${index + 1}`,
          type,
          typeSource: "decl"
        }));
        return {
          ...baseSymbol,
          functionParameters,
          functionReturnType,
          signatureLabel: formatFunctionSignature(name, functionParameters, functionReturnType),
          signatureSource: declSignature.returnType || declSignature.parameterTypes.length > 0 ? "decl" : "inferred",
          detail: `${detailKind} (${owner.name}, ${macroName}, ${declSignature.returnType ? "decl" : "inferred"})`
        };
      }
    }
    return baseSymbol;
  }

  if (bodyInfo.body.length > DEEP_FUNCTION_ANALYSIS_BODY_LIMIT) {
    const functionParameters: FunctionParameter[] = declSignature.parameterTypes.map((type, index) => ({
      name: `_arg${index + 1}`,
      type,
      typeSource: "decl"
    }));
    const functionReturnType = declSignature.returnType;
    return {
      ...baseSymbol,
      functionParameters,
      functionReturnType,
      signatureLabel: formatFunctionSignature(name, functionParameters, functionReturnType),
      signatureSource: functionReturnType || functionParameters.length > 0 ? "decl" : "inferred",
      bodyStartOffset: bodyInfo.bodyStartOffset,
      bodyEndOffset: bodyInfo.bodyEndOffset
    };
  }

  const functionAst = parseSqfBlock(bodyInfo.body, bodyInfo.bodyStartOffset);
  let parsedDeclTypeIndex = 0;
  const parsedParams = extractParametersFromAst(functionAst).map((parameter): FunctionParameter => {
    const consumesDeclType = !["this", "self", "_self"].includes(parameter.name.toLowerCase());
    const declaredType = consumesDeclType ? declSignature.parameterTypes[parsedDeclTypeIndex++] : undefined;
    return {
      name: parameter.name,
      type: declaredType || (parameter.defaultValue ? inferAstExpressionType(parameter.defaultValue, new Map(), new Map()) : undefined) || "any",
      typeSource: declaredType ? "decl" : parameter.defaultValue ? "default" : "inferred",
      optional: parameter.optional,
      defaultValue: parameter.defaultValue?.kind === "unknown" ? parameter.defaultValue.raw : undefined
    };
  });
  const macroParams = extractObjParamsFromBody(bodyInfo.body, bodyInfo.bodyStartOffset, bodyInfo.bodyEndOffset, declSignature.parameterTypes);
  const functionParameters = parsedParams.length > 0 ? parsedParams : macroParams.parameters;
  const initialKnownTypes = new Map<string, string>([
    ["this", encodeOwnerType(owner)],
    ["self", encodeOwnerType(owner)],
    ["_self", encodeOwnerType(owner)]
  ]);
  for (const parameter of functionParameters) {
    if (parameter.type) {
      initialKnownTypes.set(parameter.name, parameter.type);
    }
  }

  const analysis = analyzeAstBlock(functionAst, new Map(initialKnownTypes), new Map());
  const uniqueReturnCandidates = Array.from(new Set(analysis.returnCandidates));
  const inferredReturnType = uniqueReturnCandidates.length === 1 ? uniqueReturnCandidates[0] : undefined;
  const functionReturnType = declSignature.returnType || inferredReturnType;
  const localScopeData = collectLocalSymbols(functionAst, functionParameters, new Map(), initialKnownTypes);
  const localSymbols = mergeLocalSymbols(macroParams.symbols, localScopeData.symbols);
  const signatureSource: IndexedSymbol["signatureSource"] = declSignature.returnType || declSignature.parameterTypes.length > 0
    ? "decl"
    : functionParameters.length > 0
      ? "params"
      : inferredReturnType
        ? "inferred"
        : "inferred";

  return {
    ...baseSymbol,
    detail: functionReturnType || functionParameters.length > 0
      ? `${detailKind} (${owner.name}, ${macroName}, ${signatureSource})`
      : baseSymbol.detail,
    functionParameters,
    functionReturnType,
    signatureLabel: formatFunctionSignature(name, functionParameters, functionReturnType),
    signatureSource,
    functionAst,
    bodyStartOffset: bodyInfo.bodyStartOffset,
    bodyEndOffset: bodyInfo.bodyEndOffset,
    localSymbols,
    localReferences: localScopeData.references
  };
}

function collectResdkDslSymbols(
  symbols: IndexedSymbol[],
  filePath: string,
  text: string,
  lines: string[],
  lineOffsets: number[],
  inheritedOwner?: ReSdkOwnerRef
): void {
  const interfaceOwnerMatch = /(?:^|[\\/])([A-Za-z_][A-Za-z0-9_]*)\.Interface$/i.exec(filePath);
  let currentOwner: ReSdkOwnerRef | undefined = interfaceOwnerMatch
    ? { name: interfaceOwnerMatch[1], kind: "class" }
    : inheritedOwner;

  const classPattern = /^[ \t]*class\(([A-Za-z_][A-Za-z0-9_:]*)\)(?:[ \t]+extends\(([A-Za-z_][A-Za-z0-9_:]*)\))?/;
  const structPattern = /^[ \t]*struct\(([A-Za-z_][A-Za-z0-9_:]*)\)(?:[ \t]+base\(([A-Za-z_][A-Za-z0-9_:]*)\))?/;
    const methodPattern = /^[ \t]*(func|getter_func|getterconst_func|abstract_func|proto_func)\(([A-Za-z_][A-Za-z0-9_]*)\b/;
  const propertyPattern = /^[ \t]*(var(?:_[A-Za-z0-9]+)?|varpair|var_exprval)\(([A-Za-z_][A-Za-z0-9_]*)\b/;
  const structMemberPattern = /^[ \t]*(?:decl\(.+\)[ \t]+)?(def|def_null|def_ret|cast_def)\(([A-Za-z_][A-Za-z0-9_]*)\b/;
  const editorFunctionPattern = /^[ \t]*(init_function|function)\(([A-Za-z_][A-Za-z0-9_]*)\)/;
  const macroWrapperPattern = /^[ \t]*(macro_const|macro_func|inline_macro)\(([A-Za-z_][A-Za-z0-9_]*)\b/;
  const namespacePattern = /^[ \t]*namespace\(([A-Za-z_][A-Za-z0-9_]*)(?:[ \t]*,[^)]+)?\)/;
  const enumPattern = /^[ \t]*enum\(([A-Za-z_][A-Za-z0-9_]*)\)/;
  const nonCodeState = { blockComment: false };

  for (let lineIndex = 0; lineIndex < lines.length; ++lineIndex) {
    const rawLine = lines[lineIndex];
    const lineText = maskNonCodeLine(rawLine, nonCodeState);
    const line = lineIndex + 1;

    const classMatch = classPattern.exec(lineText);
    if (classMatch) {
      currentOwner = { name: classMatch[1], kind: "class" };
    }

    const structMatch = structPattern.exec(lineText);
    if (structMatch) {
      currentOwner = { name: structMatch[1], kind: "struct" };
    }

    const editorFunctionMatch = editorFunctionPattern.exec(lineText);
    if (editorFunctionMatch) {
      pushSymbol(symbols, buildDslFunctionSymbol(filePath, line, editorFunctionMatch[2], `${editorFunctionMatch[1]} editor function`));
    }

    const macroWrapperMatch = macroWrapperPattern.exec(lineText);
    if (macroWrapperMatch) {
      pushSymbol(symbols, {
        name: macroWrapperMatch[2],
        kind: "macro",
        filePath,
        line,
        detail: macroWrapperMatch[1],
        macroBody: rawLine.trim()
      });
    }

    const namespaceMatch = namespacePattern.exec(lineText);
    if (namespaceMatch) {
      pushSymbol(symbols, {
        name: namespaceMatch[1],
        kind: "macro",
        filePath,
        line,
        detail: "namespace",
        macroBody: rawLine.trim()
      });
    }

    const enumMatch = enumPattern.exec(lineText);
    if (enumMatch) {
      pushSymbol(symbols, {
        name: enumMatch[1],
        kind: "macro",
        filePath,
        line,
        detail: "enum",
        macroBody: rawLine.trim()
      });
    }

    if (currentOwner?.kind === "class") {
      const methodMatch = methodPattern.exec(lineText);
      if (methodMatch) {
        const declText = findDeclNearLine(lines, lineIndex - 1);
        pushSymbol(symbols, buildMemberSymbol(
          filePath,
          line,
          methodMatch[2],
          currentOwner,
          "classMethod",
          methodMatch[1],
          lineText,
          findDslBody(text, lineOffsets, lineIndex),
          declText
        ));
      }

      const propertyMatch = propertyPattern.exec(lineText);
      if (propertyMatch) {
        pushSymbol(symbols, buildMemberSymbol(filePath, line, propertyMatch[2], currentOwner, "classProperty", propertyMatch[1], lineText));
      }
    }

    if (currentOwner?.kind === "struct") {
      const memberMatch = structMemberPattern.exec(lineText);
      if (memberMatch) {
        const sameLineDecl = extractMacroArgsFromLine(lineText, "decl").join(", ").trim();
        const memberSymbol = buildMemberSymbol(
          filePath,
          line,
          memberMatch[2],
          currentOwner,
          "structMember",
          memberMatch[1],
          lineText,
          findDslBody(text, lineOffsets, lineIndex),
          sameLineDecl || extractSimpleTrailingTypeComment(rawLine) || findDeclNearLine(lines, lineIndex - 1)
        );
        if (!memberSymbol.valueType && typeof memberSymbol.bodyStartOffset !== "number") {
          const defaultValue = extractDslDefaultValue(rawLine.slice(0, rawLine.indexOf("//") >= 0 ? rawLine.indexOf("//") : rawLine.length), memberMatch[1]);
          if (defaultValue) {
            memberSymbol.valueType = inferExpressionType(defaultValue, new Map(), new Map());
          }
        }
        pushSymbol(symbols, memberSymbol);
      }
    }

    if (/^[ \t]*endclass\b/.test(lineText) && currentOwner?.kind === "class") {
      currentOwner = undefined;
    } else if (/^[ \t]*endstruct\b/.test(lineText) && currentOwner?.kind === "struct") {
      currentOwner = undefined;
    }
  }
}

function expandTokenPasteExpression(expression: string, parameters: string[], args: string[]): string | undefined {
  const pieces = expression.split("##").map((piece) => piece.trim()).filter(Boolean);
  if (pieces.length < 2) {
    return undefined;
  }

  let result = "";
  for (const piece of pieces) {
    const parameterIndex = parameters.indexOf(piece);
    const value = parameterIndex >= 0 ? args[parameterIndex]?.trim() : piece;
    if (!value || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
      return undefined;
    }
    result += value;
  }

  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(result) ? result : undefined;
}

function collectMacroGeneratedFunctionSymbols(
  symbols: IndexedSymbol[],
  filePath: string,
  text: string,
  lines: string[],
  lineOffsets: number[]
): void {
  const macros = symbols.filter((symbol) => symbol.kind === "macro" && symbol.macroParameters?.length && symbol.macroBody?.includes("##"));
  for (const macro of macros) {
    const assignmentMatch = /([A-Za-z_][A-Za-z0-9_]*(?:\s*##\s*[A-Za-z_][A-Za-z0-9_]*)+)\s*=\s*\{/.exec(macro.macroBody ?? "");
    if (!assignmentMatch) {
      continue;
    }

    const invocationPattern = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(macro.name)}\\s*\\(([^\\r\\n)]*)\\)`, "g");
    let match: RegExpExecArray | null;
    while ((match = invocationPattern.exec(text)) !== null) {
      const lineText = lineTextForOffset(lines, lineOffsets, match.index ?? 0).trimStart();
      if (lineText.startsWith("#define")) {
        continue;
      }

      const args = splitTopLevel(match[1], ",").map((arg) => arg.trim());
      const generatedName = expandTokenPasteExpression(assignmentMatch[1], macro.macroParameters ?? [], args);
      if (!generatedName) {
        continue;
      }

      pushSymbol(symbols, buildMacroGeneratedFunctionSymbol(filePath, lineNumberForOffset(lineOffsets, match.index ?? 0), generatedName, macro.name));
    }
  }
}

function refineFunctionSymbol(symbol: IndexedSymbol, functionReturnTypes: Map<string, string>): IndexedSymbol {
  if (symbol.kind !== "globalFunction" || !symbol.functionAst) {
    return symbol;
  }
  const intrinsicReturnType = intrinsicGlobalFunctionReturnTypes.get(symbol.name.toLowerCase());
  if (intrinsicReturnType && symbol.functionReturnType !== intrinsicReturnType) {
    const localScopeData = collectLocalSymbols(symbol.functionAst, symbol.functionParameters ?? [], functionReturnTypes);
    return {
      ...symbol,
      functionReturnType: intrinsicReturnType,
      signatureLabel: formatFunctionSignature(symbol.name, symbol.functionParameters, intrinsicReturnType),
      signatureSource: symbol.signatureSource ?? "inferred",
      detail: `global function (${symbol.signatureSource ?? "inferred"})`,
      localSymbols: localScopeData.symbols,
      localReferences: localScopeData.references
    };
  }
  if (symbol.functionReturnType) {
    return symbol;
  }

  const knownTypes = new Map<string, string>();
  for (const parameter of symbol.functionParameters ?? []) {
    if (parameter.type) {
      knownTypes.set(parameter.name, parameter.type);
    }
  }

  const candidates = analyzeAstBlock(symbol.functionAst, knownTypes, functionReturnTypes).returnCandidates;
  const uniqueCandidates = Array.from(new Set(candidates));
  if (uniqueCandidates.length !== 1) {
    return symbol;
  }

  const functionReturnType = uniqueCandidates[0];
  const localScopeData = collectLocalSymbols(symbol.functionAst, symbol.functionParameters ?? [], functionReturnTypes);
  return {
    ...symbol,
    functionReturnType,
    signatureLabel: formatFunctionSignature(symbol.name, symbol.functionParameters, functionReturnType),
    signatureSource: symbol.signatureSource ?? "inferred",
    detail: `global function (${symbol.signatureSource ?? "inferred"})`,
    localSymbols: localScopeData.symbols,
    localReferences: localScopeData.references
  };
}

function refineReSdkMemberFunctionSymbol(symbol: IndexedSymbol, index: WorkspaceSymbolIndex): IndexedSymbol {
  if (!needsIndexedReturnInference(symbol)) {
    return symbol;
  }

  const inferredReturnType = inferReSdkMemberReturnType(symbol, index);
  if (!inferredReturnType || inferredReturnType === symbol.functionReturnType) {
    return symbol;
  }

  return {
    ...symbol,
    functionReturnType: inferredReturnType,
    signatureLabel: formatFunctionSignature(symbol.name, symbol.functionParameters, inferredReturnType),
    signatureSource: "inferred",
    detail: symbol.detail.replace(/,\s*(?:params|inferred)\)$/, ", inferred)")
  };
}

function flattenArgExpression(expression: SqfAstExpression | undefined): SqfAstExpression[] {
  if (!expression) {
    return [];
  }
  if (expression.kind === "binary" && expression.operator.toLowerCase() === "arg") {
    return [...flattenArgExpression(expression.left), ...flattenArgExpression(expression.right)];
  }
  return [expression];
}

function symbolIdentity(symbol: IndexedSymbol): string {
  return `${symbol.kind}:${symbol.filePath}:${symbol.line}:${symbol.ownerKind ?? ""}:${symbol.ownerName ?? ""}:${symbol.name}`;
}

function isPseudoThisParameter(name: string): boolean {
  return ["this", "self", "_self"].includes(name.toLowerCase());
}

function inferCallArgumentType(argument: SqfAstExpression, caller: IndexedSymbol, index: WorkspaceSymbolIndex): string | undefined {
  if (argument.kind === "identifier") {
    const indexedType = inferIndexedIdentifierType(index, argument.name);
    if (indexedType) {
      return indexedType;
    }
  }

  const knownTypes = new Map<string, string>();
  if (caller.ownerName && caller.ownerKind) {
    const ownerType = encodeOwnerType({ name: caller.ownerName, kind: caller.ownerKind });
    knownTypes.set("this", ownerType);
    knownTypes.set("self", ownerType);
    knownTypes.set("_self", ownerType);
  }
  for (const parameter of caller.functionParameters ?? []) {
    if (parameter.type) {
      knownTypes.set(parameter.name, parameter.type);
    }
  }
  for (const local of caller.localSymbols ?? []) {
    if (local.type && !knownTypes.has(local.name)) {
      knownTypes.set(local.name, local.type);
    }
  }

  const cheapType = inferAstExpressionType(argument, knownTypes, new Map());
  if (cheapType) {
    return cheapType;
  }

  if (argument.kind === "macroCall" || argument.kind === "binary" || argument.kind === "select") {
    return inferAstExpressionTypeWithIndex(argument, caller, index);
  }
  return undefined;
}

function getDirectLocalSymbolType(symbol: IndexedSymbol, localName: string): string | undefined {
  return symbol.localSymbols?.find((local) => local.name.toLowerCase() === localName.toLowerCase() && !!local.type)?.type
    ?? symbol.functionParameters?.find((parameter) => parameter.name.toLowerCase() === localName.toLowerCase())?.type;
}

function inferDirectOwnerFromExpression(
  expression: SqfAstExpression | undefined,
  caller: IndexedSymbol,
  index: WorkspaceSymbolIndex
): ReSdkOwnerRef | undefined {
  if (!expression) {
    return undefined;
  }
  if (expression.kind === "identifier") {
    if (["self", "this", "_self"].includes(expression.name.toLowerCase()) && caller.ownerName && caller.ownerKind) {
      return { name: caller.ownerName, kind: caller.ownerKind };
    }
    return resolveIndexedTypeOwner(index, getDirectLocalSymbolType(caller, expression.name));
  }
  if (expression.kind === "macroCall") {
    const loweredName = expression.name.toLowerCase();
    if ((loweredName === "new" || loweredName === "newp" || loweredName === "struct_new" || loweredName === "struct_newp") && expression.args[0]?.kind === "identifier") {
      return resolveIndexedTypeOwner(index, `${loweredName.startsWith("new") ? "class" : "struct"}:${expression.args[0].name}`);
    }
    if ((loweredName === "callself" || loweredName === "callselfparams") && expression.args[0]?.kind === "identifier" && caller.ownerName && caller.ownerKind) {
      const member = resolveReSdkMember(index, { name: caller.ownerName, kind: caller.ownerKind }, expression.args[0].name, caller.ownerKind === "struct" ? "structMember" : "method");
      return resolveIndexedTypeOwner(index, member?.functionReturnType);
    }
    if (loweredName === "getself" && expression.args[0]?.kind === "identifier" && caller.ownerName && caller.ownerKind) {
      const member = resolveReSdkMember(index, { name: caller.ownerName, kind: caller.ownerKind }, expression.args[0].name, "property");
      return resolveIndexedTypeOwner(index, member?.valueType);
    }
  }
  return undefined;
}

function collectReSdkCallParameterTypesFromExpression(
  expression: SqfAstExpression,
  caller: IndexedSymbol,
  index: WorkspaceSymbolIndex,
  targetTypes: Map<string, Map<number, string[]>>
): void {
  const pushTypes = (target: IndexedSymbol | undefined, args: SqfAstExpression[]) => {
    if (!target || args.length === 0) {
      return;
    }
    const byIndex = targetTypes.get(symbolIdentity(target)) ?? new Map<number, string[]>();
    const callableParameters = (target.functionParameters ?? [])
      .map((parameter, parameterIndex) => ({ parameter, parameterIndex }))
      .filter((entry) => !isPseudoThisParameter(entry.parameter.name));
    args.forEach((argument, argumentIndex) => {
      const type = inferCallArgumentType(argument, caller, index);
      if (!type) {
        return;
      }
      const parameterIndex = callableParameters[argumentIndex]?.parameterIndex ?? argumentIndex;
      const bucket = byIndex.get(parameterIndex) ?? [];
      bucket.push(type);
      byIndex.set(parameterIndex, bucket);
    });
    targetTypes.set(symbolIdentity(target), byIndex);
  };

  switch (expression.kind) {
    case "macroCall": {
      const loweredName = expression.name.toLowerCase();
      if ((loweredName === "struct_newp" || loweredName === "newp") && expression.args[0]?.kind === "identifier") {
        const ownerKind: ReSdkOwnerKind = loweredName === "struct_newp" ? "struct" : "class";
        const target = resolveReSdkMember(index, { name: expression.args[0].name, kind: ownerKind }, "init", ownerKind === "struct" ? "structMember" : "method");
        pushTypes(target, flattenArgExpression(expression.args[1]));
      } else if ((loweredName === "callselfparams" || loweredName === "callself") && expression.args[0]?.kind === "identifier" && caller.ownerName && caller.ownerKind) {
        const target = resolveReSdkMember(index, { name: caller.ownerName, kind: caller.ownerKind }, expression.args[0].name, caller.ownerKind === "struct" ? "structMember" : "method");
        pushTypes(target, loweredName === "callselfparams" ? flattenArgExpression(expression.args[1]) : []);
      } else if ((loweredName === "callfuncparams" || loweredName === "callfunc" || loweredName === "allfuncparams" || loweredName === "allfunc") && expression.args[1]?.kind === "identifier") {
        const receiverOwner = inferDirectOwnerFromExpression(expression.args[0], caller, index);
        const target = resolveReSdkMember(index, receiverOwner, expression.args[1].name, receiverOwner?.kind === "struct" ? "structMember" : "method");
        const args = loweredName.endsWith("params") ? flattenArgExpression(expression.args[2]) : [];
        if (target) {
          pushTypes(target, args);
        } else if (!receiverOwner) {
          for (const candidate of getReSdkMemberCandidates(index, expression.args[1].name, "method")) {
            pushTypes(candidate, args);
          }
          for (const candidate of getReSdkMemberCandidates(index, expression.args[1].name, "structMember")) {
            pushTypes(candidate, args);
          }
        }
      }
      for (const argument of expression.args) {
        collectReSdkCallParameterTypesFromExpression(argument, caller, index, targetTypes);
      }
      return;
    }
    case "binary": {
      const operator = expression.operator.toLowerCase();
      if ((operator === "callp" || operator === "callv") && expression.right.kind === "macroCall") {
        const memberName = getMacroIdentifierArg(expression.right.args[0]);
        const receiverOwner = inferDirectOwnerFromExpression(expression.left, caller, index);
        const target = memberName
          ? resolveReSdkMember(index, receiverOwner, memberName, receiverOwner?.kind === "struct" ? "structMember" : "method")
          : undefined;
        pushTypes(target, operator === "callp" ? expression.right.args.slice(1).flatMap(flattenArgExpression) : []);
      }
      collectReSdkCallParameterTypesFromExpression(expression.left, caller, index, targetTypes);
      collectReSdkCallParameterTypesFromExpression(expression.right, caller, index, targetTypes);
      return;
    }
    case "array":
      for (const element of expression.elements) {
        collectReSdkCallParameterTypesFromExpression(element, caller, index, targetTypes);
      }
      return;
    case "code":
      for (const statement of expression.block.statements) {
        if (statement.kind === "assignment" || statement.kind === "expression") {
          collectReSdkCallParameterTypesFromExpression(statement.expression, caller, index, targetTypes);
        }
      }
      return;
    case "unary":
      collectReSdkCallParameterTypesFromExpression(expression.operand, caller, index, targetTypes);
      return;
    case "invoke":
      if (expression.target) {
        collectReSdkCallParameterTypesFromExpression(expression.target, caller, index, targetTypes);
      }
      collectReSdkCallParameterTypesFromExpression(expression.callee, caller, index, targetTypes);
      return;
    case "select":
      collectReSdkCallParameterTypesFromExpression(expression.source, caller, index, targetTypes);
      collectReSdkCallParameterTypesFromExpression(expression.index, caller, index, targetTypes);
      return;
    case "exitWith":
      if (expression.condition) {
        collectReSdkCallParameterTypesFromExpression(expression.condition, caller, index, targetTypes);
      }
      for (const statement of expression.block.statements) {
        if (statement.kind === "assignment" || statement.kind === "expression") {
          collectReSdkCallParameterTypesFromExpression(statement.expression, caller, index, targetTypes);
        }
      }
      return;
    case "if":
      collectReSdkCallParameterTypesFromExpression(expression.condition, caller, index, targetTypes);
      for (const block of [expression.thenBlock, expression.elseBlock].filter((entry): entry is SqfAstBlock => !!entry)) {
        for (const statement of block.statements) {
          if (statement.kind === "assignment" || statement.kind === "expression") {
            collectReSdkCallParameterTypesFromExpression(statement.expression, caller, index, targetTypes);
          }
        }
      }
      return;
    case "identifier":
    case "string":
    case "number":
    case "boolean":
    case "unknown":
      return;
  }
}

function refineReSdkParameterTypesFromCalls(all: IndexedSymbol[], index: WorkspaceSymbolIndex): boolean {
  const inferred = new Map<string, Map<number, string[]>>();
  for (const symbol of all) {
    if (!symbol.functionAst) {
      continue;
    }
    for (const statement of symbol.functionAst.statements) {
      if (statement.kind === "assignment" || statement.kind === "expression") {
        collectReSdkCallParameterTypesFromExpression(statement.expression, symbol, index, inferred);
      }
    }
  }

  let changed = false;
  const virtualTypes = new Map<string, Map<number, string[]>>();
  const pushVirtualType = (symbol: IndexedSymbol, parameterIndex: number, type: string | undefined) => {
    if (!type || (symbol.kind !== "classMethod" && symbol.kind !== "structMember")) {
      return;
    }
    const key = `${symbol.kind}:${symbol.ownerKind ?? ""}:${symbol.ownerName ?? ""}:${symbol.name.toLowerCase()}`;
    const byIndex = virtualTypes.get(key) ?? new Map<number, string[]>();
    const bucket = byIndex.get(parameterIndex) ?? [];
    bucket.push(type);
    byIndex.set(parameterIndex, bucket);
    virtualTypes.set(key, byIndex);
  };

  for (const symbol of all) {
    symbol.functionParameters?.forEach((parameter, parameterIndex) => {
      if (!isPseudoThisParameter(parameter.name)) {
        pushVirtualType(symbol, parameterIndex, parameter.type);
      }
    });
  }

  for (const symbol of all) {
    if (!symbol.functionParameters?.length) {
      continue;
    }
    const byIndex = inferred.get(symbolIdentity(symbol));
    let symbolChanged = false;
    const functionParameters: FunctionParameter[] = symbol.functionParameters.map((parameter, parameterIndex): FunctionParameter => {
      if (isPseudoThisParameter(parameter.name)) {
        return parameter;
      }
      const usageType = inferLocalTypeFromMemberUsage(symbol, parameter.name, index);
      if (parameter.type) {
        const betterType = parameter.typeSource === "decl"
          ? parameter.type
          : chooseBestSpecificType([usageType, parameter.type]);
        if (betterType && betterType !== parameter.type && typeSpecificity(betterType) > typeSpecificity(parameter.type)) {
          symbolChanged = true;
          pushVirtualType(symbol, parameterIndex, betterType);
          return { ...parameter, type: betterType, typeSource: "inferred" };
        }
        return parameter;
      }
      const callInferredType = chooseDominantParameterType([
        ...(byIndex?.get(parameterIndex) ?? []),
        ...(virtualTypes.get(`${symbol.kind}:${symbol.ownerKind ?? ""}:${symbol.ownerName ?? ""}:${symbol.name.toLowerCase()}`)?.get(parameterIndex) ?? [])
      ], index);
      const inferredType = chooseParameterInferenceType(usageType, callInferredType);
      if (!inferredType) {
        return parameter;
      }
      symbolChanged = true;
      pushVirtualType(symbol, parameterIndex, inferredType);
      return { ...parameter, type: inferredType, typeSource: "inferred" };
    });
    if (!symbolChanged) {
      continue;
    }

    const parameterTypes = new Map(functionParameters.map((parameter) => [parameter.name.toLowerCase(), parameter.type]));
    symbol.functionParameters = functionParameters;
    symbol.localSymbols = symbol.localSymbols?.map((local) => {
      const parameterType = parameterTypes.get(local.name.toLowerCase());
      return local.source === "param" && parameterType && local.type !== parameterType
        ? { ...local, type: parameterType }
        : local;
    });
    symbol.signatureLabel = formatFunctionSignature(symbol.name, functionParameters, symbol.functionReturnType);
    changed = true;
  }

  return changed;
}

function collectPropertyWriteTypesFromExpression(
  expression: SqfAstExpression,
  caller: IndexedSymbol,
  index: WorkspaceSymbolIndex,
  propertyTypes: Map<string, string[]>
): void {
  const pushPropertyType = (property: IndexedSymbol | undefined, value: SqfAstExpression | undefined) => {
    if (!property || !value) {
      return;
    }
    const type = inferCallArgumentType(value, caller, index);
    if (!type || type === "null" || type === "nil") {
      return;
    }
    const key = symbolIdentity(property);
    const bucket = propertyTypes.get(key) ?? [];
    bucket.push(type);
    propertyTypes.set(key, bucket);
  };

  switch (expression.kind) {
    case "macroCall": {
      const loweredName = expression.name.toLowerCase();
      if (loweredName === "setself" && expression.args[0]?.kind === "identifier" && caller.ownerName && caller.ownerKind) {
        pushPropertyType(resolveReSdkMember(index, { name: caller.ownerName, kind: caller.ownerKind }, expression.args[0].name, "property"), expression.args[1]);
      } else if (loweredName === "setvar" && expression.args[1]?.kind === "identifier") {
        const receiverOwner = inferDirectOwnerFromExpression(expression.args[0], caller, index);
        pushPropertyType(resolveReSdkMember(index, receiverOwner, expression.args[1].name, receiverOwner?.kind === "struct" ? "structMember" : "property"), expression.args[2]);
      }
      for (const argument of expression.args) {
        collectPropertyWriteTypesFromExpression(argument, caller, index, propertyTypes);
      }
      return;
    }
    case "binary":
      if (expression.operator.toLowerCase() === "setv" && expression.right.kind === "macroCall") {
        const receiverOwner = inferDirectOwnerFromExpression(expression.left, caller, index) ?? inferAstOwnerFromExpressionWithIndex(expression.left, caller, index);
        pushPropertyType(
          resolveReSdkMember(index, receiverOwner, getMacroIdentifierArg(expression.right.args[0]) ?? "", "structMember"),
          expression.right.args[1]
        );
      }
      collectPropertyWriteTypesFromExpression(expression.left, caller, index, propertyTypes);
      collectPropertyWriteTypesFromExpression(expression.right, caller, index, propertyTypes);
      return;
    case "array":
      for (const element of expression.elements) {
        collectPropertyWriteTypesFromExpression(element, caller, index, propertyTypes);
      }
      return;
    case "code":
      for (const statement of expression.block.statements) {
        if (statement.kind === "assignment" || statement.kind === "expression") {
          collectPropertyWriteTypesFromExpression(statement.expression, caller, index, propertyTypes);
        }
      }
      return;
    case "unary":
      collectPropertyWriteTypesFromExpression(expression.operand, caller, index, propertyTypes);
      return;
    case "invoke":
      if (expression.target) {
        collectPropertyWriteTypesFromExpression(expression.target, caller, index, propertyTypes);
      }
      collectPropertyWriteTypesFromExpression(expression.callee, caller, index, propertyTypes);
      return;
    case "select":
      collectPropertyWriteTypesFromExpression(expression.source, caller, index, propertyTypes);
      collectPropertyWriteTypesFromExpression(expression.index, caller, index, propertyTypes);
      return;
    case "exitWith":
      if (expression.condition) {
        collectPropertyWriteTypesFromExpression(expression.condition, caller, index, propertyTypes);
      }
      for (const statement of expression.block.statements) {
        if (statement.kind === "assignment" || statement.kind === "expression") {
          collectPropertyWriteTypesFromExpression(statement.expression, caller, index, propertyTypes);
        }
      }
      return;
    case "if":
      collectPropertyWriteTypesFromExpression(expression.condition, caller, index, propertyTypes);
      for (const block of [expression.thenBlock, expression.elseBlock].filter((entry): entry is SqfAstBlock => !!entry)) {
        for (const statement of block.statements) {
          if (statement.kind === "assignment" || statement.kind === "expression") {
            collectPropertyWriteTypesFromExpression(statement.expression, caller, index, propertyTypes);
          }
        }
      }
      return;
    case "identifier":
    case "string":
    case "number":
    case "boolean":
    case "unknown":
      return;
  }
}

function refineReSdkPropertyTypesFromWrites(all: IndexedSymbol[], index: WorkspaceSymbolIndex): boolean {
  const inferred = new Map<string, string[]>();
  for (const symbol of all) {
    if (!symbol.functionAst) {
      continue;
    }
    for (const statement of symbol.functionAst.statements) {
      if (statement.kind === "assignment" || statement.kind === "expression") {
        collectPropertyWriteTypesFromExpression(statement.expression, symbol, index, inferred);
      }
    }
  }

  let changed = false;
  for (const symbol of all) {
    if (symbol.kind !== "classProperty" && symbol.kind !== "structMember") {
      continue;
    }
    if (symbol.valueType && !["null", "nil", "object", "any"].includes(symbol.valueType)) {
      continue;
    }
    const inferredType = chooseBestSpecificType(inferred.get(symbolIdentity(symbol)) ?? []);
    if (!inferredType || inferredType === symbol.valueType) {
      continue;
    }
    if (symbol.valueType && (inferredType === "any" || inferredType === "class:any" || inferredType === "class:object")) {
      continue;
    }
    symbol.valueType = inferredType;
    changed = true;
  }
  return changed;
}

function collectGlobalVariableWriteTypesFromExpression(
  expression: SqfAstExpression,
  caller: IndexedSymbol,
  index: WorkspaceSymbolIndex,
  globalTypes: Map<string, string[]>,
  globalNames: Set<string>
): void {
  switch (expression.kind) {
    case "array":
      for (const element of expression.elements) {
        collectGlobalVariableWriteTypesFromExpression(element, caller, index, globalTypes, globalNames);
      }
      return;
    case "code":
      collectGlobalVariableWriteTypesFromBlock(expression.block, caller, index, globalTypes, globalNames);
      return;
    case "unary":
      collectGlobalVariableWriteTypesFromExpression(expression.operand, caller, index, globalTypes, globalNames);
      return;
    case "binary":
      collectGlobalVariableWriteTypesFromExpression(expression.left, caller, index, globalTypes, globalNames);
      collectGlobalVariableWriteTypesFromExpression(expression.right, caller, index, globalTypes, globalNames);
      return;
    case "macroCall":
      for (const argument of expression.args) {
        collectGlobalVariableWriteTypesFromExpression(argument, caller, index, globalTypes, globalNames);
      }
      return;
    case "invoke":
      if (expression.target) {
        collectGlobalVariableWriteTypesFromExpression(expression.target, caller, index, globalTypes, globalNames);
      }
      collectGlobalVariableWriteTypesFromExpression(expression.callee, caller, index, globalTypes, globalNames);
      return;
    case "select":
      collectGlobalVariableWriteTypesFromExpression(expression.source, caller, index, globalTypes, globalNames);
      collectGlobalVariableWriteTypesFromExpression(expression.index, caller, index, globalTypes, globalNames);
      return;
    case "exitWith":
      if (expression.condition) {
        collectGlobalVariableWriteTypesFromExpression(expression.condition, caller, index, globalTypes, globalNames);
      }
      collectGlobalVariableWriteTypesFromBlock(expression.block, caller, index, globalTypes, globalNames);
      return;
    case "if":
      collectGlobalVariableWriteTypesFromExpression(expression.condition, caller, index, globalTypes, globalNames);
      collectGlobalVariableWriteTypesFromBlock(expression.thenBlock, caller, index, globalTypes, globalNames);
      if (expression.elseBlock) {
        collectGlobalVariableWriteTypesFromBlock(expression.elseBlock, caller, index, globalTypes, globalNames);
      }
      return;
    case "identifier":
    case "string":
    case "number":
    case "boolean":
    case "unknown":
      return;
  }
}

function collectGlobalVariableWriteTypesFromBlock(
  block: SqfAstBlock,
  caller: IndexedSymbol,
  index: WorkspaceSymbolIndex,
  globalTypes: Map<string, string[]>,
  globalNames: Set<string>
): void {
  for (const statement of block.statements) {
    if (statement.kind === "assignment") {
      if (!statement.isPrivate && !statement.name.startsWith("_") && globalNames.has(statement.name.toLowerCase())) {
        const inferredType = inferAstExpressionTypeWithIndex(statement.expression, caller, index);
        if (inferredType && !isNullLikeType(inferredType) && !(statement.expression.kind === "select" && inferredType === "float")) {
          const bucket = globalTypes.get(statement.name.toLowerCase()) ?? [];
          bucket.push(inferredType);
          globalTypes.set(statement.name.toLowerCase(), bucket);
        }
      }
      collectGlobalVariableWriteTypesFromExpression(statement.expression, caller, index, globalTypes, globalNames);
    } else if (statement.kind === "expression") {
      collectGlobalVariableWriteTypesFromExpression(statement.expression, caller, index, globalTypes, globalNames);
    }
  }
}

function refineGlobalVariableTypesFromWrites(all: IndexedSymbol[], index: WorkspaceSymbolIndex): boolean {
  const globalNames = new Set(all.filter((symbol) => symbol.kind === "globalVariable").map((symbol) => symbol.name.toLowerCase()));
  if (globalNames.size === 0) {
    return false;
  }

  const inferred = new Map<string, string[]>();
  for (const symbol of all) {
    if (!symbol.functionAst) {
      continue;
    }
    collectGlobalVariableWriteTypesFromBlock(symbol.functionAst, symbol, index, inferred, globalNames);
  }

  let changed = false;
  for (const symbol of all) {
    if (symbol.kind !== "globalVariable") {
      continue;
    }
    const inferredType = chooseBestSpecificType([symbol.valueType, ...(inferred.get(symbol.name.toLowerCase()) ?? [])]);
    if (!inferredType || inferredType === symbol.valueType) {
      continue;
    }
    if (symbol.valueType && (inferredType === "any" || inferredType === "class:any" || inferredType === "class:object")) {
      continue;
    }
    symbol.valueType = inferredType;
    symbol.detail = `global variable: ${inferredType}`;
    changed = true;
  }
  return changed;
}

function parseMacroWrapperReturnType(lines: string[], lineIndex: number, macroName: string): string | undefined {
  for (let index = lineIndex - 1; index >= Math.max(0, lineIndex - 4); --index) {
    const macroFuncArgs = extractMacroArgsFromLine(lines[index], "macro_func");
    if (macroFuncArgs.length < 2 || macroFuncArgs[0].toLowerCase() !== macroName.toLowerCase()) {
      continue;
    }
    const signature = parseDeclSignature(macroFuncArgs[1]);
    return signature.returnType;
  }
  return undefined;
}

function extractTextSymbols(filePath: string, text: string, inheritedOwner?: ReSdkOwnerRef): IndexedSymbol[] {
  const symbols: IndexedSymbol[] = [];
  const lines = text.split(/\r?\n/);
  const lineOffsets = [0];
  for (const match of text.matchAll(/\r?\n/g)) {
    lineOffsets.push((match.index ?? 0) + match[0].length);
  }
  const topLevelLineStarts = computeTopLevelLineStarts(text, lineOffsets);

  const macroPattern = /^[ \t]*#define[ \t]+([A-Za-z_][A-Za-z0-9_]*)(?:\(([^)\r\n]*)\))?(?:[ \t]+(.*))?$/gm;
  for (const match of text.matchAll(macroPattern)) {
    const line = lineNumberForOffset(lineOffsets, match.index ?? 0);
    const macroParameters = match[2]
      ? match[2].split(",").map((parameter) => parameter.trim()).filter(Boolean)
      : undefined;
    const macroBody = match[3]?.trim() ?? "";
    const wrapperType = !macroParameters?.length ? parseMacroWrapperReturnType(lines, line - 1, match[1]) : undefined;
    const valueType = wrapperType
      ?? (!macroParameters?.length && macroBody
        ? inferExpressionType(macroBody, new Map(), new Map())
        : undefined);
    pushSymbol(symbols, {
      name: match[1],
      kind: "macro",
      filePath,
      line,
      detail: valueType
        ? `#define: ${valueType}`
        : macroParameters && macroParameters.length > 0
        ? `#define(${macroParameters.join(", ")})`
        : "#define",
      macroParameters,
      macroBody,
      valueType
    });
  }

  const sameLineFunctionPattern = /^[ \t]*(?:(?:extern|const)[ \t]+)*(?:decl\(([^)\r\n]*)\)[ \t]+)?([A-Za-z][A-Za-z0-9_]*)[ \t]*=[ \t]*\{/;
  const plainFunctionPattern = /^[ \t]*([A-Za-z][A-Za-z0-9_]*)[ \t]*=[ \t]*\{/;
  const nodeFunctionPattern = /(?:^|["'])[ \t]*node_func\(([A-Za-z_][A-Za-z0-9_]*)\)[ \t]*=[ \t]*\{/;
  const topLevelAssignmentPattern = /^[ \t]*(?:private[ \t]+)?([A-Za-z][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*?)(?:;[ \t]*)?(?:(?:\/\/).*)?$/;
  for (let lineIndex = 0; lineIndex < lines.length; ++lineIndex) {
    const lineText = lines[lineIndex];
    if (topLevelLineStarts[lineIndex]) {
      const assignmentMatch = topLevelAssignmentPattern.exec(lineText);
      if (assignmentMatch && !sameLineFunctionPattern.test(lineText) && !/^[A-Za-z0-9_]+__/.test(assignmentMatch[1])) {
        pushSymbol(symbols, buildGlobalVariableSymbolWithType(filePath, lineIndex + 1, assignmentMatch[1], assignmentMatch[2]?.trim()));
      }
    }

    if (!topLevelLineStarts[lineIndex]) {
      continue;
    }

    const sameLineMatch = sameLineFunctionPattern.exec(lineText);
    const nodeFunctionMatch = nodeFunctionPattern.exec(lineText);
    if (!sameLineMatch && !nodeFunctionMatch) {
      continue;
    }

    const plainMatch = plainFunctionPattern.exec(lineText.trimStart());
    const name = nodeFunctionMatch?.[1] || sameLineMatch?.[2] || plainMatch?.[1];
    if (!name) {
      continue;
    }

    const declText = sameLineMatch?.[1]?.trim() || findDeclNearLine(lines, lineIndex - 1);
    const openBraceOnLine = nodeFunctionMatch
      ? lineText.indexOf("{", nodeFunctionMatch.index)
      : lineText.indexOf("{");
    if (openBraceOnLine < 0) {
      continue;
    }

    const openBraceIndex = (lineOffsets[lineIndex] ?? 0) + openBraceOnLine;
    const closeBraceIndex = findMatchingBrace(text, openBraceIndex);
    if (closeBraceIndex < 0) {
      continue;
    }

    const body = text.slice(openBraceIndex + 1, closeBraceIndex);
    pushSymbol(symbols, buildFunctionSymbol(filePath, lineIndex + 1, name, body, declText, openBraceIndex + 1, closeBraceIndex));
  }

  collectMacroGeneratedFunctionSymbols(symbols, filePath, text, lines, lineOffsets);

  const classPattern = /^[ \t]*class\(([A-Za-z_][A-Za-z0-9_:]*)\)(?:[ \t]+extends\(([A-Za-z_][A-Za-z0-9_:]*)\))?/gm;
  for (const match of text.matchAll(classPattern)) {
    const line = lineNumberForOffset(lineOffsets, match.index ?? 0);
    const detail = match[2] ? `class extends ${match[2]}` : "class";
    pushSymbol(symbols, {
      name: match[1],
      kind: "classType",
      filePath,
      line,
      detail,
      ownerKind: "class",
      baseName: match[2]
    });
  }

  const structPattern = /^[ \t]*struct\(([A-Za-z_][A-Za-z0-9_:]*)\)(?:[ \t]+base\(([A-Za-z_][A-Za-z0-9_:]*)\))?/gm;
  for (const match of text.matchAll(structPattern)) {
    const line = lineNumberForOffset(lineOffsets, match.index ?? 0);
    const detail = match[2] ? `struct base ${match[2]}` : "struct";
    pushSymbol(symbols, {
      name: match[1],
      kind: "structType",
      filePath,
      line,
      detail,
      ownerKind: "struct",
      baseName: match[2]
    });
  }

  collectResdkDslSymbols(symbols, filePath, text, lines, lineOffsets, inheritedOwner);

  return symbols;
}

function extractFileSymbols(filePath: string, inheritedOwner?: ReSdkOwnerRef): IndexedSymbol[] {
  return extractTextSymbols(filePath, readFileSync(filePath, "utf8"), inheritedOwner);
}

function cloneIndexedSymbol(symbol: IndexedSymbol): IndexedSymbol {
  return {
    ...symbol,
    functionParameters: symbol.functionParameters?.map((parameter) => ({ ...parameter })),
    localSymbols: symbol.localSymbols?.map((local) => ({ ...local })),
    localReferences: symbol.localReferences?.map((reference) => ({ ...reference }))
  };
}

function cloneRawFileSymbols(symbols: IndexedSymbol[]): IndexedSymbol[] {
  return symbols.map(cloneIndexedSymbol);
}

function isGenericInferredType(type: string | undefined): boolean {
  return !type || type === "any" || type === "any[]" || type === "object" || type === "null" || type === "nil";
}

function mergeFastRefinedSymbol(rawSymbol: IndexedSymbol, previousSymbol: IndexedSymbol | undefined): IndexedSymbol {
  if (!previousSymbol) {
    return rawSymbol;
  }

  const merged = cloneIndexedSymbol(rawSymbol);
  if (previousSymbol.valueType && isGenericInferredType(merged.valueType) && !isGenericInferredType(previousSymbol.valueType)) {
    merged.valueType = previousSymbol.valueType;
    merged.detail = previousSymbol.detail;
  }

  const sameBody = merged.bodyStartOffset !== undefined
    && merged.bodyStartOffset === previousSymbol.bodyStartOffset
    && merged.bodyEndOffset === previousSymbol.bodyEndOffset;
  if (sameBody) {
    merged.functionReturnType = merged.functionReturnType ?? previousSymbol.functionReturnType;
    merged.functionParameters = merged.functionParameters?.length ? merged.functionParameters : previousSymbol.functionParameters?.map((parameter) => ({ ...parameter }));
    merged.signatureLabel = previousSymbol.signatureLabel ?? merged.signatureLabel;
    merged.signatureSource = previousSymbol.signatureSource ?? merged.signatureSource;
    merged.localSymbols = previousSymbol.localSymbols?.map((local) => ({ ...local })) ?? merged.localSymbols;
    merged.localReferences = previousSymbol.localReferences?.map((reference) => ({ ...reference })) ?? merged.localReferences;
  }

  return merged;
}

export function extractDocumentSymbols(filePath: string, text: string): IndexedSymbol[] {
  return extractTextSymbols(filePath, text);
}

export function extractDocumentFunctionSymbols(filePath: string, text: string): IndexedSymbol[] {
  return extractTextSymbols(filePath, text).filter((symbol) =>
    symbol.kind === "globalFunction"
    || symbol.kind === "classMethod"
    || (symbol.kind === "structMember" && typeof symbol.bodyStartOffset === "number")
  );
}

function collectInheritedIncludeOwners(project: WorkspaceProject): Map<string, ReSdkOwnerRef> {
  const result = new Map<string, ReSdkOwnerRef>();
  const classPattern = /^[ \t]*class\(([A-Za-z_][A-Za-z0-9_:]*)\)(?:[ \t]+extends\(([A-Za-z_][A-Za-z0-9_:]*)\))?/;
  const structPattern = /^[ \t]*struct\(([A-Za-z_][A-Za-z0-9_:]*)\)(?:[ \t]+base\(([A-Za-z_][A-Za-z0-9_:]*)\))?/;
  const includePattern = /^[ \t]*#include\b/;

  for (const [filePath, edges] of project.outgoing) {
    const includeEdges = edges.filter((edge) => edge.kind === "include" || edge.kind === "componentInclude");
    if (includeEdges.length === 0) {
      continue;
    }

    let includeIndex = 0;
    let currentOwner: ReSdkOwnerRef | undefined;
    const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
    const nonCodeState = { blockComment: false };
    for (const rawLine of lines) {
      const lineText = maskNonCodeLine(rawLine, nonCodeState);
      const classMatch = classPattern.exec(lineText);
      if (classMatch) {
        currentOwner = { name: classMatch[1], kind: "class" };
      }

      const structMatch = structPattern.exec(lineText);
      if (structMatch) {
        currentOwner = { name: structMatch[1], kind: "struct" };
      }

      if (includePattern.test(lineText)) {
        const edge = includeEdges[includeIndex++];
        if (edge && currentOwner) {
          const key = normalizeFsPath(edge.to);
          if (!result.has(key)) {
            result.set(key, currentOwner);
          }
        }
      }

      if (/^[ \t]*endclass\b/.test(lineText) && currentOwner?.kind === "class") {
        currentOwner = undefined;
      } else if (/^[ \t]*endstruct\b/.test(lineText) && currentOwner?.kind === "struct") {
        currentOwner = undefined;
      }
    }
  }

  return result;
}

function buildLowerNameIndex(symbols: IndexedSymbol[]): Map<string, IndexedSymbol[]> {
  const byLowerName = new Map<string, IndexedSymbol[]>();
  for (const symbol of symbols) {
    const key = symbol.name.toLowerCase();
    const bucket = byLowerName.get(key) ?? [];
    bucket.push(symbol);
    byLowerName.set(key, bucket);
  }
  return byLowerName;
}

export function updateWorkspaceSymbolIndexFileFast(
  project: WorkspaceProject,
  previousIndex: WorkspaceSymbolIndex,
  filePath: string,
  text?: string
): WorkspaceSymbolIndex {
  const changedKey = normalizeFsPath(filePath);
  const rawFileSymbolsByPath = new Map(previousIndex.rawFileSymbolsByPath);
  const projectFilePath = Array.from(project.outgoing.keys()).find((candidate) => normalizeFsPath(candidate) === changedKey);
  const previousChangedSymbols = new Map<string, IndexedSymbol>();
  for (const symbol of previousIndex.all) {
    if (normalizeFsPath(symbol.filePath) === changedKey) {
      previousChangedSymbols.set(symbolIdentity(symbol), symbol);
    }
  }

  if (projectFilePath) {
    const inheritedOwner = collectInheritedIncludeOwners(project).get(changedKey);
    const rawSymbols = text !== undefined
      ? extractTextSymbols(projectFilePath, text, inheritedOwner)
      : extractFileSymbols(projectFilePath, inheritedOwner);
    rawFileSymbolsByPath.set(changedKey, rawSymbols);
  } else {
    rawFileSymbolsByPath.delete(changedKey);
  }

  const all: IndexedSymbol[] = [];
  for (const symbol of previousIndex.all) {
    if (normalizeFsPath(symbol.filePath) !== changedKey) {
      all.push(cloneIndexedSymbol(symbol));
    }
  }
  for (const symbol of rawFileSymbolsByPath.get(changedKey) ?? []) {
    all.push(mergeFastRefinedSymbol(symbol, previousChangedSymbols.get(symbolIdentity(symbol))));
  }

  let workingIndex: WorkspaceSymbolIndex = {
    all,
    byLowerName: buildLowerNameIndex(all),
    typesByLowerName: buildReSdkTypeIndex(all),
    rawFileSymbolsByPath
  };
  refineReSdkPropertyTypesFromWrites(all, workingIndex);

  for (let iteration = 0; iteration < 2; ++iteration) {
    const functionReturnTypes = new Map<string, string>(intrinsicGlobalFunctionReturnTypes);
    for (const symbol of all) {
      if (symbol.kind === "globalFunction" && symbol.functionReturnType) {
        functionReturnTypes.set(symbol.name.toLowerCase(), symbol.functionReturnType);
      }
    }
    workingIndex = {
      all,
      byLowerName: buildLowerNameIndex(all),
      typesByLowerName: buildReSdkTypeIndex(all),
      rawFileSymbolsByPath
    };

    let changed = false;
    for (let index = 0; index < all.length; ++index) {
      if (normalizeFsPath(all[index].filePath) !== changedKey) {
        continue;
      }
      const refinedFunction = refineFunctionSymbol(all[index], functionReturnTypes);
      const refinedMember = refineReSdkMemberFunctionSymbol(refinedFunction, workingIndex);
      if (refinedMember.functionReturnType !== all[index].functionReturnType || refinedMember.signatureLabel !== all[index].signatureLabel) {
        all[index] = refinedMember;
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }

  return {
    all,
    byLowerName: buildLowerNameIndex(all),
    typesByLowerName: buildReSdkTypeIndex(all),
    rawFileSymbolsByPath
  };
}

function emptyTypeInfo(symbol: IndexedSymbol): ReSdkTypeInfo {
  return {
    name: symbol.name,
    kind: symbol.kind === "structType" ? "struct" : "class",
    baseName: symbol.baseName,
    symbol,
    methodsByLowerName: new Map(),
    propertiesByLowerName: new Map(),
    membersByLowerName: new Map()
  };
}

function typeIndexKey(owner: ReSdkOwnerRef): string {
  return `${owner.kind}:${owner.name.toLowerCase()}`;
}

function getOrCreateTypeInfo(typesByLowerName: Map<string, ReSdkTypeInfo>, owner: ReSdkOwnerRef): ReSdkTypeInfo {
  const key = typeIndexKey(owner);
  const existing = typesByLowerName.get(key);
  if (existing) {
    return existing;
  }

  const created: ReSdkTypeInfo = {
    name: owner.name,
    kind: owner.kind,
    methodsByLowerName: new Map(),
    propertiesByLowerName: new Map(),
    membersByLowerName: new Map()
  };
  typesByLowerName.set(key, created);
  return created;
}

function pushMappedSymbol(map: Map<string, IndexedSymbol[]>, symbol: IndexedSymbol): void {
  const key = symbol.name.toLowerCase();
  const bucket = map.get(key) ?? [];
  bucket.push(symbol);
  map.set(key, bucket);
}

function propagateInheritedMemberSignatures(typesByLowerName: Map<string, ReSdkTypeInfo>): void {
  for (let iteration = 0; iteration < 4; ++iteration) {
    let changed = false;
    for (const info of typesByLowerName.values()) {
      if (!info.baseName) {
        continue;
      }
      const base = typesByLowerName.get(typeIndexKey({ name: info.baseName, kind: info.kind }));
      if (!base) {
        continue;
      }

      const memberMaps: Array<[Map<string, IndexedSymbol[]>, Map<string, IndexedSymbol[]>]> = [
        [info.methodsByLowerName, base.methodsByLowerName],
        [info.propertiesByLowerName, base.propertiesByLowerName],
        [info.membersByLowerName, base.membersByLowerName]
      ];
      for (const [currentMap, baseMap] of memberMaps) {
        for (const [name, currentMembers] of currentMap) {
          const baseMember = baseMap.get(name)?.[0];
          if (!baseMember) {
            continue;
          }
          for (const currentMember of currentMembers) {
            if (!currentMember.valueType && baseMember.valueType) {
              currentMember.valueType = baseMember.valueType;
              changed = true;
            }
            if (!currentMember.functionReturnType && baseMember.functionReturnType) {
              currentMember.functionReturnType = baseMember.functionReturnType;
              changed = true;
            }
            if ((!currentMember.functionParameters || currentMember.functionParameters.length === 0) && baseMember.functionParameters?.length) {
              currentMember.functionParameters = baseMember.functionParameters.map((parameter) => ({ ...parameter }));
              currentMember.signatureLabel = formatFunctionSignature(currentMember.name, currentMember.functionParameters, currentMember.functionReturnType);
              changed = true;
            }
          }
        }
      }
    }
    if (!changed) {
      break;
    }
  }
}

function buildReSdkTypeIndex(all: IndexedSymbol[]): Map<string, ReSdkTypeInfo> {
  const typesByLowerName = new Map<string, ReSdkTypeInfo>();
  for (const symbol of all) {
    if (symbol.kind !== "classType" && symbol.kind !== "structType") {
      continue;
    }
    const ownerKind: ReSdkOwnerKind = symbol.kind === "structType" ? "struct" : "class";
    const key = typeIndexKey({ name: symbol.name, kind: ownerKind });
    const existing = typesByLowerName.get(key);
    typesByLowerName.set(key, {
      ...(existing ?? emptyTypeInfo(symbol)),
      name: symbol.name,
      kind: ownerKind,
      baseName: symbol.baseName ?? existing?.baseName,
      symbol
    });
  }

  for (const symbol of all) {
    if (!symbol.ownerName || !symbol.ownerKind) {
      continue;
    }

    const info = getOrCreateTypeInfo(typesByLowerName, { name: symbol.ownerName, kind: symbol.ownerKind });
    if (symbol.kind === "classMethod") {
      pushMappedSymbol(info.methodsByLowerName, symbol);
    } else if (symbol.kind === "classProperty") {
      pushMappedSymbol(info.propertiesByLowerName, symbol);
    } else if (symbol.kind === "structMember") {
      pushMappedSymbol(info.membersByLowerName, symbol);
    }
  }

  propagateInheritedMemberSignatures(typesByLowerName);
  return typesByLowerName;
}

export function buildWorkspaceSymbolIndex(
  project: WorkspaceProject,
  previousIndex?: WorkspaceSymbolIndex,
  changedFiles?: Iterable<string>,
  textOverrides?: Map<string, string>
): WorkspaceSymbolIndex {
  const changedFileKeys = changedFiles
    ? new Set(Array.from(changedFiles, (filePath) => normalizeFsPath(filePath)))
    : undefined;
  const textOverrideByPath = new Map<string, string>();
  for (const [filePath, text] of textOverrides ?? []) {
    textOverrideByPath.set(normalizeFsPath(filePath), text);
  }
  const rawFileSymbolsByPath = new Map<string, IndexedSymbol[]>();
  const inheritedOwners = collectInheritedIncludeOwners(project);
  for (const filePath of project.outgoing.keys()) {
    const key = normalizeFsPath(filePath);
    const cachedRawSymbols = previousIndex?.rawFileSymbolsByPath.get(key);
    const textOverride = textOverrideByPath.get(key);
    const canReuse = cachedRawSymbols && changedFileKeys && !changedFileKeys.has(key) && textOverride === undefined;
    const rawSymbols = canReuse
      ? cachedRawSymbols
      : textOverride !== undefined
        ? extractTextSymbols(filePath, textOverride, inheritedOwners.get(key))
        : extractFileSymbols(filePath, inheritedOwners.get(key));
    rawFileSymbolsByPath.set(key, rawSymbols);
  }

  const all: IndexedSymbol[] = [];
  for (const symbols of rawFileSymbolsByPath.values()) {
    for (const symbol of symbols) {
      all.push(cloneIndexedSymbol(symbol));
    }
  }

  for (let iteration = 0; iteration < 3; ++iteration) {
    const functionReturnTypes = new Map<string, string>(intrinsicGlobalFunctionReturnTypes);
    for (const symbol of all) {
      if (symbol.kind === "globalFunction" && symbol.functionReturnType) {
        functionReturnTypes.set(symbol.name.toLowerCase(), symbol.functionReturnType);
      }
    }

    let changed = false;
    for (let index = 0; index < all.length; ++index) {
      const refined = refineFunctionSymbol(all[index], functionReturnTypes);
      if (refined.functionReturnType !== all[index].functionReturnType || refined.signatureLabel !== all[index].signatureLabel) {
        all[index] = refined;
        changed = true;
      }
    }

    if (!changed) {
      break;
    }
  }

  for (let iteration = 0; iteration < 3; ++iteration) {
    const typeIndex = buildReSdkTypeIndex(all);
    const refinementIndex: WorkspaceSymbolIndex = { all, byLowerName: new Map(), typesByLowerName: typeIndex, rawFileSymbolsByPath };
    refineReSdkPropertyTypesFromWrites(all, refinementIndex);
    let changed = false;
    for (let index = 0; index < all.length; ++index) {
      const refined = refineReSdkMemberFunctionSymbol(all[index], refinementIndex);
      if (refined.functionReturnType !== all[index].functionReturnType || refined.signatureLabel !== all[index].signatureLabel) {
        all[index] = refined;
        changed = true;
      }
    }

    if (!changed) {
      break;
    }
  }

  for (let iteration = 0; iteration < 2; ++iteration) {
    const typeIndex = buildReSdkTypeIndex(all);
    const refinementIndex: WorkspaceSymbolIndex = { all, byLowerName: new Map(), typesByLowerName: typeIndex, rawFileSymbolsByPath };
    if (!refineReSdkParameterTypesFromCalls(all, refinementIndex)) {
      break;
    }
  }

  for (let iteration = 0; iteration < 2; ++iteration) {
    const typeIndex = buildReSdkTypeIndex(all);
    const refinementIndex: WorkspaceSymbolIndex = { all, byLowerName: new Map(), typesByLowerName: typeIndex, rawFileSymbolsByPath };
    if (!refineGlobalVariableTypesFromWrites(all, refinementIndex)) {
      break;
    }
  }

  for (let iteration = 0; iteration < 2; ++iteration) {
    const typeIndex = buildReSdkTypeIndex(all);
    const refinementIndex: WorkspaceSymbolIndex = { all, byLowerName: new Map(), typesByLowerName: typeIndex, rawFileSymbolsByPath };
    refineReSdkPropertyTypesFromWrites(all, refinementIndex);
    let changed = false;
    for (let index = 0; index < all.length; ++index) {
      const refined = refineReSdkMemberFunctionSymbol(all[index], refinementIndex);
      if (refined.functionReturnType !== all[index].functionReturnType || refined.signatureLabel !== all[index].signatureLabel) {
        all[index] = refined;
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }

  return { all, byLowerName: buildLowerNameIndex(all), typesByLowerName: buildReSdkTypeIndex(all), rawFileSymbolsByPath };
}

export function resolveIndexedTypeOwner(index: WorkspaceSymbolIndex, typeName: string | undefined): ReSdkOwnerRef | undefined {
  if (!typeName) {
    return undefined;
  }
  if (isPrimitiveTypeName(typeName) || /^enum\./i.test(typeName) || typeName.endsWith("[]") || typeName.startsWith("map<")) {
    return undefined;
  }

  const encoded = /^(class|struct):([A-Za-z_][A-Za-z0-9_:]*)$/i.exec(typeName.trim());
  if (encoded) {
    const owner = {
      kind: encoded[1].toLowerCase() as ReSdkOwnerKind,
      name: encoded[2]
    };
    const info = index.typesByLowerName.get(typeIndexKey(owner));
    return info ? { name: info.name, kind: info.kind } : owner;
  }

  const classInfo = index.typesByLowerName.get(typeIndexKey({ name: typeName.trim(), kind: "class" }));
  const structInfo = index.typesByLowerName.get(typeIndexKey({ name: typeName.trim(), kind: "struct" }));
  if (classInfo && !structInfo) {
    return { name: classInfo.name, kind: classInfo.kind };
  }
  if (structInfo && !classInfo) {
    return { name: structInfo.name, kind: structInfo.kind };
  }
  return undefined;
}

export function resolveReSdkMember(
  index: WorkspaceSymbolIndex,
  owner: ReSdkOwnerRef | undefined,
  memberName: string,
  role: "method" | "property" | "structMember"
): IndexedSymbol | undefined {
  if (!owner) {
    return undefined;
  }

  const visited = new Set<string>();
  let current: ReSdkOwnerRef | undefined = owner;
  while (current && !visited.has(`${current.kind}:${current.name.toLowerCase()}`)) {
    visited.add(`${current.kind}:${current.name.toLowerCase()}`);
    const info = index.typesByLowerName.get(typeIndexKey(current));
    if (!info || info.kind !== current.kind) {
      break;
    }

    const loweredMember = memberName.toLowerCase();
    const candidates = role === "method"
      ? info.methodsByLowerName.get(loweredMember)
      : role === "property"
        ? info.propertiesByLowerName.get(loweredMember)
        : info.membersByLowerName.get(loweredMember);
    if (candidates?.length) {
      return candidates[0];
    }

    current = info.baseName ? resolveIndexedTypeOwner(index, `${current.kind}:${info.baseName}`) : undefined;
  }

  return undefined;
}

export function getReSdkMemberCandidates(
  index: WorkspaceSymbolIndex,
  memberName: string,
  role: "method" | "property" | "structMember"
): IndexedSymbol[] {
  const loweredMember = memberName.toLowerCase();
  const result: IndexedSymbol[] = [];
  const seen = new Set<string>();
  for (const info of index.typesByLowerName.values()) {
    const candidates = role === "method"
      ? info.methodsByLowerName.get(loweredMember)
      : role === "property"
        ? info.propertiesByLowerName.get(loweredMember)
        : info.membersByLowerName.get(loweredMember);
    for (const candidate of candidates ?? []) {
      const key = `${candidate.kind}:${candidate.ownerKind}:${candidate.ownerName}:${candidate.filePath}:${candidate.line}:${candidate.name}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push(candidate);
    }
  }
  return result;
}

function filterVisibleSymbols(
  index: WorkspaceSymbolIndex,
  project: WorkspaceProject,
  preferredContext: ResolvedContext | undefined,
  kind: IndexedSymbolKind
): IndexedSymbol[] {
  const symbols = index.all.filter((symbol) => symbol.kind === kind);
  if (!preferredContext) {
    return symbols;
  }

  if (
    kind === "globalFunction"
    || kind === "globalVariable"
    || kind === "classType"
    || kind === "structType"
    || kind === "classMethod"
    || kind === "classProperty"
    || kind === "structMember"
  ) {
    return symbols;
  }

  const reachable = collectReachableFiles(project, preferredContext.validationEntryFile);
  return symbols.filter((symbol) => reachable.has(symbol.filePath) || normalizeFsPath(symbol.filePath) === normalizeFsPath(preferredContext.targetFile));
}

export function getVisibleMacroNames(
  index: WorkspaceSymbolIndex,
  project: WorkspaceProject,
  preferredContext: ResolvedContext | undefined
): Set<string> {
  return new Set(filterVisibleSymbols(index, project, preferredContext, "macro").map((symbol) => symbol.name));
}

export function getVisibleMacroSymbols(
  index: WorkspaceSymbolIndex,
  project: WorkspaceProject,
  preferredContext: ResolvedContext | undefined
): IndexedSymbol[] {
  return filterVisibleSymbols(index, project, preferredContext, "macro");
}

export function getVisibleSymbolMatches(
  index: WorkspaceSymbolIndex,
  project: WorkspaceProject,
  preferredContext: ResolvedContext | undefined,
  token: string
): IndexedSymbol[] {
  const lowered = token.toLowerCase();
  const macroCandidates = filterVisibleSymbols(index, project, preferredContext, "macro");
  const functionCandidates = filterVisibleSymbols(index, project, preferredContext, "globalFunction");
  const variableCandidates = filterVisibleSymbols(index, project, preferredContext, "globalVariable");
  const classCandidates = filterVisibleSymbols(index, project, preferredContext, "classType");
  const structCandidates = filterVisibleSymbols(index, project, preferredContext, "structType");
  const classMethodCandidates = filterVisibleSymbols(index, project, preferredContext, "classMethod");
  const classPropertyCandidates = filterVisibleSymbols(index, project, preferredContext, "classProperty");
  const structMemberCandidates = filterVisibleSymbols(index, project, preferredContext, "structMember");

  return [...macroCandidates, ...functionCandidates, ...variableCandidates, ...classCandidates, ...structCandidates, ...classMethodCandidates, ...classPropertyCandidates, ...structMemberCandidates]
    .filter((symbol) => symbol.name.toLowerCase() === lowered);
}

export function getVisibleCompletionItems(
  index: WorkspaceSymbolIndex,
  project: WorkspaceProject,
  preferredContext: ResolvedContext | undefined
): CompletionItem[] {
  const items: CompletionItem[] = [];
  const seen = new Set<string>();

  for (const symbol of filterVisibleSymbols(index, project, preferredContext, "macro")) {
    const key = `macro:${symbol.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      label: symbol.name,
      kind: CompletionItemKind.Constant,
      detail: symbol.detail,
      documentation: symbol.filePath
    });
  }

  for (const symbol of filterVisibleSymbols(index, project, preferredContext, "globalFunction")) {
    const key = `function:${symbol.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      label: symbol.name,
      kind: CompletionItemKind.Function,
      detail: symbol.signatureLabel ?? symbol.detail,
      documentation: symbol.signatureSource
        ? `${symbol.filePath}\n${symbol.detail}`
        : symbol.filePath
    });
  }

  for (const symbol of filterVisibleSymbols(index, project, preferredContext, "globalVariable")) {
    const key = `variable:${symbol.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      label: symbol.name,
      kind: CompletionItemKind.Variable,
      detail: symbol.detail,
      documentation: symbol.filePath
    });
  }

  for (const symbol of filterVisibleSymbols(index, project, preferredContext, "classType")) {
    const key = `class:${symbol.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      label: symbol.name,
      kind: CompletionItemKind.Class,
      detail: symbol.detail,
      documentation: symbol.filePath
    });
  }

  for (const symbol of filterVisibleSymbols(index, project, preferredContext, "structType")) {
    const key = `struct:${symbol.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      label: symbol.name,
      kind: CompletionItemKind.Struct,
      detail: symbol.detail,
      documentation: symbol.filePath
    });
  }

  for (const symbol of filterVisibleSymbols(index, project, preferredContext, "classMethod")) {
    const key = `classMethod:${symbol.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      label: symbol.name,
      kind: CompletionItemKind.Method,
      detail: symbol.signatureLabel ?? symbol.detail,
      documentation: symbol.filePath
    });
  }

  for (const symbol of filterVisibleSymbols(index, project, preferredContext, "classProperty")) {
    const key = `classProperty:${symbol.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      label: symbol.name,
      kind: CompletionItemKind.Property,
      detail: symbol.detail,
      documentation: symbol.filePath
    });
  }

  for (const symbol of filterVisibleSymbols(index, project, preferredContext, "structMember")) {
    const key = `structMember:${symbol.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      label: symbol.name,
      kind: CompletionItemKind.Field,
      detail: symbol.detail,
      documentation: symbol.filePath
    });
  }

  return items;
}

export function getDefinitionLocations(
  index: WorkspaceSymbolIndex,
  project: WorkspaceProject,
  preferredContext: ResolvedContext | undefined,
  token: string
): Location[] {
  const macroCandidates = filterVisibleSymbols(index, project, preferredContext, "macro");
  const functionCandidates = filterVisibleSymbols(index, project, preferredContext, "globalFunction");
  const variableCandidates = filterVisibleSymbols(index, project, preferredContext, "globalVariable");
  const classCandidates = filterVisibleSymbols(index, project, preferredContext, "classType");
  const structCandidates = filterVisibleSymbols(index, project, preferredContext, "structType");
  const classMethodCandidates = filterVisibleSymbols(index, project, preferredContext, "classMethod");
  const classPropertyCandidates = filterVisibleSymbols(index, project, preferredContext, "classProperty");
  const structMemberCandidates = filterVisibleSymbols(index, project, preferredContext, "structMember");
  const matches = [...macroCandidates, ...functionCandidates, ...variableCandidates, ...classCandidates, ...structCandidates, ...classMethodCandidates, ...classPropertyCandidates, ...structMemberCandidates]
    .filter((symbol) => symbol.name.toLowerCase() === token.toLowerCase());

  return matches.map((symbol) => buildLocation(symbol.filePath, symbol.line, 0));
}

function maskNonCodeLine(lineText: string, state: { blockComment: boolean }): string {
  let masked = "";
  let quote: string | undefined;
  for (let index = 0; index < lineText.length; ++index) {
    const current = lineText[index];
    const next = lineText[index + 1];

    if (state.blockComment) {
      if (current === "*" && next === "/") {
        masked += "  ";
        state.blockComment = false;
        index += 1;
      } else {
        masked += " ";
      }
      continue;
    }

    if (quote) {
      masked += " ";
      if (current === quote) {
        quote = undefined;
      }
      continue;
    }

    if (current === "/" && next === "/") {
      masked += " ".repeat(lineText.length - index);
      break;
    }

    if (current === "/" && next === "*") {
      masked += "  ";
      state.blockComment = true;
      index += 1;
      continue;
    }

    if (current === '"' || current === "'") {
      masked += " ";
      quote = current;
      continue;
    }

    masked += current;
  }

  return masked;
}

export function getReferenceLocations(
  index: WorkspaceSymbolIndex,
  project: WorkspaceProject,
  preferredContext: ResolvedContext | undefined,
  token: string,
  includeDeclaration: boolean
): Location[] {
  const lowerToken = token.toLowerCase();
  const matchedSymbols = (index.byLowerName.get(lowerToken) ?? []).filter((symbol) => {
    if (symbol.kind === "macro") {
      return filterVisibleSymbols(index, project, preferredContext, "macro").some((candidate) => candidate.filePath === symbol.filePath && candidate.line === symbol.line && candidate.name === symbol.name);
    }

    if (symbol.kind === "globalFunction") {
      return filterVisibleSymbols(index, project, preferredContext, "globalFunction").some((candidate) => candidate.filePath === symbol.filePath && candidate.line === symbol.line && candidate.name === symbol.name);
    }

    if (symbol.kind === "globalVariable") {
      return filterVisibleSymbols(index, project, preferredContext, "globalVariable").some((candidate) => candidate.filePath === symbol.filePath && candidate.line === symbol.line && candidate.name === symbol.name);
    }

    if (symbol.kind === "classType") {
      return filterVisibleSymbols(index, project, preferredContext, "classType").some((candidate) => candidate.filePath === symbol.filePath && candidate.line === symbol.line && candidate.name === symbol.name);
    }

    return filterVisibleSymbols(index, project, preferredContext, symbol.kind).some((candidate) => candidate.filePath === symbol.filePath && candidate.line === symbol.line && candidate.name === symbol.name);
  });

  if (matchedSymbols.length === 0) {
    return [];
  }

  const hasMacro = matchedSymbols.some((symbol) => symbol.kind === "macro");
  const searchFiles = hasMacro && preferredContext
    ? Array.from(collectReachableFiles(project, preferredContext.validationEntryFile))
    : Array.from(project.outgoing.keys());

  const tokenPattern = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(token)}(?![A-Za-z0-9_])`, "g");
  const references: Location[] = [];
  const definitionKeys = new Set<string>(matchedSymbols.map((symbol) => `${normalizeFsPath(symbol.filePath)}:${symbol.line}`));

  for (const filePath of searchFiles) {
    const text = readFileSync(filePath, "utf8");
    const lines = text.split(/\r?\n/);
    const state = { blockComment: false };
    for (let lineIndex = 0; lineIndex < lines.length; ++lineIndex) {
      const lineText = maskNonCodeLine(lines[lineIndex], state);
      let match: RegExpExecArray | null;
      tokenPattern.lastIndex = 0;
      while ((match = tokenPattern.exec(lineText)) !== null) {
        const lineNumber = lineIndex + 1;
        const definitionKey = `${normalizeFsPath(filePath)}:${lineNumber}`;
        if (!includeDeclaration && definitionKeys.has(definitionKey)) {
          continue;
        }
        references.push(buildLocation(filePath, lineNumber, match.index));
      }
    }
  }

  return references;
}
