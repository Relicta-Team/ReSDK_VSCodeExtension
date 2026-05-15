import commandEntriesJson from "./generated/commands.json";

export type SqfAstRange = {
  start: number;
  end: number;
};

export type SqfAstBlock = {
  kind: "block";
  statements: SqfAstStatement[];
} & SqfAstRange;

export type SqfAstParameter = {
  name: string;
  defaultValue?: SqfAstExpression;
  optional: boolean;
} & SqfAstRange;

export type SqfAstParamsStatement = {
  kind: "params";
  parameters: SqfAstParameter[];
} & SqfAstRange;

export type SqfAstAssignmentStatement = {
  kind: "assignment";
  name: string;
  nameStart: number;
  nameEnd: number;
  expression: SqfAstExpression;
  isPrivate: boolean;
} & SqfAstRange;

export type SqfAstPrivateStatement = {
  kind: "private";
  names: Array<{ name: string; start: number; end: number }>;
} & SqfAstRange;

export type SqfAstExpressionStatement = {
  kind: "expression";
  expression: SqfAstExpression;
} & SqfAstRange;

export type SqfAstStatement = SqfAstParamsStatement | SqfAstAssignmentStatement | SqfAstPrivateStatement | SqfAstExpressionStatement;

export type SqfAstIdentifier = {
  kind: "identifier";
  name: string;
} & SqfAstRange;

export type SqfAstStringLiteral = {
  kind: "string";
  value: string;
} & SqfAstRange;

export type SqfAstNumberLiteral = {
  kind: "number";
  raw: string;
} & SqfAstRange;

export type SqfAstBooleanLiteral = {
  kind: "boolean";
  value: boolean;
} & SqfAstRange;

export type SqfAstArrayLiteral = {
  kind: "array";
  elements: SqfAstExpression[];
} & SqfAstRange;

export type SqfAstCodeLiteral = {
  kind: "code";
  block: SqfAstBlock;
} & SqfAstRange;

export type SqfAstUnaryExpression = {
  kind: "unary";
  operator: string;
  operand: SqfAstExpression;
} & SqfAstRange;

export type SqfAstBinaryExpression = {
  kind: "binary";
  operator: string;
  left: SqfAstExpression;
  right: SqfAstExpression;
} & SqfAstRange;

export type SqfAstMacroCallExpression = {
  kind: "macroCall";
  name: string;
  nameStart: number;
  nameEnd: number;
  args: SqfAstExpression[];
} & SqfAstRange;

export type SqfAstInvokeExpression = {
  kind: "invoke";
  operator: "call" | "spawn";
  callee: SqfAstExpression;
  target?: SqfAstExpression;
} & SqfAstRange;

export type SqfAstSelectExpression = {
  kind: "select";
  source: SqfAstExpression;
  index: SqfAstExpression;
} & SqfAstRange;

export type SqfAstExitWithExpression = {
  kind: "exitWith";
  condition?: SqfAstExpression;
  block: SqfAstBlock;
} & SqfAstRange;

export type SqfAstIfExpression = {
  kind: "if";
  condition: SqfAstExpression;
  thenBlock: SqfAstBlock;
  elseBlock?: SqfAstBlock;
} & SqfAstRange;

export type SqfAstUnknownExpression = {
  kind: "unknown";
  raw: string;
} & SqfAstRange;

export type SqfAstExpression =
  | SqfAstIdentifier
  | SqfAstStringLiteral
  | SqfAstNumberLiteral
  | SqfAstBooleanLiteral
  | SqfAstArrayLiteral
  | SqfAstCodeLiteral
  | SqfAstUnaryExpression
  | SqfAstBinaryExpression
  | SqfAstMacroCallExpression
  | SqfAstInvokeExpression
  | SqfAstSelectExpression
  | SqfAstExitWithExpression
  | SqfAstIfExpression
  | SqfAstUnknownExpression;

type TokenKind = "identifier" | "number" | "string" | "operator" | "punctuation" | "eof";

type Token = {
  kind: TokenKind;
  value: string;
  start: number;
  end: number;
};

type CommandEntry = {
  kind: "nular" | "function" | "operator";
  name: string;
};

const REGISTERED_FUNCTION_COMMANDS = new Set(
  (commandEntriesJson as CommandEntry[])
    .filter((entry) => entry.kind === "function")
    .map((entry) => entry.name.toLowerCase())
);
for (const command of ["floor", "ceil", "round", "parseNumber", "pick", "selectRandom"]) {
  REGISTERED_FUNCTION_COMMANDS.add(command.toLowerCase());
}

const KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "call",
  "spawn",
  "select",
  "params",
  "private",
  "and",
  "or",
  "mod",
  "exitwith",
  "true",
  "false",
  "not",
]);
const NON_INFIX_KEYWORDS = new Set(["if", "then", "else", "params", "private", "true", "false"]);
const PAREN_INFIX_MACROS = new Set(["callp", "callv", "getv", "setv"]);
const MULTI_CHAR_OPERATORS = ["==", "!=", ">=", "<=", "&&", "||"];
const SINGLE_CHAR_OPERATORS = new Set(["=", "+", "-", "*", "/", "%", "!", ">", "<", "^", "#"]);
const PUNCTUATION = new Set(["(", ")", "[", "]", "{", "}", ",", ";"]);

function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_]/.test(char);
}

function isIdentifierPart(char: string): boolean {
  return /[A-Za-z0-9_]/.test(char);
}

function tokenize(text: string, baseOffset: number): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < text.length) {
    const current = text[index];
    const next = text[index + 1] ?? "";

    if (/\s/.test(current)) {
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

    if (current === '"' || current === "'") {
      const quote = current;
      const start = index;
      index += 1;
      let value = "";
      while (index < text.length && text[index] !== quote) {
        value += text[index];
        index += 1;
      }
      if (index < text.length) {
        index += 1;
      }
      tokens.push({ kind: "string", value, start: baseOffset + start, end: baseOffset + index });
      continue;
    }

    const multiOperator = MULTI_CHAR_OPERATORS.find((operator) => text.slice(index, index + operator.length) === operator);
    if (multiOperator) {
      tokens.push({ kind: "operator", value: multiOperator, start: baseOffset + index, end: baseOffset + index + multiOperator.length });
      index += multiOperator.length;
      continue;
    }

    if (SINGLE_CHAR_OPERATORS.has(current)) {
      tokens.push({ kind: "operator", value: current, start: baseOffset + index, end: baseOffset + index + 1 });
      index += 1;
      continue;
    }

    if (PUNCTUATION.has(current)) {
      tokens.push({ kind: "punctuation", value: current, start: baseOffset + index, end: baseOffset + index + 1 });
      index += 1;
      continue;
    }

    if (/\d/.test(current)) {
      const start = index;
      let value = current;
      index += 1;
      while (index < text.length && /[0-9.]/.test(text[index])) {
        value += text[index];
        index += 1;
      }
      tokens.push({ kind: "number", value, start: baseOffset + start, end: baseOffset + index });
      continue;
    }

    if (isIdentifierStart(current)) {
      const start = index;
      let value = current;
      index += 1;
      while (index < text.length && isIdentifierPart(text[index])) {
        value += text[index];
        index += 1;
      }
      tokens.push({ kind: "identifier", value, start: baseOffset + start, end: baseOffset + index });
      continue;
    }

    tokens.push({ kind: "operator", value: current, start: baseOffset + index, end: baseOffset + index + 1 });
    index += 1;
  }

  tokens.push({ kind: "eof", value: "", start: baseOffset + text.length, end: baseOffset + text.length });
  return tokens;
}

class Parser {
  private readonly tokens: Token[];
  private index = 0;

  constructor(text: string, baseOffset: number) {
    this.tokens = tokenize(text, baseOffset);
  }

  parseBlock(stopPunctuation?: string): SqfAstBlock {
    const statements: SqfAstStatement[] = [];
    const start = this.peek().start;
    while (!this.isAtEnd()) {
      if (stopPunctuation && this.checkPunctuation(stopPunctuation)) {
        break;
      }
      if (this.matchPunctuation(";")) {
        continue;
      }

      const statement = this.parseStatement();
      if (statement) {
        statements.push(statement);
      } else {
        this.advance();
      }

      this.matchPunctuation(";");
    }

    const end = statements.at(-1)?.end ?? this.peek().start;
    return { kind: "block", statements, start, end };
  }

  private parseStatement(): SqfAstStatement | undefined {
    if (this.checkKeyword("params")) {
      return this.parseParamsStatement();
    }

    if (this.peek().kind === "identifier" && this.peek().value === "_this" && this.peek(1).kind === "identifier" && this.peek(1).value.toLowerCase() === "params") {
      const start = this.advance().start;
      return this.parseParamsStatement(start);
    }

    const statementStart = this.peek().start;
    const isPrivate = this.matchKeyword("private");
    if (this.checkKind("identifier") && this.peek(1).kind === "operator" && this.peek(1).value === "=") {
      const nameToken = this.advance();
      const name = nameToken.value;
      this.advance();
      const expression = this.parseExpression(0);
      return {
        kind: "assignment",
        name,
        nameStart: nameToken.start,
        nameEnd: nameToken.end,
        expression,
        isPrivate,
        start: isPrivate ? statementStart : nameToken.start,
        end: expression.end
      };
    }

    if (isPrivate) {
      return this.parsePrivateStatement(statementStart);
    }

    const expression = this.parseExpression(0);
    return {
      kind: "expression",
      expression,
      start: expression.start,
      end: expression.end
    };
  }

  private parsePrivateStatement(start: number): SqfAstPrivateStatement | SqfAstExpressionStatement {
    const names: Array<{ name: string; start: number; end: number }> = [];
    let end = this.previous().end;

    if (this.matchPunctuation("[")) {
      while (!this.isAtEnd() && !this.checkPunctuation("]")) {
        if (this.matchKind("string") || this.matchKind("identifier")) {
          const token = this.previous();
          if (token.value.startsWith("_")) {
            names.push({ name: token.value, start: token.start, end: token.end });
          }
          end = token.end;
        } else {
          this.advance();
        }
        if (!this.matchPunctuation(",")) {
          break;
        }
      }
      if (this.matchPunctuation("]")) {
        end = this.previous().end;
      }
    } else if (this.matchKind("string") || this.matchKind("identifier")) {
      const token = this.previous();
      if (token.value.startsWith("_")) {
        names.push({ name: token.value, start: token.start, end: token.end });
      }
      end = token.end;
    }

    if (names.length > 0) {
      return { kind: "private", names, start, end };
    }

    return {
      kind: "expression",
      expression: { kind: "unknown", raw: "private", start, end },
      start,
      end
    };
  }

  private parseParamsStatement(explicitStart?: number): SqfAstParamsStatement | SqfAstExpressionStatement {
    const start = explicitStart ?? this.peek().start;
    this.advance();
    const source = this.parseExpression(0);
    if (source.kind !== "array") {
      return { kind: "expression", expression: source, start, end: source.end };
    }

    const parameters: SqfAstParameter[] = [];
    for (const element of source.elements) {
      if (element.kind === "string") {
        if (!element.value) {
          continue;
        }
        parameters.push({ name: element.value, optional: false, start: element.start, end: element.end });
        continue;
      }

      if (element.kind === "array" && element.elements.length > 0 && element.elements[0]?.kind === "string") {
        if (!element.elements[0].value) {
          continue;
        }
        parameters.push({
          name: element.elements[0].value,
          optional: element.elements.length > 1,
          defaultValue: element.elements[1],
          start: element.elements[0].start,
          end: element.elements[0].end,
        });
      }
    }

    return { kind: "params", parameters, start, end: source.end };
  }

  private parseExpression(minPrecedence: number): SqfAstExpression {
    let left = this.parsePrefix();

    while (true) {
      const operatorInfo = this.getInfixOperator();
      if (!operatorInfo || operatorInfo.precedence < minPrecedence) {
        break;
      }

      const operatorToken = this.advance();
      if (operatorInfo.type === "invoke") {
        const callee = this.parseExpression(operatorInfo.precedence + 1);
        left = { kind: "invoke", operator: operatorInfo.value as "call" | "spawn", target: left, callee, start: left.start, end: callee.end };
        continue;
      }

      if (operatorInfo.type === "select") {
        const index = this.parseExpression(operatorInfo.precedence + 1);
        left = { kind: "select", source: left, index, start: left.start, end: index.end };
        continue;
      }

      if (operatorInfo.type === "exitWith") {
        const block = this.parseCodeBlock();
        left = { kind: "exitWith", condition: left, block, start: left.start, end: block.end };
        continue;
      }

      if (PAREN_INFIX_MACROS.has(operatorInfo.value.toLowerCase()) && this.matchPunctuation("(")) {
        const args: SqfAstExpression[] = [];
        while (!this.isAtEnd() && !this.checkPunctuation(")")) {
          args.push(this.parseExpression(0));
          if (!this.matchPunctuation(",")) {
            break;
          }
        }
        const closed = this.matchPunctuation(")");
        const right: SqfAstExpression = {
          kind: "macroCall",
          name: operatorInfo.value,
          nameStart: operatorToken.start,
          nameEnd: operatorToken.end,
          args,
          start: operatorToken.start,
          end: closed ? this.previous().end : (args.at(-1)?.end ?? operatorToken.end)
        };
        left = { kind: "binary", operator: operatorInfo.value, left, right, start: left.start, end: right.end };
        continue;
      }

      const right = this.parseExpression(operatorInfo.precedence + 1);
      left = { kind: "binary", operator: operatorInfo.value, left, right, start: left.start, end: right.end };
    }

    return left;
  }

  private parsePrefix(): SqfAstExpression {
    if (this.matchKeyword("if")) {
      const start = this.previous().start;
      const condition = this.parseExpression(0);
      if (!this.matchKeyword("then")) {
        if (this.matchKeyword("exitwith")) {
          const block = this.parseCodeBlock();
          return { kind: "exitWith", condition, block, start, end: block.end };
        }
        return { kind: "unknown", raw: "if", start, end: condition.end };
      }
      const thenBlock = this.parseCodeBlock();
      const elseBlock = this.matchKeyword("else") ? this.parseCodeBlock() : undefined;
      return { kind: "if", condition, thenBlock, elseBlock, start, end: elseBlock?.end ?? thenBlock.end };
    }

    if (this.matchKeyword("call") || this.matchKeyword("spawn")) {
      const start = this.previous().start;
      const operator = this.previous().value.toLowerCase() as "call" | "spawn";
      const callee = this.parseExpression(6);
      return { kind: "invoke", operator, callee, start, end: callee.end };
    }

    if (this.matchOperator("!") || this.matchOperator("-") || this.matchKeyword("not")) {
      const start = this.previous().start;
      const operator = this.previous().value.toLowerCase();
      const operand = this.parseExpression(7);
      return { kind: "unary", operator, operand, start, end: operand.end };
    }

    if (this.peek().kind === "identifier" && REGISTERED_FUNCTION_COMMANDS.has(this.peek().value.toLowerCase()) && this.canStartExpression(this.peek(1))) {
      const operator = this.advance();
      const operand = this.parseExpression(7);
      return { kind: "unary", operator: operator.value, operand, start: operator.start, end: operand.end };
    }

    return this.parsePrimary();
  }

  private canStartExpression(token: Token): boolean {
    if (token.kind === "number" || token.kind === "string") {
      return true;
    }
    if (token.kind === "identifier") {
      const lowered = token.value.toLowerCase();
      return lowered !== "then" && lowered !== "else" && lowered !== "do";
    }
    if (token.kind === "operator") {
      return token.value === "!" || token.value === "-";
    }
    return token.kind === "punctuation" && (token.value === "[" || token.value === "{" || token.value === "(");
  }

  private parsePrimary(): SqfAstExpression {
    if (this.matchKind("number")) {
      return { kind: "number", raw: this.previous().value, start: this.previous().start, end: this.previous().end };
    }

    if (this.matchKind("string")) {
      return { kind: "string", value: this.previous().value, start: this.previous().start, end: this.previous().end };
    }

    if (this.matchKeyword("true")) {
      return { kind: "boolean", value: true, start: this.previous().start, end: this.previous().end };
    }

    if (this.matchKeyword("false")) {
      return { kind: "boolean", value: false, start: this.previous().start, end: this.previous().end };
    }

    if (this.matchKind("identifier")) {
      const identifier = this.previous();
      if (this.matchPunctuation("(")) {
        const args: SqfAstExpression[] = [];
        while (!this.isAtEnd() && !this.checkPunctuation(")")) {
          args.push(this.parseExpression(0));
          if (!this.matchPunctuation(",")) {
            break;
          }
        }
        const closed = this.matchPunctuation(")");
        return {
          kind: "macroCall",
          name: identifier.value,
          nameStart: identifier.start,
          nameEnd: identifier.end,
          args,
          start: identifier.start,
          end: closed ? this.previous().end : (args.at(-1)?.end ?? identifier.end),
        };
      }
      return { kind: "identifier", name: identifier.value, start: identifier.start, end: identifier.end };
    }

    if (this.matchPunctuation("[")) {
      const start = this.previous().start;
      const elements: SqfAstExpression[] = [];
      while (!this.isAtEnd() && !this.checkPunctuation("]")) {
        elements.push(this.parseExpression(0));
        if (!this.matchPunctuation(",")) {
          break;
        }
      }
      const closed = this.matchPunctuation("]");
      return { kind: "array", elements, start, end: closed ? this.previous().end : (elements.at(-1)?.end ?? start) };
    }

    if (this.checkPunctuation("{")) {
      const block = this.parseCodeBlock();
      return { kind: "code", block, start: block.start, end: block.end };
    }

    if (this.matchPunctuation("(")) {
      const start = this.previous().start;
      const expression = this.parseExpression(0);
      this.matchPunctuation(")");
      return { ...expression, start, end: this.previous().end };
    }

    const token = this.advance();
    return { kind: "unknown", raw: token.value, start: token.start, end: token.end };
  }

  private parseCodeBlock(): SqfAstBlock {
    if (!this.matchPunctuation("{")) {
      const start = this.peek().start;
      return { kind: "block", statements: [], start, end: start };
    }

    const start = this.previous().start;
    const block = this.parseBlock("}");
    this.matchPunctuation("}");
    return { ...block, start, end: this.previous().end };
  }

  private getInfixOperator(): { value: string; precedence: number; type: "binary" | "invoke" | "select" | "exitWith" } | undefined {
    const token = this.peek();
    if (token.kind === "identifier") {
      const lowered = token.value.toLowerCase();
      if (NON_INFIX_KEYWORDS.has(lowered)) return undefined;
      if (lowered === "or") return { value: "or", precedence: 1, type: "binary" };
      if (lowered === "and") return { value: "and", precedence: 2, type: "binary" };
      if (lowered === "call" || lowered === "spawn") return { value: lowered, precedence: 3, type: "invoke" };
      if (lowered === "exitwith") return { value: lowered, precedence: 3, type: "exitWith" };
      if (lowered === "select") return { value: lowered, precedence: 6, type: "select" };
      if (lowered === "mod") return { value: "mod", precedence: 6, type: "binary" };
      return { value: token.value, precedence: 4, type: "binary" };
    }

    if (token.kind === "operator") {
      if (token.value === "||") return { value: "or", precedence: 1, type: "binary" };
      if (token.value === "&&") return { value: "and", precedence: 2, type: "binary" };
      if (["==", "!=", ">=", "<=", ">", "<"].includes(token.value)) return { value: token.value, precedence: 4, type: "binary" };
      if (["+", "-"].includes(token.value)) return { value: token.value, precedence: 5, type: "binary" };
      if (["*", "/", "%"].includes(token.value)) return { value: token.value, precedence: 6, type: "binary" };
      if (token.value === "#") return { value: token.value, precedence: 6, type: "select" };
      if (token.value === "^") return { value: token.value, precedence: 7, type: "binary" };
    }

    return undefined;
  }

  private matchKind(kind: TokenKind): boolean {
    if (!this.checkKind(kind)) {
      return false;
    }
    this.advance();
    return true;
  }

  private checkKind(kind: TokenKind): boolean {
    return this.peek().kind === kind;
  }

  private matchOperator(value: string): boolean {
    if (!(this.peek().kind === "operator" && this.peek().value === value)) {
      return false;
    }
    this.advance();
    return true;
  }

  private matchPunctuation(value: string): boolean {
    if (!this.checkPunctuation(value)) {
      return false;
    }
    this.advance();
    return true;
  }

  private checkPunctuation(value: string): boolean {
    return this.peek().kind === "punctuation" && this.peek().value === value;
  }

  private matchKeyword(value: string): boolean {
    if (!this.checkKeyword(value)) {
      return false;
    }
    this.advance();
    return true;
  }

  private checkKeyword(value: string): boolean {
    const token = this.peek();
    return token.kind === "identifier" && token.value.toLowerCase() === value.toLowerCase() && KEYWORDS.has(token.value.toLowerCase());
  }

  private previous(): Token {
    return this.tokens[Math.max(0, this.index - 1)] ?? this.tokens[0];
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.tokens.length - 1, this.index + offset)] ?? this.tokens[this.tokens.length - 1];
  }

  private advance(): Token {
    const token = this.peek();
    if (!this.isAtEnd()) {
      this.index += 1;
    }
    return token;
  }

  private isAtEnd(): boolean {
    return this.peek().kind === "eof";
  }
}

export function parseSqfBlock(text: string, baseOffset = 0): SqfAstBlock {
  return new Parser(text, baseOffset).parseBlock();
}
