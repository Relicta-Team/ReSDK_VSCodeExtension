export type ReSdkRange = {
  start: number;
  end: number;
};

export type ReSdkIdentifierExpression = {
  kind: "identifier";
  name: string;
} & ReSdkRange;

export type ReSdkLiteralExpression = {
  kind: "literal";
  raw: string;
} & ReSdkRange;

export type ReSdkSequenceExpression = {
  kind: "sequence";
  items: ReSdkExpression[];
} & ReSdkRange;

export type ReSdkMacroCallExpression = {
  kind: "macroCall";
  name: string;
  nameStart: number;
  nameEnd: number;
  args: ReSdkExpression[];
} & ReSdkRange;

export type ReSdkInfixMacroExpression = {
  kind: "infixMacro";
  operator: string;
  operatorStart: number;
  operatorEnd: number;
  receiver: ReSdkExpression;
  args: ReSdkExpression[];
} & ReSdkRange;

export type ReSdkExpression =
  | ReSdkIdentifierExpression
  | ReSdkLiteralExpression
  | ReSdkSequenceExpression
  | ReSdkMacroCallExpression
  | ReSdkInfixMacroExpression;

export type ReSdkMemberReferenceNode = {
  memberName: string;
  memberStart: number;
  memberEnd: number;
  role: "method" | "property" | "structMember";
  receiver?: ReSdkExpression;
  call: ReSdkMacroCallExpression | ReSdkInfixMacroExpression;
};

type TokenKind = "identifier" | "string" | "number" | "punctuation" | "operator" | "eof";

type Token = {
  kind: TokenKind;
  value: string;
  start: number;
  end: number;
};

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\r" || char === "\n";
}

function isIdentifierStart(char: string): boolean {
  const code = char.charCodeAt(0);
  return char === "_" || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isIdentifierPart(char: string): boolean {
  const code = char.charCodeAt(0);
  return isIdentifierStart(char) || (code >= 48 && code <= 57);
}

function isDigit(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function isPunctuation(char: string): boolean {
  return char === "(" || char === ")" || char === "[" || char === "]" || char === "{" || char === "}" || char === "," || char === ";";
}

function tokenize(text: string, baseOffset: number): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const current = text[index];
    const next = text[index + 1] ?? "";

    if (isWhitespace(current)) {
      index += 1;
      continue;
    }

    if (current === "/" && next === "/") {
      index += 2;
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }
      continue;
    }

    if (current === "/" && next === "*") {
      index += 2;
      while (index < text.length - 1 && !(text[index] === "*" && text[index + 1] === "/")) {
        index += 1;
      }
      index = Math.min(text.length, index + 2);
      continue;
    }

    if (current === "\"" || current === "'") {
      const quote = current;
      const start = index;
      index += 1;
      while (index < text.length) {
        if (text[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      tokens.push({ kind: "string", value: text.slice(start, index), start: baseOffset + start, end: baseOffset + index });
      continue;
    }

    if (isPunctuation(current)) {
      tokens.push({ kind: "punctuation", value: current, start: baseOffset + index, end: baseOffset + index + 1 });
      index += 1;
      continue;
    }

    if (isDigit(current)) {
      const start = index;
      index += 1;
      while (index < text.length && (isDigit(text[index]) || text[index] === ".")) {
        index += 1;
      }
      tokens.push({ kind: "number", value: text.slice(start, index), start: baseOffset + start, end: baseOffset + index });
      continue;
    }

    if (isIdentifierStart(current)) {
      const start = index;
      index += 1;
      while (index < text.length && isIdentifierPart(text[index])) {
        index += 1;
      }
      tokens.push({ kind: "identifier", value: text.slice(start, index), start: baseOffset + start, end: baseOffset + index });
      continue;
    }

    tokens.push({ kind: "operator", value: current, start: baseOffset + index, end: baseOffset + index + 1 });
    index += 1;
  }

  tokens.push({ kind: "eof", value: "", start: baseOffset + text.length, end: baseOffset + text.length });
  return tokens;
}

class ReSdkExpressionParser {
  private readonly tokens: Token[];
  private index = 0;

  constructor(text: string, baseOffset: number) {
    this.tokens = tokenize(text, baseOffset);
  }

  parse(): ReSdkExpression | undefined {
    const expression = this.parseExpression(new Set());
    return expression;
  }

  private parseExpression(stop: Set<string>): ReSdkExpression | undefined {
    const items: ReSdkExpression[] = [];
    while (!this.isAtEnd()) {
      const token = this.peek();
      if (token.kind === "punctuation" && stop.has(token.value)) {
        break;
      }

      const atom = this.parseAtom(stop);
      if (!atom) {
        this.advance();
        continue;
      }
      items.push(this.parseInfix(atom));
    }

    if (items.length === 0) {
      return undefined;
    }
    if (items.length === 1) {
      return items[0];
    }
    return {
      kind: "sequence",
      items,
      start: items[0].start,
      end: items[items.length - 1].end
    };
  }

  private parseAtom(stop: Set<string>): ReSdkExpression | undefined {
    const token = this.peek();
    if (token.kind === "eof") {
      return undefined;
    }

    if (token.kind === "punctuation" && stop.has(token.value)) {
      return undefined;
    }

    if (token.kind === "identifier") {
      const identifier = this.advance();
      if (this.check("punctuation", "(")) {
        return this.parseMacroCall(identifier);
      }
      return {
        kind: "identifier",
        name: identifier.value,
        start: identifier.start,
        end: identifier.end
      };
    }

    if (token.kind === "punctuation" && token.value === "(") {
      const open = this.advance();
      const inner = this.parseExpression(new Set([")"]));
      const close = this.match("punctuation", ")");
      if (!inner) {
        return { kind: "literal", raw: "()", start: open.start, end: close?.end ?? open.end };
      }
      return { ...inner, start: open.start, end: close?.end ?? inner.end };
    }

    if (token.kind === "punctuation" && token.value === "[") {
      const open = this.advance();
      const items: ReSdkExpression[] = [];
      while (!this.isAtEnd() && !this.check("punctuation", "]")) {
        const item = this.parseExpression(new Set([",", "]"]));
        if (item) {
          items.push(item);
        }
        this.match("punctuation", ",");
      }
      const close = this.match("punctuation", "]");
      return {
        kind: "sequence",
        items,
        start: open.start,
        end: close?.end ?? (items[items.length - 1]?.end ?? open.end)
      };
    }

    const literal = this.advance();
    return {
      kind: "literal",
      raw: literal.value,
      start: literal.start,
      end: literal.end
    };
  }

  private parseMacroCall(identifier: Token): ReSdkMacroCallExpression {
    const open = this.advance();
    const args: ReSdkExpression[] = [];
    while (!this.isAtEnd() && !this.check("punctuation", ")")) {
      const arg = this.parseExpression(new Set([",", ")"]));
      if (arg) {
        args.push(arg);
      }
      this.match("punctuation", ",");
    }
    const close = this.match("punctuation", ")");
    return {
      kind: "macroCall",
      name: identifier.value,
      nameStart: identifier.start,
      nameEnd: identifier.end,
      args,
      start: identifier.start,
      end: close?.end ?? open.end
    };
  }

  private parseInfix(receiver: ReSdkExpression): ReSdkExpression {
    let current = receiver;
    while (this.peek().kind === "identifier" && isInfixMemberOperator(this.peek().value) && this.tokens[this.index + 1]?.value === "(") {
      const operator = this.advance();
      this.advance();
      const args: ReSdkExpression[] = [];
      while (!this.isAtEnd() && !this.check("punctuation", ")")) {
        const arg = this.parseExpression(new Set([",", ")"]));
        if (arg) {
          args.push(arg);
        }
        this.match("punctuation", ",");
      }
      const close = this.match("punctuation", ")");
      current = {
        kind: "infixMacro",
        operator: operator.value,
        operatorStart: operator.start,
        operatorEnd: operator.end,
        receiver: current,
        args,
        start: current.start,
        end: close?.end ?? operator.end
      };
    }
    return current;
  }

  private peek(): Token {
    return this.tokens[this.index] ?? this.tokens[this.tokens.length - 1];
  }

  private advance(): Token {
    const token = this.peek();
    this.index = Math.min(this.tokens.length - 1, this.index + 1);
    return token;
  }

  private isAtEnd(): boolean {
    return this.peek().kind === "eof";
  }

  private check(kind: TokenKind, value: string): boolean {
    const token = this.peek();
    return token.kind === kind && token.value === value;
  }

  private match(kind: TokenKind, value: string): Token | undefined {
    if (!this.check(kind, value)) {
      return undefined;
    }
    return this.advance();
  }
}

function isMacroName(name: string, expected: string): boolean {
  return name.toLowerCase() === expected.toLowerCase();
}

function isAnyMacroName(name: string, expected: string[]): boolean {
  const lower = name.toLowerCase();
  return expected.some((item) => item.toLowerCase() === lower);
}

function isInfixMemberOperator(name: string): boolean {
  return isAnyMacroName(name, ["callv", "callp", "getv", "setv"]);
}

function identifierArg(expression: ReSdkExpression | undefined): ReSdkIdentifierExpression | undefined {
  return expression?.kind === "identifier" ? expression : undefined;
}

function visitExpression(expression: ReSdkExpression, visitor: (node: ReSdkExpression) => void): void {
  visitor(expression);
  if (expression.kind === "sequence") {
    for (const item of expression.items) {
      visitExpression(item, visitor);
    }
  } else if (expression.kind === "macroCall") {
    for (const arg of expression.args) {
      visitExpression(arg, visitor);
    }
  } else if (expression.kind === "infixMacro") {
    visitExpression(expression.receiver, visitor);
    for (const arg of expression.args) {
      visitExpression(arg, visitor);
    }
  }
}

export function parseReSdkExpression(text: string, baseOffset = 0): ReSdkExpression | undefined {
  return new ReSdkExpressionParser(text, baseOffset).parse();
}

export function findReSdkMemberReferenceAtOffset(expression: ReSdkExpression, offset: number): ReSdkMemberReferenceNode | undefined {
  let found: ReSdkMemberReferenceNode | undefined;
  for (const reference of collectReSdkMemberReferences(expression)) {
    if (offset >= reference.memberStart && offset <= reference.memberEnd) {
      found = reference;
      break;
    }
  }
  return found;
}

export function collectReSdkMemberReferences(expression: ReSdkExpression): ReSdkMemberReferenceNode[] {
  const result: ReSdkMemberReferenceNode[] = [];
  visitExpression(expression, (node) => {
    if (node.kind === "macroCall") {
      const name = node.name;
      if (isAnyMacroName(name, ["callSelf", "callSelfParams"])) {
        const member = identifierArg(node.args[0]);
        if (member) {
          result.push({ memberName: member.name, memberStart: member.start, memberEnd: member.end, role: "method", call: node });
        }
      } else if (isAnyMacroName(name, ["getSelf", "setSelf"])) {
        const member = identifierArg(node.args[0]);
        if (member) {
          result.push({ memberName: member.name, memberStart: member.start, memberEnd: member.end, role: "property", call: node });
        }
      } else if (isAnyMacroName(name, ["callFunc", "callFuncParams", "allFunc", "allFuncParams"])) {
        const member = identifierArg(node.args[1]);
        if (member) {
          result.push({ memberName: member.name, memberStart: member.start, memberEnd: member.end, role: "method", receiver: node.args[0], call: node });
        }
      } else if (isAnyMacroName(name, ["getVar", "setVar"])) {
        const member = identifierArg(node.args[1]);
        if (member) {
          result.push({ memberName: member.name, memberStart: member.start, memberEnd: member.end, role: "property", receiver: node.args[0], call: node });
        }
      }
    } else if (node.kind === "infixMacro") {
      const member = identifierArg(node.args[0]);
      if (member) {
        result.push({ memberName: member.name, memberStart: member.start, memberEnd: member.end, role: "structMember", receiver: node.receiver, call: node });
      }
    }
  });
  return result;
}

export function expressionToSource(text: string, expression: ReSdkExpression): string {
  return text.slice(expression.start, expression.end);
}

export function macroCallNameEquals(expression: ReSdkExpression | undefined, name: string): expression is ReSdkMacroCallExpression {
  return expression?.kind === "macroCall" && isMacroName(expression.name, name);
}

export function macroCallNameIn(expression: ReSdkExpression | undefined, names: string[]): expression is ReSdkMacroCallExpression {
  return expression?.kind === "macroCall" && isAnyMacroName(expression.name, names);
}
