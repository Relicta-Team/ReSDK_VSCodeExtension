import { Position } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";

import { IndexedSymbol } from "./symbolIndex";

type ConditionalFrame = {
  parentActive: boolean;
  branchTaken: boolean;
  currentActive: boolean;
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trimOuterParens(input: string): string {
  let text = input.trim();
  while (text.startsWith("(") && text.endsWith(")")) {
    let depth = 0;
    let balanced = true;
    for (let index = 0; index < text.length; ++index) {
      const ch = text[index];
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (depth === 0 && index < text.length - 1) {
        balanced = false;
        break;
      }
    }
    if (!balanced) {
      break;
    }
    text = text.slice(1, -1).trim();
  }
  return text;
}

function splitByOperator(input: string, operator: "&&" | "||"): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < input.length - 1; ++index) {
    const ch = input[index];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && input.slice(index, index + 2) === operator) {
      parts.push(input.slice(start, index));
      start = index + 2;
      index += 1;
    }
  }
  if (parts.length === 0) {
    return [input];
  }
  parts.push(input.slice(start));
  return parts;
}

function evaluateCondition(expression: string, activeDefines: Set<string>): boolean {
  const trimmed = trimOuterParens(expression);
  if (!trimmed) {
    return false;
  }

  const orParts = splitByOperator(trimmed, "||");
  if (orParts.length > 1) {
    return orParts.some((part) => evaluateCondition(part, activeDefines));
  }

  const andParts = splitByOperator(trimmed, "&&");
  if (andParts.length > 1) {
    return andParts.every((part) => evaluateCondition(part, activeDefines));
  }

  if (trimmed.startsWith("!")) {
    return !evaluateCondition(trimmed.slice(1), activeDefines);
  }

  const definedPattern = /^defined\s*(?:\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)|([A-Za-z_][A-Za-z0-9_]*))$/;
  const definedMatch = definedPattern.exec(trimmed);
  if (definedMatch) {
    const name = definedMatch[1] || definedMatch[2];
    return activeDefines.has(name);
  }

  if (trimmed === "1" || trimmed.toLowerCase() === "true") {
    return true;
  }
  if (trimmed === "0" || trimmed.toLowerCase() === "false") {
    return false;
  }

  return activeDefines.has(trimmed);
}

function getCurrentActive(stack: ConditionalFrame[]): boolean {
  return stack.length === 0 ? true : stack[stack.length - 1].currentActive;
}

function parseMacroDefinition(line: string, lineNumber: number, filePath: string): IndexedSymbol | undefined {
  const match = /^#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)(?:\(([^)\r\n]*)\))?(?:[ \t]+(.*))?$/.exec(line.trim());
  if (!match) {
    return undefined;
  }

  const macroParameters = match[2]
    ? match[2].split(",").map((parameter) => parameter.trim()).filter(Boolean)
    : undefined;
  return {
    name: match[1],
    kind: "macro",
    filePath,
    line: lineNumber,
    detail: macroParameters && macroParameters.length > 0
      ? `#define(${macroParameters.join(", ")})`
      : "#define",
    macroParameters,
    macroBody: match[3]?.trim() ?? ""
  };
}

export function collectActiveDocumentMacros(
  document: TextDocument,
  position: Position,
  initialDefinedNames: Set<string>,
  filePath: string
): Map<string, IndexedSymbol> {
  const activeDefines = new Set(initialDefinedNames);
  const activeMacros = new Map<string, IndexedSymbol>();
  const stack: ConditionalFrame[] = [];
  const lines = document.getText().split(/\r?\n/);
  const lastLine = Math.min(position.line, Math.max(0, lines.length - 1));

  for (let lineIndex = 0; lineIndex <= lastLine; ++lineIndex) {
    const sourceLine = lines[lineIndex] ?? "";
    const line = lineIndex === position.line ? sourceLine.slice(0, position.character) : sourceLine;
    const trimmed = line.trim();
    const wasActive = getCurrentActive(stack);

    const directiveMatch = /^#\s*(ifdef|ifndef|if|elif|else|endif)\b(.*)$/i.exec(trimmed);
    if (directiveMatch) {
      const directive = directiveMatch[1].toLowerCase();
      const argument = directiveMatch[2].trim();
      if (directive === "ifdef") {
        const parentActive = wasActive;
        const cond = activeDefines.has(argument);
        stack.push({
          parentActive,
          branchTaken: parentActive && cond,
          currentActive: parentActive && cond
        });
      } else if (directive === "ifndef") {
        const parentActive = wasActive;
        const cond = !activeDefines.has(argument);
        stack.push({
          parentActive,
          branchTaken: parentActive && cond,
          currentActive: parentActive && cond
        });
      } else if (directive === "if") {
        const parentActive = wasActive;
        const cond = evaluateCondition(argument, activeDefines);
        stack.push({
          parentActive,
          branchTaken: parentActive && cond,
          currentActive: parentActive && cond
        });
      } else if (directive === "elif") {
        const frame = stack[stack.length - 1];
        if (frame) {
          const cond = evaluateCondition(argument, activeDefines);
          frame.currentActive = frame.parentActive && !frame.branchTaken && cond;
          frame.branchTaken = frame.branchTaken || frame.currentActive;
        }
      } else if (directive === "else") {
        const frame = stack[stack.length - 1];
        if (frame) {
          frame.currentActive = frame.parentActive && !frame.branchTaken;
          frame.branchTaken = true;
        }
      } else if (directive === "endif") {
        if (stack.length > 0) {
          stack.pop();
        }
      }
      continue;
    }

    if (!wasActive) {
      continue;
    }

    const macroDefinition = parseMacroDefinition(line, lineIndex + 1, filePath);
    if (macroDefinition) {
      activeDefines.add(macroDefinition.name);
      activeMacros.set(macroDefinition.name.toLowerCase(), macroDefinition);
      continue;
    }

    const undefMatch = /^#\s*undef\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(trimmed);
    if (undefMatch) {
      activeDefines.delete(undefMatch[1]);
      activeMacros.delete(undefMatch[1].toLowerCase());
    }
  }

  return activeMacros;
}

export function getMacroInvocationArgumentsAtPosition(
  document: TextDocument,
  position: Position,
  macroName: string
): string[] | undefined {
  const lineText = document.getText({
    start: { line: position.line, character: 0 },
    end: { line: position.line, character: Number.MAX_SAFE_INTEGER }
  });
  const tokenPattern = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(macroName)}(?![A-Za-z0-9_])`, "g");

  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(lineText)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (position.character < start || position.character > end) {
      continue;
    }

    let cursor = end;
    while (cursor < lineText.length && /\s/.test(lineText[cursor])) {
      cursor += 1;
    }
    if (lineText[cursor] !== "(") {
      return undefined;
    }

    const argumentsText: string[] = [];
    let depth = 1;
    let quote: string | undefined;
    let argumentStart = cursor + 1;
    for (let index = cursor + 1; index < lineText.length; ++index) {
      const ch = lineText[index];
      if (quote) {
        if (ch === quote) {
          quote = undefined;
        }
        continue;
      }

      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }

      if (ch === "(" || ch === "[" || ch === "{") {
        depth += 1;
        continue;
      }
      if (ch === ")" || ch === "]" || ch === "}") {
        depth -= 1;
        if (ch === ")" && depth === 0) {
          argumentsText.push(lineText.slice(argumentStart, index).trim());
          return argumentsText.length === 1 && argumentsText[0] === "" ? [] : argumentsText;
        }
        continue;
      }
      if (ch === "," && depth === 1) {
        argumentsText.push(lineText.slice(argumentStart, index).trim());
        argumentStart = index + 1;
      }
    }
  }

  return undefined;
}

function substituteMacroParameters(body: string, parameters: string[], argumentsText: string[] | undefined): string {
  if (!argumentsText || argumentsText.length === 0) {
    return body;
  }

  let result = body;
  for (let index = 0; index < parameters.length; ++index) {
    const parameter = parameters[index];
    const replacement = argumentsText[index] ?? parameter;
    result = result.replace(new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(parameter)}(?![A-Za-z0-9_])`, "g"), replacement);
  }
  return result;
}

function replaceIdentifiersOutsideStrings(text: string, replacer: (token: string) => string): string {
  let result = "";
  let index = 0;
  let quote: string | undefined;

  while (index < text.length) {
    const current = text[index];
    if (quote) {
      result += current;
      if (current === quote && text[index - 1] !== "\\") {
        quote = undefined;
      }
      index += 1;
      continue;
    }

    if (current === '"' || current === "'") {
      quote = current;
      result += current;
      index += 1;
      continue;
    }

    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(index));
    if (match) {
      result += replacer(match[0]);
      index += match[0].length;
      continue;
    }

    result += current;
    index += 1;
  }

  return result;
}

export function buildMacroPreview(
  macro: IndexedSymbol,
  argumentsText: string[] | undefined,
  visibleMacrosByName: Map<string, IndexedSymbol>
): string | undefined {
  const body = macro.macroBody?.trim();
  if (!body) {
    return undefined;
  }

  const parameters = macro.macroParameters ?? [];
  let preview = parameters.length > 0
    ? substituteMacroParameters(body, parameters, argumentsText)
    : body;

  for (let iteration = 0; iteration < 8; ++iteration) {
    let changed = false;
    preview = replaceIdentifiersOutsideStrings(preview, (token) => {
      const candidate = visibleMacrosByName.get(token.toLowerCase());
      if (!candidate || candidate.name.toLowerCase() === macro.name.toLowerCase()) {
        return token;
      }
      if ((candidate.macroParameters?.length ?? 0) > 0) {
        return token;
      }
      const candidateBody = candidate.macroBody?.trim();
      if (!candidateBody || candidateBody === token) {
        return token;
      }
      changed = true;
      return candidateBody;
    });
    if (!changed) {
      break;
    }
  }

  return preview;
}
