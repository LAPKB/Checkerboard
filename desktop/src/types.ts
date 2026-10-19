export type AuthPhase = "unconfigured" | "restoring" | "signed_out" | "authenticated" | "suspended";

export interface AuthUser {
  subject: string;
  displayName: string;
  email: string | null;
}

export type SeatConflictReason = "seat_unavailable" | "seat_moved";

export interface SeatHolder {
  reservationId: string;
  generation: number;
  deviceLabel: string;
}

export interface SeatConflict {
  appId: string;
  capacity: number;
  holders: SeatHolder[];
  totalHolders: number;
  holdersTruncated: boolean;
}

export type SeatStatus =
  | { state: "acquiring" }
  | { state: "pending"; not_before: number | null }
  | { state: "granted" }
  | { state: "conflict"; reason: SeatConflictReason; detail: SeatConflict }
  | { state: "locked" };

export interface SeatReference {
  reservation_id: string;
  generation: number;
}

export interface AuthView {
  phase: AuthPhase;
  user: AuthUser | null;
  accountId: string | null;
  seat: SeatStatus | null;
  message: string | null;
}

export type ColumnRole =
  | "ignore"
  | "drugNameA" | "drugNameB" | "drugNameC"
  | "drugA" | "drugB" | "drugC"
  | "unitsA" | "unitsB" | "unitsC"
  | "organism"
  | "response";

export type AnalysisMode = "synergyFinderPlus" | "legacyOd";
export type ResponseType = "viability" | "viabilityFraction" | "inhibition" | "inhibitionFraction" | "rawOd";
export type BaselineCorrection = "none" | "part" | "all";
export type AnalysisType = "bliss" | "diamond" | "drusanoGreco" | "musyc";
export type InputType = "absorbance" | "fluorescence" | "count" | "normalized";
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
  bootstrapIterations: number | null;
  bootstrapSeed: number | null;
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
    wellId: string;
    rawResponse: number;
    normalizedEffect: number;
    normalizedDoses: number[];
    censored: boolean;
  }[];
  eligibleWellCount: number;
  controlCount: number;
  excludedBoundaryCount: number;
  excludedEffectBelowZeroCount: number;
  excludedEffectAboveOneCount: number;
  censoredCount: number;
  responseCensorLimit: number | null;
  normalizedEffectCensorLimit: number | null;
  blankValue: number;
  controlMean: number;
  maxConcentrations: number[];
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
  parameterSummaries: { name: string; mean: number; standardDeviation: number; percentile2_5: number; median: number; percentile97_5: number; percentile25?: number; percentile975?: number }[];
  referenceSupportPoint: { values: number[]; probability: number };
  predictions: {
    wellId: string;
    observedEffect: number;
    predictedEffect: number;
    observedResponse: number;
    predictedResponse: number;
    responseResidual: number | null;
    normalizedDoses: number[];
    censored: boolean;
  }[];
  regression: { observations: number; slope: number; intercept: number; rSquared: number; rootMeanSquaredError: number } | null;
  unpredictedCount: number;
  converged: boolean;
  cycles: number;
  runCycles: number;
  maxCycles: number;
  continuedFromCycles: number;
  objectiveFunction: number;
  bootstrapIterations: number;
  bootstrapSeed: number;
  bootstrapConvergedCount: number;
}

export interface DrusanoRegimenSimulationResult {
  drugNames: string[];
  concentrations: number[];
  maxConcentrations: number[];
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

export interface DrusanoSimulationEntry {
  id: string;
  label: string;
  regimenLabel?: string;
  organism?: string | null;
  simulation: DrusanoRegimenSimulationResult;
}

export interface DrusanoSimulationComparison {
  rankings: Array<DrusanoSimulationEntry & { rank: number }>;
}

export interface MusycModelSettings {
  responseCensorLimit: number | null;
  maxIterations: number | null;
  bootstrapIterations: number | null;
  bootstrapSeed: number | null;
}

export interface MusycDistributionSummary {
  mean: number;
  standardDeviation: number;
  percentile2_5: number;
  median: number;
  percentile97_5: number;
}

export interface MusycFitResult {
  data: DrusanoDataSet;
  modelSource: string;
  parameters: { name: string; value: number; fixed: boolean }[];
  parameterSummaries: Array<MusycDistributionSummary & { name: string }>;
  efficacyBeta: number;
  efficacyBetaSummary: MusycDistributionSummary | null;
  combinationEfficacy: number;
  combinationEfficacySummary: MusycDistributionSummary | null;
  objectiveFunction: number;
  iterations: number;
  converged: boolean;
  predictions: {
    wellId: string;
    observedEffect: number;
    predictedEffect: number;
    observedResponse: number;
    predictedResponse: number;
    normalizedDoses: number[];
    censored: boolean;
  }[];
  regression: { observations: number; slope: number; intercept: number; rSquared: number; rootMeanSquaredError: number } | null;
  residualStandardDeviation: number;
  bootstrapIterations: number;
  bootstrapSeed: number;
  bootstrapConvergedCount: number;
  warnings: string[];
}

export interface ImportRequest {
  path: string;
  worksheet: string | null;
  startRow: number;
  startColumn: number;
  rowLimit: number;
  columnLimit: number;
  organismColumn: number | null;
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
  regimenKey: string;
  regimenLabel: string;
  organism: string | null;
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
  blankValue: number;
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

export interface ConcentrationRange {
  minimum: number | null;
  maximum: number | null;
}

export interface AnalysisResult {
  drugNames: string[];
  micValues: number[];
  micZeroTolerance: number;
  concentrationRanges: ConcentrationRange[];
  clinicallyRelevantConcentrations?: (number | null)[];
  concentrationUnits: string[];
  control: { replicateCount: number; meanOd: number };
  processed: ProcessedCombination[];
  summary: AnalysisSummary;
  warnings: { code: string; message: string }[];
  policy: AnalysisPolicy;
}

export interface DiamondPolicy {
  responseType: ResponseType;
  blankValue: number;
  responseCensorThreshold: number;
  bootstrapIterations: number;
  randomSeed: number;
  diagonalToleranceLog2: number;
}

export interface DiamondScore {
  inhibitionLevel: number;
  observedDose: number;
  expectedDose: number;
  fic: number;
  log2Fic: number;
  ciLower: number | null;
  ciUpper: number | null;
  interpretation: InteractionInterpretation;
}

export interface DiamondHillFit {
  maximumInhibition: number;
  ec50: number;
  hillSlope: number;
  rSquared: number;
  ic50: number | null;
  ic90: number | null;
}

export interface DiamondCurve {
  drugIndices: number[];
  drugNames: string[];
  points: Array<{
    concentrations: number[];
    normalizedTotalDose: number;
    meanInhibition: number;
    replicateCount: number;
  }>;
  fit: DiamondHillFit;
}

export interface DiamondIsoboleDiagnostic {
  drugIndices: number[];
  drugNames: string[];
  inhibitionLevel: number;
  singleDrugIcs: number[];
  contourSegments: Array<{ start: number[]; end: number[] }>;
  rayDirection: number[];
  rayIntersection: number[] | null;
  surfaceFic: number | null;
  primaryFic: number;
  absoluteLog2Difference: number | null;
  agreesWithPrimary: boolean | null;
  rayIntersectionCount: number;
  gridShape: number[];
}

export interface DiamondResult {
  drugNames: string[];
  doseAnchors: number[];
  concentrationUnits: string[];
  controlMean: number;
  controlReplicates: number;
  curves: DiamondCurve[];
  assayLocations: Array<{ concentrations: number[]; meanInhibition: number; replicateCount: number }>;
  totalScores: DiamondScore[];
  pairwiseSummaries: Array<{ drugIndices: number[]; drugNames: string[]; scores: DiamondScore[] }>;
  emergentScores: DiamondScore[];
  isoboleDiagnostics?: DiamondIsoboleDiagnostic[];
  excludedOffDiagonalLocations: number;
  warnings: string[];
  policy: DiamondPolicy;
}

export interface DiamondRegimen {
  id: string;
  label: string;
  regimenLabel?: string;
  organism?: string | null;
  result: DiamondResult;
  source?: ComparisonSource;
}

export interface ComparisonRegimen {
  id: string;
  label: string;
  regimenLabel?: string;
  organism?: string | null;
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
