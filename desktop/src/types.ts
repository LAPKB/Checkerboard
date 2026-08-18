export type ColumnRole = "ignore" | "drugA" | "drugB" | "drugC" | "od";

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
}

export interface AnalysisSummary {
  sumBliss: number;
  meanBliss: number;
  positiveSum: number;
  negativeSum: number;
  combinationCount: number;
  interpretation: InteractionInterpretation;
}

export interface AnalysisResult {
  drugNames: string[];
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
