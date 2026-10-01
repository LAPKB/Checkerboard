import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";

import { AuthGate } from "./AuthGate";
import { aggregateBliss, buildMapping, compareRegimens, concentrationRangeFor, exceedanceDomain, formatNumber, formatPValue, groupAnalysisUnits, hasConcentrationRanges, inactiveDrugPairSummary, isClinicalWindowCell, micAssignmentKey, propagateSharedDrugConcentrations, roleLabel, stratificationIndexFor, suggestMicsByOrganismDrug, validateRoles, withinClinicalWindow } from "./analysis";
import { DrusanoComparisonWorkspace, DrusanoFitWorkspace, DrusanoRegimenWorkspace, InputTypeControls, ProjectWorkspace } from "./DrusanoGreco";
import { MusycComparisonWorkspace, MusycFitWorkspace } from "./Musyc";
import { DiamondComparisonWorkspace, DiamondResultsWorkspace, DiamondSetupWorkspace } from "./Diamond";
import { RegimenNavigator } from "./RegimenNavigator";
import logo from "./assets/logo.png";
import {
  defaultPlotColors,
  loadPlotColors,
  savePlotColors,
  type PlotColors,
} from "./preferences";
import type {
  AnalysisPolicy,
  AnalysisType,
  AnalysisResult,
  AppError,
  BaselineCorrection,
  ColumnRole,
  ComparisonRegimen,
  ComparisonSettings,
  ConcentrationRange,
  DrusanoCensorLimitSuggestion,
  DiamondPolicy,
  DiamondRegimen,
  DiamondResult,
  ImportPreview,
  ImportRequest,
  InputSettings,
  DrusanoFitResult,
  DrusanoModelSettings,
  DrusanoRegimenSimulationResult,
  MusycFitResult,
  MusycModelSettings,
  MicEstimate,
  ProcessedCombination,
  RegimenPreview,
  RegimenRanking,
  ResponseType,
} from "./types";
import "./App.css";

type Page = "project" | "import" | "mic" | "analyze" | "regimen" | "results" | "compare";
type ResultTab = "summary" | "heatmap" | "bar" | "processed";
type AnalysisProgress = { completedIterations: number; totalIterations: number; regimenLabel?: string };
type DrusanoFitProgress = { phase: "reference" | "bootstrap"; cycle: number; objectiveFunction: number; completedBootstraps: number; totalBootstraps: number; regimenLabel?: string };
type MusycFitProgress = { phase: "reference" | "bootstrap"; iteration: number; objectiveFunction: number; completedBootstraps: number; totalBootstraps: number; regimenLabel?: string };
type RankingSortKey = "regimen" | "auc" | "win" | "locations" | "breadth0" | "breadth1" | "antagonism";
type SortDirection = "asc" | "desc";
type ResultOrder = "organism" | "regimen";

interface ProjectSnapshot {
  schemaVersion: 1;
  savedAt: string;
  page: Page;
  analysisType: AnalysisType;
  inputSettings: InputSettings;
  drusanoFits: Array<{ id: string; label: string; regimenLabel?: string; organism?: string | null; fit: DrusanoFitResult }>;
  drusanoSimulations: Record<string, DrusanoRegimenSimulationResult>;
  drusanoSimulationConcentrations: Record<string, Array<number | null>>;
  drusanoModelSettings: DrusanoModelSettings;
  drusanoCensorSuggestion: DrusanoCensorLimitSuggestion | null;
  blissResponseCensorLimit?: number | null;
  diamondRegimens?: DiamondRegimen[];
  diamondComparisonRegimens?: DiamondRegimen[];
  selectedDiamondId?: string | null;
  diamondToleranceLog2?: number;
  musycFits: Array<{ id: string; label: string; regimenLabel?: string; organism?: string | null; fit: MusycFitResult }>;
  musycModelSettings: MusycModelSettings;
  tab: ResultTab;
  importRequest: ImportRequest;
  worksheets: string[];
  preview: ImportPreview | null;
  roles: ColumnRole[];
  analysis: AnalysisResult | null;
  stratifyIndex: number;
  stratificationOverrides: Record<string, string>;
  sharedStratificationDrugs: string[];
  baselineCorrection: BaselineCorrection;
  bootstrapIterations: number;
  randomSeed: number;
  showConfidenceIntervals: boolean;
  micZeroTolerance: number;
  drugMicValues: Record<string, number | null>;
  drugMicSuggestions: Record<string, number | null>;
  micEstimatesByRegimen: Record<string, MicEstimate[]>;
  drugConcentrationRanges?: Record<string, ConcentrationRange>;
  drugClinicalValues?: Record<string, number | null>;
  responseTypes: Record<string, ResponseType>;
  selectedImportRegimenId: string | null;
  selectedImportRegimenKeys?: string[];
  selectedImportOrganisms?: string[];
  resultOrder?: ResultOrder;
  comparisonGrouping?: ResultOrder;
  analysisRegimens: ComparisonRegimen[];
  colors: PlotColors;
  comparisonRegimens: ComparisonRegimen[];
  comparisonIncludedIds: string[];
  comparisonSettings: ComparisonSettings;
}

const BarPlot = lazy(() => import("./BarPlot"));
const appBuild = "0.8.0";

const roleOptions: ColumnRole[] = ["ignore", "organism", "drugNameA", "drugA", "unitsA", "drugNameB", "drugB", "unitsB", "drugNameC", "drugC", "unitsC", "response"];

const initialImport: ImportRequest = {
  path: "",
  worksheet: null,
  startRow: 1,
  startColumn: 1,
  rowLimit: 0,
  columnLimit: 0,
  organismColumn: null,
};

const initialComparisonSettings: ComparisonSettings = {
  minimumEffect: 0,
  synergyThresholds: [10, 20],
  antagonismThreshold: 10,
};

const initialInputSettings: InputSettings = {
  inputType: "",
  blankAdjustment: true,
  blankValue: 0,
  relativeToGrowthControl: true,
  responseDirection: "viability",
};

const initialDrusanoModelSettings: DrusanoModelSettings = {
  responseCensorLimit: null,
  errorCoefficients: [0.01, 0, 0, 0],
  lambda: 0.01,
  maxCycles: 100,
  bootstrapIterations: 500,
  bootstrapSeed: 123,
};

const initialMusycModelSettings: MusycModelSettings = {
  responseCensorLimit: null,
  maxIterations: 5000,
  bootstrapIterations: 500,
  bootstrapSeed: 123,
};

function App() {
  const [launcherError, setLauncherError] = useState<string | null>(null);

  async function openLauncher() {
    setLauncherError(null);
    try {
      await invoke("auth_open_launcher", { startup: false });
    } catch (reason) {
      setLauncherError(errorMessage(reason));
    }
  }

  return (
    <AuthGate
      buildVersion={appBuild}
      formatError={errorMessage}
      launcherError={launcherError}
      logo={logo}
      openLauncher={openLauncher}
    >
      {() => <ProtectedWorkspace />}
    </AuthGate>
  );
}

function ProtectedWorkspace() {
  const [page, setPage] = useState<Page>("project");
  const [analysisType, setAnalysisType] = useState<AnalysisType>("bliss");
  const [inputSettings, setInputSettings] = useState<InputSettings>(initialInputSettings);
  const [drusanoFits, setDrusanoFits] = useState<{ id: string; label: string; regimenLabel?: string; organism?: string | null; fit: DrusanoFitResult }[]>([]);
  const [drusanoSimulations, setDrusanoSimulations] = useState<Record<string, DrusanoRegimenSimulationResult>>({});
  const [drusanoSimulationConcentrations, setDrusanoSimulationConcentrations] = useState<Record<string, Array<number | null>>>({});
  const [drusanoProgress, setDrusanoProgress] = useState<DrusanoFitProgress | null>(null);
  const [drusanoModelSettings, setDrusanoModelSettings] = useState<DrusanoModelSettings>(initialDrusanoModelSettings);
  const [drusanoCensorSuggestion, setDrusanoCensorSuggestion] = useState<DrusanoCensorLimitSuggestion | null>(null);
  const [blissResponseCensorLimit, setBlissResponseCensorLimit] = useState<number | null>(null);
  const [diamondRegimens, setDiamondRegimens] = useState<DiamondRegimen[]>([]);
  const [diamondComparisonRegimens, setDiamondComparisonRegimens] = useState<DiamondRegimen[]>([]);
  const [selectedDiamondId, setSelectedDiamondId] = useState<string | null>(null);
  const [diamondToleranceLog2, setDiamondToleranceLog2] = useState(0.5);
  const [drusanoSuggestionBusy, setDrusanoSuggestionBusy] = useState(false);
  const [drusanoSuggestionError, setDrusanoSuggestionError] = useState<string | null>(null);
  const [musycFits, setMusycFits] = useState<{ id: string; label: string; regimenLabel?: string; organism?: string | null; fit: MusycFitResult }[]>([]);
  const [musycProgress, setMusycProgress] = useState<MusycFitProgress | null>(null);
  const [musycModelSettings, setMusycModelSettings] = useState<MusycModelSettings>(initialMusycModelSettings);
  const [tab, setTab] = useState<ResultTab>("summary");
  const [importRequest, setImportRequest] = useState(initialImport);
  const [worksheets, setWorksheets] = useState<string[]>([]);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [roles, setRoles] = useState<ColumnRole[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState<AnalysisProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [batchWarning, setBatchWarning] = useState<string | null>(null);
  const [stratifyIndex, setStratifyIndex] = useState(2);
  const [stratificationOverrides, setStratificationOverrides] = useState<Record<string, string>>({});
  const [sharedStratificationDrugs, setSharedStratificationDrugs] = useState<string[]>([]);
  const [baselineCorrection, setBaselineCorrection] = useState<BaselineCorrection>("all");
  const [bootstrapIterations, setBootstrapIterations] = useState(10);
  const [randomSeed, setRandomSeed] = useState(123);
  const [showConfidenceIntervals, setShowConfidenceIntervals] = useState(true);
  const [micZeroTolerance, setMicZeroTolerance] = useState(5);
  const [drugMicValues, setDrugMicValues] = useState<Record<string, number | null>>({});
  const [drugMicSuggestions, setDrugMicSuggestions] = useState<Record<string, number | null>>({});
  const [micEstimatesByRegimen, setMicEstimatesByRegimen] = useState<Record<string, MicEstimate[]>>({});
  const [micBusy, setMicBusy] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [drugConcentrationRanges, setDrugConcentrationRanges] = useState<Record<string, ConcentrationRange>>({});
  const [responseTypes, setResponseTypes] = useState<Record<string, ResponseType>>({});
  const [selectedImportRegimenId, setSelectedImportRegimenId] = useState<string | null>(null);
  const [selectedImportRegimenKeys, setSelectedImportRegimenKeys] = useState<string[]>([]);
  const [selectedImportOrganisms, setSelectedImportOrganisms] = useState<string[]>([]);
  const [resultOrder, setResultOrder] = useState<ResultOrder>("organism");
  const [comparisonGrouping, setComparisonGrouping] = useState<ResultOrder>("organism");
  const [analysisRegimens, setAnalysisRegimens] = useState<ComparisonRegimen[]>([]);
  const [colors, setColors] = useState<PlotColors>(defaultPlotColors);
  const [comparisonRegimens, setComparisonRegimens] = useState<ComparisonRegimen[]>([]);
  const [comparisonIncludedIds, setComparisonIncludedIds] = useState<string[]>([]);
  const [comparisonSettings, setComparisonSettings] = useState(initialComparisonSettings);
  const [currentBootstrapRegimen, setCurrentBootstrapRegimen] = useState<string | null>(null);
  const [showInstructions, setShowInstructions] = useState(false);
  const [restoredSnapshot, setRestoredSnapshot] = useState(false);
  const [projectNotice, setProjectNotice] = useState<string | null>(null);

  useEffect(() => {
    loadPlotColors().then(setColors).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!showInstructions) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowInstructions(false);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [showInstructions]);

  const mappingErrors = useMemo(() => validateRoles(roles), [roles]);
  const mappedOrganismColumn = roles.indexOf("organism") >= 0 ? roles.indexOf("organism") : null;
  const importedRegimenOptions = useMemo(() => uniqueBy(
    (preview?.regimens ?? []).map((regimen) => ({ key: regimenKeyOf(regimen), label: regimenLabelOf(regimen) })),
    (item) => item.key,
  ), [preview]);
  const importedOrganismOptions = useMemo(() => uniqueBy(
    (preview?.regimens ?? []).map((regimen) => ({ key: organismKey(regimen.organism), label: regimen.organism ?? "Unspecified organism" })),
    (item) => item.key,
  ), [preview]);
  const activeRegimens = useMemo(() => (preview?.regimens ?? [])
    .filter((regimen) => selectedImportRegimenKeys.includes(regimenKeyOf(regimen))
      && selectedImportOrganisms.includes(organismKey(regimen.organism)))
    .sort((left, right) => compareAnalysisUnits(left, right, resultOrder)),
  [preview, selectedImportRegimenKeys, selectedImportOrganisms, resultOrder]);
  const selectedImportRegimen = preview?.regimens.find((regimen) => regimen.id === selectedImportRegimenId)
    ?? activeRegimens[0] ?? preview?.regimens[0] ?? null;
  const uploadedDrugs = useMemo(() => {
    const drugs = new Map<string, { name: string; unit: string }>();
    for (const regimen of activeRegimens) {
      regimen.drugNames.forEach((name, index) => {
        if (!drugs.has(name)) drugs.set(name, { name, unit: regimen.concentrationUnits[index] ?? "" });
      });
    }
    return [...drugs.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [activeRegimens]);
  const micAssignments = useMemo(() => {
    const assignments = new Map<string, { key: string; organism: string | null; name: string; unit: string }>();
    for (const regimen of activeRegimens) {
      regimen.drugNames.forEach((name, index) => {
        const key = micAssignmentKey(regimen.organism, name);
        const existing = assignments.get(key);
        const unit = regimen.concentrationUnits[index] ?? "";
        if (!existing) assignments.set(key, { key, organism: regimen.organism, name, unit });
        else if (!existing.unit && unit) assignments.set(key, { ...existing, unit });
      });
    }
    return [...assignments.values()].sort((left, right) =>
      (left.organism ?? "").localeCompare(right.organism ?? "") || left.name.localeCompare(right.name));
  }, [activeRegimens]);
  const importReady = Boolean(inputSettings.inputType && preview && mappingErrors.length === 0 && activeRegimens.length > 0
    && activeRegimens.every((regimen) => buildMapping(preview, roles, regimen.drugNames) !== null));
  const micComplete = importReady && micAssignments.length > 0 && micAssignments.every((assignment) => {
    const value = micRecordValue(drugMicValues, assignment.key, assignment.name);
    return value != null && Number.isFinite(value) && value > 0;
  });
  const micAnalysis = analysisType === "bliss" || analysisType === "diamond";
  const resultsReady = micComplete && (analysisType === "bliss" ? analysisRegimens.length > 0 : analysisType === "diamond" && diamondRegimens.length > 0);
  const showCompare = analysisType === "bliss" ? comparisonRegimens.length > 1 : analysisType === "diamond" && diamondComparisonRegimens.length > 1;
  const drusanoComparisonEntries = useMemo(() => drusanoFits.flatMap((entry) => {
    const simulation = drusanoSimulations[entry.id];
    const entered = drusanoSimulationConcentrations[entry.id];
    return simulation && entered && simulation.concentrations.every((value, index) => value === entered[index])
      ? [{ id: entry.id, label: entry.label, regimenLabel: entry.regimenLabel, organism: entry.organism, simulation }]
      : [];
  }), [drusanoFits, drusanoSimulations, drusanoSimulationConcentrations]);
  const orderedDrusanoFits = useMemo(() => [...drusanoFits].sort((left, right) => compareAnalysisUnits(left, right, resultOrder)), [drusanoFits, resultOrder]);
  const orderedMusycFits = useMemo(() => [...musycFits].sort((left, right) => compareAnalysisUnits(left, right, resultOrder)), [musycFits, resultOrder]);
  const orderedAnalysisRegimens = useMemo(() => [...analysisRegimens].sort((left, right) => compareAnalysisUnits(left, right, resultOrder)), [analysisRegimens, resultOrder]);
  const orderedDiamondRegimens = useMemo(() => [...diamondRegimens].sort((left, right) => compareAnalysisUnits(left, right, resultOrder)), [diamondRegimens, resultOrder]);
  const orderedDiamondComparisons = useMemo(() => [...diamondComparisonRegimens].sort((left, right) => compareAnalysisUnits(left, right, resultOrder)), [diamondComparisonRegimens, resultOrder]);
  const selectedDiamond = diamondRegimens.find((entry) => entry.id === selectedDiamondId) ?? orderedDiamondRegimens[0] ?? null;
  const validBlankValue = inputSettings.inputType === "count"
    || (inputSettings.blankValue != null && Number.isFinite(inputSettings.blankValue));
  const blissSettingsComplete = validBlankValue
    && validResponseCensorLimit(inputSettings.inputType, blissResponseCensorLimit);
  const diamondSettingsComplete = blissSettingsComplete && diamondToleranceLog2 >= 0;
  const drusanoSettingsComplete = validBlankValue
    && validResponseCensorLimit(inputSettings.inputType, drusanoModelSettings.responseCensorLimit)
    && drusanoModelSettings.errorCoefficients.every((value) => value != null && Number.isFinite(value))
    && drusanoModelSettings.lambda != null
    && Number.isFinite(drusanoModelSettings.lambda)
    && drusanoModelSettings.lambda >= 0
    && drusanoModelSettings.maxCycles != null
    && Number.isInteger(drusanoModelSettings.maxCycles)
    && drusanoModelSettings.maxCycles >= 1
    && drusanoModelSettings.maxCycles <= 10_000
    && drusanoModelSettings.bootstrapIterations != null
    && Number.isInteger(drusanoModelSettings.bootstrapIterations)
    && drusanoModelSettings.bootstrapIterations >= 1
    && drusanoModelSettings.bootstrapIterations <= 10_000
    && drusanoModelSettings.bootstrapSeed != null
    && Number.isInteger(drusanoModelSettings.bootstrapSeed)
    && drusanoModelSettings.bootstrapSeed >= 0;
  const musycSettingsComplete = validBlankValue
    && validResponseCensorLimit(inputSettings.inputType, musycModelSettings.responseCensorLimit)
    && musycModelSettings.maxIterations != null
    && Number.isInteger(musycModelSettings.maxIterations)
    && musycModelSettings.maxIterations >= 100
    && musycModelSettings.maxIterations <= 50_000
    && musycModelSettings.bootstrapIterations != null
    && Number.isInteger(musycModelSettings.bootstrapIterations)
    && musycModelSettings.bootstrapIterations >= 1
    && musycModelSettings.bootstrapIterations <= 10_000
    && musycModelSettings.bootstrapSeed != null
    && Number.isInteger(musycModelSettings.bootstrapSeed)
    && musycModelSettings.bootstrapSeed >= 0;

  useEffect(() => {
    if (page === "project") return;
    if (page !== "import" && !importReady) setPage("import");
    else if (micAnalysis && ["analyze", "results", "compare", "regimen"].includes(page) && !micComplete) setPage("mic");
    else if (!micAnalysis && (page === "mic" || page === "results")) setPage("analyze");
    else if (micAnalysis && page === "results" && !resultsReady) setPage("analyze");
    else if (micAnalysis && page === "compare" && !showCompare) setPage(resultsReady ? "results" : "analyze");
    else if (micAnalysis && page === "regimen") setPage(micComplete ? "analyze" : "mic");
    else if (analysisType === "drusanoGreco" && page === "regimen" && drusanoFits.length === 0) setPage("analyze");
    else if (analysisType === "drusanoGreco" && page === "compare" && drusanoComparisonEntries.length < 2) setPage(drusanoFits.length ? "regimen" : "analyze");
    else if (analysisType === "musyc" && page === "regimen") setPage("analyze");
    else if (analysisType === "musyc" && page === "compare" && musycFits.length < 2) setPage("analyze");
  }, [page, analysisType, micAnalysis, importReady, micComplete, resultsReady, showCompare, drusanoFits.length, drusanoComparisonEntries.length, musycFits.length]);

  useEffect(() => {
    if (restoredSnapshot) return;
    if (!preview || mappingErrors.length > 0) {
      setDrugMicSuggestions({});
      setMicEstimatesByRegimen({});
      return;
    }
    if (!micAnalysis) {
      setDrugMicSuggestions({});
      setMicEstimatesByRegimen({});
      setMicBusy(false);
      setMicError(null);
      setDrugMicValues((current) => Object.fromEntries(micAssignments.map((assignment) => [
        assignment.key,
        micRecordValue(current, assignment.key, assignment.name) ?? null,
      ])));
      return;
    }
    let cancelled = false;
    setMicBusy(true);
    setMicError(null);
    Promise.all(activeRegimens.map(async (regimen) => {
      const mapping = buildMapping(preview, roles, regimen.drugNames);
      if (!mapping) throw new Error(`${regimen.label}: invalid mapping`);
      const estimates = await invoke<MicEstimate[]>("infer_mics", { request: {
        import: importRequest, mapping,
        responseType: responseTypes[regimen.id] ?? regimen.suggestedResponseType,
        blankValue: inputSettings.inputType === "count" ? 0 : inputSettings.blankValue,
        zeroTolerance: micZeroTolerance, regimenDrugNames: regimen.drugNames,
        organism: regimen.organism, organismColumn: mappedOrganismColumn,
      } });
      return { regimen, estimates };
    })).then((results) => {
      if (cancelled) return;
      const byRegimen = Object.fromEntries(results.map(({ regimen, estimates }) => [regimen.id, estimates]));
      const groupedSuggestions = suggestMicsByOrganismDrug(results.flatMap(({ regimen, estimates }) =>
        estimates.map((estimate) => ({ organism: regimen.organism, ...estimate }))));
      const suggestions = Object.fromEntries(micAssignments.map((assignment) => [
        assignment.key,
        groupedSuggestions[assignment.key] ?? null,
      ]));
      setMicEstimatesByRegimen(byRegimen);
      setDrugMicSuggestions(suggestions);
      setDrugMicValues((current) => Object.fromEntries(micAssignments.map((assignment) => [
        assignment.key,
        micRecordValue(current, assignment.key, assignment.name) ?? suggestions[assignment.key] ?? null,
      ])));
      setDrugConcentrationRanges((current) => Object.fromEntries(uploadedDrugs.map((drug) => [drug.name, current[drug.name] ?? { minimum: null, maximum: null }])));
    }).catch((reason) => {
      if (!cancelled) setMicError(errorMessage(reason));
    }).finally(() => { if (!cancelled) setMicBusy(false); });
    return () => { cancelled = true; };
  }, [analysisType, micAnalysis, preview, activeRegimens, roles, importRequest, inputSettings.inputType, inputSettings.blankValue, micZeroTolerance, responseTypes, uploadedDrugs, micAssignments, restoredSnapshot]);

  useEffect(() => {
    if (restoredSnapshot) return;
    if (!usesResponseCensoring(inputSettings.inputType)
      || (inputSettings.inputType !== "count" && (inputSettings.blankValue == null || !Number.isFinite(inputSettings.blankValue)))
      || !preview || !selectedImportRegimen) {
      setDrusanoCensorSuggestion(null);
      setDrusanoSuggestionBusy(false);
      setDrusanoSuggestionError(null);
      return;
    }
    const mapping = buildMapping(preview, roles, selectedImportRegimen.drugNames);
    if (!mapping) return;
    let cancelled = false;
    setDrusanoSuggestionBusy(true);
    setDrusanoSuggestionError(null);
    invoke<DrusanoCensorLimitSuggestion | null>("suggest_drusano_censor_limit", { request: {
      import: importRequest,
      mapping,
      blankValue: inputSettings.inputType === "count" ? 0 : inputSettings.blankValue,
      countData: inputSettings.inputType === "count",
      regimenDrugNames: selectedImportRegimen.drugNames,
      organism: selectedImportRegimen.organism,
      organismColumn: mappedOrganismColumn,
    } }).then((suggestion) => {
      if (cancelled) return;
        setDrusanoCensorSuggestion(suggestion);
        if (suggestion && analysisType === "drusanoGreco") setDrusanoModelSettings((current) => current.responseCensorLimit == null ? { ...current, responseCensorLimit: suggestion.responseCensorLimit } : current);
        if (suggestion && analysisType === "musyc") setMusycModelSettings((current) => current.responseCensorLimit == null ? { ...current, responseCensorLimit: suggestion.responseCensorLimit } : current);
        if (suggestion && micAnalysis) setBlissResponseCensorLimit((current) => current ?? suggestion.responseCensorLimit);
    }).catch((reason) => {
      if (!cancelled) setDrusanoSuggestionError(errorMessage(reason));
    }).finally(() => {
      if (!cancelled) setDrusanoSuggestionBusy(false);
    });
    return () => { cancelled = true; };
  }, [analysisType, inputSettings.inputType, inputSettings.blankValue, preview, selectedImportRegimen, roles, importRequest, restoredSnapshot]);

  async function chooseFile() {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [
        {
          name: "Checkerboard data",
          extensions: ["csv", "txt", "xls", "xlsx"],
        },
      ],
    });
    if (!selected) return;
    setRestoredSnapshot(false);
    const path = String(selected);
    const next = { ...initialImport, path };
    setImportRequest(next);
    setPreview(null);
    setAnalysis(null);
    setAnalysisRegimens([]);
    setDiamondRegimens([]);
    setSelectedDiamondId(null);
    setDrusanoFits([]);
    setMusycFits([]);
    setDrusanoSimulations({});
    setDrusanoSimulationConcentrations({});
    setDrusanoModelSettings((current) => ({ ...current, responseCensorLimit: null }));
    setMusycModelSettings((current) => ({ ...current, responseCensorLimit: null }));
    setDrusanoCensorSuggestion(null);
    setBlissResponseCensorLimit(null);
    setDrugMicValues({});
    setDrugMicSuggestions({});
    setMicEstimatesByRegimen({});
    setDrugConcentrationRanges({});
    setResponseTypes({});
    setSelectedImportRegimenId(null);
    setPage("import");
    setError(null);
    setBatchWarning(null);
    try {
      const sheets = await invoke<string[]>("list_worksheets", { path });
      setWorksheets(sheets);
      if (sheets.length > 0) next.worksheet = sheets[0];
      setImportRequest({ ...next });
      await loadPreview(next);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function loadPreview(request = importRequest) {
    if (!request.path) return;
    setRestoredSnapshot(false);
    setBusy(true);
    setError(null);
    try {
      const imported = await invoke<ImportPreview>("import_preview", { request });
      setPreview(imported);
      setRoles(imported.suggestedRoles);
      setSelectedImportRegimenId(imported.regimens[0]?.id ?? null);
      setSelectedImportRegimenKeys([...new Set(imported.regimens.map(regimenKeyOf))]);
      setSelectedImportOrganisms([...new Set(imported.regimens.map((regimen) => organismKey(regimen.organism)))]);
      const selectedInputResponse = responseTypeForInput(inputSettings);
      const detectedResponses = Object.fromEntries(imported.regimens.map((regimen) => [
        regimen.id,
        selectedInputResponse ?? regimen.suggestedResponseType,
      ]));
      setResponseTypes(detectedResponses);
      setDrugMicValues({});
      setDrugMicSuggestions({});
      setMicEstimatesByRegimen({});
      setDrugConcentrationRanges({});
      setAnalysis(null);
      setAnalysisRegimens([]);
      setDiamondRegimens([]);
      setSelectedDiamondId(null);
      setDrusanoFits([]);
      setMusycFits([]);
      setDrusanoSimulations({});
      setDrusanoSimulationConcentrations({});
      setDrusanoModelSettings((current) => ({ ...current, responseCensorLimit: null }));
      setMusycModelSettings((current) => ({ ...current, responseCensorLimit: null }));
      setDrusanoCensorSuggestion(null);
      setBlissResponseCensorLimit(null);
    } catch (reason) {
      setPreview(null);
      setSelectedImportRegimenKeys([]);
      setSelectedImportOrganisms([]);
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function runAnalysis() {
    if (!preview || !micComplete || !blissSettingsComplete) {
      setError("Complete the blank response and response censor limit before calculating Bliss.");
      return;
    }
    const targets = activeRegimens;
    setBusy(true);
    setCurrentBootstrapRegimen(targets[0]?.label ?? null);
    setAnalysisProgress({ completedIterations: 0, totalIterations: bootstrapIterations, regimenLabel: targets[0]?.label });
    setError(null);
    setBatchWarning(null);
    try {
      const completed: ComparisonRegimen[] = [];
      const failures: string[] = [];
      for (const regimen of targets) {
        setCurrentBootstrapRegimen(regimen.label);
        setAnalysisProgress({ completedIterations: 0, totalIterations: bootstrapIterations, regimenLabel: regimen.label });
        const mapping = buildMapping(preview, roles, regimen.drugNames);
        if (!mapping) { failures.push(`${regimen.label}: invalid column mapping`); continue; }
        try {
          const regimenResponseType = responseTypes[regimen.id] ?? regimen.suggestedResponseType;
          const requestedPolicy: AnalysisPolicy = {
            mode: "synergyFinderPlus", responseType: regimenResponseType, baselineCorrection,
            bootstrapIterations, randomSeed, cellAdditiveThreshold: 10,
            blankValue: inputSettings.inputType === "count" ? 0 : inputSettings.blankValue ?? 0,
            odCensorThreshold: usesResponseCensoring(inputSettings.inputType) ? blissResponseCensorLimit ?? 0 : 0,
            allowIncompleteGrid: true,
          };
          const regimenMics = regimen.drugNames.map((name) =>
            micRecordValue(drugMicValues, micAssignmentKey(regimen.organism, name), name));
          if (regimenMics.some((value) => value == null || !Number.isFinite(value) || value <= 0)) throw new Error("one or more MIC assignments are incomplete");
          const regimenRanges = regimen.drugNames.map((name) => drugConcentrationRanges[name] ?? { minimum: null, maximum: null });
          const onProgress = new Channel<AnalysisProgress>();
          onProgress.onmessage = (progress) => setAnalysisProgress({ ...progress, regimenLabel: regimen.label });
          const result = await invoke<AnalysisResult>("analyze_table", { request: {
            import: importRequest, mapping, micValues: regimenMics, micZeroTolerance,
            concentrationRanges: regimenRanges,
            regimenDrugNames: regimen.drugNames, organism: regimen.organism, organismColumn: mappedOrganismColumn,
            concentrationUnits: regimen.concentrationUnits, policy: requestedPolicy,
          }, onProgress });
          verifyAnalysisResult(result, requestedPolicy, regimenMics, micZeroTolerance, regimenRanges, regimen.concentrationUnits);
          const source = { importRequest: { ...importRequest }, preview, roles: [...roles], worksheets: [...worksheets], micEstimates: (micEstimatesByRegimen[regimen.id] ?? []).map((estimate) => ({ ...estimate })), regimenId: regimen.id };
          completed.push({
            id: `${importRequest.path}:${importRequest.worksheet ?? ""}:${regimen.id}`,
            label: regimen.label,
            regimenLabel: regimenLabelOf(regimen),
            organism: regimen.organism,
            analysis: result,
            source,
          });
        } catch (reason) {
          failures.push(`${regimen.label}: ${errorMessage(reason)}`);
        }
      }
      if (!completed.length) throw new Error(`No regimens could be analyzed. ${failures.join(" ")}`);
      setAnalysisRegimens(completed);
      const displayed = completed[0];
      setAnalysis(displayed.analysis);
      setSelectedImportRegimenId(displayed.source?.regimenId ?? null);
      setComparisonRegimens((current) => [...current.filter((existing) => !completed.some((next) => next.id === existing.id)), ...completed]);
      setComparisonIncludedIds((current) => [
        ...new Set([
          ...current,
          ...completed
            .filter((next) => !comparisonRegimens.some((existing) => existing.id === next.id))
            .map((regimen) => regimen.id),
        ]),
      ]);
      if (failures.length) setBatchWarning(`${completed.length} regimen${completed.length === 1 ? " was" : "s were"} analyzed. Skipped ${failures.length}: ${failures.join(" ")}`);
      setStratifyIndex(stratificationIndexFor(displayed, stratificationOverrides, sharedStratificationDrugs));
      setPage("results");
      setTab("summary");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
      setAnalysisProgress(null);
      setCurrentBootstrapRegimen(null);
    }
  }

  async function runDiamondAnalysis() {
    if (!preview || !micComplete || !blissSettingsComplete) {
      setError("Complete the dose anchors, blank response, and response censor limit before calculating DiaMOND.");
      return;
    }
    setBusy(true);
    setError(null);
    setBatchWarning(null);
    const completed: DiamondRegimen[] = [];
    const failures: string[] = [];
    try {
      for (const regimen of activeRegimens) {
        setCurrentBootstrapRegimen(regimen.label);
        setAnalysisProgress({ completedIterations: 0, totalIterations: bootstrapIterations, regimenLabel: regimen.label });
        const mapping = buildMapping(preview, roles, regimen.drugNames);
        if (!mapping) { failures.push(`${regimen.label}: invalid column mapping`); continue; }
        const doseAnchors = regimen.drugNames.map((name) =>
          micRecordValue(drugMicValues, micAssignmentKey(regimen.organism, name), name));
        if (doseAnchors.some((value) => value == null || !Number.isFinite(value) || value <= 0)) { failures.push(`${regimen.label}: incomplete dose anchors`); continue; }
        const policy: DiamondPolicy = {
          responseType: responseTypes[regimen.id] ?? regimen.suggestedResponseType,
          blankValue: inputSettings.inputType === "count" ? 0 : inputSettings.blankValue ?? 0,
          responseCensorThreshold: usesResponseCensoring(inputSettings.inputType) ? blissResponseCensorLimit ?? 0 : 0,
          bootstrapIterations,
          randomSeed,
          diagonalToleranceLog2: diamondToleranceLog2,
        };
        try {
          const onProgress = new Channel<AnalysisProgress>();
          onProgress.onmessage = (progress) => setAnalysisProgress({ ...progress, regimenLabel: regimen.label });
          const result = await invoke<DiamondResult>("analyze_diamond", { request: {
            import: importRequest, mapping, policy, doseAnchors,
            regimenDrugNames: regimen.drugNames, organism: regimen.organism,
            organismColumn: mappedOrganismColumn, concentrationUnits: regimen.concentrationUnits,
          }, onProgress });
          const source = { importRequest: { ...importRequest }, preview, roles: [...roles], worksheets: [...worksheets], micEstimates: (micEstimatesByRegimen[regimen.id] ?? []).map((estimate) => ({ ...estimate })), regimenId: regimen.id };
          completed.push({ id: `${importRequest.path}:${importRequest.worksheet ?? ""}:${regimen.id}:diamond`, label: regimen.label, regimenLabel: regimenLabelOf(regimen), organism: regimen.organism, result, source });
        } catch (reason) { failures.push(`${regimen.label}: ${errorMessage(reason)}`); }
      }
      if (!completed.length) throw new Error(`No regimens could be analyzed. ${failures.join(" ")}`);
      setDiamondRegimens(completed);
      setSelectedDiamondId(completed[0].id);
      setDiamondComparisonRegimens((current) => [...current.filter((existing) => !completed.some((next) => next.id === existing.id)), ...completed]);
      if (failures.length) setBatchWarning(`${completed.length} regimen${completed.length === 1 ? " was" : "s were"} analyzed. Skipped ${failures.length}: ${failures.join(" ")}`);
      setPage("results");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); setAnalysisProgress(null); setCurrentBootstrapRegimen(null); }
  }

  function updateRange(field: keyof ImportRequest, value: number | string | null) {
    setRestoredSnapshot(false);
    setImportRequest((current) => ({
      ...current,
      [field]: value,
      organismColumn: field === "rowLimit" ? current.organismColumn : null,
    }));
  }

  function updateColumnRole(index: number, role: ColumnRole) {
    const next = [...roles];
    if (role === "organism") {
      next.forEach((assigned, column) => { if (assigned === "organism" && column !== index) next[column] = "ignore"; });
    }
    next[index] = role;
    setRestoredSnapshot(false);
    setRoles(next);
    const currentOrganismColumn = roles.indexOf("organism");
    const nextOrganismColumn = next.indexOf("organism");
    if (currentOrganismColumn !== nextOrganismColumn) {
      const request = { ...importRequest, organismColumn: nextOrganismColumn >= 0 ? nextOrganismColumn : null };
      setImportRequest(request);
      void loadPreview(request);
    }
  }

  function updateImportScope(regimenKeys: string[], organisms: string[]) {
    setRestoredSnapshot(false);
    setSelectedImportRegimenKeys(regimenKeys);
    setSelectedImportOrganisms(organisms);
    const first = preview?.regimens.find((regimen) =>
      regimenKeys.includes(regimenKeyOf(regimen)) && organisms.includes(organismKey(regimen.organism)));
    setSelectedImportRegimenId(first?.id ?? null);
    setAnalysis(null);
    setAnalysisRegimens([]);
    setDrusanoFits([]);
    setDrusanoSimulations({});
    setMusycFits([]);
    setDiamondRegimens([]);
    setSelectedDiamondId(null);
    setDrugMicValues({});
    setDrugMicSuggestions({});
    setMicEstimatesByRegimen({});
  }

  function selectImportRegimen(id: string) {
    setSelectedImportRegimenId(id);
  }

  function selectAnalyzedRegimen(regimen: ComparisonRegimen) {
    setAnalysis(regimen.analysis);
    setSelectedImportRegimenId(regimen.source?.regimenId ?? null);
    setInputSettings((current) => ({ ...current, blankValue: regimen.analysis.policy.blankValue ?? 0 }));
    setBlissResponseCensorLimit(regimen.analysis.policy.odCensorThreshold || null);
    setBaselineCorrection(regimen.analysis.policy.baselineCorrection);
    setBootstrapIterations(regimen.analysis.policy.bootstrapIterations);
    setRandomSeed(regimen.analysis.policy.randomSeed);
    setDrugConcentrationRanges((current) => ({
      ...current,
      ...Object.fromEntries(regimen.analysis.drugNames.map((name, index) => [name, concentrationRangeFor(regimen.analysis, index)])),
    }));
    setStratifyIndex(stratificationIndexFor(regimen, stratificationOverrides, sharedStratificationDrugs));
  }

  function changeAnalysisType(value: AnalysisType) {
    setAnalysisType(value);
    setPage("project");
    setError(null);
    setBatchWarning(null);
  }

  function updateInputSettings(next: InputSettings) {
    const inputTypeChanged = next.inputType !== inputSettings.inputType;
    if (next.inputType === "count" || next.inputType === "normalized") {
      next = { ...next, blankAdjustment: false, blankValue: 0 };
    }
    setRestoredSnapshot(false);
    setInputSettings(next);
    setDrusanoFits([]);
    setDrusanoSimulations({});
    setMusycFits([]);
    setDiamondRegimens([]);
    setSelectedDiamondId(null);
    if (inputTypeChanged) {
      setDrusanoCensorSuggestion(null);
      setBlissResponseCensorLimit(null);
      setDrusanoModelSettings((current) => ({ ...current, responseCensorLimit: null }));
      setMusycModelSettings((current) => ({ ...current, responseCensorLimit: null }));
    }
    if (!preview || !next.inputType) return;
    const selectedType = responseTypeForInput(next);
    setResponseTypes(Object.fromEntries(preview.regimens.map((regimen) => [
      regimen.id,
      selectedType ?? regimen.suggestedResponseType,
    ])));
  }

  function updateMusycModelSettings(next: MusycModelSettings) {
    const fitChange = next.responseCensorLimit !== musycModelSettings.responseCensorLimit
      || next.bootstrapIterations !== musycModelSettings.bootstrapIterations
      || next.bootstrapSeed !== musycModelSettings.bootstrapSeed;
    setMusycModelSettings(next);
    if (fitChange) setMusycFits([]);
  }

  async function runMusycFit() {
    if (!preview || !importReady || !musycSettingsComplete) {
      setError("Complete the import, blank response, censor limit, and MuSyC optimizer settings before fitting.");
      return;
    }
    setBusy(true);
    setMusycProgress({ phase: "reference", iteration: 0, objectiveFunction: Number.NaN, completedBootstraps: 0, totalBootstraps: musycModelSettings.bootstrapIterations ?? 0, regimenLabel: activeRegimens[0]?.label });
    setError(null);
    setBatchWarning(null);
    try {
      const completed: { id: string; label: string; regimenLabel?: string; organism?: string | null; fit: MusycFitResult }[] = [];
      const failures: string[] = [];
      for (const regimen of activeRegimens) {
        const mapping = buildMapping(preview, roles, regimen.drugNames);
        if (!mapping) { failures.push(`${regimen.label}: invalid column mapping`); continue; }
        try {
          setMusycProgress({ phase: "reference", iteration: 0, objectiveFunction: Number.NaN, completedBootstraps: 0, totalBootstraps: musycModelSettings.bootstrapIterations ?? 0, regimenLabel: regimen.label });
          const onProgress = new Channel<MusycFitProgress>();
          onProgress.onmessage = (progress) => setMusycProgress({ ...progress, regimenLabel: regimen.label });
          const fitted = await invoke<MusycFitResult>("fit_musyc", { request: {
            import: importRequest,
            mapping,
            regimenDrugNames: regimen.drugNames,
            organism: regimen.organism,
            organismColumn: mappedOrganismColumn,
            settings: {
              blankValue: inputSettings.inputType === "count" ? 0 : inputSettings.blankValue,
              responseCensorLimit: usesResponseCensoring(inputSettings.inputType) ? musycModelSettings.responseCensorLimit : null,
            },
            maxIterations: musycModelSettings.maxIterations,
            bootstrapIterations: musycModelSettings.bootstrapIterations,
            bootstrapSeed: musycModelSettings.bootstrapSeed,
          }, onProgress });
          completed.push({ id: regimen.id, label: regimen.label, regimenLabel: regimenLabelOf(regimen), organism: regimen.organism, fit: fitted });
        } catch (reason) {
          failures.push(`${regimen.label}: ${errorMessage(reason)}`);
        }
      }
      if (!completed.length) throw new Error(`No regimens could be fitted. ${failures.join(" ")}`);
      setMusycFits(completed);
      if (failures.length) setBatchWarning(`${completed.length} regimen${completed.length === 1 ? " was" : "s were"} fitted. Skipped ${failures.length}: ${failures.join(" ")}`);
    } catch (reason) {
      setMusycFits([]);
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
      setMusycProgress(null);
    }
  }

  function updateDrusanoModelSettings(next: DrusanoModelSettings) {
    const runtimeOnlyChange = next.responseCensorLimit === drusanoModelSettings.responseCensorLimit
      && next.lambda === drusanoModelSettings.lambda
      && next.bootstrapIterations === drusanoModelSettings.bootstrapIterations
      && next.bootstrapSeed === drusanoModelSettings.bootstrapSeed
      && next.errorCoefficients.every((value, index) => value === drusanoModelSettings.errorCoefficients[index]);
    setDrusanoModelSettings(next);
    if (!runtimeOnlyChange) {
      setDrusanoFits([]);
      setDrusanoSimulations({});
    }
  }

  async function runDrusanoFit() {
    if (!preview || !importReady || !drusanoSettingsComplete) {
      setError("Complete the import, blank response, censor limit, and assay error model before fitting the model.");
      return;
    }
    setBusy(true);
    setError(null);
    setBatchWarning(null);
    setDrusanoProgress({ phase: "reference", cycle: 0, objectiveFunction: Number.NaN, completedBootstraps: 0, totalBootstraps: drusanoModelSettings.bootstrapIterations ?? 0, regimenLabel: activeRegimens[0]?.label });
    try {
      const completed: { id: string; label: string; regimenLabel?: string; organism?: string | null; fit: DrusanoFitResult }[] = [];
      const failures: string[] = [];
      for (const regimen of activeRegimens) {
        const mapping = buildMapping(preview, roles, regimen.drugNames);
        if (!mapping) { failures.push(`${regimen.label}: invalid column mapping`); continue; }
        try {
          setDrusanoProgress({ phase: "reference", cycle: 0, objectiveFunction: Number.NaN, completedBootstraps: 0, totalBootstraps: drusanoModelSettings.bootstrapIterations ?? 0, regimenLabel: regimen.label });
          const onProgress = new Channel<DrusanoFitProgress>();
          onProgress.onmessage = (progress) => setDrusanoProgress({ ...progress, regimenLabel: regimen.label });
          const fit = await invoke<DrusanoFitResult>("fit_drusano_greco", { request: {
            import: importRequest,
            mapping,
            regimenDrugNames: regimen.drugNames,
            organism: regimen.organism,
            organismColumn: mappedOrganismColumn,
            settings: {
              blankValue: inputSettings.inputType === "count" ? 0 : inputSettings.blankValue,
              responseCensorLimit: usesResponseCensoring(inputSettings.inputType) ? drusanoModelSettings.responseCensorLimit : null,
            },
            assayError: {
              coefficients: drusanoModelSettings.errorCoefficients as [number, number, number, number],
              lambda: drusanoModelSettings.lambda,
            },
            maxCycles: drusanoModelSettings.maxCycles,
            bootstrapIterations: drusanoModelSettings.bootstrapIterations,
            bootstrapSeed: drusanoModelSettings.bootstrapSeed,
          }, onProgress });
          completed.push({ id: regimen.id, label: regimen.label, regimenLabel: regimenLabelOf(regimen), organism: regimen.organism, fit });
        } catch (reason) {
          failures.push(`${regimen.label}: ${errorMessage(reason)}`);
        }
      }
      if (!completed.length) throw new Error(`No regimens could be fitted. ${failures.join(" ")}`);
      setDrusanoFits(completed);
      setDrusanoSimulations({});
      if (failures.length) setBatchWarning(`${completed.length} regimen${completed.length === 1 ? " was" : "s were"} fitted. Skipped ${failures.length}: ${failures.join(" ")}`);
    } catch (reason) {
      setDrusanoFits([]);
      setDrusanoSimulations({});
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
      setDrusanoProgress(null);
    }
  }

  async function continueDrusanoFit(id: string) {
    if (!preview || !drusanoSettingsComplete) return;
    const previous = drusanoFits.find((entry) => entry.id === id);
    const regimen = preview.regimens.find((entry) => entry.id === id);
    if (!previous || !regimen || previous.fit.converged || previous.fit.runCycles < previous.fit.maxCycles) return;
    const mapping = buildMapping(preview, roles, regimen.drugNames);
    if (!mapping) return;
    setBusy(true);
    setError(null);
    setDrusanoProgress({ phase: "reference", cycle: previous.fit.cycles, objectiveFunction: previous.fit.objectiveFunction, completedBootstraps: 0, totalBootstraps: drusanoModelSettings.bootstrapIterations ?? 0, regimenLabel: regimen.label });
    try {
      const onProgress = new Channel<DrusanoFitProgress>();
      onProgress.onmessage = (progress) => setDrusanoProgress({ ...progress, regimenLabel: regimen.label });
      const fit = await invoke<DrusanoFitResult>("fit_drusano_greco", { request: {
        import: importRequest,
        mapping,
        regimenDrugNames: regimen.drugNames,
        organism: regimen.organism,
        organismColumn: mappedOrganismColumn,
        settings: {
          blankValue: inputSettings.inputType === "count" ? 0 : inputSettings.blankValue,
          responseCensorLimit: usesResponseCensoring(inputSettings.inputType) ? drusanoModelSettings.responseCensorLimit : null,
        },
        assayError: {
          coefficients: previous.fit.assayError.coefficients,
          lambda: previous.fit.assayError.fittedLambda,
        },
        maxCycles: drusanoModelSettings.maxCycles,
        bootstrapIterations: drusanoModelSettings.bootstrapIterations,
        bootstrapSeed: drusanoModelSettings.bootstrapSeed,
        continuation: {
          supportPoints: [previous.fit.referenceSupportPoint],
          fittedLambda: previous.fit.assayError.fittedLambda,
          completedCycles: previous.fit.cycles,
        },
      }, onProgress });
      setDrusanoFits((current) => current.map((entry) => entry.id === id ? { ...entry, fit } : entry));
      setDrusanoSimulations((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
      setDrusanoProgress(null);
    }
  }

  async function runDrusanoRegimenSimulation(id: string, concentrations: number[]) {
    const entry = drusanoFits.find((candidate) => candidate.id === id);
    if (!entry) throw new Error("Select a completed NPAG fit before simulation.");
    setError(null);
    try {
      const result = await invoke<DrusanoRegimenSimulationResult>("simulate_drusano_regimen", { request: {
        drugNames: entry.fit.data.drugNames,
        parameterNames: entry.fit.parameterNames,
        supportPoints: entry.fit.supportPoints,
        maxConcentrations: entry.fit.data.maxConcentrations,
        concentrations,
        simulationCount: 1000,
        seed: 17,
      } });
      setDrusanoSimulations((current) => ({ ...current, [id]: result }));
      return result;
    } catch (reason) {
      setError(errorMessage(reason));
      throw reason;
    }
  }

  function updateDrusanoSimulationConcentrations(id: string, values: Array<number | null>) {
    const regimens = drusanoFits.map((entry) => ({ id: entry.id, drugNames: entry.fit.data.drugNames }));
    setDrusanoSimulationConcentrations((current) =>
      propagateSharedDrugConcentrations(current, regimens, id, values));
  }

  function setCurrentStratification(index: number) {
    const regimen = analysisRegimens.find((candidate) => candidate.analysis === analysis);
    if (!regimen || !regimen.analysis.drugNames[index]) return;
    setStratifyIndex(index);
    setStratificationOverrides((current) => ({ ...current, [regimen.id]: regimen.analysis.drugNames[index] }));
  }

  function toggleSharedStratification(drug: string, enabled: boolean) {
    const next = enabled
      ? [...sharedStratificationDrugs.filter((candidate) => candidate !== drug), drug]
      : sharedStratificationDrugs.filter((candidate) => candidate !== drug);
    setSharedStratificationDrugs(next);
    const regimen = analysisRegimens.find((candidate) => candidate.analysis === analysis);
    if (regimen && !stratificationOverrides[regimen.id]) {
      setStratifyIndex(stratificationIndexFor(regimen, stratificationOverrides, next));
    }
  }

  async function saveProjectSnapshot() {
    const path = await saveDialog({
      title: "Save Checkmate results",
      defaultPath: "checkmate-results.ckm",
      filters: [{ name: "Checkmate snapshot", extensions: ["ckm"] }],
    });
    if (!path) return;
    const snapshot: ProjectSnapshot = {
      schemaVersion: 1,
      savedAt: new Date().toISOString(),
      page, analysisType, inputSettings,
      drusanoFits, drusanoSimulations, drusanoSimulationConcentrations,
      drusanoModelSettings, drusanoCensorSuggestion, blissResponseCensorLimit,
      diamondRegimens, diamondComparisonRegimens, selectedDiamondId, diamondToleranceLog2,
      musycFits, musycModelSettings,
      tab, importRequest, worksheets, preview, roles, analysis,
      stratifyIndex, stratificationOverrides, sharedStratificationDrugs,
      baselineCorrection, bootstrapIterations, randomSeed, showConfidenceIntervals,
      micZeroTolerance, drugMicValues, drugMicSuggestions, micEstimatesByRegimen,
      drugConcentrationRanges, responseTypes, selectedImportRegimenId,
      selectedImportRegimenKeys, selectedImportOrganisms, resultOrder, comparisonGrouping,
      analysisRegimens,
      colors, comparisonRegimens, comparisonIncludedIds, comparisonSettings,
    };
    setError(null);
    setProjectNotice(null);
    try {
      await invoke("save_project_snapshot", { path: String(path), snapshotJson: JSON.stringify(snapshot) });
      setProjectNotice(`Saved compressed results to ${String(path)}.`);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function loadProjectSnapshot() {
    const selected = await open({
      multiple: false,
      directory: false,
      title: "Load Checkmate results",
      filters: [{ name: "Checkmate snapshot", extensions: ["ckm"] }],
    });
    if (!selected) return;
    setError(null);
    setProjectNotice(null);
    try {
      const snapshot = JSON.parse(await invoke<string>("load_project_snapshot", { path: String(selected) })) as ProjectSnapshot;
      if (snapshot.schemaVersion !== 1 || !snapshot.analysisType || !Array.isArray(snapshot.roles)
        || !Array.isArray(snapshot.drusanoFits) || !Array.isArray(snapshot.musycFits)) {
        throw new Error("This file is not a supported Checkmate results snapshot.");
      }
      setRestoredSnapshot(true);
      setAnalysisType(snapshot.analysisType);
      const restoredInputType = (snapshot.inputSettings.inputType as string) === "cfu"
        ? "count"
        : snapshot.inputSettings.inputType;
      setInputSettings(restoredInputType === "count"
        ? { ...snapshot.inputSettings, inputType: "count", blankAdjustment: false, blankValue: 0 }
        : snapshot.inputSettings);
      setDrusanoFits(snapshot.drusanoFits);
      setDrusanoSimulations(snapshot.drusanoSimulations);
      setDrusanoSimulationConcentrations(snapshot.drusanoSimulationConcentrations);
      setDrusanoModelSettings(snapshot.drusanoModelSettings);
      setDrusanoCensorSuggestion(snapshot.drusanoCensorSuggestion);
      setBlissResponseCensorLimit(snapshot.blissResponseCensorLimit ?? null);
      setDiamondRegimens(snapshot.diamondRegimens ?? []);
      setDiamondComparisonRegimens(snapshot.diamondComparisonRegimens ?? snapshot.diamondRegimens ?? []);
      setSelectedDiamondId(snapshot.selectedDiamondId ?? snapshot.diamondRegimens?.[0]?.id ?? null);
      setDiamondToleranceLog2(snapshot.diamondToleranceLog2 ?? 0.5);
      setMusycFits(snapshot.musycFits);
      setMusycModelSettings(snapshot.musycModelSettings);
      setTab(snapshot.tab);
      setImportRequest(snapshot.importRequest);
      setWorksheets(snapshot.worksheets);
      setPreview(snapshot.preview);
      setRoles(snapshot.roles);
      setAnalysis(snapshot.analysis);
      setStratifyIndex(snapshot.stratifyIndex);
      setStratificationOverrides(snapshot.stratificationOverrides);
      setSharedStratificationDrugs(snapshot.sharedStratificationDrugs);
      setBaselineCorrection(snapshot.baselineCorrection);
      setBootstrapIterations(snapshot.bootstrapIterations);
      setRandomSeed(snapshot.randomSeed);
      setShowConfidenceIntervals(snapshot.showConfidenceIntervals);
      setMicZeroTolerance(snapshot.micZeroTolerance);
      setDrugMicValues(snapshot.drugMicValues);
      setDrugMicSuggestions(snapshot.drugMicSuggestions);
      setMicEstimatesByRegimen(snapshot.micEstimatesByRegimen);
      setDrugConcentrationRanges(snapshot.drugConcentrationRanges ?? Object.fromEntries(
        Object.entries(snapshot.drugClinicalValues ?? {}).map(([drug, target]) => [drug, target == null
          ? { minimum: null, maximum: null }
          : { minimum: target / 4, maximum: target * 4 }]),
      ));
      setResponseTypes(snapshot.responseTypes);
      setSelectedImportRegimenId(snapshot.selectedImportRegimenId);
      setSelectedImportRegimenKeys(snapshot.selectedImportRegimenKeys
        ?? [...new Set((snapshot.preview?.regimens ?? []).map(regimenKeyOf))]);
      setSelectedImportOrganisms(snapshot.selectedImportOrganisms
        ?? [...new Set((snapshot.preview?.regimens ?? []).map((regimen) => organismKey(regimen.organism)))]);
      setResultOrder(snapshot.resultOrder ?? "organism");
      setComparisonGrouping(snapshot.comparisonGrouping ?? "organism");
      setAnalysisRegimens(snapshot.analysisRegimens);
      setColors(snapshot.colors);
      setComparisonRegimens(snapshot.comparisonRegimens);
      setComparisonIncludedIds(snapshot.comparisonIncludedIds);
      setComparisonSettings(snapshot.comparisonSettings);
      setBusy(false);
      setAnalysisProgress(null);
      setDrusanoProgress(null);
      setMusycProgress(null);
      setBatchWarning(null);
      setPage(snapshot.page);
      setProjectNotice(`Loaded saved results from ${String(selected)}.`);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function quitApplication() {
    try {
      await invoke("quit_application");
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <img className="brand-mark" src={logo} alt="Pmetrics logo" />
          <span>Checkmate <small>v{appBuild}</small></span>
        </div>
        <nav aria-label="Primary navigation">
          <button className={page === "project" ? "nav-active" : ""} onClick={() => setPage("project")}>Algorithm</button>
          <button className={page === "import" ? "nav-active" : ""} onClick={() => setPage("import")}>
            Import
          </button>
          {micAnalysis && <button
            className={page === "mic" ? "nav-active" : page === "import" && importReady ? "nav-ready" : ""}
            disabled={!importReady}
            onClick={() => setPage("mic")}
          >
            MIC
          </button>}
          <button
            className={page === "analyze" ? "nav-active" : ""}
            disabled={micAnalysis ? !micComplete : !importReady}
            onClick={() => setPage("analyze")}
          >
            {micAnalysis ? "Analyze" : "Fit"}
          </button>
          {analysisType === "drusanoGreco" && <button className={page === "regimen" ? "nav-active" : ""} disabled={drusanoFits.length === 0} onClick={() => setPage("regimen")}>Simulate</button>}
          {micAnalysis && <button className={page === "results" ? "nav-active" : ""} disabled={!resultsReady} onClick={() => setPage("results")}>Results</button>}
          {analysisType === "drusanoGreco"
            ? <button className={page === "compare" ? "nav-active" : ""} disabled={drusanoComparisonEntries.length < 2} onClick={() => setPage("compare")}>Compare{drusanoComparisonEntries.length >= 2 ? ` (${drusanoComparisonEntries.length})` : ""}</button>
            : analysisType === "musyc"
              ? <button className={page === "compare" ? "nav-active" : ""} disabled={musycFits.length < 2} onClick={() => setPage("compare")}>Compare{musycFits.length >= 2 ? ` (${musycFits.length})` : ""}</button>
              : showCompare && <button className={page === "compare" ? "nav-active" : ""} onClick={() => setPage("compare")}>Compare ({analysisType === "diamond" ? diamondComparisonRegimens.length : comparisonRegimens.length})</button>}
        </nav>
        <div className="header-actions">
          {preview && <label className="header-order-control">Results order<select value={resultOrder} onChange={(event) => setResultOrder(event.target.value as ResultOrder)}><option value="organism">Organism</option><option value="regimen">Regimen</option></select></label>}
          <button className="instructions-button" disabled={busy} onClick={saveProjectSnapshot}>Save</button>
          <button className="instructions-button" disabled={busy} onClick={loadProjectSnapshot}>Load</button>
          <button className="instructions-button" onClick={() => setShowInstructions(true)}>Instructions</button>
          <button className="quit-button" onClick={quitApplication}>Quit</button>
        </div>
      </header>

      {showInstructions && <InstructionsModal analysisType={analysisType} close={() => setShowInstructions(false)} />}

      {error && (
        <div className="global-error" role="alert">
          <strong>Could not continue.</strong> {error}
          <button aria-label="Dismiss error" onClick={() => setError(null)}>×</button>
        </div>
      )}
      {batchWarning && (
        <div className="global-warning" role="status">
          <strong>Completed with skipped regimens.</strong> {batchWarning}
          <button aria-label="Dismiss warning" onClick={() => setBatchWarning(null)}>×</button>
        </div>
      )}
      {projectNotice && (
        <div className="global-notice" role="status">
          {projectNotice}
          <button aria-label="Dismiss notice" onClick={() => setProjectNotice(null)}>×</button>
        </div>
      )}

      {page === "project" ? (
        <ProjectWorkspace analysisType={analysisType} setAnalysisType={changeAnalysisType} />
      ) : page === "import" ? (
        <main className="workspace import-workspace">
          <aside className="sidebar">
            <section>
              <label>Input file</label>
              <button className="primary-button full-width" onClick={chooseFile} disabled={busy}>
                Choose data file…
              </button>
              <p className="file-path" title={importRequest.path}>
                {importRequest.path || "No file selected"}
              </p>
            </section>

            {worksheets.length > 0 && (
              <label>
                Worksheet
                <select
                  value={importRequest.worksheet ?? ""}
                  onChange={(event) => updateRange("worksheet", event.target.value)}
                >
                  {worksheets.map((sheet) => <option key={sheet}>{sheet}</option>)}
                </select>
              </label>
            )}

            <div className="range-grid">
              <NumberField label="Start row" value={importRequest.startRow} min={1} onChange={(value) => updateRange("startRow", value)} />
              <NumberField label="Start column" value={importRequest.startColumn} min={1} onChange={(value) => updateRange("startColumn", value)} />
              <NumberField label="Rows to read" value={importRequest.rowLimit} min={0} zeroLabel="All" onChange={(value) => updateRange("rowLimit", value)} />
              <NumberField label="Columns to read" value={importRequest.columnLimit} min={0} zeroLabel="All" onChange={(value) => updateRange("columnLimit", value)} />
            </div>
            <p className="help-text">“All” reads every remaining row or column. The start row is the header row.</p>
            <InputTypeControls settings={inputSettings} setSettings={updateInputSettings} analysisType={analysisType} />
            <button className="secondary-button full-width" disabled={!importRequest.path || busy} onClick={() => loadPreview()}>
              {busy ? "Reading…" : "Refresh selected range"}
            </button>
          </aside>

          <section className="content-card mapping-card">
            <div className="card-heading">
              <div>
                <h1>Selected range and column assignments</h1>
                <p>Assign concentration and response roles. Drug names and units may come from separate columns or be inferred from headers such as “Amikacin (mg/L)”; every suggestion can be overridden.</p>
              </div>
              {preview && <span className="count-badge">{selectedImportRegimen?.totalRows ?? preview.totalRows} rows × {preview.totalColumns} columns</span>}
            </div>

            {!preview ? (
              <EmptyState busy={busy} />
            ) : (
              <>
                {preview.regimens.length > 1 && selectedImportRegimen && (
                  <RegimenNavigator
                    regimens={preview.regimens}
                    selectedId={selectedImportRegimen.id}
                    onSelect={selectImportRegimen}
                  />
                )}
                <section className="import-scope-panel">
                  <div><h2>Analyze imported data</h2><span className="count-badge">{activeRegimens.length} of {preview.regimens.length} analysis sets selected</span></div>
                  <p className="help-text">Select any combination of regimens and organisms. Each selected organism–regimen pair is analyzed separately.</p>
                  <label className="compact-setting">Order results by<select value={resultOrder} onChange={(event) => setResultOrder(event.target.value as ResultOrder)}><option value="organism">Organism, then regimen</option><option value="regimen">Regimen, then organism</option></select></label>
                  <div className="import-scope-grid">
                    <fieldset><legend>Regimens</legend>
                      <label className="include-control"><input type="checkbox" checked={selectedImportRegimenKeys.length === importedRegimenOptions.length} onChange={(event) => updateImportScope(event.target.checked ? importedRegimenOptions.map((item) => item.key) : [], selectedImportOrganisms)} />All regimens</label>
                      {importedRegimenOptions.map((item) => <label className="include-control" key={item.key}><input type="checkbox" checked={selectedImportRegimenKeys.includes(item.key)} onChange={(event) => updateImportScope(event.target.checked ? [...selectedImportRegimenKeys, item.key] : selectedImportRegimenKeys.filter((key) => key !== item.key), selectedImportOrganisms)} />{item.label}</label>)}
                    </fieldset>
                    <fieldset><legend>Organisms</legend>
                      <label className="include-control"><input type="checkbox" checked={selectedImportOrganisms.length === importedOrganismOptions.length} onChange={(event) => updateImportScope(selectedImportRegimenKeys, event.target.checked ? importedOrganismOptions.map((item) => item.key) : [])} />All organisms</label>
                      {importedOrganismOptions.map((item) => <label className="include-control" key={item.key}><input type="checkbox" checked={selectedImportOrganisms.includes(item.key)} onChange={(event) => updateImportScope(selectedImportRegimenKeys, event.target.checked ? [...selectedImportOrganisms, item.key] : selectedImportOrganisms.filter((key) => key !== item.key))} />{item.label}</label>)}
                    </fieldset>
                  </div>
                </section>
                <div className="mapping-table-wrap">
                  <table className="mapping-table">
                    <thead>
                      <tr className="assignment-row">
                        <th>Assign</th>
                        {preview.headers.map((header, index) => (
                          <th key={`${header}-${index}`}>
                            <select
                              aria-label={`Role for ${header}`}
                              value={roles[index] ?? "ignore"}
                              onChange={(event) => updateColumnRole(index, event.target.value as ColumnRole)}
                            >
                              {roleOptions.map((role) => <option value={role} key={role}>{roleLabel(role)}</option>)}
                            </select>
                          </th>
                        ))}
                      </tr>
                      <tr>
                        <th>Row</th>
                        {preview.headers.map((header, index) => <th key={`${header}-${index}`}>{header}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {(selectedImportRegimen?.rows ?? preview.rows).map((row, rowIndex) => (
                        <tr key={rowIndex}>
                          <td className="row-number">{rowIndex + 1}</td>
                          {preview.headers.map((_, columnIndex) => {
                            const value = row[columnIndex];
                            return (
                              <td title={value ?? ""} key={columnIndex}>{displayCell(value)}</td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className={mappingErrors.length || !inputSettings.inputType || activeRegimens.length === 0 ? "mapping-status warning" : "mapping-status ready"}>
                  {mappingErrors.length ? mappingErrors.join(" ") : !inputSettings.inputType ? "Choose the input response type to complete import." : activeRegimens.length === 0 ? "Select at least one regimen and one organism for analysis." : !micAnalysis ? "Import, selection, and mapping are complete. Continue to the Fit tab." : "Import, selection, and mapping are complete. Continue to the MIC tab."}
                </div>
              </>
            )}
          </section>
        </main>
      ) : page === "mic" ? (
        <MicWorkspace
          assignments={micAssignments}
          values={drugMicValues}
          suggestions={drugMicSuggestions}
          setValue={(key, value) => {
            setDrugMicValues((current) => ({ ...current, [key]: value }));
          }}
          zeroTolerance={micZeroTolerance}
          setZeroTolerance={(value) => { setRestoredSnapshot(false); setMicZeroTolerance(value); }}
          busy={micBusy}
          error={micError}
          complete={micComplete}
          diamond={analysisType === "diamond"}
        />
      ) : page === "analyze" ? (
        analysisType === "drusanoGreco" ? <DrusanoFitWorkspace
          fits={orderedDrusanoFits}
          busy={busy}
          progress={drusanoProgress}
          fit={runDrusanoFit}
          continueFit={continueDrusanoFit}
          inputType={inputSettings.inputType}
          settings={drusanoModelSettings}
          setSettings={updateDrusanoModelSettings}
          suggestion={drusanoCensorSuggestion}
          suggestionBusy={drusanoSuggestionBusy}
          suggestionError={drusanoSuggestionError}
          settingsComplete={drusanoSettingsComplete}
          regimens={preview?.regimens ?? []}
        /> : analysisType === "musyc" ? <MusycFitWorkspace
          fits={orderedMusycFits}
          busy={busy}
          progress={musycProgress}
          fit={runMusycFit}
          inputType={inputSettings.inputType}
          settings={musycModelSettings}
          setSettings={updateMusycModelSettings}
          suggestion={drusanoCensorSuggestion}
          suggestionBusy={drusanoSuggestionBusy}
          suggestionError={drusanoSuggestionError}
          settingsComplete={musycSettingsComplete}
          regimens={preview?.regimens ?? []}
        /> : analysisType === "diamond" ? <DiamondSetupWorkspace
          inputType={inputSettings.inputType}
          responseCensorLimit={blissResponseCensorLimit}
          setResponseCensorLimit={setBlissResponseCensorLimit}
          bootstrapIterations={bootstrapIterations}
          setBootstrapIterations={setBootstrapIterations}
          randomSeed={randomSeed}
          setRandomSeed={setRandomSeed}
          diagonalToleranceLog2={diamondToleranceLog2}
          setDiagonalToleranceLog2={setDiamondToleranceLog2}
          calculate={runDiamondAnalysis}
          busy={busy}
          progress={analysisProgress}
          settingsComplete={diamondSettingsComplete}
        /> : <AnalyzeSetupWorkspace
          drugs={uploadedDrugs}
          concentrationRanges={drugConcentrationRanges}
          setConcentrationRange={(drug, range) => setDrugConcentrationRanges((current) => ({ ...current, [drug]: range }))}
          baselineCorrection={baselineCorrection}
          setBaselineCorrection={setBaselineCorrection}
          inputType={inputSettings.inputType}
          responseCensorLimit={blissResponseCensorLimit}
          setResponseCensorLimit={setBlissResponseCensorLimit}
          suggestion={drusanoCensorSuggestion}
          suggestionBusy={drusanoSuggestionBusy}
          suggestionError={drusanoSuggestionError}
          settingsComplete={blissSettingsComplete}
          bootstrapIterations={bootstrapIterations}
          setBootstrapIterations={setBootstrapIterations}
          randomSeed={randomSeed}
          setRandomSeed={setRandomSeed}
          calculate={runAnalysis}
          busy={busy}
          progress={analysisProgress}
          currentRegimen={currentBootstrapRegimen}
        />
      ) : page === "regimen" ? (
        <DrusanoRegimenWorkspace
          fits={orderedDrusanoFits}
          regimens={preview?.regimens ?? []}
          simulations={drusanoSimulations}
          concentrationValues={drusanoSimulationConcentrations}
          setConcentrationValues={updateDrusanoSimulationConcentrations}
          simulate={runDrusanoRegimenSimulation}
        />
      ) : page === "results" ? (
        analysisType === "diamond" && selectedDiamond ? <DiamondResultsWorkspace
          entries={orderedDiamondRegimens}
          selected={selectedDiamond}
          select={(entry) => setSelectedDiamondId(entry.id)}
          returnToAnalyze={() => setPage("analyze")}
        /> : <AnalysisWorkspace
          analysis={analysis!}
          tab={tab}
          setTab={setTab}
          stratifyIndex={stratifyIndex}
          setStratifyIndex={setCurrentStratification}
          sharedStratificationDrugs={sharedStratificationDrugs}
          toggleSharedStratification={toggleSharedStratification}
          colors={colors}
          setColors={setColors}
          showConfidenceIntervals={showConfidenceIntervals}
          setShowConfidenceIntervals={setShowConfidenceIntervals}
          regimens={orderedAnalysisRegimens}
          selectRegimen={selectAnalyzedRegimen}
          returnToAnalyze={() => setPage("analyze")}
        />
      ) : (
        analysisType === "drusanoGreco" ? <DrusanoComparisonWorkspace entries={drusanoComparisonEntries} grouping={comparisonGrouping} setGrouping={setComparisonGrouping} />
          : analysisType === "musyc" ? <MusycComparisonWorkspace fits={orderedMusycFits} grouping={comparisonGrouping} setGrouping={setComparisonGrouping} />
          : analysisType === "diamond" ? <DiamondComparisonWorkspace entries={orderedDiamondComparisons} grouping={comparisonGrouping} setGrouping={setComparisonGrouping} importAnother={() => setPage("import")} />
          : <ComparisonWorkspace
          regimens={comparisonRegimens}
          includedIds={comparisonIncludedIds}
          setIncludedIds={setComparisonIncludedIds}
          settings={comparisonSettings}
          setSettings={setComparisonSettings}
          grouping={comparisonGrouping}
          setGrouping={setComparisonGrouping}
          importAnother={() => setPage("import")}
        />
      )}
    </div>
  );
}

function InstructionsModal({ analysisType, close }: { analysisType: AnalysisType; close: () => void }) {
  const workflowSteps = analysisType === "drusanoGreco"
    ? [["1", "Algorithm", "Choose the analysis framework"], ["2", "Import", "Choose data, input type, and mapping"], ["3", "Fit", "Fit Equation 2 and review diagnostics"], ["4", "Simulate", "Simulate constant concentrations"], ["5", "Compare", "Rank simulated efficacy"]]
    : analysisType === "musyc"
      ? [["1", "Algorithm", "Choose the analysis framework"], ["2", "Import", "Choose data, input type, and mapping"], ["3", "Fit", "Fit and bootstrap MuSyC"], ["4", "Compare", "Rank bootstrap efficacy"]]
    : [["1", "Algorithm", "Choose the analysis framework"], ["2", "Import", "Choose data, input type, and mapping"], ["3", "MIC", "Review suggested MICs"], ["4", "Analyze", "Choose policy and calculate"], ["5", "Results", "Inspect tables and plots"], ["6", "Compare", "Rank multiple regimens"]];
  return (
    <div className="instructions-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className="instructions-modal" role="dialog" aria-modal="true" aria-labelledby="instructions-title">
        <header className="instructions-header">
          <div><h1 id="instructions-title">Checkmate instructions</h1><p>Prepare and analyze two- and three-drug assays with Bliss, DiaMOND, Drusano–Greco, or MuSyC.</p></div>
          <button className="instructions-close-icon" aria-label="Close instructions" autoFocus onClick={close}>×</button>
        </header>
        <div className="instructions-layout">
          <nav className="instructions-index" aria-label="Instruction sections">
            <strong>Contents</strong>
            <a href="#instructions-workflow">Workflow</a>
            <a href="#instructions-data">Data format</a>
            <a href="#instructions-import">Import</a>
            {analysisType === "bliss" || analysisType === "diamond" ? <>
              <a href="#instructions-mic">MIC</a>
              <a href={analysisType === "diamond" ? "#instructions-diamond" : "#instructions-analyze"}>Analyze</a>
              <a href="#instructions-results">Results</a>
              <a href="#instructions-compare">Compare</a>
            </> : analysisType === "musyc" ? <a href="#instructions-musyc">MuSyC fit</a> : <a href="#instructions-drusano">Fit, simulate, and compare</a>}
            <a href="#instructions-troubleshooting">Troubleshooting</a>
            <p>Press Esc or use either Close button to exit.</p>
          </nav>
          <article className="instructions-content">
            <section id="instructions-workflow">
              <h2>Workflow at a glance</h2>
              <p>Complete the tabs from left to right. A tab becomes available only after the preceding information is valid.</p>
              <div className="instruction-workflow-preview" aria-label="Application workflow preview">
                {workflowSteps.map(([number, title, detail]) => <div key={number}><i>{number}</i><strong>{title}</strong><span>{detail}</span></div>)}
              </div>
              <p className="instruction-note">Compare is available when at least two eligible regimen results are available; for Drusano–Greco, that means two current simulations.</p>
              <p className="instruction-note"><strong>Save and Load:</strong> Save writes a compact binary <code>.ckm</code> snapshot containing the imported state, settings, fitted results, bootstrap summaries, and simulations. Load restores that state without rerunning fits or simulations and does not require the original data file.</p>
            </section>

            <section id="instructions-data">
              <h2>Data format</h2>
              <p>Use CSV, TXT, XLS, or XLSX. Column order and spacing in column names do not matter. Each row represents one observed well or replicate.</p>
              <div className="result-table-wrap"><table className="result-table instruction-data-table">
                <thead><tr><th>Column</th><th>Status</th><th>Contents</th></tr></thead>
                <tbody>
                  <tr><td>Drug A, Drug B</td><td>Optional metadata</td><td>Drug names repeated on every row, or inferred from concentration headers such as “Amikacin (mg/L)”.</td></tr>
                  <tr><td>Conc A, Conc B</td><td>Required</td><td>Numeric concentrations; use 0 for untreated or absent drug.</td></tr>
                  <tr><td>Units A, Units B</td><td>Optional metadata</td><td>Separate unit columns, or units inferred from concentration headers; keep units consistent within each regimen.</td></tr>
                  <tr><td>Drug C, Conc C, Units C</td><td>Optional</td><td>For three-drug assays. Conc C is required when Drug C or Units C is assigned.</td></tr>
                  <tr><td>Response</td><td>Required</td><td>Absorbance, fluorescence, count, or percent/fractional viability or inhibition, matching the selected input policy.</td></tr>
                </tbody>
              </table></div>
              <ul>
                <li>Unique ordered combinations of Drug A, Drug B, and Drug C are assigned numerical regimen IDs automatically.</li>
                <li>Include untreated controls and the single-agent wells needed for Bliss and MIC inference. Do not silently fill missing wells.</li>
                <li>Choose absorbance, fluorescence, or Count explicitly. Count inputs do not use blank adjustment; reported values of 0 or 1 are treated as censored.</li>
              </ul>
            </section>

            <section id="instructions-import">
              <h2>2. Import and map columns</h2>
              <div className="instruction-split">
                <div>
                  <ol>
                    <li>Select <strong>Choose data file…</strong>. For workbooks, choose the worksheet.</li>
                    <li>Adjust the starting row/column or limits if needed. <strong>All</strong> reads every remaining row or column.</li>
                    <li>Confirm Conc A/B/C and Response assignments. Drug names and units may be mapped from separate columns or inferred from concentration headers.</li>
                    <li>For multiple regimens, use the previous/next controls or regimen menu to inspect each preview.</li>
                    <li>Choose the input type. For absorbance or fluorescence, enter 0 when responses are already blank-adjusted or enter the assay blank on the imported response scale. For control-normalized viability, the all-zero drug controls automatically distinguish fractional values near 1 from percentages near 100.</li>
                  </ol>
                  <p>{analysisType === "bliss" || analysisType === "diamond" ? "The MIC tab activates only when the import and mapping are valid for every regimen." : "The Fit tab activates when the import and mapping are valid for every regimen."}</p>
                </div>
                <div className="instruction-ui-preview mapping-preview" aria-label="Import mapping interface preview">
                  <div className="preview-title">Selected range and column assignments</div>
                  <div className="preview-regimen">‹ <strong>1 — DETA + CFZ + AMK</strong> ›</div>
                  <div className="preview-mapping-row"><span>Drug A</span><span>Drug B</span><span>Drug C</span><span>Conc A</span><span>Response</span></div>
                  <div className="preview-data-row"><span>DETA</span><span>CFZ</span><span>AMK</span><span>1000</span><span>0.84</span></div>
                  <div className="preview-ready">Import and mapping are complete.</div>
                </div>
              </div>
            </section>

            <section id="instructions-mic">
              <h2>3. Assign MICs</h2>
              <p>This tab is used by Bliss and DiaMOND. For Bliss, values are MICs used for normalized comparison coordinates. For DiaMOND, they are dose-centering anchors—normally IC90, or the common MIC/IC reference used to prepare the assay. Drusano–Greco and MuSyC derive their concentration scales from tested maxima.</p>
              <ul>
                <li>Enter one finite positive MIC for every organism–drug pair. Suggested values may be overwritten independently for each organism.</li>
                <li><strong>MIC zero tolerance</strong> defines how close a single-agent response must be to zero viability for automatic inference.</li>
                <li>The green completion message indicates that Analyze is ready.</li>
              </ul>
            </section>

            <section id="instructions-analyze">
              <h2>4. Configure and calculate Bliss</h2>
              <div className="instruction-split">
                <div>
                  <h3>Analysis concentration ranges</h3>
                  <p>Enter an optional minimum and maximum concentration for each drug. Blank bounds are unrestricted; supplied bounds limit eligible positive doses in every regimen containing that drug.</p>
                  <h3>Analysis options</h3>
                  <ul>
                    <li><strong>Response censoring:</strong> For absorbance and count inputs, responses at or below L use L before blank and growth-control normalization. The data suggestion uses the same lower-response analysis as Drusano–Greco and MuSyC.</li>
                    <li><strong>Baseline correction:</strong> None, Part (negative inhibition values only), or All values. All is the default.</li>
                    <li><strong>Bootstrap iterations:</strong> The number of simulated Bliss surfaces used to estimate uncertainty. More iterations improve stability but take longer.</li>
                    <li><strong>Random seed:</strong> Initializes the simulation so unchanged data, settings, iteration count, and seed reproduce the same result.</li>
                  </ul>
                  <p>Select <strong>Calculate Bliss</strong>. Progress identifies both the regimen and completed replicates. A failing regimen is skipped and reported without discarding successful analyses.</p>
                </div>
                <div className="instruction-ui-preview clinical-preview" aria-label="Analysis concentration range interface preview">
                  <div className="preview-title">Analysis concentration ranges</div>
                  <div className="preview-table-head"><span>Drug</span><span>Units</span><span>Range</span></div>
                  <div><span>DETA</span><span>mM</span><span className="preview-input">Unrestricted</span></div>
                  <div><span>CFZ</span><span>µg/mL</span><span className="preview-input">Unrestricted</span></div>
                  <div><span>AMK</span><span>µg/mL</span><span className="preview-input selected">1–16</span></div>
                  <span className="preview-button">Calculate Bliss</span>
                  <small>Bootstrapping 1 — DETA + CFZ + AMK</small>
                </div>
              </div>
              <div className="instruction-method-grid">
                <section>
                  <h3>How bootstrapping works</h3>
                  <p>The app groups replicate wells at each dose location and calculates their observed mean and sample standard deviation. On each iteration it draws normally distributed pseudo-replicates independently at every location, averages them, applies the selected baseline correction, and recalculates the complete Bliss surface.</p>
                  <p>The resulting collection of surfaces supplies the cellwise empirical 95% confidence intervals and the replicate-based uncertainty used for summary statistics and p values. It does not add experimental replicates or replace biological replication.</p>
                  <ul>
                    <li><strong>Iterations:</strong> Use a small number for a quick exploratory run. For final reporting, 1,000 or more is a reasonable starting point; increase it if confidence limits or p values change materially between runs.</li>
                    <li><strong>Seed:</strong> Keep one documented seed for a planned analysis and use the same seed and iteration count across regimens being compared. Changing the seed produces another valid simulation sample and may slightly change uncertainty estimates.</li>
                    <li><strong>No replicate wells:</strong> When no dose location is replicated, the app calculates one deterministic Bliss surface. Increasing iterations cannot estimate replicate uncertainty, so bootstrap confidence intervals are unavailable.</li>
                  </ul>
                </section>
                <section>
                  <h3>What baseline correction does</h3>
                  <p>Response censoring and synergy baseline correction are separate. Censoring applies a lower measurement boundary before normalization; baseline correction acts afterward on the normalized inhibition surface.</p>
                  <p>Correction is applied after responses are converted to percent inhibition. The app fits each single-agent dilution series, finds the lowest fitted response baseline, and adjusts an inhibition value <em>y</em> by subtracting <code>((100 − y) / 100) × fitted baseline</code>. The corrected single-agent and combination responses are then used to calculate Bliss interactions.</p>
                  <div className="result-table-wrap"><table className="result-table correction-guide-table">
                    <thead><tr><th>Choice</th><th>Application and guidance</th></tr></thead>
                    <tbody>
                      <tr><td><strong>Part</strong><br />(negative only)</td><td>Adjusts only inhibition values below zero; nonnegative values are unchanged. Prefer this minimally invasive option when small negative values appear to be background or assay noise but the rest of the response scale is already well calibrated.</td></tr>
                      <tr><td><strong>All</strong></td><td>Applies the fitted-baseline adjustment to every inhibition value. Prefer it when single-agent curves indicate a systematic baseline offset affecting the full response range, or when following the full SynergyFinder+ correction consistently. This is the app default.</td></tr>
                      <tr><td><strong>None</strong></td><td>Leaves converted inhibition values unchanged. Use when the uploaded responses were already appropriately baseline-corrected, or for a deliberate uncorrected sensitivity analysis.</td></tr>
                    </tbody>
                  </table></div>
                  <p className="instruction-note"><strong>Best practice:</strong> Choose the correction from assay quality-control evidence before reviewing synergy results, use one policy across regimens intended for comparison, and compare Part with All as a sensitivity analysis when the choice is uncertain. A correction should not be used to conceal failed controls, extreme outliers, or poor dose-response fits.</p>
                </section>
              </div>
            </section>

            <section id="instructions-diamond">
              <h2>4. Configure and calculate DiaMOND</h2>
              <p>DiaMOND uses the same imported rows as the other pathways, but fits only untreated controls, single-agent dose responses, and equipotent combination diagonals. It never fills missing doses or uses off-diagonal wells in a fit.</p>
              <ul>
                <li>Lay out each drug on the same dose-position scale by centering its single-agent series at a shared endpoint, normally IC90. Enter those centering concentrations as the dose anchors.</li>
                <li>At a combination position, each active drug must have the same concentration divided by its anchor. The diagonal tolerance accommodates small dispensing/rounding differences.</li>
                <li>A native three-parameter Hill curve yields IC50 and IC90. The Loewe expectation is the harmonic intersection of component ICs; observed dose divided by expected dose is FIC.</li>
                <li>FIC below 1 is synergistic, FIC above 1 is antagonistic, and FIC equal to 1 is additive. When a bootstrap 95% confidence interval is available, an interval spanning 1 is labeled additive.</li>
                <li>FIC50 is the primary DiaMOND display and comparison result; FIC90 remains available as a secondary, more stringent endpoint. The DiaMOND plots toggle switches the geometry, relative-dose response, full-checkerboard contour, equipotent-ray intersection, and sidebar isobole comparison together.</li>
                <li>Three-drug results retain all available pairwise diagonal scores and report an emergent three-drug score when all three pairwise curves are present.</li>
              </ul>
            </section>

            <section id="instructions-musyc">
              <h2>3. MuSyC surface fit</h2>
              <p>MuSyC fits a four-state, two-drug equilibrium surface to normalized inhibition. The untreated state E₀ is fixed at 0 by growth-control normalization; E₁ and E₂ are the monotherapy efficacies, and E₃ is the asymptotic combination-state efficacy.</p>
              <ul>
                <li>C₁ and C₂ are monotherapy EC50 values. They are fitted as fractions of the maximum tested concentrations and reported in the imported concentration units.</li>
                <li>α₁₂ is the fold change in drug 2 potency induced by drug 1; α₂₁ is the converse. Values above 1 indicate potency synergy and values below 1 indicate potency antagonism.</li>
                <li>γ₁₂ and γ₂₁ are directional fold changes in Hill cooperativity. A value of 1 means no cooperativity interaction.</li>
                <li>On Checkmate's increasing-inhibition scale, <code>β = (E3 − max(E1,E2)) / max(E1,E2)</code>. Positive β denotes efficacy synergy. Compare can rank multiple fitted regimens by bootstrap median β or E₃ so relative synergy and absolute combination efficacy can be considered together.</li>
                <li>For absorbance data, wells at or below L are retained with a one-sided constraint, observed <code>E ≥ E_L</code>.</li>
                <li>After the reference surface fit, a fixed-dose-grid parametric bootstrap generates synthetic normalized effects using the residual SD from uncensored wells, reapplies the absorbance censor boundary, and refits each synthetic dataset. Fit reports percentile confidence intervals; Compare ranks regimens by bootstrap median β or E₃.</li>
              </ul>
            </section>

            <section id="instructions-drusano">
              <h2>3. Drusano–Greco Equation 2 fit</h2>
              <p>This workflow currently supports two-drug checkerboards. For absorbance or fluorescence, supply the assay blank on the same scale as the imported response. Count inputs do not use blank adjustment.</p>
              <ul>
                <li>The mean of all untreated wells is the growth control. Effect is calculated as <code>E = 1 − (observation − blank) / (mean growth control − blank)</code>.</li>
                <li>Each concentration is divided by that drug’s maximum tested concentration in the imported regimen. All eligible drug-exposed wells, including monotherapy and combination wells, contribute to one joint seven-parameter reference fit.</li>
                <li>Growth controls define normalization and are not fit subjects. For absorbance, the Fit tab suggests a censor limit from a sharp lower-tail frequency drop. For Count, it suggests a limit immediately below the lowest reported count above 1, and reported values of 0 or 1 are censored. Responses at or below the selected limit are retained with <code>CENS = 1</code>.</li>
                <li>The transformed censor boundary must satisfy <code>0 ≤ E_L &lt; 1</code>. Equation 2 remains singular at an effect of exactly 0 or 1, so drug-exposed subjects on those boundaries are excluded with an explicit directional count rather than clipped.</li>
                <li>The additive assay-error model uses <code>α(f) = C0 + C1f + C2f² + C3f³</code> and <code>σ = sqrt(α(f)² + λ²)</code>, evaluated on each well's predicted response. For absorbance, the polynomial coefficients, lambda, observations, and censor limit are therefore all on the absorbance scale.</li>
                <li>PMcore jointly fits EC50₁, EC50₂, h₁,₀, h₂,₀, B₁, B₂, and α₁₂ through the numerical Equation 2 effect solve. The dose-dependent Hill coefficient is <code>hᵢ(dᵢ) = hᵢ,₀ exp(Bᵢ tanh(log(dᵢ / EC50ᵢ)))</code>, with <code>−2 ≤ Bᵢ ≤ 2</code>; <code>Bᵢ = 0</code> recovers the constant-Hill model. Internal concentrations and EC50s are fractions of the tested maximum. The Fit summary multiplies EC50 results back into the corresponding imported concentration units.</li>
                <li>The NPAG cycle limit defaults to 100. The fixed-grid parametric bootstrap defaults to 500 joint seven-parameter refits with seed 123; both values are editable. Synthetic absorbances are generated from the fitted prediction-based error model and recensored at L.</li>
              </ul>
              <p>The bacterial growth differential equation, <code>get_e2()</code>, and Nelder–Mead root search are not used. After fitting, Simulate draws 1,000 effects at user-entered constant free concentrations by sampling the unclustered bootstrap parameter vectors directly. With at least two completed simulations, Compare provides a descriptive ranking by median E; hypothesis tests are omitted because Monte Carlo draws are not independent biological replicates.</p>
            </section>

            <section id="instructions-results">
              <h2>5. Review results</h2>
              <ul>
                <li><strong>Summary:</strong> Overall Mean Bliss Interaction, approximate 95% confidence interval, p value, eligible locations, restricted concentration ranges, strata, and three-drug pairwise summaries.</li>
                <li><strong>Heatmap:</strong> Cellwise Bliss interactions and confidence intervals can be shown or hidden with the cell-value switch. A black box outlines the specified analysis ranges, including pairwise facets where the stratifying drug is zero.</li>
                <li><strong>Bar plot:</strong> Compact categorical strata with approximate 95% confidence-interval error bars.</li>
                <li><strong>Processed data:</strong> Concentrations, MIC-normalized coordinates, effects, expected Bliss, interaction, intervals, and replicate counts.</li>
              </ul>
              <p>For three-drug assays, select the stratifying drug in the Results sidebar. Each regimen remembers its manual choice. The shared checkbox applies that drug to other matching regimens in priority order; later shared drugs cover regimens that do not contain an earlier shared drug. The choice also applies to bar plots and workbook export.</p>
              <div className="instruction-ui-preview results-preview" aria-label="Results interface preview">
                <div className="preview-title">Bliss interaction summary</div>
                <div className="preview-clinical-range">Analysis concentration ranges: <strong>AMK 1–16 µg/mL</strong></div>
                <div className="preview-metrics"><span><small>Mean Bliss Interaction</small><strong>14.62</strong></span><span><small>Approx. 95% CI</small><strong>11.3 to 17.9</strong></span><span><small>Locations</small><strong>64</strong></span></div>
                <div className="preview-heatmap">{[0,1,2,3,4,5,6,7,8].map((cell) => <i className={cell >= 3 && cell <= 7 ? "outlined" : ""} key={cell}>{cell % 3 === 1 ? "+" : "·"}</i>)}</div>
              </div>
            </section>

            <section id="instructions-compare">
              <h2>6. Compare regimens</h2>
              <ul>
                <li>Two- and three-drug cohorts are compared separately.</li>
                <li>Use individual <strong>Include</strong> checkboxes or <strong>Include All</strong> without deleting imported results.</li>
                <li>Adjust minimum observed effect, synergy thresholds, and the antagonism threshold.</li>
                <li>The default ranking is descending synergy-exceedance AUC. Use the highlighted arrows to sort by any ranking column.</li>
                <li>AUC begins at the lowest eligible Bliss score, excluding the all-exceed plateau below observed scores.</li>
                <li>Matched-dose probability of superiority compares combination-only locations at matching log2(concentration/MIC) coordinates; ties count as half a win.</li>
              </ul>
              <div className="instruction-ui-preview compare-preview" aria-label="Comparison interface preview">
                <label><input type="checkbox" checked readOnly /> Include All</label>
                <div><strong>Regimen</strong><strong>Exceedance AUC <em>▼</em></strong><strong>Win probability</strong></div>
                <div><span>☑ DETA + CFZ + AMK</span><span>31.8</span><span>68.2%</span></div>
                <div><span>☑ DETA + CFZ + FOX</span><span>26.4</span><span>52.7%</span></div>
              </div>
            </section>

            <section id="instructions-troubleshooting">
              <h2>Troubleshooting and good practice</h2>
              <ul>
                <li>If a tab remains disabled, return to the preceding tab and look for missing mappings, nonpositive MICs, or an import warning.</li>
                <li>Confirm that units are nonblank and consistent, Drug C columns are supplied as a complete set, and every regimen includes a control.</li>
                <li>Fractional response detection tolerates a small fraction of corrected outliers, but at least 95% of absolute values must remain within 0–1.</li>
                <li>Changing MICs, concentration ranges, baseline correction, bootstrap iterations, or seed requires returning to Analyze and recalculating.</li>
                <li>Use Export results to save the selected regimen’s summary and processed combinations to XLSX.</li>
              </ul>
            </section>
          </article>
        </div>
        <footer className="instructions-footer"><span>Checkmate v{appBuild}</span><button className="primary-button" onClick={close}>Close instructions</button></footer>
      </section>
    </div>
  );
}

function NumberField({ label, value, min, onChange, help, zeroLabel }: { label: string; value: number; min: number; onChange: (value: number) => void; help?: string; zeroLabel?: string }) {
  return (
    <label>
      <span className="setting-label">{label}{help && <InfoTip text={help} />}</span>
      <input type="number" min={min} step={1} value={zeroLabel && value === 0 ? "" : value} placeholder={zeroLabel} onChange={(event) => onChange(event.target.value === "" ? 0 : Math.max(min, Number(event.target.value) || 0))} />
    </label>
  );
}

function InfoTip({ text }: { text: string }) {
  return (
    <details className="info-tip">
      <summary aria-label="More information">i</summary>
      <div className="info-popup" role="tooltip">{text}</div>
    </details>
  );
}

function MicWorkspace({ assignments, values, suggestions, setValue, zeroTolerance, setZeroTolerance, busy, error, complete, diamond }: {
  assignments: { key: string; organism: string | null; name: string; unit: string }[];
  values: Record<string, number | null>;
  suggestions: Record<string, number | null>;
  setValue: (key: string, value: number | null) => void;
  zeroTolerance: number;
  setZeroTolerance: (value: number) => void;
  busy: boolean;
  error: string | null;
  complete: boolean;
  diamond: boolean;
}) {
  return <main className="single-workspace"><section className="content-card stage-card">
    <div className="card-heading"><div><h1>{diamond ? "DiaMOND dose anchors" : "MIC assignments"}</h1><p>{diamond ? "Assign a dose-centering concentration for every organism–drug pair (normally IC90 for a centered DiaMOND assay, or the common MIC/IC reference used when preparing the plate)." : "Each organism has its own MIC assignment for every drug to which it was exposed. Suggestions pool repeated estimates only within the same organism–drug pair; ties use the lower value."}</p></div><span className="count-badge">{assignments.length} assignments</span></div>
    <div className="stage-content">
      <label className="compact-setting">MIC zero tolerance (viability percentage points)<input type="number" min={0} step="any" value={zeroTolerance} onChange={(event) => setZeroTolerance(Math.max(0, Number(event.target.value) || 0))} /></label>
      <div className="result-table-wrap"><table className="result-table shared-drug-table"><thead><tr><th>Organism</th><th>Drug</th><th>Units</th><th>Suggested MIC</th><th>{diamond ? "Assigned dose anchor" : "Assigned MIC"}</th></tr></thead><tbody>
        {assignments.map((assignment) => {
          const assigned = micRecordValue(values, assignment.key, assignment.name);
          const suggested = micRecordValue(suggestions, assignment.key, assignment.name);
          const organism = assignment.organism ?? "Unspecified organism";
          return <tr key={assignment.key}><td>{organism}</td><td><strong>{assignment.name}</strong></td><td>{assignment.unit || "—"}</td><td>{suggested == null ? "—" : suggested}</td><td><input aria-label={`${diamond ? "Dose anchor" : "MIC"} for ${assignment.name} against ${organism}`} type="number" min="0" step="any" value={assigned ?? ""} onChange={(event) => { const value = Number(event.target.value); setValue(assignment.key, event.target.value === "" || !Number.isFinite(value) ? null : value); }} /></td></tr>;
        })}
      </tbody></table></div>
      {busy && <p className="help-text">Inferring organism-specific MICs across all selected regimens…</p>}
      {error && <p className="side-warning">{error}</p>}
      {complete && <div className="mapping-status ready">{diamond ? "Dose anchors" : "MIC information"} complete. Continue to the Analyze tab.</div>}
    </div>
  </section></main>;
}

function AnalyzeSetupWorkspace({ drugs, concentrationRanges, setConcentrationRange, baselineCorrection, setBaselineCorrection, inputType, responseCensorLimit, setResponseCensorLimit, suggestion, suggestionBusy, suggestionError, settingsComplete, bootstrapIterations, setBootstrapIterations, randomSeed, setRandomSeed, calculate, busy, progress, currentRegimen }: {
  drugs: { name: string; unit: string }[];
  concentrationRanges: Record<string, ConcentrationRange>;
  setConcentrationRange: (drug: string, range: ConcentrationRange) => void;
  baselineCorrection: BaselineCorrection;
  setBaselineCorrection: (value: BaselineCorrection) => void;
  inputType: InputSettings["inputType"];
  responseCensorLimit: number | null;
  setResponseCensorLimit: (value: number | null) => void;
  suggestion: DrusanoCensorLimitSuggestion | null;
  suggestionBusy: boolean;
  suggestionError: string | null;
  settingsComplete: boolean;
  bootstrapIterations: number;
  setBootstrapIterations: (value: number) => void;
  randomSeed: number;
  setRandomSeed: (value: number) => void;
  calculate: () => Promise<void>;
  busy: boolean;
  progress: AnalysisProgress | null;
  currentRegimen: string | null;
}) {
  const rangesValid = drugs.every((drug) => {
    const range = concentrationRanges[drug.name];
    return !range
      || (range.minimum == null || range.minimum >= 0)
      && (range.maximum == null || range.maximum > 0)
      && (range.minimum == null || range.maximum == null || range.minimum <= range.maximum);
  });
  return <main className="workspace analysis-setup-workspace"><aside className="sidebar">
    {usesResponseCensoring(inputType) && <section className="drusano-model-settings">
      <h3>Response censoring</h3>
      <label>{inputType === "count" ? "Count censor limit (L)" : "Absorbance censor limit (L)"}<input type="number" min={inputType === "count" ? 1 : undefined} step="any" value={responseCensorLimit ?? ""} onChange={(event) => setResponseCensorLimit(nullableNumber(event.target.value))} /></label>
      <span className="field-help">{inputType === "count" ? "The suggested L is immediately below the lowest reported count above 1. Values of 0 or 1 are censored; responses at or below L use L for Bliss normalization." : <>Responses at or below L use L for Bliss normalization. The transformed boundary must satisfy 0 ≤ E<sub>L</sub> &lt; 1.</>}</span>
      {suggestionBusy ? <p className="help-text">{inputType === "count" ? "Finding the lowest reported count…" : "Examining the lower-response frequency distribution…"}</p>
        : suggestion ? <div className="censor-suggestion"><div><strong>Data suggestion: {format(suggestion.responseCensorLimit)}</strong><span>{suggestion.belowOrEqualCount} of {suggestion.responseCount} drug-exposed responses at or below L · E<sub>L</sub> = {format(suggestion.normalizedEffectLimit)}{inputType === "absorbance" ? ` · density drop ${format(suggestion.densityRatio)}×` : ""}</span></div><button className="secondary-button" disabled={busy} onClick={() => setResponseCensorLimit(suggestion.responseCensorLimit)}>Use suggestion</button></div>
          : <p className="help-text">{suggestionError ? `Suggestion unavailable: ${suggestionError}` : inputType === "count" ? "No count above 1 was available for a censor-limit suggestion." : "No clear lower-response frequency break was detected. Enter an assay-validated limit."}</p>}
    </section>}
    <label><span className="setting-label">Synergy baseline correction<InfoTip text="Part adjusts negative inhibition values; All applies fitted single-agent baseline adjustment to every response." /></span><select value={baselineCorrection} onChange={(event) => setBaselineCorrection(event.target.value as BaselineCorrection)}><option value="none">None (no correction)</option><option value="part">Part (negative values)</option><option value="all">All values</option></select></label>
    <NumberField label="Bootstrap iterations" value={bootstrapIterations} min={2} onChange={setBootstrapIterations} help="More iterations stabilize scores, p-values, and confidence intervals." />
    <NumberField label="Random seed" value={randomSeed} min={0} onChange={setRandomSeed} help="The same data and settings with this seed produce the same bootstrap result." />
  </aside><section className="content-card stage-card"><div className="card-heading"><div><h1>Analysis concentration ranges</h1><p>Set an optional minimum and maximum for each drug. Blank bounds remain unrestricted and apply to every regimen containing that drug.</p></div></div><div className="stage-content">
    <div className="result-table-wrap"><table className="result-table shared-drug-table"><thead><tr><th>Drug</th><th>Units</th><th>Minimum</th><th>Maximum</th></tr></thead><tbody>{drugs.map((drug) => {
      const range = concentrationRanges[drug.name] ?? { minimum: null, maximum: null };
      return <tr key={drug.name}><td><strong>{drug.name}</strong></td><td>{drug.unit || "—"}</td><td><input aria-label={`Minimum concentration for ${drug.name}`} type="number" min="0" step="any" placeholder="No minimum" value={range.minimum ?? ""} onChange={(event) => setConcentrationRange(drug.name, { ...range, minimum: nullableNumber(event.target.value) })} /></td><td><input aria-label={`Maximum concentration for ${drug.name}`} type="number" min="0" step="any" placeholder="No maximum" value={range.maximum ?? ""} onChange={(event) => setConcentrationRange(drug.name, { ...range, maximum: nullableNumber(event.target.value) })} /></td></tr>;
    })}</tbody></table></div>
    {!rangesValid && <p className="side-warning">Each range needs a nonnegative minimum, a positive maximum, and a minimum no greater than its maximum.</p>}
    <button className="success-button calculate-button" disabled={busy || !settingsComplete || !rangesValid} onClick={calculate}>{busy ? "Calculating…" : "Calculate Bliss"}</button>
    {progress && <AnalysisProgressBar progress={{ ...progress, regimenLabel: progress.regimenLabel ?? currentRegimen ?? undefined }} />}
  </div></section></main>;
}

function EmptyState({ busy }: { busy: boolean }) {
  return (
    <div className="empty-state">
      <span className="empty-icon">▦</span>
      <h2>{busy ? "Reading the selected range…" : "Choose a checkerboard data file"}</h2>
      <p>CSV, TXT, XLS, and XLSX inputs are supported.</p>
    </div>
  );
}

function AnalysisProgressBar({ progress }: { progress: AnalysisProgress }) {
  const total = Math.max(1, progress.totalIterations);
  const completed = Math.min(total, Math.max(0, progress.completedIterations));
  const percentage = Math.round(completed / total * 100);
  return (
    <div className="analysis-progress" role="status" aria-live="polite">
      <div><strong>{progress.regimenLabel ? `Bootstrapping ${progress.regimenLabel}` : "Calculating Bliss surfaces"}</strong><span>{completed} / {total} iterations · {percentage}%</span></div>
      <progress max={total} value={completed} aria-label={`Bliss calculation progress: ${percentage}%`} />
    </div>
  );
}

function AnalysisWorkspace({ analysis, tab, setTab, stratifyIndex, setStratifyIndex, sharedStratificationDrugs, toggleSharedStratification, colors, setColors, showConfidenceIntervals, setShowConfidenceIntervals, regimens, selectRegimen, returnToAnalyze }: {
  analysis: AnalysisResult;
  tab: ResultTab;
  setTab: (tab: ResultTab) => void;
  stratifyIndex: number;
  setStratifyIndex: (index: number) => void;
  sharedStratificationDrugs: string[];
  toggleSharedStratification: (drug: string, enabled: boolean) => void;
  colors: PlotColors;
  setColors: (colors: PlotColors) => void;
  showConfidenceIntervals: boolean;
  setShowConfidenceIntervals: (value: boolean) => void;
  regimens: ComparisonRegimen[];
  selectRegimen: (regimen: ComparisonRegimen) => void;
  returnToAnalyze: () => void;
}) {
  const [notice, setNotice] = useState<string | null>(null);

  async function persistColors() {
    try {
      await savePlotColors(colors);
      setNotice("Plot color defaults saved.");
    } catch (reason) {
      setNotice(errorMessage(reason));
    }
  }

  async function exportWorkbook() {
    try {
      const safeNames = analysis.drugNames.map((name) => name.replace(/[^a-z0-9_-]+/gi, "_")).join("_");
      const path = await saveDialog({
        defaultPath: `Checkmate_${safeNames}_${new Date().toISOString().slice(0, 10)}.xlsx`,
        filters: [{ name: "Excel workbook", extensions: ["xlsx"] }],
      });
      if (!path) return;
      await invoke("export_results", {
        request: {
          path,
          analysis,
          stratifyIndex: analysis.drugNames.length === 3 ? stratifyIndex : null,
        },
      });
      setNotice(`Results exported to ${path}`);
    } catch (reason) {
      setNotice(errorMessage(reason));
    }
  }

  return (
    <main className="workspace analysis-workspace">
      <aside className="sidebar">
        <section>
          <h2>Analysis</h2>
          {regimens.length > 1 && (
            <RegimenNavigator regimens={regimens} selectedId={regimens.find((regimen) => regimen.analysis === analysis)?.id ?? regimens[0].id} onSelect={(id) => {
              const regimen = regimens.find((candidate) => candidate.id === id);
              if (regimen) selectRegimen(regimen);
            }} compact />
          )}
          <p className="combination-name">{analysis.drugNames.join(" + ")}</p>
          <p className="help-text">Native SynergyFinder+ compatible Bliss · scores in percentage points.</p>
          <p className="help-text">MICs: {analysis.drugNames.map((name, index) => `${name} ${analysis.micValues[index]}${analysis.concentrationUnits[index] ? ` ${analysis.concentrationUnits[index]}` : ""}`).join(" · ")}</p>
          <p className="help-text">MIC inference tolerance: ±{analysis.micZeroTolerance} viability percentage points.</p>
        </section>
        <p className="help-text">Calculated with blank {analysis.policy.blankValue ?? 0}, response censor limit {analysis.policy.odCensorThreshold || "none"}, {capitalize(analysis.policy.baselineCorrection)} baseline correction, seed {analysis.policy.randomSeed}, and {analysis.policy.bootstrapIterations} iterations.</p>
        <button className="secondary-button full-width" onClick={returnToAnalyze}>Return to Analyze and rerun</button>
        {analysis.drugNames.length === 3 && (
          <section className="stratification-controls">
            <label>
              Stratify / facet by
              <select value={stratifyIndex} onChange={(event) => setStratifyIndex(Number(event.target.value))}>
                {analysis.drugNames.map((name, index) => <option value={index} key={name}>{name}</option>)}
              </select>
            </label>
            <label className="switch-control">
              <input type="checkbox" checked={sharedStratificationDrugs.includes(analysis.drugNames[stratifyIndex])} onChange={(event) => toggleSharedStratification(analysis.drugNames[stratifyIndex], event.target.checked)} />
              Use {analysis.drugNames[stratifyIndex]} for all matching regimens
            </label>
            <p className="field-help">Each regimen remembers manual choices. Shared drugs are applied in priority order to other matching regimens; a later drug applies where no earlier shared drug is present.</p>
            {sharedStratificationDrugs.length > 0 && <p className="field-help"><strong>Shared priority:</strong> {sharedStratificationDrugs.join(" → ")}</p>}
          </section>
        )}
        <label className="switch-control confidence-toggle">
          <input type="checkbox" checked={showConfidenceIntervals} onChange={(event) => setShowConfidenceIntervals(event.target.checked)} />
          Show 95% confidence intervals
        </label>
        <hr />
        <h2>Plot colors</h2>
        <ColorField label="Antagonism" value={colors.low} onChange={(low) => setColors({ ...colors, low })} />
        <ColorField label="Additive / midpoint" value={colors.midpoint} onChange={(midpoint) => setColors({ ...colors, midpoint })} />
        <ColorField label="Synergy" value={colors.high} onChange={(high) => setColors({ ...colors, high })} />
        {analysis.drugNames.length === 2 && <ColorField label="Expected-growth line" value={colors.expected} onChange={(expected) => setColors({ ...colors, expected })} />}
        <button className="secondary-button full-width" onClick={persistColors}>Save colors as defaults</button>
        <hr />
        <button className="primary-button full-width" onClick={exportWorkbook}>Export results (.xlsx)</button>
        <p className="help-text">Exports summary metrics and all processed combinations.</p>
        {notice && <div className="side-notice">{notice}</div>}
        {analysis.warnings.map((warning) => <div className="side-warning" key={warning.code}>{warning.message}</div>)}
      </aside>

      <section className="content-card results-card">
        <div className="result-tabs" role="tablist">
          {(["summary", "heatmap", "bar", "processed"] as ResultTab[]).map((value) => (
            <button key={value} className={tab === value ? "tab-active" : ""} onClick={() => setTab(value)}>
              {value === "bar" ? "Bar plot" : value === "processed" ? "Processed data" : capitalize(value)}
            </button>
          ))}
        </div>
        <div className="result-panel">
          {tab === "summary" && <SummaryPanel analysis={analysis} stratifyIndex={stratifyIndex} showConfidenceIntervals={showConfidenceIntervals} />}
          {tab === "heatmap" && <HeatmapPanel analysis={analysis} stratifyIndex={stratifyIndex} colors={colors} showConfidenceIntervals={showConfidenceIntervals} />}
          {tab === "bar" && (
            <Suspense fallback={<div className="empty-state"><h2>Loading interactive plot…</h2></div>}>
              <BarPlot analysis={analysis} stratifyIndex={stratifyIndex} colors={colors} showConfidenceIntervals={showConfidenceIntervals} />
            </Suspense>
          )}
          {tab === "processed" && <ProcessedTable analysis={analysis} />}
        </div>
      </section>
    </main>
  );
}

function ComparisonWorkspace({ regimens, includedIds, setIncludedIds, settings, setSettings, grouping, setGrouping, importAnother }: {
  regimens: ComparisonRegimen[];
  includedIds: string[];
  setIncludedIds: (ids: string[]) => void;
  settings: ComparisonSettings;
  setSettings: (settings: ComparisonSettings) => void;
  grouping: ResultOrder;
  setGrouping: (value: ResultOrder) => void;
  importAnother: () => void;
}) {
  const allIncluded = regimens.length > 0 && regimens.every((regimen) => includedIds.includes(regimen.id));
  const includedCount = regimens.filter((regimen) => includedIds.includes(regimen.id)).length;
  const cohorts = groupAnalysisUnits(regimens, grouping).flatMap((group) => ([2, 3] as const).flatMap((drugCount) => {
    const groupedRegimens = group.entries.filter((regimen) => regimen.analysis.drugNames.length === drugCount);
    return groupedRegimens.length ? [{ key: `${group.key}:${drugCount}`, label: group.label, drugCount, regimens: groupedRegimens }] : [];
  }));

  return (
    <main className="workspace comparison-workspace">
      <aside className="sidebar">
        <section>
          <h2>Comparison cohort</h2>
          <p className="help-text">Two-drug and three-drug regimens are ranked separately.</p>
        </section>
        <ComparisonPercentField label="Minimum observed effect" value={settings.minimumEffect} onChange={(minimumEffect) => setSettings({ ...settings, minimumEffect })} />
        <ComparisonPercentField label="Synergy threshold 1" value={settings.synergyThresholds[0]} onChange={(value) => setSettings({ ...settings, synergyThresholds: [value, settings.synergyThresholds[1]] })} />
        <ComparisonPercentField label="Synergy threshold 2" value={settings.synergyThresholds[1]} onChange={(value) => setSettings({ ...settings, synergyThresholds: [settings.synergyThresholds[0], value] })} />
        <ComparisonPercentField label="Antagonism threshold" value={settings.antagonismThreshold} onChange={(antagonismThreshold) => setSettings({ ...settings, antagonismThreshold })} />
        <p className="field-help">Effects and Bliss interactions are entered as percentage points. A minimum effect of 0 includes every combination-only location.</p>
        <label>Group comparisons by<select value={grouping} onChange={(event) => setGrouping(event.target.value as ResultOrder)}><option value="organism">Organism</option><option value="regimen">Regimen</option></select></label>
        <hr />
        <button className="primary-button full-width" onClick={importAnother}>Import another regimen</button>
      </aside>
      <section className="content-card comparison-card">
        <div className="card-heading">
          <div>
            <h1>Dose-stratified regimen ranking</h1>
            <p>Ranked by synergy exceedance AUC; matched-dose probability of superiority remains available as a secondary measure.</p>
          </div>
          <span className="count-badge">{includedCount} of {regimens.length} included</span>
        </div>
        <div className="comparison-content">
          <label className="include-control include-all-control">
            <input type="checkbox" checked={allIncluded} onChange={(event) => setIncludedIds(event.target.checked ? regimens.map((regimen) => regimen.id) : [])} />
            Include All
          </label>
          {cohorts.map((cohort) => (
            <ComparisonCohort
              key={cohort.key}
              groupLabel={`${grouping === "organism" ? "Organism" : "Regimen"}: ${cohort.label}`}
              drugCount={cohort.drugCount}
              regimens={cohort.regimens}
              includedIds={includedIds}
              settings={settings}
              setIncluded={(id, include) => setIncludedIds(include ? [...new Set([...includedIds, id])] : includedIds.filter((includedId) => includedId !== id))}
            />
          ))}
        </div>
      </section>
    </main>
  );
}

function ComparisonPercentField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return <label>{label} (%)<input type="number" step={1} value={value} onChange={(event) => onChange(Math.max(0, Number(event.target.value) || 0))} /></label>;
}

function ComparisonCohort({ groupLabel, drugCount, regimens, includedIds, settings, setIncluded }: {
  groupLabel: string;
  drugCount: 2 | 3;
  regimens: ComparisonRegimen[];
  includedIds: string[];
  settings: ComparisonSettings;
  setIncluded: (id: string, include: boolean) => void;
}) {
  const [rankingSort, setRankingSort] = useState<{ key: RankingSortKey; direction: SortDirection }>({ key: "auc", direction: "desc" });
  const includedRegimens = regimens.filter((regimen) => includedIds.includes(regimen.id));
  const result = includedRegimens.length >= 2 ? compareRegimens(includedRegimens, settings) : null;
  const sortedRankings = result ? [...result.rankings].sort((left, right) => compareRankingRows(left, right, rankingSort)) : [];
  return (
    <section className="comparison-section">
      <h2>{groupLabel} · {drugCount}-drug analyses</h2>
      <div className="regimen-list">
        {regimens.map((regimen) => (
          <div className="regimen-item" key={regimen.id}>
            <strong>{regimen.label}</strong>
            <span>
              {regimen.analysis.processed.filter((row) => row.concentrations.every((value) => value > 0) && withinClinicalWindow(regimen.analysis, row)).length} locations · MICs {regimen.analysis.micValues.join(" / ")}
            </span>
            <div className="regimen-actions">
              <label className="include-control">
                <input type="checkbox" checked={includedIds.includes(regimen.id)} onChange={(event) => setIncluded(regimen.id, event.target.checked)} />
                Include
              </label>
            </div>
          </div>
        ))}
      </div>
      {!result ? <div className="comparison-empty">Include at least two {drugCount}-drug regimens to calculate their ranking.</div> : (
        <>
          <h3>Overall ranking</h3>
          <div className="result-table-wrap">
            <table className="result-table ranking-table">
              <thead><tr><th>Rank</th><SortableRankingHeading label="Regimen" sortKey="regimen" sort={rankingSort} setSort={setRankingSort} /><SortableRankingHeading label="Exceedance AUC" sortKey="auc" sort={rankingSort} setSort={setRankingSort} /><SortableRankingHeading label="Avg. win probability" sortKey="win" sort={rankingSort} setSort={setRankingSort} /><SortableRankingHeading label="Eligible locations" sortKey="locations" sort={rankingSort} setSort={setRankingSort} /><SortableRankingHeading label={`Bliss ≥ ${formatPercent(settings.synergyThresholds[0])}`} sortKey="breadth0" sort={rankingSort} setSort={setRankingSort} /><SortableRankingHeading label={`Bliss ≥ ${formatPercent(settings.synergyThresholds[1])}`} sortKey="breadth1" sort={rankingSort} setSort={setRankingSort} /><SortableRankingHeading label={`Bliss ≤ −${formatPercent(settings.antagonismThreshold)}`} sortKey="antagonism" sort={rankingSort} setSort={setRankingSort} /></tr></thead>
              <tbody>{sortedRankings.map((row, index) => <tr key={row.regimen.id}><td>{index + 1}</td><td><strong>{row.regimen.label}</strong></td><td>{row.exceedanceAuc === null ? "—" : formatNumber(row.exceedanceAuc)}</td><td>{formatProbability(row.averageWinProbability)}</td><td>{row.eligibleLocations}</td><td>{formatProbability(row.synergyBreadth[0])}</td><td>{formatProbability(row.synergyBreadth[1])}</td><td>{formatProbability(row.antagonismBurden)}</td></tr>)}</tbody>
            </table>
          </div>
          <h3 className="title-with-info">Synergy exceedance curves<InfoTip text="For every Bliss threshold on the horizontal axis, the curve shows the percentage of eligible combination locations whose Bliss score is at least that threshold. The shared AUC domain begins at the lowest eligible score, where combinations first begin to fail to exceed increasing thresholds; the all-exceed plateau below observed scores is excluded. Eligibility follows the minimum observed-effect filter. The curve is descriptive and does not itself provide a p-value or confidence interval." /></h3>
          <ExceedanceChart regimens={includedRegimens} minimumEffect={settings.minimumEffect} />
          <h3>Pairwise probability of superiority</h3>
          <div className="result-table-wrap">
            <table className="result-table pairwise-table">
              <thead><tr><th>Regimen</th>{includedRegimens.map((regimen) => <th key={regimen.id}>{regimen.label}</th>)}</tr></thead>
              <tbody>{includedRegimens.map((left) => <tr key={left.id}><td><strong>{left.label}</strong></td>{includedRegimens.map((right) => {
                const cell = result.pairwise.find((value) => value.leftId === left.id && value.rightId === right.id)!;
                return <td key={right.id} title={`${cell.matchedLocations} matched location${cell.matchedLocations === 1 ? "" : "s"}`}>{formatProbability(cell.winProbability)}<small>n={cell.matchedLocations}</small></td>;
              })}</tr>)}</tbody>
            </table>
          </div>
          <p className="policy-note">Default ranking is descending exceedance AUC over the cohort's shared Bliss-threshold range, beginning where an eligible combination can first fail to exceed the threshold. Use the highlighted table arrows to select another ranking. Pairwise rows are compared only where every component is present, observed effect meets the filter, and normalized dose coordinates match. Ties count as half a win. These are descriptive results; confidence intervals require replicate experiments and hierarchical resampling.</p>
        </>
      )}
    </section>
  );
}

function SortableRankingHeading({ label, sortKey, sort, setSort }: {
  label: string;
  sortKey: RankingSortKey;
  sort: { key: RankingSortKey; direction: SortDirection };
  setSort: (sort: { key: RankingSortKey; direction: SortDirection }) => void;
}) {
  return <th><span className="sortable-heading"><span>{label}</span><span className="sort-arrows"><button className={sort.key === sortKey && sort.direction === "asc" ? "active" : ""} aria-label={`Sort ${label} ascending`} onClick={() => setSort({ key: sortKey, direction: "asc" })}>▲</button><button className={sort.key === sortKey && sort.direction === "desc" ? "active" : ""} aria-label={`Sort ${label} descending`} onClick={() => setSort({ key: sortKey, direction: "desc" })}>▼</button></span></span></th>;
}

function compareRankingRows(left: RegimenRanking, right: RegimenRanking, sort: { key: RankingSortKey; direction: SortDirection }) {
  if (sort.key === "regimen") {
    const compared = left.regimen.label.localeCompare(right.regimen.label);
    return sort.direction === "asc" ? compared : -compared;
  }
  const value = (row: RegimenRanking): number | null => ({
    auc: row.exceedanceAuc,
    win: row.averageWinProbability,
    locations: row.eligibleLocations,
    breadth0: row.synergyBreadth[0],
    breadth1: row.synergyBreadth[1],
    antagonism: row.antagonismBurden,
  })[sort.key as Exclude<RankingSortKey, "regimen">];
  const leftValue = value(left);
  const rightValue = value(right);
  if (leftValue == null) return rightValue == null ? left.regimen.label.localeCompare(right.regimen.label) : 1;
  if (rightValue == null) return -1;
  const compared = leftValue - rightValue;
  if (Math.abs(compared) > 1e-12) return sort.direction === "asc" ? compared : -compared;
  return left.regimen.label.localeCompare(right.regimen.label);
}

const comparisonLineColors = ["#235789", "#27824b", "#c26b18", "#8b4fa3", "#b33b4d", "#287f84", "#6d7131", "#555f6a"];

function ExceedanceChart({ regimens, minimumEffect }: { regimens: ComparisonRegimen[]; minimumEffect: number }) {
  const series = regimens.map((regimen) => ({
    regimen,
    values: regimen.analysis.processed
      .filter((row) => row.concentrations.every((value) => value > 0) && withinClinicalWindow(regimen.analysis, row) && row.effect >= minimumEffect)
      .map((row) => row.blissInteraction),
  }));
  const allValues = series.flatMap((item) => item.values);
  if (allValues.length === 0) return <div className="comparison-empty">No locations meet the current effect filter.</div>;
  const [minimum, maximum] = exceedanceDomain(allValues);
  const thresholds = Array.from({ length: 61 }, (_, index) => minimum + (maximum - minimum) * index / 60);
  const left = 52;
  const top = 14;
  const width = 668;
  const height = 206;
  const x = (value: number) => left + (value - minimum) / (maximum - minimum) * width;
  const y = (value: number) => top + (1 - value) * height;
  return (
    <figure className="exceedance-figure">
      <svg viewBox="0 0 742 258" role="img" aria-label="Proportion of eligible dose surface at or above each Bliss threshold">
        {[0, 0.5, 1].map((value) => <g key={value}><line x1={left} x2={left + width} y1={y(value)} y2={y(value)} className="chart-grid" /><text x={left - 9} y={y(value) + 4} textAnchor="end">{(value * 100).toFixed(0)}%</text></g>)}
        {minimum < 0 && maximum > 0 && <line x1={x(0)} x2={x(0)} y1={top} y2={top + height} className="chart-zero" />}
        {series.map((item, index) => {
          const points = thresholds.map((threshold) => {
            const exceedance = item.values.length ? item.values.filter((value) => value >= threshold).length / item.values.length : 0;
            return `${x(threshold)},${y(exceedance)}`;
          }).join(" ");
          return <polyline key={item.regimen.id} points={points} fill="none" stroke={comparisonLineColors[index % comparisonLineColors.length]} strokeWidth="3" />;
        })}
        <line x1={left} x2={left + width} y1={top + height} y2={top + height} className="chart-axis" />
        <text x={left} y={top + height + 20} textAnchor="middle">{formatPercent(minimum)}</text>
        <text x={left + width} y={top + height + 20} textAnchor="middle">{formatPercent(maximum)}</text>
        <text x={left + width / 2} y={254} textAnchor="middle" className="chart-axis-title">Bliss threshold</text>
      </svg>
      <figcaption>{series.map((item, index) => <span key={item.regimen.id}><i style={{ background: comparisonLineColors[index % comparisonLineColors.length] }} />{item.regimen.label}</span>)}</figcaption>
    </figure>
  );
}

function formatProbability(value: number | null) {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function formatPercent(value: number) {
  return `${value.toFixed(value % 1 ? 1 : 0)}%`;
}

function formatDose(value: number) {
  return Number(value.toPrecision(6)).toString();
}

function SummaryPanel({ analysis, stratifyIndex, showConfidenceIntervals }: { analysis: AnalysisResult; stratifyIndex: number; showConfidenceIntervals: boolean }) {
  const strata = analysis.drugNames.length === 3 ? groupedSummaries(analysis, stratifyIndex) : [];
  const overall = aggregateBliss(analysis.processed.filter((row) => row.concentrations.every((value) => value > 0) && withinClinicalWindow(analysis, row)));
  const pairAxes = analysis.drugNames.map((_, index) => index).filter((index) => index !== stratifyIndex);
  const pair = inactiveDrugPairSummary(analysis, stratifyIndex);
  return (
    <div className="summary-panel">
      <h1>Bliss interaction summary</h1>
      <ClinicalRangeSummary analysis={analysis} />
      <div className="metrics-grid">
        <Metric label="Mean Bliss Interaction" value={formatNumber(analysis.summary.meanBliss)} />
        {showConfidenceIntervals && <Metric label="Approx. 95% CI" value={formatCi(overall)} />}
        <Metric label="Combination locations" value={String(analysis.summary.combinationCount)} />
        <Metric label="P value vs zero" value={formatPValue(analysis.summary.pValue)} />
        <Metric label="Score unit" value="percentage points" />
      </div>
      <table className="result-table summary-table">
        <thead><tr>{strata.length > 0 && <th>{analysis.drugNames[stratifyIndex]}</th>}<th>Mean Bliss Interaction</th>{showConfidenceIntervals && <th>Approx. 95% CI</th>}<th>Interpretation</th></tr></thead>
        <tbody>
          {strata.map((stratum) => <tr key={stratum.concentration}><td>{stratum.concentration}</td><td>{formatNumber(stratum.mean)}</td>{showConfidenceIntervals && <td>{formatCi(stratum)}</td>}<td>{synergyFinderInterpretation(stratum.mean)}</td></tr>)}
          <tr><td>{strata.length > 0 ? "Overall" : formatNumber(analysis.summary.meanBliss)}</td>{strata.length > 0 && <td>{formatNumber(analysis.summary.meanBliss)}</td>}{showConfidenceIntervals && <td>{formatCi(overall)}</td>}<td><span className={`interpretation ${analysis.summary.interpretation}`}>{capitalize(analysis.summary.interpretation)}</span></td></tr>
        </tbody>
      </table>
      {pair && (
        <div className="pair-summary">
          <strong>{pairAxes.map((index) => analysis.drugNames[index]).join(" + ")} when {analysis.drugNames[stratifyIndex]} = 0:</strong>
          <span>Mean Bliss Interaction {formatNumber(pair.mean)}{showConfidenceIntervals ? `; approximate 95% CI ${formatCi(pair)}` : ""} ({pair.count} locations)</span>
        </div>
      )}
      <p className="policy-note">The matrix score is the mean over locations where every drug concentration is positive, matching synergyfinder 3.20.0.</p>
      {showConfidenceIntervals && <p className="policy-note">Summary confidence intervals are approximate and propagate the cellwise bootstrap SEMs; heatmap intervals are the native engine's empirical cellwise bootstrap intervals.</p>}
    </div>
  );
}

function ClinicalRangeSummary({ analysis }: { analysis: AnalysisResult }) {
  const ranges = analysis.drugNames.flatMap((drug, index) => {
    const range = concentrationRangeFor(analysis, index);
    return range.minimum == null && range.maximum == null ? [] : [{
    drug,
    minimum: range.minimum,
    maximum: range.maximum,
    unit: analysis.concentrationUnits[index],
  }];
  });
  if (!ranges.length) return null;
  return <p className="clinical-range-summary"><strong>Analysis concentration ranges:</strong> {ranges.map((range) => `${range.drug} ${range.minimum == null ? "unbounded" : formatDose(range.minimum)}–${range.maximum == null ? "unbounded" : formatDose(range.maximum)}${range.unit ? ` ${range.unit}` : ""}`).join(" · ")}</p>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}

function HeatmapPanel({ analysis, stratifyIndex, colors, showConfidenceIntervals }: { analysis: AnalysisResult; stratifyIndex: number; colors: PlotColors; showConfidenceIntervals: boolean }) {
  const [showCellAnnotations, setShowCellAnnotations] = useState(true);
  const facetValues = analysis.drugNames.length === 3
    ? uniqueSorted(analysis.processed.map((row) => row.concentrations[stratifyIndex]))
    : [null];
  const axes = analysis.drugNames.map((_, index) => index).filter((index) => index !== (analysis.drugNames.length === 3 ? stratifyIndex : -1));
  const maxAbs = Math.max(0.000001, ...analysis.processed.map((row) => Math.abs(row.blissInteraction)));
  return (
    <div className="heatmap-panel">
      <h1>Bliss interaction: {analysis.drugNames.join(" + ")}</h1>
      <label className="switch-control heatmap-value-toggle"><input type="checkbox" checked={showCellAnnotations} onChange={(event) => setShowCellAnnotations(event.target.checked)} />Show Bliss values and 95% CIs in cells</label>
      <div className="heatmap-legend"><span>Antagonism</span><i style={{ background: `linear-gradient(90deg, ${colors.low}, ${colors.midpoint}, ${colors.high})` }} /><span>Synergy</span></div>
      {hasConcentrationRanges(analysis) && <p className="policy-note clinical-window-note">Black outline: wells included in the specified overall analysis ranges.</p>}
      <div className="facet-grid">
        {facetValues.map((facet) => {
          const rows = facet === null ? analysis.processed : analysis.processed.filter((row) => row.concentrations[stratifyIndex] === facet);
          return <Heatmap key={facet ?? "all"} analysis={analysis} rows={rows} xIndex={axes[1]} yIndex={axes[0]} xName={`${analysis.drugNames[axes[1]]}${analysis.concentrationUnits[axes[1]] ? ` (${analysis.concentrationUnits[axes[1]]})` : ""}`} yName={`${analysis.drugNames[axes[0]]}${analysis.concentrationUnits[axes[0]] ? ` (${analysis.concentrationUnits[axes[0]]})` : ""}`} title={facet === null ? null : `${analysis.drugNames[stratifyIndex]} = ${facet}${analysis.concentrationUnits[stratifyIndex] ? ` ${analysis.concentrationUnits[stratifyIndex]}` : ""}`} maxAbs={maxAbs} colors={colors} showConfidenceIntervals={showConfidenceIntervals} showCellAnnotations={showCellAnnotations} />;
        })}
      </div>
    </div>
  );
}

function Heatmap({ analysis, rows, xIndex, yIndex, xName, yName, title, maxAbs, colors, showConfidenceIntervals, showCellAnnotations }: { analysis: AnalysisResult; rows: ProcessedCombination[]; xIndex: number; yIndex: number; xName: string; yName: string; title: string | null; maxAbs: number; colors: PlotColors; showConfidenceIntervals: boolean; showCellAnnotations: boolean }) {
  const xValues = uniqueSorted(rows.map((row) => row.concentrations[xIndex]));
  const yValues = uniqueSorted(rows.map((row) => row.concentrations[yIndex])).reverse();
  const lookup = new Map(rows.map((row) => [`${row.concentrations[xIndex]}|${row.concentrations[yIndex]}`, row]));
  const clinicalRows = rows.filter((row) => isClinicalWindowCell(analysis, row, xIndex, yIndex));
  const clinicalX = uniqueSorted(clinicalRows.map((row) => row.concentrations[xIndex]));
  const clinicalY = uniqueSorted(clinicalRows.map((row) => row.concentrations[yIndex]));
  return (
    <figure className="heatmap-figure">
      {title && <figcaption>{title}</figcaption>}
      <div className="heatmap-axes">
        <div className="heatmap-y-name">{yName}</div>
        <div className="heatmap-grid" style={{ gridTemplateColumns: `4rem repeat(${xValues.length}, minmax(5rem, 1fr))` }}>
          <span />
          {xValues.map((value) => <span className="axis-label" key={`x-${value}`}>{value}</span>)}
          {yValues.flatMap((y) => [
            <span className="axis-label" key={`yl-${y}`}>{y}</span>,
            ...xValues.map((x) => {
              const row = lookup.get(`${x}|${y}`);
              const restricted = row && isClinicalWindowCell(analysis, row, xIndex, yIndex);
              const boundary = restricted ? [
                x === clinicalX[0] ? " clinical-left" : "",
                x === clinicalX[clinicalX.length - 1] ? " clinical-right" : "",
                y === clinicalY[0] ? " clinical-bottom" : "",
                y === clinicalY[clinicalY.length - 1] ? " clinical-top" : "",
              ].join("") : "";
              return <span className={`heat-cell${boundary}`} key={`${x}-${y}`} title={row ? `Bliss: ${formatNumber(row.blissInteraction)}${row.blissCiLeft == null || row.blissCiRight == null ? "" : `; 95% CI ${formatNumber(row.blissCiLeft)} to ${formatNumber(row.blissCiRight)}`}` : "Not observed"} style={{ backgroundColor: row ? interactionColor(row.blissInteraction, maxAbs, colors) : "#edf0f2" }}>{row ? showCellAnnotations && <><strong>{formatNumber(row.blissInteraction, 2)}</strong>{showConfidenceIntervals && row.blissCiLeft != null && row.blissCiRight != null && <small>{formatNumber(row.blissCiLeft, 1)} to {formatNumber(row.blissCiRight, 1)}</small>}</> : "—"}</span>;
            }),
          ])}
        </div>
        <div className="heatmap-x-name">{xName}</div>
      </div>
    </figure>
  );
}

function ProcessedTable({ analysis }: { analysis: AnalysisResult }) {
  return (
    <div className="processed-panel">
      <h1>Processed combinations</h1>
      <div className="result-table-wrap">
        <table className="result-table">
          <thead><tr>{analysis.drugNames.map((name, index) => <th key={name}>{name}{analysis.concentrationUnits[index] ? ` (${analysis.concentrationUnits[index]})` : ""}</th>)}{analysis.drugNames.map((name) => <th key={`mic-${name}`}>{name} log₂(dose/MIC)</th>)}<th>Original response</th><th>Inhibition (%)</th>{analysis.drugNames.map((name) => <th key={`effect-${name}`}>{name} inhibition</th>)}<th>Bliss expected</th><th>Mean Bliss Interaction</th><th>95% CI</th><th>Replicates</th></tr></thead>
          <tbody>{analysis.processed.map((row, index) => <tr key={index}>{row.concentrations.map((value, column) => <td key={column}>{value}</td>)}{row.concentrations.map((value, column) => <td key={`mic-${column}`}>{value > 0 ? formatNumber(Math.log2(value / analysis.micValues[column])) : "—"}</td>)}<td>{formatNumber(row.meanOriginalOd)}</td><td>{formatNumber(row.effect)}</td>{row.singleAgentEffects.map((value, column) => <td key={column}>{formatNumber(value)}</td>)}<td>{formatNumber(row.blissExpected)}</td><td className={row.interpretation}>{formatNumber(row.blissInteraction)}</td><td>{row.blissCiLeft == null || row.blissCiRight == null ? "—" : `${formatNumber(row.blissCiLeft)} to ${formatNumber(row.blissCiRight)}`}</td><td>{row.replicateCount}</td></tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="color-field">{label}<span><input type="color" value={value} onChange={(event) => onChange(event.target.value)} /><input value={value} onChange={(event) => onChange(event.target.value)} /></span></label>;
}

function groupedSummaries(analysis: AnalysisResult, index: number) {
  return uniqueSorted(analysis.processed.filter((row) => row.concentrations.every((value) => value > 0) && withinClinicalWindow(analysis, row)).map((row) => row.concentrations[index])).map((concentration) => {
    const rows = analysis.processed.filter((row) => row.concentrations.every((value) => value > 0) && withinClinicalWindow(analysis, row) && row.concentrations[index] === concentration);
    return { concentration, ...aggregateBliss(rows) };
  });
}

function formatCi(summary: { ciLeft: number | null; ciRight: number | null }) {
  return summary.ciLeft == null || summary.ciRight == null ? "—" : `${formatNumber(summary.ciLeft)} to ${formatNumber(summary.ciRight)}`;
}

function verifyAnalysisResult(result: AnalysisResult, policy: AnalysisPolicy, micValues: (number | null)[], micTolerance: number, ranges: ConcentrationRange[], units: string[]) {
  if (result.policy.randomSeed !== policy.randomSeed
    || result.policy.bootstrapIterations !== policy.bootstrapIterations
    || result.policy.responseType !== policy.responseType
    || result.policy.baselineCorrection !== policy.baselineCorrection
    || result.policy.blankValue !== policy.blankValue
    || result.policy.odCensorThreshold !== policy.odCensorThreshold) {
    throw new Error("The analysis backend returned settings that differ from the submitted settings.");
  }
  if (result.micValues.length !== micValues.length || result.micValues.some((value, index) => value !== micValues[index])) {
    throw new Error("The analysis backend returned MIC values that differ from the submitted values.");
  }
  if (result.micZeroTolerance !== micTolerance
    || result.concentrationRanges.length !== ranges.length
    || result.concentrationRanges.some((value, index) => value.minimum !== ranges[index].minimum || value.maximum !== ranges[index].maximum)
    || result.concentrationUnits.length !== units.length
    || result.concentrationUnits.some((value, index) => value !== units[index])) {
    throw new Error("The analysis backend returned concentration settings that differ from the submitted values.");
  }
  const scores = result.processed.filter((row) => row.concentrations.every((value) => value > 0) && withinClinicalWindow(result, row)).map((row) => row.blissInteraction);
  const mean = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  if (!Number.isFinite(mean) || Math.abs(mean - result.summary.meanBliss) > 1e-9) {
    throw new Error("The returned Bliss summary does not match the returned combination-level scores.");
  }
}

function uniqueSorted(values: number[]) {
  return [...new Set(values)].sort((left, right) => left - right);
}

function interactionColor(value: number, maxAbs: number, colors: PlotColors) {
  return blend(colors.midpoint, value < 0 ? colors.low : colors.high, Math.min(1, Math.abs(value) / maxAbs));
}

function blend(from: string, to: string, amount: number) {
  const first = hexRgb(from);
  const second = hexRgb(to);
  return `rgb(${first.map((value, index) => Math.round(value + (second[index] - value) * amount)).join(",")})`;
}

function hexRgb(value: string) {
  const normalized = value.startsWith("#") ? value.slice(1) : value;
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return [255, 255, 255];
  return [0, 2, 4].map((offset) => parseInt(normalized.slice(offset, offset + 2), 16));
}

function synergyFinderInterpretation(value: number) {
  return value > 10 ? "Synergistic" : value < -10 ? "Antagonistic" : "Additive";
}

function displayCell(value?: string) {
  if (value === undefined || value === "") return "";
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(3) : value;
}

function errorMessage(reason: unknown) {
  if (reason && typeof reason === "object" && "message" in reason) return String((reason as AppError).message);
  return typeof reason === "string" ? reason : "An unexpected error occurred.";
}

function responseTypeForInput(settings: InputSettings): ResponseType | null {
  if (!settings.inputType) return null;
  if (settings.inputType === "normalized") return null;
  return "rawOd";
}

function nullableNumber(value: string): number | null {
  if (value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function format(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, { maximumSignificantDigits: 6 });
}

function usesResponseCensoring(inputType: InputSettings["inputType"]) {
  return inputType === "absorbance" || inputType === "count";
}

function organismKey(organism: string | null | undefined) {
  return organism?.trim() || "__unspecified_organism__";
}

function micRecordValue(
  values: Record<string, number | null>,
  assignmentKey: string,
  legacyDrugName: string,
) {
  return Object.prototype.hasOwnProperty.call(values, assignmentKey)
    ? values[assignmentKey]
    : values[legacyDrugName];
}

function regimenKeyOf(regimen: Pick<RegimenPreview, "regimenKey" | "drugNames">) {
  return regimen.regimenKey || regimen.drugNames.join("\u001f");
}

function regimenLabelOf(regimen: Pick<RegimenPreview, "regimenLabel" | "drugNames">) {
  return regimen.regimenLabel || regimen.drugNames.join(" + ");
}

function uniqueBy<T>(values: T[], key: (value: T) => string) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identifier = key(value);
    if (seen.has(identifier)) return false;
    seen.add(identifier);
    return true;
  });
}

function compareAnalysisUnits(
  left: { label: string; regimenLabel?: string; organism?: string | null },
  right: { label: string; regimenLabel?: string; organism?: string | null },
  order: ResultOrder,
) {
  const leftRegimen = left.regimenLabel ?? left.label;
  const rightRegimen = right.regimenLabel ?? right.label;
  const organismComparison = (left.organism ?? "").localeCompare(right.organism ?? "");
  const regimenComparison = leftRegimen.localeCompare(rightRegimen);
  return order === "organism"
    ? organismComparison || regimenComparison || left.label.localeCompare(right.label)
    : regimenComparison || organismComparison || left.label.localeCompare(right.label);
}

function validResponseCensorLimit(inputType: InputSettings["inputType"], value: number | null) {
  if (!usesResponseCensoring(inputType)) return true;
  return value != null && Number.isFinite(value) && (inputType !== "count" || value >= 1);
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export default App;
