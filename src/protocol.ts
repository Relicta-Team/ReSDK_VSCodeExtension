export const GET_RESOLVED_CONTEXTS_REQUEST = "evaluatorSqf/getResolvedContexts";
export const GET_INACTIVE_RANGES_REQUEST = "evaluatorSqf/getInactiveRanges";

export type ResolvedContextRequest = {
  uri: string;
};

export type ResolvedContextSummary = {
  id: string;
  label: string;
  detail: string;
  contextKind: string;
  rootKind: string;
  workspaceKind: string;
  workspaceRoot: string;
  rootFile: string;
  validationEntryFile: string;
  ownerFile: string;
  targetFile: string;
  chain: string[];
  edgeKinds: string[];
  confidence: string;
  preferred: boolean;
  profileHints: string[];
};

export type ResolvedContextsResponse = {
  workspaceKind: string;
  workspaceRoot: string;
  preferredContextId: string;
  contexts: ResolvedContextSummary[];
};

export type InactiveRangesRequest = {
  uri: string;
};

export type InactiveRange = {
  startLine: number;
  endLine: number;
};

export type InactiveRangesResponse = {
  ranges: InactiveRange[];
};
