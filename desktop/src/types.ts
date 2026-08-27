export type ColumnRole =
  | "ignore"
  | "drugNameA" | "drugNameB" | "drugNameC"
  | "drugA" | "drugB" | "drugC"
  | "unitsA" | "unitsB" | "unitsC"
  | "response";

export type AnalysisMode = "synergyFinderPlus" | "legacyOd";
export type ResponseType = "viability" | "viabilityFraction" | "inhibition" | "inhibitionFraction" | "rawOd";
export type BaselineCorrection = "none" | "part" | "all";
export type AnalysisType = "bliss" | "drusanoGreco";
export type InputType = "absorbance" | "fluorescence" | "cfu";
export type ResponseDirection = "viability" | "inhibition";

export interface InputSettings {
  inputType: InputType | "";
  blankAdjustment: boolean;
  blankValue: number | null;
  relativeToGrowthControl: boolean;
  responseDirection: ResponseDirection;
}

export interface DrusanoModelSettings {
  responseCensorLimit: number | null;
  errorCoefficients: [number | null, number | null, number | null, number | null];
  lambda: number | null;
  maxCycles: number | null;
}

export interface DrusanoCensorLimitSuggestion {
  responseCensorLimit: number;
  normalizedEffectLimit: number;
  belowOrEqualCount: number;
  responseCount: number;
  densityRatio: number;
}

export interface DrusanoDataSet {
  drugNames: string[];
  headers: string[];
  rows: string[][];
  wells: {
    subjectId: string;
    rawResponse: number;
    normalizedEffect: number;
    normalizedDoses: number[];
    censored: boolean;
  }[];
  subjectCount: number;
  controlCount: number;
  excludedBoundaryCount: number;
  excludedEffectBelowZeroCount: number;
  excludedEffectAboveOneCount: number;
  censoredCount: number;
  responseCensorLimit: number | null;
  normalizedEffectCensorLimit: number | null;
  blankValue: number;
  controlMean: number;
  micValues: number[];
  warnings: string[];
}

export interface DrusanoFitResult {
  data: DrusanoDataSet;
  assayError: {
    coefficients: [number, number, number, number];
    initialLambda: number;
    fittedLambda: number;
  };
  modelSource: string;
  parameterNames: string[];
  supportPoints: { values: number[]; probability: number }[];
  parameterSummaries: { name: string; mean: number; standardDeviation: number }[];
  predictions: { subjectId: string; observedEffect: number; predictedEffect: number; censored: boolean }[];
  regression: { observations: number; slope: number; intercept: number; rSquared: number; rootMeanSquaredError: number } | null;
  unpredictedCount: number;
  converged: boolean;
  cycles: number;
  runCycles: number;
  maxCycles: number;
  continuedFromCycles: number;
  objectiveFunction: number;
}

export interface DrusanoRegimenSimulationResult {
  drugNames: string[];
  concentrations: number[];
  micValues: number[];
  normalizedDoses: number[];
  simulationCount: number;
  supportPointCount: number;
  seed: number;
  rejectedDraws: number;
  effects: number[];
  summary: {
    mean: number;
    standardDeviation: number;
    minimum: number;
    percentile2_5: number;
    percentile25: number;
    median: number;
    percentile75: number;
    percentile97_5: number;
    maximum: number;
  };
}

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
