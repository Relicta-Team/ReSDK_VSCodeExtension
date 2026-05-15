export type InactiveLineRange = {
  startLine: number;
  endLine: number;
};

type ConditionalFrame = {
  parentActive: boolean;
  branchTaken: boolean;
  currentActive: boolean;
};

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

function closeInactiveRange(ranges: InactiveLineRange[], openStart: number, endLine: number): number {
  if (openStart >= 0 && endLine >= openStart) {
    ranges.push({ startLine: openStart, endLine });
  }
  return -1;
}

function getCurrentActive(stack: ConditionalFrame[]): boolean {
  return stack.length === 0 ? true : stack[stack.length - 1].currentActive;
}

export function computeInactiveRanges(
  text: string,
  baseDefines: Iterable<string>
): InactiveLineRange[] {
  const activeDefines = new Set<string>(baseDefines);

  const ranges: InactiveLineRange[] = [];
  const lines = text.split(/\r?\n/);
  const stack: ConditionalFrame[] = [];
  let inactiveStart = -1;

  for (let lineIndex = 0; lineIndex < lines.length; ++lineIndex) {
    const line = lines[lineIndex];
    const trimmed = line.trim();
    const wasActive = getCurrentActive(stack);

    const directiveMatch = /^#\s*(ifdef|ifndef|if|elif|else|endif)\b(.*)$/i.exec(trimmed);
    if (directiveMatch) {
      const directive = directiveMatch[1].toLowerCase();
      const argument = directiveMatch[2].trim();

      if (!wasActive) {
        if (inactiveStart < 0) inactiveStart = lineIndex;
      } else {
        inactiveStart = closeInactiveRange(ranges, inactiveStart, lineIndex - 1);
      }

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
      if (inactiveStart < 0) inactiveStart = lineIndex;
    } else {
      inactiveStart = closeInactiveRange(ranges, inactiveStart, lineIndex - 1);
    }

    const defineMatch = /^#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(trimmed);
    if (defineMatch && wasActive) {
      activeDefines.add(defineMatch[1]);
    }

    const undefMatch = /^#\s*undef\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(trimmed);
    if (undefMatch && wasActive) {
      activeDefines.delete(undefMatch[1]);
    }
  }

  closeInactiveRange(ranges, inactiveStart, lines.length - 1);
  return ranges;
}
