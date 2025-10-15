// ======================================================
// ReSDK Language Server
// ======================================================

import {
	createConnection,
	TextDocuments,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	SymbolInformation,
	SymbolKind,
	DocumentSymbolParams,
	DocumentSymbol,
	Range,
	TextDocumentSyncKind,
	DefinitionParams,
	Location,
	ReferenceParams,
	Hover,
	MarkupKind,
	TextDocumentPositionParams,
	CodeLens,
	CodeLensParams
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';

import { WorkspaceManager } from './workspace/WorkspaceManager';

let connection = createConnection(ProposedFeatures.all);
let documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let workspaceManager: WorkspaceManager | null = null;

connection.onInitialize((params: InitializeParams) => {
	return {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			documentSymbolProvider: true,
			definitionProvider: true,
			referencesProvider: true,
			hoverProvider: true,
			codeLensProvider: {
				resolveProvider: false
			}
		}
	};
});

connection.onInitialized(async () => {
	const workspaceFolders = await connection.workspace.getWorkspaceFolders();
	
	if (workspaceFolders && workspaceFolders.length > 0) {
		const roots = workspaceFolders.map(folder => {
			let fsPath = folder.uri;
			if (fsPath.startsWith('file://')) {
				fsPath = decodeURIComponent(fsPath.substring(7));
				if (process.platform === 'win32' && fsPath.startsWith('/')) {
					fsPath = fsPath.substring(1);
				}
				fsPath = fsPath.replace(/\//g, require('path').sep);
			}
			return fsPath;
		});

		workspaceManager = new WorkspaceManager(roots);
		
		workspaceManager.scanWorkspace().then(() => {
			connection.console.log('ReSDK Language Server ready');
		});
	}
});

// Helper to normalize URI
function normalizeUri(uri: string): string {
	return decodeURIComponent(uri).toLowerCase();
}

// Document changes
documents.onDidChangeContent(change => {
	if (workspaceManager) {
		workspaceManager.parseFile(change.document.uri, change.document.getText());
	}
});

// Document Symbols
connection.onDocumentSymbol((params: DocumentSymbolParams): DocumentSymbol[] => {
	const doc = documents.get(params.textDocument.uri);
	if (!doc) return [];

	const { parse } = require('./parser/sqfParser');
	const { Variable, Keyword, Space, Tab, EndOfLine, Comment, ParserKeyword } = require('./parser/sqfTypes');
	
	const text = doc.getText();
	const statement = parse(text);
	const tokens = statement.content;
	
	const rootSymbols: DocumentSymbol[] = [];
	
	// Helper для пропуска whitespace
	const skipWhitespace = (idx: number) => {
		while (idx < tokens.length && 
		       (tokens[idx] instanceof Space || 
		        tokens[idx] instanceof Tab || 
		        tokens[idx] instanceof EndOfLine ||
		        tokens[idx] instanceof Comment)) {
			idx++;
		}
		return idx;
	};
	
	// Найти закрывающую скобку
	const findClosingBrace = (startIdx: number) => {
		let depth = 1;
		for (let i = startIdx + 1; i < tokens.length; i++) {
			if (tokens[i] instanceof ParserKeyword) {
				if (tokens[i].value === '{') depth++;
				if (tokens[i].value === '}') {
					depth--;
					if (depth === 0) return i;
				}
			}
		}
		return -1;
	};
	
	// Найти закрывающую скобку для функции (учитывает только { } без вложенности)
	const findFunctionClosingBrace = (startIdx: number) => {
		for (let i = startIdx + 1; i < tokens.length; i++) {
			if (tokens[i] instanceof ParserKeyword) {
				if (tokens[i].value === '}') {
					// Проверяем, есть ли точка с запятой после }
					let nextIdx = skipWhitespace(i + 1);
					if (nextIdx < tokens.length && tokens[nextIdx] instanceof ParserKeyword && tokens[nextIdx].value === ';') {
						return nextIdx; // Возвращаем позицию ;
					}
					return i; // Возвращаем позицию }
				}
			}
		}
		return -1;
	};
	
	// Найти endclass/endstruct
	const findEndKeyword = (startIdx: number, endKeyword: string) => {
		let depth = 1;
		const startKeyword = endKeyword === 'endclass' ? 'class' : 'struct';
		
		for (let i = startIdx; i < tokens.length; i++) {
			if (tokens[i] instanceof Keyword) {
				const kw = tokens[i].value.toLowerCase();
				if (kw === startKeyword) depth++;
				if (kw === endKeyword) {
					depth--;
					if (depth === 0) return i;
				}
			}
		}
		return -1;
	};
	
	// Создать Range для символа
	const createRange = (startIdx: number, endIdx: number): Range => {
		// Найти реальные позиции токенов в тексте
		const startToken = tokens[startIdx].toString();
		const endToken = tokens[endIdx].toString();
		
		// Вычисляем примерную позицию через суммирование
		let approxStartOffset = 0;
		for (let i = 0; i < startIdx; i++) {
			approxStartOffset += tokens[i].toString().length;
		}
		
		// Ищем точную позицию startToken в тексте, начиная с примерной позиции
		let startOffset = text.indexOf(startToken, Math.max(0, approxStartOffset - 100));
		if (startOffset === -1) {
			startOffset = approxStartOffset;
		}
		
		// Ищем точную позицию endToken в тексте, начиная после startToken
		let endOffset = text.indexOf(endToken, startOffset);
		if (endOffset === -1) {
			// Fallback
			endOffset = approxStartOffset;
			for (let i = startIdx; i <= endIdx; i++) {
				endOffset += tokens[i].toString().length;
			}
		} else {
			endOffset += endToken.length;
		}
		
		return {
			start: doc.positionAt(startOffset),
			end: doc.positionAt(endOffset)
		};
	};
	
	// Создать selection range только для имени
	const createSelectionRange = (nameIdx: number, fullRange: Range): Range => {
		const { SQFString, Variable } = require('./parser/sqfTypes');
		const token = tokens[nameIdx];
		
		// Вычисляем позицию токена
		let offset = 0;
		for (let i = 0; i < nameIdx; i++) {
			offset += tokens[i].toString().length;
		}
		
		let selectionRange: Range;
		
		if (token instanceof SQFString) {
			// Для строк: offset на открывающей кавычке, пропускаем её
			selectionRange = {
				start: doc.positionAt(offset + 1),
				end: doc.positionAt(offset + 1 + token.value.length)
			};
	} else {
			// Для переменных и других токенов
			const name = token instanceof Variable ? token.name : token.toString();
			selectionRange = {
				start: doc.positionAt(offset),
				end: doc.positionAt(offset + name.length)
			};
		}
		
		// Убеждаемся, что selectionRange находится внутри fullRange
		const fullStart = doc.offsetAt(fullRange.start);
		const fullEnd = doc.offsetAt(fullRange.end);
		const selStart = doc.offsetAt(selectionRange.start);
		const selEnd = doc.offsetAt(selectionRange.end);
		
		// Если selectionRange выходит за границы fullRange, используем fullRange
		if (selStart < fullStart || selEnd > fullEnd) {
			return fullRange;
		}
		
		return selectionRange;
	};

	// Парсинг переменных в диапазоне (только private и params)
	const parseVariablesInRange = (startIdx: number, endIdx: number): DocumentSymbol[] => {
		const vars: DocumentSymbol[] = [];
		const seen = new Set<string>();
		const { SQFString } = require('./parser/sqfTypes');
		
		for (let i = startIdx; i < endIdx; i++) {
			const token = tokens[i];
			
			if (!(token instanceof Keyword)) continue;
			
			const keyword = token.value.toLowerCase();
			
			// Pattern: private _var = ...
			if (keyword === 'private') {
				let nextIdx = skipWhitespace(i + 1);
				
				// private ["_var1", "_var2"]
				if (nextIdx < endIdx && tokens[nextIdx] instanceof ParserKeyword && tokens[nextIdx].value === '[') {
					let innerIdx = skipWhitespace(nextIdx + 1);
					
					while (innerIdx < endIdx) {
						if (tokens[innerIdx] instanceof ParserKeyword && tokens[innerIdx].value === ']') {
							break;
						}
						
						if (tokens[innerIdx] instanceof SQFString) {
							const varName = tokens[innerIdx].value;
							if (varName.startsWith('_') && !seen.has(varName)) {
								seen.add(varName);
								const fullRange = createRange(innerIdx, innerIdx);
								const selectionRange = createSelectionRange(innerIdx, fullRange);
								vars.push(DocumentSymbol.create(
									varName,
									undefined,
									SymbolKind.Variable,
									selectionRange,
									selectionRange
								));
							}
						}
						
						innerIdx = skipWhitespace(innerIdx + 1);
					}
				}
				// private _var = ...
				else if (nextIdx < endIdx && tokens[nextIdx] instanceof Variable) {
					const varName = tokens[nextIdx].name;
					if (!seen.has(varName)) {
						seen.add(varName);
						const fullRange = createRange(nextIdx, nextIdx);
						const selectionRange = createSelectionRange(nextIdx, fullRange);
						vars.push(DocumentSymbol.create(
							varName,
							undefined,
							SymbolKind.Variable,
							selectionRange,
							selectionRange
						));
					}
				}
			}
			// Pattern: params ["_var1", "_var2"]
			else if (keyword === 'params') {
				let nextIdx = skipWhitespace(i + 1);
				
				if (nextIdx < endIdx && tokens[nextIdx] instanceof ParserKeyword && tokens[nextIdx].value === '[') {
					let innerIdx = skipWhitespace(nextIdx + 1);
					
					while (innerIdx < endIdx) {
						if (tokens[innerIdx] instanceof ParserKeyword && tokens[innerIdx].value === ']') {
							break;
						}
						
						if (tokens[innerIdx] instanceof SQFString) {
							const varName = tokens[innerIdx].value;
							if (varName.startsWith('_') && !seen.has(varName)) {
								seen.add(varName);
								const fullRange = createRange(innerIdx, innerIdx);
								const selectionRange = createSelectionRange(innerIdx, fullRange);
								vars.push(DocumentSymbol.create(
									varName,
									undefined,
									SymbolKind.Variable,
									selectionRange,
									selectionRange
								));
							}
						}
						
						innerIdx = skipWhitespace(innerIdx + 1);
					}
				}
			}
		}
		
		return vars;
	};
	
	// Парсинг полей и методов класса
	const parseClassMembers = (startIdx: number, endIdx: number): DocumentSymbol[] => {
		const members: DocumentSymbol[] = [];
		const seenFields = new Set<string>();
		const seenMethods = new Set<string>();
		
		for (let i = startIdx; i < endIdx; i++) {
			const token = tokens[i];
			
			if (!(token instanceof Keyword)) continue;
			
			const keyword = token.value.toLowerCase();
			
			// var(name, value) и var_*(name)
			if (keyword.startsWith('var')) {
				let nextIdx = skipWhitespace(i + 1);
				if (nextIdx < endIdx && tokens[nextIdx] instanceof ParserKeyword && tokens[nextIdx].value === '(') {
					let nameIdx = skipWhitespace(nextIdx + 1);
					
					if (nameIdx < endIdx && tokens[nameIdx] instanceof Variable) {
						const fieldName = tokens[nameIdx].name;
						
						if (!seenFields.has(fieldName)) {
							seenFields.add(fieldName);
							
							// Найти закрывающую скобку для полного range
							let closeIdx = nameIdx + 1;
							let parenDepth = 1;
							while (closeIdx < endIdx && parenDepth > 0) {
								if (tokens[closeIdx] instanceof ParserKeyword) {
									if (tokens[closeIdx].value === '(') parenDepth++;
									if (tokens[closeIdx].value === ')') parenDepth--;
								}
								closeIdx++;
							}
							
							const fullRange = createRange(i, closeIdx - 1);
							const selectionRange = createSelectionRange(nameIdx, fullRange);
							
							members.push(DocumentSymbol.create(
								fieldName,
								undefined,
								SymbolKind.Field,
								fullRange,
								selectionRange
							));
						}
					}
				}
			}
			// func(name) { ... }
			else if (keyword === 'func' || keyword === 'func_runtime') {
				let nextIdx = skipWhitespace(i + 1);
				if (nextIdx < endIdx && tokens[nextIdx] instanceof ParserKeyword && tokens[nextIdx].value === '(') {
					let nameIdx = skipWhitespace(nextIdx + 1);
					
					if (nameIdx < endIdx && tokens[nameIdx] instanceof Variable) {
						const methodName = tokens[nameIdx].name;
						
						if (!seenMethods.has(methodName)) {
							seenMethods.add(methodName);
							
							// Найти тело функции { ... }
							let closeParenIdx = skipWhitespace(nameIdx + 1);
							if (closeParenIdx < endIdx && tokens[closeParenIdx] instanceof ParserKeyword && tokens[closeParenIdx].value === ')') {
								let bodyIdx = skipWhitespace(closeParenIdx + 1);
								
								if (bodyIdx < endIdx && tokens[bodyIdx] instanceof ParserKeyword && tokens[bodyIdx].value === '{') {
									const bodyEndIdx = findFunctionClosingBrace(bodyIdx);
									
									if (bodyEndIdx !== -1 && bodyEndIdx < endIdx) {
										// range должен начинаться с func, а не с {
										const range = createRange(i, bodyEndIdx);
										const selectionRange = createSelectionRange(nameIdx, range);
										
										// Парсим переменные внутри метода
										const methodVars = parseVariablesInRange(bodyIdx + 1, bodyEndIdx);
										
										members.push(DocumentSymbol.create(
											methodName,
											undefined,
											SymbolKind.Method,
											range,
											selectionRange,
											methodVars
										));
										
										i = bodyEndIdx;
									} else {
										// Нет тела, но есть полная декларация func(name)
										const fullRange = createRange(i, closeParenIdx);
										const selectionRange = createSelectionRange(nameIdx, fullRange);
										
										members.push(DocumentSymbol.create(
											methodName,
											undefined,
											SymbolKind.Method,
											fullRange,
											selectionRange
										));
									}
								}
							}
						}
					}
				}
			}
			// getter_func(name, do) и getterconst_func(name, do)
			else if (keyword === 'getter_func' || keyword === 'getterconst_func') {
				let nextIdx = skipWhitespace(i + 1);
				if (nextIdx < endIdx && tokens[nextIdx] instanceof ParserKeyword && tokens[nextIdx].value === '(') {
					let nameIdx = skipWhitespace(nextIdx + 1);
					
					if (nameIdx < endIdx && tokens[nameIdx] instanceof Variable) {
						const methodName = tokens[nameIdx].name;
						
						if (!seenMethods.has(methodName)) {
							seenMethods.add(methodName);
							
							// Найти закрывающую скобку для полного range
							let closeIdx = nameIdx + 1;
							let parenDepth = 1;
							while (closeIdx < endIdx && parenDepth > 0) {
								if (tokens[closeIdx] instanceof ParserKeyword) {
									if (tokens[closeIdx].value === '(') parenDepth++;
									if (tokens[closeIdx].value === ')') parenDepth--;
								}
								closeIdx++;
							}
							
							// Найти точку с запятой после )
							let semicolonIdx = closeIdx;
							while (semicolonIdx < endIdx && !(tokens[semicolonIdx] instanceof ParserKeyword && tokens[semicolonIdx].value === ';')) {
								semicolonIdx++;
							}
							
							// Отладка
							console.log(`\ngetter_func ${methodName}:`);
							console.log(`  i: ${i} -> ${tokens[i].toString()}`);
							console.log(`  semicolonIdx: ${semicolonIdx} -> ${tokens[semicolonIdx].toString()}`);
							console.log(`  Tokens between:`);
							for (let j = i; j <= semicolonIdx; j++) {
								console.log(`    [${j}] ${tokens[j].constructor.name}: "${tokens[j].toString()}"`);
							}
							
							const fullRange = createRange(i, semicolonIdx);
							const selectionRange = createSelectionRange(nameIdx, fullRange);
							
							console.log(`  fullRange: ${JSON.stringify(fullRange)}`);
							console.log(`  Text at range: "${text.substring(doc.offsetAt(fullRange.start), doc.offsetAt(fullRange.end))}"`);

							
							members.push(DocumentSymbol.create(
								methodName,
								undefined,
								SymbolKind.Method,
								fullRange,
								selectionRange
							));
						}
					}
				}
			}
			// def(name) для структур
			else if (keyword === 'def' || keyword === 'def_ret' || keyword === 'def_null') {
				let nextIdx = skipWhitespace(i + 1);
				if (nextIdx < endIdx && tokens[nextIdx] instanceof ParserKeyword && tokens[nextIdx].value === '(') {
					let nameIdx = skipWhitespace(nextIdx + 1);
					
					if (nameIdx < endIdx && tokens[nameIdx] instanceof Variable) {
						const defName = tokens[nameIdx].name;
						
						if (!seenFields.has(defName)) {
							seenFields.add(defName);
							
							// Найти закрывающую скобку для полного range
							let closeIdx = nameIdx + 1;
							let parenDepth = 1;
							while (closeIdx < endIdx && parenDepth > 0) {
								if (tokens[closeIdx] instanceof ParserKeyword) {
									if (tokens[closeIdx].value === '(') parenDepth++;
									if (tokens[closeIdx].value === ')') parenDepth--;
								}
								closeIdx++;
							}
							
							const fullRange = createRange(i, closeIdx - 1);
							const selectionRange = createSelectionRange(nameIdx, fullRange);
							
							members.push(DocumentSymbol.create(
								defName,
								undefined,
								SymbolKind.Field,
								fullRange,
								selectionRange
							));
						}
					}
				}
			}
		}
		
		return members;
	};

	// Основной проход
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];

		// class(ClassName)
		if (token instanceof Keyword && token.value.toLowerCase() === 'class') {
			let nextIdx = skipWhitespace(i + 1);
			
			if (nextIdx < tokens.length && tokens[nextIdx] instanceof ParserKeyword && tokens[nextIdx].value === '(') {
				let nameIdx = skipWhitespace(nextIdx + 1);
				
				if (nameIdx < tokens.length && tokens[nameIdx] instanceof Variable) {
					const className = tokens[nameIdx].name;
					const endIdx = findEndKeyword(i + 1, 'endclass');
					
					if (endIdx !== -1) {
						const range = createRange(nameIdx, endIdx);
						const selectionRange = createRange(nameIdx, nameIdx);
						
						const classSymbol = DocumentSymbol.create(
							className,
							undefined,
							SymbolKind.Class,
							range,
							selectionRange,
							parseClassMembers(nameIdx + 1, endIdx)
						);
						
						rootSymbols.push(classSymbol);
						i = endIdx;
					}
				}
			}
		}
		
		// struct(StructName)
		else if (token instanceof Keyword && token.value.toLowerCase() === 'struct') {
			let nextIdx = skipWhitespace(i + 1);
			
			if (nextIdx < tokens.length && tokens[nextIdx] instanceof ParserKeyword && tokens[nextIdx].value === '(') {
				let nameIdx = skipWhitespace(nextIdx + 1);
				
				if (nameIdx < tokens.length && tokens[nameIdx] instanceof Variable) {
					const structName = tokens[nameIdx].name;
					const endIdx = findEndKeyword(i + 1, 'endstruct');
					
					if (endIdx !== -1) {
						const range = createRange(nameIdx, endIdx);
						const selectionRange = createRange(nameIdx, nameIdx);
						
						const structSymbol = DocumentSymbol.create(
							structName,
							undefined,
							SymbolKind.Struct,
							range,
							selectionRange,
							parseClassMembers(nameIdx + 1, endIdx)
						);
						
						rootSymbols.push(structSymbol);
						i = endIdx;
					}
				}
			}
		}
		
		// Variable = { ... } (функция)
		else if (token instanceof Variable) {
			let nextIdx = skipWhitespace(i + 1);
			
			if (nextIdx < tokens.length && tokens[nextIdx] instanceof Keyword && tokens[nextIdx].value === '=') {
				let valueIdx = skipWhitespace(nextIdx + 1);
				
				if (valueIdx < tokens.length && tokens[valueIdx] instanceof ParserKeyword && tokens[valueIdx].value === '{') {
					const funcName = token.name;
					const endIdx = findClosingBrace(valueIdx);
					
					if (endIdx !== -1) {
						const range = createRange(i, endIdx);
						const selectionRange = createRange(i, i);
						
						const funcSymbol = DocumentSymbol.create(
							funcName,
							undefined,
							SymbolKind.Function,
							range,
							selectionRange,
							parseVariablesInRange(valueIdx + 1, endIdx)
						);
						
						rootSymbols.push(funcSymbol);
						i = endIdx;
					}
				}
			}
		}
	}

	return rootSymbols;
});

// Go to Definition
connection.onDefinition((params: DefinitionParams): Location | null => {
	if (!workspaceManager) return null;

	const doc = documents.get(params.textDocument.uri);
	if (!doc) return null;

	const word = getWordAt(doc, params.position);
	if (!word) return null;

	const typeSystem = workspaceManager.getTypeSystem();
	const typeInfo = typeSystem.findType(word);
	
	if (typeInfo) {
		return {
			uri: typeInfo.location.uri,
			range: { start: { line: typeInfo.location.line, character: 0 }, end: { line: typeInfo.location.line, character: 0 } }
		};
	}

	return null;
});

// Find References  
connection.onReferences((params: ReferenceParams): Location[] => {
	if (!workspaceManager) return [];

	const doc = documents.get(params.textDocument.uri);
	if (!doc) return [];

	const word = getWordAt(doc, params.position);
	if (!word) return [];

	const locations: Location[] = [];
	
	// Search in all documents
	for (const document of documents.all()) {
		const text = document.getText();
		const regex = new RegExp(`\\b${escapeRegex(word)}\\b`, 'gi');
		let match;
		
		while ((match = regex.exec(text)) !== null) {
			locations.push({
				uri: document.uri,
			range: {
					start: document.positionAt(match.index),
					end: document.positionAt(match.index + match[0].length)
				}
			});
		}
	}

	return locations;
});

// Hover
connection.onHover((params: TextDocumentPositionParams): Hover | null => {
	if (!workspaceManager) return null;

	const doc = documents.get(params.textDocument.uri);
	if (!doc) return null;

	const word = getWordAt(doc, params.position);
	if (!word) return null;

	const resolver = workspaceManager.getResolver();
	const inferredType = resolver.inferVariableType(word, doc.getText());
	
	if (inferredType) {
		return {
			contents: {
				kind: MarkupKind.Markdown,
				value: `**Type:** \`${inferredType.typeName}\`\n\n**Confidence:** ${inferredType.confidence}`
			}
		};
	}

	const typeSystem = workspaceManager.getTypeSystem();
	const typeInfo = typeSystem.findType(word);
	
	if (typeInfo) {
		return {
			contents: {
				kind: MarkupKind.Markdown,
				value: `**${typeInfo.kind}:** \`${typeInfo.name}\`${typeInfo.parent ? `\n\n**Extends:** ${typeInfo.parent}` : ''}`
			}
		};
	}

	return null;
});

// CodeLens
connection.onCodeLens((params: CodeLensParams): CodeLens[] => {
	if (!workspaceManager) return [];

	const uri = params.textDocument.uri;
	const normalizedUri = normalizeUri(uri);
	const typeSystem = workspaceManager.getTypeSystem();
	const allTypes = typeSystem.getAllTypes();
	const lenses: CodeLens[] = [];

	for (const typeInfo of allTypes) {
		const typeUri = normalizeUri(typeInfo.location.uri);
		if (typeUri !== normalizedUri) continue;

		const refCount = countReferences(typeInfo.name);
		
		lenses.push({
			range: { start: { line: typeInfo.location.line, character: 0 }, end: { line: typeInfo.location.line, character: 0 } },
			command: {
				title: refCount === 0 ? 'no references' : `${refCount} reference${refCount === 1 ? '' : 's'}`,
				command: '',
				arguments: []
			}
		});
	}

	return lenses;
});

// Helper functions
function getTokenOffset(text: string, tokens: any[], tokenIndex: number): number {
	let offset = 0;
	
	for (let i = 0; i < tokenIndex; i++) {
		const token = tokens[i];
		// Для всех токенов используем реальную длину
		offset += token.toString().length;
	}
	
	return offset;
}

function getWordAt(doc: TextDocument, position: { line: number; character: number }): string | null {
	const text = doc.getText();
	const offset = doc.offsetAt(position);
	
	let start = offset;
	let end = offset;
	
	while (start > 0 && /[a-zA-Z0-9_]/.test(text[start - 1])) {
		start--;
	}
	
	while (end < text.length && /[a-zA-Z0-9_]/.test(text[end])) {
		end++;
	}
	
	if (start === end) return null;
	
	return text.substring(start, end);
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countReferences(symbolName: string): number {
	let count = 0;
	for (const doc of documents.all()) {
		const text = doc.getText();
		const regex = new RegExp(`\\b${escapeRegex(symbolName)}\\b`, 'gi');
		const matches = text.match(regex);
		if (matches) {
			count += matches.length;
		}
	}
	return Math.max(0, count - 1); // Subtract definition
}

documents.listen(connection);
connection.listen();
