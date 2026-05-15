import { fileURLToPath } from "node:url";
import {
  Diagnostic,
  DiagnosticSeverity
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";

import {
  IndexedSymbol,
  extractDocumentFunctionSymbols
} from "./symbolIndex";
import {
  SqfAstBlock,
  SqfAstExpression,
  SqfAstStatement
} from "./sqfAst";

type ConstantValue =
  | { kind: "unknown" }
  | { kind: "number"; value: number }
  | { kind: "bool"; value: boolean }
  | { kind: "string"; value: string }
  | { kind: "array"; elements: ConstantValue[] };

type LatentFault = {
  message: string;
  start: number;
  end: number;
  functionName: string;
};

type EvalResult = {
  value: ConstantValue;
  faults: LatentFault[];
  terminated: boolean;
};

type AnalysisState = {
  functionName: string;
  functionsByLowerName: Map<string, IndexedSymbol>;
  activeFunctionStack: string[];
};

const UNKNOWN_VALUE: ConstantValue = { kind: "unknown" };

function numberValue(value: number): ConstantValue {
  return { kind: "number", value };
}

function boolValue(value: boolean): ConstantValue {
  return { kind: "bool", value };
}

function stringValue(value: string): ConstantValue {
  return { kind: "string", value };
}

function arrayValue(elements: ConstantValue[]): ConstantValue {
  return { kind: "array", elements };
}

function isTruthyConstant(value: ConstantValue): boolean | undefined {
  if (value.kind === "bool") {
    return value.value;
  }
  return undefined;
}

function mergeFaults(...faultGroups: LatentFault[][]): LatentFault[] {
  return faultGroups.flat();
}

function isRecursingIntoFunction(state: AnalysisState, functionName: string): boolean {
  return state.activeFunctionStack.includes(functionName.toLowerCase());
}

function evaluateFunctionBody(
  symbol: IndexedSymbol,
  inputValue: ConstantValue,
  parentState: AnalysisState
): EvalResult {
  if (symbol.kind !== "globalFunction" || !symbol.functionAst) {
    return { value: UNKNOWN_VALUE, faults: [], terminated: false };
  }

  const loweredName = symbol.name.toLowerCase();
  if (isRecursingIntoFunction(parentState, loweredName)) {
    return { value: UNKNOWN_VALUE, faults: [], terminated: false };
  }

  const env = new Map<string, ConstantValue>();
  env.set("_this", inputValue);
  for (const parameter of symbol.functionParameters ?? []) {
    if (!env.has(parameter.name)) {
      env.set(parameter.name, UNKNOWN_VALUE);
    }
  }

  return evaluateBlock(symbol.functionAst, env, {
    functionName: symbol.name,
    functionsByLowerName: parentState.functionsByLowerName,
    activeFunctionStack: [...parentState.activeFunctionStack, loweredName]
  });
}

function buildLatentFault(message: string, expression: SqfAstExpression, state: AnalysisState): LatentFault {
  return {
    message: `${message} in latent body of ${state.functionName}`,
    start: expression.start,
    end: expression.end,
    functionName: state.functionName
  };
}

function evaluateStatement(statement: SqfAstStatement, env: Map<string, ConstantValue>, state: AnalysisState): EvalResult {
  if (statement.kind === "params") {
    const source = env.get("_this");
    const sourceElements = source?.kind === "array" ? source.elements : undefined;
    for (let index = 0; index < statement.parameters.length; ++index) {
      const parameter = statement.parameters[index];
      const currentValue = sourceElements?.[index];
      if (currentValue && currentValue.kind !== "unknown") {
        env.set(parameter.name, currentValue);
        continue;
      }

      if (parameter.defaultValue) {
        const evaluatedDefault = evaluateExpression(parameter.defaultValue, env, state);
        env.set(parameter.name, evaluatedDefault.value);
        if (evaluatedDefault.faults.length > 0) {
          return { value: UNKNOWN_VALUE, faults: evaluatedDefault.faults, terminated: false };
        }
        continue;
      }

      env.set(parameter.name, UNKNOWN_VALUE);
    }
    return { value: UNKNOWN_VALUE, faults: [], terminated: false };
  }

  if (statement.kind === "assignment") {
    const evaluated = evaluateExpression(statement.expression, env, state);
    env.set(statement.name, evaluated.value);
    return {
      value: evaluated.value,
      faults: evaluated.faults,
      terminated: false
    };
  }

  if (statement.kind === "private") {
    for (const local of statement.names) {
      env.set(local.name, UNKNOWN_VALUE);
    }
    return { value: UNKNOWN_VALUE, faults: [], terminated: false };
  }

  return evaluateExpression(statement.expression, env, state);
}

function evaluateBlock(block: SqfAstBlock, parentEnv: Map<string, ConstantValue>, state: AnalysisState): EvalResult {
  const env = new Map(parentEnv);
  const faults: LatentFault[] = [];
  let lastValue: ConstantValue = UNKNOWN_VALUE;

  for (const statement of block.statements) {
    const evaluated = evaluateStatement(statement, env, state);
    faults.push(...evaluated.faults);
    lastValue = evaluated.value;
    if (evaluated.terminated) {
      return { value: evaluated.value, faults, terminated: true };
    }
  }

  return { value: lastValue, faults, terminated: false };
}

function evaluateExpression(expression: SqfAstExpression, env: Map<string, ConstantValue>, state: AnalysisState): EvalResult {
  switch (expression.kind) {
    case "identifier":
      return { value: env.get(expression.name) ?? UNKNOWN_VALUE, faults: [], terminated: false };
    case "number":
      return { value: numberValue(Number(expression.raw)), faults: [], terminated: false };
    case "boolean":
      return { value: boolValue(expression.value), faults: [], terminated: false };
    case "string":
      return { value: stringValue(expression.value), faults: [], terminated: false };
    case "unknown":
      return { value: UNKNOWN_VALUE, faults: [], terminated: false };
    case "array": {
      const faults: LatentFault[] = [];
      const elements: ConstantValue[] = [];
      for (const element of expression.elements) {
        const evaluated = evaluateExpression(element, env, state);
        faults.push(...evaluated.faults);
        elements.push(evaluated.value);
      }
      const isConstantArray = elements.every((element) => element.kind !== "unknown");
      return { value: isConstantArray ? arrayValue(elements) : UNKNOWN_VALUE, faults, terminated: false };
    }
    case "macroCall": {
      const evaluatedArgs = expression.args.map((argument) => evaluateExpression(argument, env, state));
      return { value: UNKNOWN_VALUE, faults: mergeFaults(...evaluatedArgs.map((argument) => argument.faults)), terminated: false };
    }
    case "code": {
      const nested = evaluateBlock(expression.block, new Map(), state);
      return { value: UNKNOWN_VALUE, faults: nested.faults, terminated: false };
    }
    case "select": {
      const source = evaluateExpression(expression.source, env, state);
      const index = evaluateExpression(expression.index, env, state);
      if (source.value.kind === "array" && index.value.kind === "number") {
        const numericIndex = index.value.value;
        if (!Number.isInteger(numericIndex)) {
          return {
            value: UNKNOWN_VALUE,
            faults: [...mergeFaults(source.faults, index.faults), buildLatentFault("Guaranteed non-integer select index", expression, state)],
            terminated: false
          };
        }
        if (numericIndex < 0 || numericIndex >= source.value.elements.length) {
          return {
            value: UNKNOWN_VALUE,
            faults: [...mergeFaults(source.faults, index.faults), buildLatentFault("Guaranteed out-of-bounds select", expression, state)],
            terminated: false
          };
        }
        return {
          value: source.value.elements[numericIndex] ?? UNKNOWN_VALUE,
          faults: mergeFaults(source.faults, index.faults),
          terminated: false
        };
      }
      return { value: UNKNOWN_VALUE, faults: mergeFaults(source.faults, index.faults), terminated: false };
    }
    case "invoke": {
      const target = expression.target ? evaluateExpression(expression.target, env, state) : { value: UNKNOWN_VALUE, faults: [], terminated: false };
      const callee = evaluateExpression(expression.callee, env, state);
      if (expression.operator === "call" && expression.callee.kind === "code") {
        const callEnv = new Map(env);
        if (expression.target) {
          callEnv.set("_this", target.value);
        }
        const blockResult = evaluateBlock(expression.callee.block, callEnv, state);
        return {
          value: blockResult.value,
          faults: mergeFaults(target.faults, callee.faults, blockResult.faults),
          terminated: false
        };
      }
      if (expression.operator === "call" && expression.callee.kind === "identifier") {
        const targetValue = expression.target ? target.value : UNKNOWN_VALUE;
        const calledFunction = state.functionsByLowerName.get(expression.callee.name.toLowerCase());
        if (calledFunction?.functionAst) {
          const called = evaluateFunctionBody(calledFunction, targetValue, state);
          return {
            value: called.value,
            faults: mergeFaults(target.faults, callee.faults, called.faults),
            terminated: false
          };
        }
      }
      return { value: UNKNOWN_VALUE, faults: mergeFaults(target.faults, callee.faults), terminated: false };
    }
    case "unary": {
      const operand = evaluateExpression(expression.operand, env, state);
      if ((expression.operator === "!" || expression.operator === "not") && operand.value.kind === "bool") {
        return { value: boolValue(!operand.value.value), faults: operand.faults, terminated: false };
      }
      if (expression.operator === "-" && operand.value.kind === "number") {
        return { value: numberValue(-operand.value.value), faults: operand.faults, terminated: false };
      }
      return { value: UNKNOWN_VALUE, faults: operand.faults, terminated: false };
    }
    case "binary": {
      if (expression.operator === "and") {
        const left = evaluateExpression(expression.left, env, state);
        if (left.value.kind === "bool" && left.value.value === false) {
          return { value: boolValue(false), faults: left.faults, terminated: false };
        }
        const right = evaluateExpression(expression.right, env, state);
        if (left.value.kind === "bool" && right.value.kind === "bool") {
          return { value: boolValue(left.value.value && right.value.value), faults: mergeFaults(left.faults, right.faults), terminated: false };
        }
        return { value: UNKNOWN_VALUE, faults: mergeFaults(left.faults, right.faults), terminated: false };
      }

      if (expression.operator === "or") {
        const left = evaluateExpression(expression.left, env, state);
        if (left.value.kind === "bool" && left.value.value === true) {
          return { value: boolValue(true), faults: left.faults, terminated: false };
        }
        const right = evaluateExpression(expression.right, env, state);
        if (left.value.kind === "bool" && right.value.kind === "bool") {
          return { value: boolValue(left.value.value || right.value.value), faults: mergeFaults(left.faults, right.faults), terminated: false };
        }
        return { value: UNKNOWN_VALUE, faults: mergeFaults(left.faults, right.faults), terminated: false };
      }

      const left = evaluateExpression(expression.left, env, state);
      const right = evaluateExpression(expression.right, env, state);
      const faults = mergeFaults(left.faults, right.faults);

      if (left.value.kind === "number" && right.value.kind === "number") {
        switch (expression.operator) {
          case "+":
            return { value: numberValue(left.value.value + right.value.value), faults, terminated: false };
          case "-":
            return { value: numberValue(left.value.value - right.value.value), faults, terminated: false };
          case "*":
            return { value: numberValue(left.value.value * right.value.value), faults, terminated: false };
          case "/": {
            if (right.value.value === 0) {
              return {
                value: UNKNOWN_VALUE,
                faults: [...faults, buildLatentFault("Guaranteed division by zero", expression, state)],
                terminated: false
              };
            }
            return { value: numberValue(left.value.value / right.value.value), faults, terminated: false };
          }
          case "%":
          case "mod": {
            if (right.value.value === 0) {
              return {
                value: UNKNOWN_VALUE,
                faults: [...faults, buildLatentFault("Guaranteed modulo by zero", expression, state)],
                terminated: false
              };
            }
            return { value: numberValue(left.value.value % right.value.value), faults, terminated: false };
          }
          case "==":
            return { value: boolValue(left.value.value === right.value.value), faults, terminated: false };
          case "!=":
            return { value: boolValue(left.value.value !== right.value.value), faults, terminated: false };
          case ">":
            return { value: boolValue(left.value.value > right.value.value), faults, terminated: false };
          case "<":
            return { value: boolValue(left.value.value < right.value.value), faults, terminated: false };
          case ">=":
            return { value: boolValue(left.value.value >= right.value.value), faults, terminated: false };
          case "<=":
            return { value: boolValue(left.value.value <= right.value.value), faults, terminated: false };
        }
      }

      if (left.value.kind === "bool" && right.value.kind === "bool" && ["==", "!="].includes(expression.operator)) {
        return {
          value: boolValue(expression.operator === "==" ? left.value.value === right.value.value : left.value.value !== right.value.value),
          faults,
          terminated: false
        };
      }

      if (left.value.kind === "string" && right.value.kind === "string") {
        if (expression.operator === "+") {
          return { value: stringValue(left.value.value + right.value.value), faults, terminated: false };
        }
        if (expression.operator === "==" || expression.operator === "!=") {
          return {
            value: boolValue(expression.operator === "==" ? left.value.value === right.value.value : left.value.value !== right.value.value),
            faults,
            terminated: false
          };
        }
      }

      return { value: UNKNOWN_VALUE, faults, terminated: false };
    }
    case "if": {
      const condition = evaluateExpression(expression.condition, env, state);
      const truthy = isTruthyConstant(condition.value);
      if (truthy === true) {
        const thenResult = evaluateBlock(expression.thenBlock, env, state);
        return { value: thenResult.value, faults: mergeFaults(condition.faults, thenResult.faults), terminated: thenResult.terminated };
      }
      if (truthy === false) {
        if (!expression.elseBlock) {
          return { value: UNKNOWN_VALUE, faults: condition.faults, terminated: false };
        }
        const elseResult = evaluateBlock(expression.elseBlock, env, state);
        return { value: elseResult.value, faults: mergeFaults(condition.faults, elseResult.faults), terminated: elseResult.terminated };
      }
      return { value: UNKNOWN_VALUE, faults: condition.faults, terminated: false };
    }
    case "exitWith": {
      if (expression.condition) {
        const condition = evaluateExpression(expression.condition, env, state);
        const truthy = isTruthyConstant(condition.value);
        if (truthy === true) {
          const blockResult = evaluateBlock(expression.block, env, state);
          return {
            value: blockResult.value,
            faults: mergeFaults(condition.faults, blockResult.faults),
            terminated: true
          };
        }
        if (truthy === false) {
          return { value: UNKNOWN_VALUE, faults: condition.faults, terminated: false };
        }
        return { value: UNKNOWN_VALUE, faults: condition.faults, terminated: false };
      }

      const blockResult = evaluateBlock(expression.block, env, state);
      return { value: blockResult.value, faults: blockResult.faults, terminated: true };
    }
  }
}

function analyzeFunctionWithLookup(symbol: IndexedSymbol, functionsByLowerName: Map<string, IndexedSymbol>): LatentFault[] {
  if (symbol.kind !== "globalFunction" || !symbol.functionAst) {
    return [];
  }

  const env = new Map<string, ConstantValue>();
  env.set("_this", UNKNOWN_VALUE);
  for (const parameter of symbol.functionParameters ?? []) {
    env.set(parameter.name, UNKNOWN_VALUE);
  }
  return evaluateBlock(symbol.functionAst, env, {
    functionName: symbol.name,
    functionsByLowerName,
    activeFunctionStack: [symbol.name.toLowerCase()]
  }).faults;
}

function buildFaultDiagnostic(document: TextDocument, fault: LatentFault): Diagnostic {
  let code = "latent/fault";
  if (fault.message.includes("division by zero")) code = "latent/div-zero";
  else if (fault.message.includes("modulo by zero")) code = "latent/mod-zero";
  else if (fault.message.includes("out-of-bounds select")) code = "latent/select-oob";
  else if (fault.message.includes("non-integer select index")) code = "latent/select-nonint";

  return {
    severity: DiagnosticSeverity.Error,
    source: "evaluator (latent)",
    code,
    message: fault.message,
    range: {
      start: document.positionAt(fault.start),
      end: document.positionAt(Math.max(fault.start + 1, fault.end))
    }
  };
}

export function analyzeLatentFaults(document: TextDocument): Diagnostic[] {
  const filePath = document.uri.startsWith("file:") ? fileURLToPath(document.uri) : document.uri;
  const functions = extractDocumentFunctionSymbols(filePath, document.getText());
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  const functionsByLowerName = new Map<string, IndexedSymbol>();
  for (const symbol of functions) {
    functionsByLowerName.set(symbol.name.toLowerCase(), symbol);
  }

  for (const symbol of functions) {
    for (const fault of analyzeFunctionWithLookup(symbol, functionsByLowerName)) {
      const key = `${fault.start}:${fault.end}:${fault.message}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      diagnostics.push(buildFaultDiagnostic(document, fault));
    }
  }

  return diagnostics.sort((left, right) => left.range.start.line - right.range.start.line || left.range.start.character - right.range.start.character);
}
