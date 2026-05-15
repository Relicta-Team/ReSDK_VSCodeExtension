import * as path from "node:path";
import { existsSync, statSync } from "node:fs";
import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  State,
  TransportKind
} from "vscode-languageclient/node";
import {
  GET_INACTIVE_RANGES_REQUEST,
  GET_RESOLVED_CONTEXTS_REQUEST,
  InactiveRangesResponse,
  ResolvedContextsResponse
} from "./protocol";

let client: LanguageClient | undefined;
let contextStatusBar: vscode.StatusBarItem | undefined;
let inactiveCodeDecoration: vscode.TextEditorDecorationType | undefined;
const resdkHeaderLanguageChanges = new Set<string>();

function hasFile(targetPath: string): boolean {
  return existsSync(targetPath) && statSync(targetPath).isFile();
}

function detectResdkRoot(folderPath: string): string | undefined {
  const normalizedFolder = path.normalize(folderPath);
  if (hasFile(path.join(normalizedFolder, "Src", "fn_init.sqf"))) {
    return normalizedFolder;
  }

  const parentCandidate = path.dirname(normalizedFolder);
  if (hasFile(path.join(normalizedFolder, "fn_init.sqf")) && hasFile(path.join(parentCandidate, "initServer.sqf"))) {
    return parentCandidate;
  }

  return undefined;
}

function isResdkHeaderDocument(document: vscode.TextDocument): boolean {
  if (document.uri.scheme !== "file" || document.languageId === "sqf") {
    return false;
  }

  if (!/\.(hpp|h)$/i.test(document.fileName)) {
    return false;
  }

  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!folder) {
    return false;
  }

  const resdkRoot = detectResdkRoot(folder.uri.fsPath);
  if (!resdkRoot) {
    return false;
  }

  const normalizedDocument = path.normalize(document.fileName).toLowerCase();
  const normalizedRoot = path.normalize(resdkRoot).toLowerCase();
  return normalizedDocument === normalizedRoot || normalizedDocument.startsWith(`${normalizedRoot}${path.sep}`);
}

async function applyResdkHeaderLanguage(document: vscode.TextDocument): Promise<void> {
  if (!isResdkHeaderDocument(document)) {
    return;
  }

  const key = document.uri.toString();
  if (resdkHeaderLanguageChanges.has(key)) {
    return;
  }

  resdkHeaderLanguageChanges.add(key);
  try {
    await vscode.languages.setTextDocumentLanguage(document, "sqf");
  } finally {
    resdkHeaderLanguageChanges.delete(key);
  }
}

function createClient(context: vscode.ExtensionContext): LanguageClient {
  const serverModule = context.asAbsolutePath(path.join("out", "server.js"));
  const bundledEvaluatorPath = context.asAbsolutePath(path.join("bin", "win32-x64", "evaluator.exe"));
  const traceServer = vscode.workspace.getConfiguration("evaluatorSqf").get<string>("traceServer", "off");
  const debugOptions = { execArgv: ["--nolazy", "--inspect=6009"] };

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions }
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "sqf" }
    ],
    synchronize: {
      configurationSection: "evaluatorSqf",
      fileEvents: vscode.workspace.createFileSystemWatcher("**/*.{sqf,hpp,h,inc,Interface}")
    },
    initializationOptions: {
      bundledEvaluatorPath
    },
    traceOutputChannel: vscode.window.createOutputChannel("ReSDK Evaluator SQF Trace")
  };

  const nextClient = new LanguageClient(
    "evaluatorSqf",
    "ReSDK Evaluator SQF Language Server",
    serverOptions,
    clientOptions
  );

  if (traceServer === "messages") {
    nextClient.setTrace(1);
  } else if (traceServer === "verbose") {
    nextClient.setTrace(2);
  } else {
    nextClient.setTrace(0);
  }

  return nextClient;
}

async function fetchResolvedContexts(document: vscode.TextDocument): Promise<ResolvedContextsResponse | null> {
  if (!client || document.languageId !== "sqf") {
    return null;
  }

  try {
    return await client.sendRequest<ResolvedContextsResponse | null>(GET_RESOLVED_CONTEXTS_REQUEST, {
      uri: document.uri.toString()
    });
  } catch {
    return null;
  }
}

async function fetchInactiveRanges(document: vscode.TextDocument): Promise<InactiveRangesResponse | null> {
  if (!client || document.languageId !== "sqf") {
    return null;
  }

  try {
    return await client.sendRequest<InactiveRangesResponse | null>(GET_INACTIVE_RANGES_REQUEST, {
      uri: document.uri.toString()
    });
  } catch {
    return null;
  }
}

async function updateContextStatusBar(): Promise<void> {
  const activeEditor = vscode.window.activeTextEditor;
  if (!contextStatusBar || !activeEditor || activeEditor.document.languageId !== "sqf") {
    contextStatusBar?.hide();
    return;
  }

  const resolved = await fetchResolvedContexts(activeEditor.document);
  const preferred = resolved?.contexts.find((context) => context.preferred);
  if (!preferred) {
    contextStatusBar.hide();
    return;
  }

  contextStatusBar.text = `$(symbol-class) ${preferred.contextKind}`;
  contextStatusBar.tooltip = `${preferred.label}\n${preferred.detail}\nValidation entry: ${preferred.validationEntryFile}`;
  contextStatusBar.command = "evaluatorSqf.showResolvedContexts";
  contextStatusBar.show();
}

async function updateInactiveBlockDecorations(editor: vscode.TextEditor | undefined): Promise<void> {
  if (!inactiveCodeDecoration || !editor || editor.document.languageId !== "sqf") {
    return;
  }

  const response = await fetchInactiveRanges(editor.document);
  const ranges = (response?.ranges ?? []).map((range) => new vscode.Range(
    new vscode.Position(range.startLine, 0),
    new vscode.Position(range.endLine, Number.MAX_SAFE_INTEGER)
  ));
  editor.setDecorations(inactiveCodeDecoration, ranges);
}

async function startClient(context: vscode.ExtensionContext): Promise<void> {
  client = createClient(context);
  await client.start();
  await updateContextStatusBar();
}

async function restartClient(context: vscode.ExtensionContext): Promise<void> {
  if (client && client.state !== State.Stopped) {
    await client.stop();
  }

  await startClient(context);
  void vscode.window.showInformationMessage("ReSDK Evaluator SQF language server restarted.");
}

async function showResolvedContexts(): Promise<void> {
  const activeEditor = vscode.window.activeTextEditor;
  if (!activeEditor || activeEditor.document.languageId !== "sqf") {
    void vscode.window.showInformationMessage("Open an SQF file to inspect resolved contexts.");
    return;
  }

  const resolved = await fetchResolvedContexts(activeEditor.document);
  if (!resolved || resolved.contexts.length === 0) {
    void vscode.window.showWarningMessage("No compile contexts were resolved for this file.");
    return;
  }

  const pick = await vscode.window.showQuickPick(
    resolved.contexts.map((context) => ({
      label: context.preferred ? `$(check) ${context.label}` : context.label,
      description: `${context.confidence} confidence | ${context.profileHints.join(", ")}`,
      detail: `${context.detail} | chain: ${context.chain.join(" -> ")}`,
      context
    })),
    {
      placeHolder: "Resolved compile contexts for the current file"
    }
  );

  if (!pick) {
    return;
  }

  await vscode.env.clipboard.writeText(
    [
      `label: ${pick.context.label}`,
      `validationEntry: ${pick.context.validationEntryFile}`,
      `rootFile: ${pick.context.rootFile}`,
      `profileHints: ${pick.context.profileHints.join(", ")}`,
      `chain: ${pick.context.chain.join(" -> ")}`
    ].join("\n")
  );
  void vscode.window.showInformationMessage("Resolved context copied to clipboard.");
}

export async function initialize(context: vscode.ExtensionContext): Promise<void> {
  contextStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(contextStatusBar);
  inactiveCodeDecoration = vscode.window.createTextEditorDecorationType({
    opacity: "0.45",
    isWholeLine: false
  });
  context.subscriptions.push(inactiveCodeDecoration);

  context.subscriptions.push(
    vscode.commands.registerCommand("evaluatorSqf.restartLanguageServer", async () => {
      await restartClient(context);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("evaluatorSqf.showResolvedContexts", async () => {
      await showResolvedContexts();
    })
  );
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(async (document) => {
    await applyResdkHeaderLanguage(document);
  }));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(async () => {
    if (vscode.window.activeTextEditor) {
      await applyResdkHeaderLanguage(vscode.window.activeTextEditor.document);
    }
    await updateContextStatusBar();
    await updateInactiveBlockDecorations(vscode.window.activeTextEditor);
  }));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async (document) => {
    if (document.languageId === "sqf") {
      await updateContextStatusBar();
      if (vscode.window.activeTextEditor?.document.uri.toString() === document.uri.toString()) {
        await updateInactiveBlockDecorations(vscode.window.activeTextEditor);
      }
    }
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(async (event) => {
    if (event.document.languageId !== "sqf") {
      return;
    }
    if (vscode.window.activeTextEditor?.document.uri.toString() === event.document.uri.toString()) {
      await updateInactiveBlockDecorations(vscode.window.activeTextEditor);
    }
  }));

  await startClient(context);
  for (const document of vscode.workspace.textDocuments) {
    await applyResdkHeaderLanguage(document);
  }
  if (vscode.window.activeTextEditor) {
    await applyResdkHeaderLanguage(vscode.window.activeTextEditor.document);
  }
  await updateInactiveBlockDecorations(vscode.window.activeTextEditor);
}

export async function deactivate(): Promise<void> {
  contextStatusBar?.dispose();
  contextStatusBar = undefined;
  inactiveCodeDecoration?.dispose();
  inactiveCodeDecoration = undefined;
  if (client) {
    await client.stop();
    client = undefined;
  }
}
