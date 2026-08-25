export type ColumnRole =
  | "ignore"
  | "drugNameA" | "drugNameB" | "drugNameC"
  | "drugA" | "drugB" | "drugC"
  | "unitsA" | "unitsB" | "unitsC"
  | "response";

export type AnalysisMode = "synergyFinderPlus" | "legacyOd";
export type ResponseType = "viability" | "viabilityFraction" | "inhibition" | "inhibitionFraction";
export type BaselineCorrection = "none" | "part" | "all";

export interface ImportRequest {
  path: string;
  worksheet: string | null;
  startRow: number;
  startColumn: number;
  rowLimit: number;
  columnLimit: number;
}

export interface ImportPreview {
  headers: string[];
  rows: string[][];
  totalRows: number;
  totalColumns: number;
  suggestedRoles: ColumnRole[];
  suggestedDrugNames: string[];
  regimens: RegimenPreview[];
}

export interface RegimenPreview {
  id: string;
  label: string;
  drugNames: string[];
  concentrationUnits: string[];
  suggestedResponseType: ResponseType;
  rows: string[][];
  totalRows: number;
}

export interface MappedDrug {
  column: number;
  name: string;
}

export interface ColumnMapping {
  drugs: MappedDrug[];
  responseColumn: number;
}

export interface AnalysisPolicy {
  mode: AnalysisMode;
  responseType: ResponseType;
  baselineCorrection: BaselineCorrection;
  bootstrapIterations: number;
  randomSeed: number;
  cellAdditiveThreshold: number;
  odCensorThreshold: number;
  allowIncompleteGrid: boolean;
}

export type InteractionInterpretation =
  | "antagonistic"
  | "additive"
  | "synergistic";

export interface ProcessedCombination {
  concentrations: number[];
  meanOriginalOd: number;
  meanCensoredOd: number;
  censoredReplicateCount: number;
  effect: number;
  singleAgentEffects: number[];
  blissExpected: number;
  blissInteraction: number;
  replicateCount: number;
  interpretation: InteractionInterpretation;
  blissSem?: number | null;
  blissCiLeft?: number | null;
  blissCiRight?: number | null;
}

export interface AnalysisSummary {
  sumBliss: number;
  meanBliss: number;
  positiveSum: number;
  negativeSum: number;
  combinationCount: number;
  pValue: string | null;
  interpretation: InteractionInterpretation;
}

export interface AnalysisResult {
  drugNames: string[];
  micValues: number[];
  micZeroTolerance: number;
  clinicallyRelevantConcentrations: (number | null)[];
  concentrationUnits: string[];
  control: { replicateCount: number; meanOd: number };
  processed: ProcessedCombination[];
  summary: AnalysisSummary;
  warnings: { code: string; message: string }[];
  policy: AnalysisPolicy;
}

export interface ComparisonRegimen {
  id: string;
  label: string;
  analysis: AnalysisResult;
  source?: ComparisonSource;
}

export interface ComparisonSource {
  importRequest: ImportRequest;
  preview: ImportPreview;
  roles: ColumnRole[];
  worksheets: string[];
  micEstimates: MicEstimate[];
  regimenId?: string | null;
}

export interface ComparisonSettings {
  minimumEffect: number;
  synergyThresholds: [number, number];
  antagonismThreshold: number;
}

export interface PairwiseComparison {
  leftId: string;
  rightId: string;
  winProbability: number | null;
  matchedLocations: number;
}

export interface RegimenRanking {
  regimen: ComparisonRegimen;
  rank: number;
  exceedanceAuc: number | null;
  averageWinProbability: number | null;
  eligibleLocations: number;
  synergyBreadth: [number, number];
  antagonismBurden: number;
}

export interface ComparisonResult {
  drugCount: number;
  rankings: RegimenRanking[];
  pairwise: PairwiseComparison[];
}

export interface AppError {
  code?: string;
  message: string;
}

export interface MicEstimate {
  drugName: string;
  mic: number | null;
  meanResponseAtMic: number | null;
  singleAgentLevels: number;
}
