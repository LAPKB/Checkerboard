import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";

import { aggregateBliss, buildMapping, compareRegimens, exceedanceDomain, formatNumber, formatPValue, inactiveDrugPairSummary, isClinicalWindowCell, mostCommonLowerTie, roleLabel, stratificationIndexFor, validateRoles, withinClinicalWindow } from "./analysis";
import logo from "./assets/logo.png";
import {
  defaultPlotColors,
  loadPlotColors,
  savePlotColors,
  type PlotColors,
} from "./preferences";
import type {
  AnalysisPolicy,
  AnalysisResult,
  AppError,
  BaselineCorrection,
  ColumnRole,
  ComparisonRegimen,
  ComparisonSettings,
  ImportPreview,
  ImportRequest,
  MicEstimate,
  ProcessedCombination,
  RegimenPreview,
  RegimenRanking,
  ResponseType,
} from "./types";
import "./App.css";

type Page = "import" | "mic" | "analyze" | "results" | "compare";
type ResultTab = "summary" | "heatmap" | "bar" | "processed";
type AnalysisProgress = { completedIterations: number; totalIterations: number; regimenLabel?: string };
type RankingSortKey = "regimen" | "auc" | "win" | "locations" | "breadth0" | "breadth1" | "antagonism";
type SortDirection = "asc" | "desc";

const BarPlot = lazy(() => import("./BarPlot"));
const appBuild = "0.7.0";

const roleOptions: ColumnRole[] = ["ignore", "drugNameA", "drugA", "unitsA", "drugNameB", "drugB", "unitsB", "drugNameC", "drugC", "unitsC", "response"];

const initialImport: ImportRequest = {
  path: "",
  worksheet: null,
  startRow: 1,
  startColumn: 1,
  rowLimit: 0,
  columnLimit: 0,
};

const initialComparisonSettings: ComparisonSettings = {
  minimumEffect: 0,
  synergyThresholds: [10, 20],
  antagonismThreshold: 10,
};

function App() {
  const [page, setPage] = useState<Page>("import");
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
  const [responseType, setResponseType] = useState<ResponseType>("viability");
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
  const [drugClinicalValues, setDrugClinicalValues] = useState<Record<string, number | null>>({});
  const [responseTypes, setResponseTypes] = useState<Record<string, ResponseType>>({});
  const [selectedImportRegimenId, setSelectedImportRegimenId] = useState<string | null>(null);
  const [analysisRegimens, setAnalysisRegimens] = useState<ComparisonRegimen[]>([]);
  const [colors, setColors] = useState<PlotColors>(defaultPlotColors);
  const [comparisonRegimens, setComparisonRegimens] = useState<ComparisonRegimen[]>([]);
  const [comparisonIncludedIds, setComparisonIncludedIds] = useState<string[]>([]);
  const [comparisonSettings, setComparisonSettings] = useState(initialComparisonSettings);
  const [currentBootstrapRegimen, setCurrentBootstrapRegimen] = useState<string | null>(null);
  const [showInstructions, setShowInstructions] = useState(false);

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
  const selectedImportRegimen = preview?.regimens.find((regimen) => regimen.id === selectedImportRegimenId) ?? preview?.regimens[0] ?? null;
  const uploadedDrugs = useMemo(() => {
    const drugs = new Map<string, { name: string; unit: string }>();
    for (const regimen of preview?.regimens ?? []) {
      regimen.drugNames.forEach((name, index) => {
        if (!drugs.has(name)) drugs.set(name, { name, unit: regimen.concentrationUnits[index] ?? "" });
      });
    }
    return [...drugs.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [preview]);
  const importReady = Boolean(preview && mappingErrors.length === 0 && preview.regimens.length > 0
    && preview.regimens.every((regimen) => buildMapping(preview, roles, regimen.drugNames) !== null));
  const micComplete = importReady && uploadedDrugs.length > 0 && uploadedDrugs.every((drug) => {
    const value = drugMicValues[drug.name];
    return value != null && Number.isFinite(value) && value > 0;
  });
  const resultsReady = micComplete && analysisRegimens.length > 0;
  const showCompare = comparisonRegimens.length > 1;

  useEffect(() => {
    if (page !== "import" && !importReady) setPage("import");
    else if (["analyze", "results", "compare"].includes(page) && !micComplete) setPage("mic");
    else if (page === "results" && !resultsReady) setPage("analyze");
    else if (page === "compare" && !showCompare) setPage(resultsReady ? "results" : "analyze");
  }, [page, importReady, micComplete, resultsReady, showCompare]);

  useEffect(() => {
    if (!preview || mappingErrors.length > 0) {
      setDrugMicSuggestions({});
      setMicEstimatesByRegimen({});
      return;
    }
    let cancelled = false;
    setMicBusy(true);
    setMicError(null);
    Promise.all(preview.regimens.map(async (regimen) => {
      const mapping = buildMapping(preview, roles, regimen.drugNames);
      if (!mapping) throw new Error(`${regimen.label}: invalid mapping`);
      const estimates = await invoke<MicEstimate[]>("infer_mics", { request: {
        import: importRequest, mapping,
        responseType: responseTypes[regimen.id] ?? regimen.suggestedResponseType,
        zeroTolerance: micZeroTolerance, regimenDrugNames: regimen.drugNames,
      } });
      return { regimen, estimates };
    })).then((results) => {
      if (cancelled) return;
      const byRegimen = Object.fromEntries(results.map(({ regimen, estimates }) => [regimen.id, estimates]));
      const candidates = new Map<string, number[]>();
      for (const { estimates } of results) {
        for (const estimate of estimates) {
          if (estimate.mic != null && Number.isFinite(estimate.mic) && estimate.mic > 0) {
            candidates.set(estimate.drugName, [...(candidates.get(estimate.drugName) ?? []), estimate.mic]);
          }
        }
      }
      const suggestions = Object.fromEntries(uploadedDrugs.map((drug) => [drug.name, mostCommonLowerTie(candidates.get(drug.name) ?? [])]));
      setMicEstimatesByRegimen(byRegimen);
      setDrugMicSuggestions(suggestions);
      setDrugMicValues((current) => Object.fromEntries(uploadedDrugs.map((drug) => [drug.name, current[drug.name] ?? suggestions[drug.name] ?? null])));
      setDrugClinicalValues((current) => Object.fromEntries(uploadedDrugs.map((drug) => [drug.name, current[drug.name] ?? null])));
    }).catch((reason) => {
      if (!cancelled) setMicError(errorMessage(reason));
    }).finally(() => { if (!cancelled) setMicBusy(false); });
    return () => { cancelled = true; };
  }, [preview, roles, importRequest, micZeroTolerance, responseTypes, uploadedDrugs]);

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
    const path = String(selected);
    const next = { ...initialImport, path };
    setImportRequest(next);
    setPreview(null);
    setAnalysis(null);
    setAnalysisRegimens([]);
    setDrugMicValues({});
    setDrugMicSuggestions({});
    setMicEstimatesByRegimen({});
    setDrugClinicalValues({});
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
    setBusy(true);
    setError(null);
    try {
      const imported = await invoke<ImportPreview>("import_preview", { request });
      setPreview(imported);
      setRoles(imported.suggestedRoles);
      setSelectedImportRegimenId(imported.regimens[0]?.id ?? null);
      const detectedResponses = Object.fromEntries(imported.regimens.map((regimen) => [regimen.id, regimen.suggestedResponseType]));
      setResponseTypes(detectedResponses);
      if (imported.regimens[0]) setResponseType(detectedResponses[imported.regimens[0].id]);
      setDrugMicValues({});
      setDrugMicSuggestions({});
      setMicEstimatesByRegimen({});
      setDrugClinicalValues({});
      setAnalysis(null);
      setAnalysisRegimens([]);
    } catch (reason) {
      setPreview(null);
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function runAnalysis() {
    if (!preview || !micComplete) return;
    const targets = preview.regimens;
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
            bootstrapIterations, randomSeed, cellAdditiveThreshold: 10, odCensorThreshold: 0, allowIncompleteGrid: true,
          };
          const regimenMics = regimen.drugNames.map((name) => drugMicValues[name]);
          if (regimenMics.some((value) => value == null || !Number.isFinite(value) || value <= 0)) throw new Error("one or more MIC assignments are incomplete");
          const regimenClinical = regimen.drugNames.map((name) => drugClinicalValues[name] ?? null);
          const onProgress = new Channel<AnalysisProgress>();
          onProgress.onmessage = (progress) => setAnalysisProgress({ ...progress, regimenLabel: regimen.label });
          const result = await invoke<AnalysisResult>("analyze_table", { request: {
            import: importRequest, mapping, micValues: regimenMics, micZeroTolerance,
            clinicallyRelevantConcentrations: regimenClinical,
            regimenDrugNames: regimen.drugNames, concentrationUnits: regimen.concentrationUnits, policy: requestedPolicy,
          }, onProgress });
          verifyAnalysisResult(result, requestedPolicy, regimenMics, micZeroTolerance, regimenClinical, regimen.concentrationUnits);
          const source = { importRequest: { ...importRequest }, preview, roles: [...roles], worksheets: [...worksheets], micEstimates: (micEstimatesByRegimen[regimen.id] ?? []).map((estimate) => ({ ...estimate })), regimenId: regimen.id };
          completed.push({ id: `${importRequest.path}:${importRequest.worksheet ?? ""}:${regimen.id}`, label: regimen.label, analysis: result, source });
        } catch (reason) {
          failures.push(`${regimen.label}: ${errorMessage(reason)}`);
        }
      }
      if (!completed.length) throw new Error(`No regimens could be analyzed. ${failures.join(" ")}`);
      setAnalysisRegimens(completed);
      const displayed = completed[0];
      setAnalysis(displayed.analysis);
      setSelectedImportRegimenId(displayed.source?.regimenId ?? null);
      setResponseType(displayed.analysis.policy.responseType);
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

  function updateRange(field: keyof ImportRequest, value: number | string | null) {
    setImportRequest((current) => ({ ...current, [field]: value }));
  }

  function selectImportRegimen(id: string) {
    const regimen = preview?.regimens.find((candidate) => candidate.id === id);
    if (regimen) setResponseType(responseTypes[id] ?? regimen.suggestedResponseType);
    setSelectedImportRegimenId(id);
  }

  function selectAnalyzedRegimen(regimen: ComparisonRegimen) {
    setAnalysis(regimen.analysis);
    setSelectedImportRegimenId(regimen.source?.regimenId ?? null);
    setResponseType(regimen.analysis.policy.responseType);
    setBaselineCorrection(regimen.analysis.policy.baselineCorrection);
    setBootstrapIterations(regimen.analysis.policy.bootstrapIterations);
    setRandomSeed(regimen.analysis.policy.randomSeed);
    setStratifyIndex(stratificationIndexFor(regimen, stratificationOverrides, sharedStratificationDrugs));
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
          <span>Checkerboard Bliss <small>v{appBuild}</small></span>
        </div>
        <nav aria-label="Primary navigation">
          <button className={page === "import" ? "nav-active" : ""} onClick={() => setPage("import")}>
            Import
          </button>
          <button
            className={page === "mic" ? "nav-active" : page === "import" && importReady ? "nav-ready" : ""}
            disabled={!importReady}
            onClick={() => setPage("mic")}
          >
            MIC
          </button>
          <button
            className={page === "analyze" ? "nav-active" : page === "mic" && micComplete ? "nav-ready" : ""}
            disabled={!micComplete}
            onClick={() => setPage("analyze")}
          >
            Analyze
          </button>
          <button className={page === "results" ? "nav-active" : ""} disabled={!resultsReady} onClick={() => setPage("results")}>Results</button>
          {showCompare && <button className={page === "compare" ? "nav-active" : ""} onClick={() => setPage("compare")}>Compare ({comparisonRegimens.length})</button>}
        </nav>
        <div className="header-actions">
          <button className="instructions-button" onClick={() => setShowInstructions(true)}>Instructions</button>
          <button className="quit-button" onClick={quitApplication}>Quit</button>
        </div>
      </header>

      {showInstructions && <InstructionsModal close={() => setShowInstructions(false)} />}

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

      {page === "import" ? (
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
            <ResponseTypeControl responseType={responseType} setResponseType={(value) => {
              setResponseType(value);
              if (selectedImportRegimen) setResponseTypes((current) => ({ ...current, [selectedImportRegimen.id]: value }));
            }} />
            <button className="secondary-button full-width" disabled={!importRequest.path || busy} onClick={() => loadPreview()}>
              {busy ? "Reading…" : "Refresh selected range"}
            </button>
          </aside>

          <section className="content-card mapping-card">
            <div className="card-heading">
              <div>
                <h1>Selected range and column assignments</h1>
                <p>Assign drug name, concentration, units, and response roles once. The Drug C / Conc C / Units C set is optional.</p>
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
                              onChange={(event) => {
                                const next = [...roles];
                                next[index] = event.target.value as ColumnRole;
                                setRoles(next);
                              }}
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
                <div className={mappingErrors.length ? "mapping-status warning" : "mapping-status ready"}>
                  {mappingErrors.length ? mappingErrors.join(" ") : "Import and mapping are complete. Continue to the MIC tab."}
                </div>
              </>
            )}
          </section>
        </main>
      ) : page === "mic" ? (
        <MicWorkspace
          drugs={uploadedDrugs}
          values={drugMicValues}
          suggestions={drugMicSuggestions}
          setValue={(drug, value) => setDrugMicValues((current) => ({ ...current, [drug]: value }))}
          zeroTolerance={micZeroTolerance}
          setZeroTolerance={setMicZeroTolerance}
          busy={micBusy}
          error={micError}
          complete={micComplete}
        />
      ) : page === "analyze" ? (
        <AnalyzeSetupWorkspace
          drugs={uploadedDrugs}
          clinicalValues={drugClinicalValues}
          setClinicalValue={(drug, value) => setDrugClinicalValues((current) => ({ ...current, [drug]: value }))}
          baselineCorrection={baselineCorrection}
          setBaselineCorrection={setBaselineCorrection}
          bootstrapIterations={bootstrapIterations}
          setBootstrapIterations={setBootstrapIterations}
          randomSeed={randomSeed}
          setRandomSeed={setRandomSeed}
          calculate={runAnalysis}
          busy={busy}
          progress={analysisProgress}
          currentRegimen={currentBootstrapRegimen}
        />
      ) : page === "results" ? (
        <AnalysisWorkspace
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
          regimens={analysisRegimens}
          selectRegimen={selectAnalyzedRegimen}
          returnToAnalyze={() => setPage("analyze")}
        />
      ) : (
        <ComparisonWorkspace
          regimens={comparisonRegimens}
          includedIds={comparisonIncludedIds}
          setIncludedIds={setComparisonIncludedIds}
          settings={comparisonSettings}
          setSettings={setComparisonSettings}
          importAnother={() => setPage("import")}
        />
      )}
    </div>
  );
}

function InstructionsModal({ close }: { close: () => void }) {
  return (
    <div className="instructions-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className="instructions-modal" role="dialog" aria-modal="true" aria-labelledby="instructions-title">
        <header className="instructions-header">
          <div><h1 id="instructions-title">Checkerboard Bliss instructions</h1><p>Prepare, analyze, review, and compare two- and three-drug checkerboard assays.</p></div>
          <button className="instructions-close-icon" aria-label="Close instructions" autoFocus onClick={close}>×</button>
        </header>
        <div className="instructions-layout">
          <nav className="instructions-index" aria-label="Instruction sections">
            <strong>Contents</strong>
            <a href="#instructions-workflow">Workflow</a>
            <a href="#instructions-data">Data format</a>
            <a href="#instructions-import">Import</a>
            <a href="#instructions-mic">MIC</a>
            <a href="#instructions-analyze">Analyze</a>
            <a href="#instructions-results">Results</a>
            <a href="#instructions-compare">Compare</a>
            <a href="#instructions-troubleshooting">Troubleshooting</a>
            <p>Press Esc or use either Close button to exit.</p>
          </nav>
          <article className="instructions-content">
            <section id="instructions-workflow">
              <h2>Workflow at a glance</h2>
              <p>Complete the tabs from left to right. A tab becomes available only after the preceding information is valid.</p>
              <div className="instruction-workflow-preview" aria-label="Application workflow preview">
                {[["1", "Import", "Choose data and confirm mapping"], ["2", "MIC", "Review suggested MICs"], ["3", "Analyze", "Choose policy and calculate"], ["4", "Results", "Inspect tables and plots"], ["5", "Compare", "Rank multiple regimens"]].map(([number, title, detail]) => <div key={number}><i>{number}</i><strong>{title}</strong><span>{detail}</span></div>)}
              </div>
              <p className="instruction-note">Compare is shown only when at least two analyzed regimens are available.</p>
            </section>

            <section id="instructions-data">
              <h2>Data format</h2>
              <p>Use CSV, TXT, XLS, or XLSX. Column order and spacing in column names do not matter. Each row represents one observed well or replicate.</p>
              <div className="result-table-wrap"><table className="result-table instruction-data-table">
                <thead><tr><th>Column</th><th>Status</th><th>Contents</th></tr></thead>
                <tbody>
                  <tr><td>Drug A, Drug B</td><td>Required</td><td>Drug names repeated on every row.</td></tr>
                  <tr><td>Conc A, Conc B</td><td>Required</td><td>Numeric concentrations; use 0 for untreated or absent drug.</td></tr>
                  <tr><td>Units A, Units B</td><td>Required</td><td>Concentration units, consistent within each regimen. Singular Unit A/B is accepted.</td></tr>
                  <tr><td>Drug C, Conc C, Units C</td><td>Optional set</td><td>For three-drug assays. Include all three columns together or omit all three.</td></tr>
                  <tr><td>Response</td><td>Required</td><td>Percent or fractional viability/inhibition. Small corrected values outside the nominal range are allowed.</td></tr>
                </tbody>
              </table></div>
              <ul>
                <li>Unique ordered combinations of Drug A, Drug B, and Drug C are assigned numerical regimen IDs automatically.</li>
                <li>Include untreated controls and the single-agent wells needed for Bliss and MIC inference. Do not silently fill missing wells.</li>
                <li>Fractional data are converted to percentage points during analysis. Raw OD is not an available response type.</li>
              </ul>
            </section>

            <section id="instructions-import">
              <h2>1. Import and map columns</h2>
              <div className="instruction-split">
                <div>
                  <ol>
                    <li>Select <strong>Choose data file…</strong>. For workbooks, choose the worksheet.</li>
                    <li>Adjust the starting row/column or limits if needed. <strong>All</strong> reads every remaining row or column.</li>
                    <li>Confirm assignments for Drug A/B/C, Conc A/B/C, Units A/B/C, and Response.</li>
                    <li>For multiple regimens, use the previous/next controls or regimen menu to inspect each preview.</li>
                    <li>Review the automatically detected response type and override it if necessary.</li>
                  </ol>
                  <p>The MIC tab activates only when the import and mapping are valid for every regimen.</p>
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
              <h2>2. Assign MICs</h2>
              <p>All unique uploaded drugs appear in one table. Suggested values pool single-agent MIC estimates from every regimen containing that drug. The most common estimate is used; ties select the lower MIC.</p>
              <ul>
                <li>Enter one finite positive MIC for every drug. Suggested values may be overwritten.</li>
                <li><strong>MIC zero tolerance</strong> defines how close a single-agent response must be to zero viability for automatic inference.</li>
                <li>The green completion message indicates that Analyze is ready.</li>
              </ul>
            </section>

            <section id="instructions-analyze">
              <h2>3. Configure and calculate Bliss</h2>
              <div className="instruction-split">
                <div>
                  <h3>Clinically relevant concentrations</h3>
                  <p>Leave a drug blank to analyze all observed concentrations. A supplied value restricts eligible positive doses to two two-fold dilutions below and above the target (¼× to 4×) in every regimen containing that drug.</p>
                  <h3>Analysis options</h3>
                  <ul>
                    <li><strong>Baseline correction:</strong> None, Part (negative inhibition values only), or All values. All is the default.</li>
                    <li><strong>Bootstrap iterations:</strong> The number of simulated Bliss surfaces used to estimate uncertainty. More iterations improve stability but take longer.</li>
                    <li><strong>Random seed:</strong> Initializes the simulation so unchanged data, settings, iteration count, and seed reproduce the same result.</li>
                  </ul>
                  <p>Select <strong>Calculate Bliss</strong>. Progress identifies both the regimen and completed replicates. A failing regimen is skipped and reported without discarding successful analyses.</p>
                </div>
                <div className="instruction-ui-preview clinical-preview" aria-label="Clinical concentration interface preview">
                  <div className="preview-title">Clinically relevant concentrations</div>
                  <div className="preview-table-head"><span>Drug</span><span>Units</span><span>Concentration</span></div>
                  <div><span>DETA</span><span>mM</span><span className="preview-input">All cells</span></div>
                  <div><span>CFZ</span><span>µg/mL</span><span className="preview-input">All cells</span></div>
                  <div><span>AMK</span><span>µg/mL</span><span className="preview-input selected">4</span></div>
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

            <section id="instructions-results">
              <h2>4. Review results</h2>
              <ul>
                <li><strong>Summary:</strong> Overall Mean Bliss Interaction, approximate 95% confidence interval, p value, eligible locations, restricted concentration ranges, strata, and three-drug pairwise summaries.</li>
                <li><strong>Heatmap:</strong> Cellwise Bliss interactions and confidence intervals. A black box outlines the clinically restricted window, including pairwise facets where the stratifying drug is zero.</li>
                <li><strong>Bar plot:</strong> Compact categorical strata with approximate 95% confidence-interval error bars.</li>
                <li><strong>Processed data:</strong> Concentrations, MIC-normalized coordinates, effects, expected Bliss, interaction, intervals, and replicate counts.</li>
              </ul>
              <p>For three-drug assays, select the stratifying drug in the Results sidebar. Each regimen remembers its manual choice. The shared checkbox applies that drug to other matching regimens in priority order; later shared drugs cover regimens that do not contain an earlier shared drug. The choice also applies to bar plots and workbook export.</p>
              <div className="instruction-ui-preview results-preview" aria-label="Results interface preview">
                <div className="preview-title">Bliss interaction summary</div>
                <div className="preview-clinical-range">Clinically relevant analysis range: <strong>AMK 1–16 µg/mL</strong></div>
                <div className="preview-metrics"><span><small>Mean Bliss Interaction</small><strong>14.62</strong></span><span><small>Approx. 95% CI</small><strong>11.3 to 17.9</strong></span><span><small>Locations</small><strong>64</strong></span></div>
                <div className="preview-heatmap">{[0,1,2,3,4,5,6,7,8].map((cell) => <i className={cell >= 3 && cell <= 7 ? "outlined" : ""} key={cell}>{cell % 3 === 1 ? "+" : "·"}</i>)}</div>
              </div>
            </section>

            <section id="instructions-compare">
              <h2>5. Compare regimens</h2>
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
                <li>Changing MICs, clinical targets, baseline correction, bootstrap iterations, or seed requires returning to Analyze and recalculating.</li>
                <li>Use Export results to save the selected regimen’s summary and processed combinations to XLSX.</li>
              </ul>
            </section>
          </article>
        </div>
        <footer className="instructions-footer"><span>Checkerboard Bliss v{appBuild}</span><button className="primary-button" onClick={close}>Close instructions</button></footer>
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

function ResponseTypeControl({ responseType, setResponseType }: {
  responseType: ResponseType;
  setResponseType: (value: ResponseType) => void;
}) {
  return (
    <div className="od-display-controls response-control">
      <label>
        <span className="setting-label">Response type<InfoTip text="Automatically inferred from the response scale and whether untreated controls are maximal (viability) or minimal (inhibition). Review the selection before analysis." /></span>
        <select value={responseType} onChange={(event) => setResponseType(event.target.value as ResponseType)}>
          <option value="viability">% Viability</option>
          <option value="viabilityFraction">Fractional viability (0–1)</option>
          <option value="inhibition">% Inhibition</option>
          <option value="inhibitionFraction">Fractional inhibition (0–1)</option>
        </select>
      </label>
    </div>
  );
}

function MicWorkspace({ drugs, values, suggestions, setValue, zeroTolerance, setZeroTolerance, busy, error, complete }: {
  drugs: { name: string; unit: string }[];
  values: Record<string, number | null>;
  suggestions: Record<string, number | null>;
  setValue: (drug: string, value: number | null) => void;
  zeroTolerance: number;
  setZeroTolerance: (value: number) => void;
  busy: boolean;
  error: string | null;
  complete: boolean;
}) {
  return <main className="single-workspace"><section className="content-card stage-card">
    <div className="card-heading"><div><h1>MIC assignments</h1><p>Suggested MICs pool every regimen containing the drug. The most frequent inferred MIC is selected; ties use the lower value.</p></div><span className="count-badge">{drugs.length} drugs</span></div>
    <div className="stage-content">
      <label className="compact-setting">MIC zero tolerance (viability percentage points)<input type="number" min={0} step="any" value={zeroTolerance} onChange={(event) => setZeroTolerance(Math.max(0, Number(event.target.value) || 0))} /></label>
      <div className="result-table-wrap"><table className="result-table shared-drug-table"><thead><tr><th>Drug</th><th>Units</th><th>Suggested MIC</th><th>Assigned MIC</th></tr></thead><tbody>
        {drugs.map((drug) => <tr key={drug.name}><td><strong>{drug.name}</strong></td><td>{drug.unit || "—"}</td><td>{suggestions[drug.name] == null ? "—" : suggestions[drug.name]}</td><td><input aria-label={`MIC for ${drug.name}`} type="number" min="0" step="any" value={values[drug.name] ?? ""} onChange={(event) => { const value = Number(event.target.value); setValue(drug.name, event.target.value === "" || !Number.isFinite(value) ? null : value); }} /></td></tr>)}
      </tbody></table></div>
      {busy && <p className="help-text">Inferring MICs across all regimens…</p>}
      {error && <p className="side-warning">{error}</p>}
      {complete && <div className="mapping-status ready">MIC information complete. Continue to the Analyze tab.</div>}
    </div>
  </section></main>;
}

function AnalyzeSetupWorkspace({ drugs, clinicalValues, setClinicalValue, baselineCorrection, setBaselineCorrection, bootstrapIterations, setBootstrapIterations, randomSeed, setRandomSeed, calculate, busy, progress, currentRegimen }: {
  drugs: { name: string; unit: string }[];
  clinicalValues: Record<string, number | null>;
  setClinicalValue: (drug: string, value: number | null) => void;
  baselineCorrection: BaselineCorrection;
  setBaselineCorrection: (value: BaselineCorrection) => void;
  bootstrapIterations: number;
  setBootstrapIterations: (value: number) => void;
  randomSeed: number;
  setRandomSeed: (value: number) => void;
  calculate: () => Promise<void>;
  busy: boolean;
  progress: AnalysisProgress | null;
  currentRegimen: string | null;
}) {
  return <main className="workspace analysis-setup-workspace"><aside className="sidebar">
    <label><span className="setting-label">Synergy baseline correction<InfoTip text="Part adjusts negative inhibition values; All applies fitted single-agent baseline adjustment to every response." /></span><select value={baselineCorrection} onChange={(event) => setBaselineCorrection(event.target.value as BaselineCorrection)}><option value="none">None (no correction)</option><option value="part">Part (negative values)</option><option value="all">All values</option></select></label>
    <NumberField label="Bootstrap iterations" value={bootstrapIterations} min={2} onChange={setBootstrapIterations} help="More iterations stabilize scores, p-values, and confidence intervals." />
    <NumberField label="Random seed" value={randomSeed} min={0} onChange={setRandomSeed} help="The same data and settings with this seed produce the same bootstrap result." />
  </aside><section className="content-card stage-card"><div className="card-heading"><div><h1>Clinically relevant concentrations</h1><p>Blank values analyze every observed cell. A value applies to every regimen containing that drug and restricts eligible doses to ¼×–4×.</p></div></div><div className="stage-content">
    <div className="result-table-wrap"><table className="result-table shared-drug-table"><thead><tr><th>Drug</th><th>Units</th><th>Clinically relevant concentration</th></tr></thead><tbody>{drugs.map((drug) => <tr key={drug.name}><td><strong>{drug.name}</strong></td><td>{drug.unit || "—"}</td><td><input aria-label={`Clinically relevant concentration for ${drug.name}`} type="number" min="0" step="any" placeholder="All cells" value={clinicalValues[drug.name] ?? ""} onChange={(event) => { const value = Number(event.target.value); setClinicalValue(drug.name, event.target.value === "" || !Number.isFinite(value) ? null : value); }} /></td></tr>)}</tbody></table></div>
    <button className="success-button calculate-button" disabled={busy} onClick={calculate}>{busy ? "Calculating…" : "Calculate Bliss"}</button>
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
        defaultPath: `Checkerboard_${safeNames}_${new Date().toISOString().slice(0, 10)}.xlsx`,
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
        <p className="help-text">Calculated with {capitalize(analysis.policy.baselineCorrection)} baseline correction, seed {analysis.policy.randomSeed}, and {analysis.policy.bootstrapIterations} iterations.</p>
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

function ComparisonWorkspace({ regimens, includedIds, setIncludedIds, settings, setSettings, importAnother }: {
  regimens: ComparisonRegimen[];
  includedIds: string[];
  setIncludedIds: (ids: string[]) => void;
  settings: ComparisonSettings;
  setSettings: (settings: ComparisonSettings) => void;
  importAnother: () => void;
}) {
  const allIncluded = regimens.length > 0 && regimens.every((regimen) => includedIds.includes(regimen.id));
  const includedCount = regimens.filter((regimen) => includedIds.includes(regimen.id)).length;
  const cohorts = ([2, 3] as const).map((drugCount) => ({
    drugCount,
    regimens: regimens.filter((regimen) => regimen.analysis.drugNames.length === drugCount),
  })).filter((cohort) => cohort.regimens.length > 0);

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
              key={cohort.drugCount}
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

function ComparisonCohort({ drugCount, regimens, includedIds, settings, setIncluded }: {
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
      <h2>{drugCount}-drug regimens</h2>
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
  const ranges = analysis.clinicallyRelevantConcentrations.flatMap((target, index) => target == null ? [] : [{
    drug: analysis.drugNames[index],
    minimum: target / 4,
    maximum: target * 4,
    unit: analysis.concentrationUnits[index],
  }]);
  if (!ranges.length) return null;
  return <p className="clinical-range-summary"><strong>Clinically relevant analysis range:</strong> {ranges.map((range) => `${range.drug} ${formatDose(range.minimum)}–${formatDose(range.maximum)}${range.unit ? ` ${range.unit}` : ""}`).join(" · ")}</p>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}

function HeatmapPanel({ analysis, stratifyIndex, colors, showConfidenceIntervals }: { analysis: AnalysisResult; stratifyIndex: number; colors: PlotColors; showConfidenceIntervals: boolean }) {
  const facetValues = analysis.drugNames.length === 3
    ? uniqueSorted(analysis.processed.map((row) => row.concentrations[stratifyIndex]))
    : [null];
  const axes = analysis.drugNames.map((_, index) => index).filter((index) => index !== (analysis.drugNames.length === 3 ? stratifyIndex : -1));
  const maxAbs = Math.max(0.000001, ...analysis.processed.map((row) => Math.abs(row.blissInteraction)));
  return (
    <div className="heatmap-panel">
      <h1>Bliss interaction: {analysis.drugNames.join(" + ")}</h1>
      <div className="heatmap-legend"><span>Antagonism</span><i style={{ background: `linear-gradient(90deg, ${colors.low}, ${colors.midpoint}, ${colors.high})` }} /><span>Synergy</span></div>
      {analysis.clinicallyRelevantConcentrations.some((value) => value != null) && <p className="policy-note clinical-window-note">Black outline: wells included in the clinically relevant overall analysis window.</p>}
      <div className="facet-grid">
        {facetValues.map((facet) => {
          const rows = facet === null ? analysis.processed : analysis.processed.filter((row) => row.concentrations[stratifyIndex] === facet);
          return <Heatmap key={facet ?? "all"} analysis={analysis} rows={rows} xIndex={axes[1]} yIndex={axes[0]} xName={`${analysis.drugNames[axes[1]]}${analysis.concentrationUnits[axes[1]] ? ` (${analysis.concentrationUnits[axes[1]]})` : ""}`} yName={`${analysis.drugNames[axes[0]]}${analysis.concentrationUnits[axes[0]] ? ` (${analysis.concentrationUnits[axes[0]]})` : ""}`} title={facet === null ? null : `${analysis.drugNames[stratifyIndex]} = ${facet}${analysis.concentrationUnits[stratifyIndex] ? ` ${analysis.concentrationUnits[stratifyIndex]}` : ""}`} maxAbs={maxAbs} colors={colors} showConfidenceIntervals={showConfidenceIntervals} />;
        })}
      </div>
    </div>
  );
}

function Heatmap({ analysis, rows, xIndex, yIndex, xName, yName, title, maxAbs, colors, showConfidenceIntervals }: { analysis: AnalysisResult; rows: ProcessedCombination[]; xIndex: number; yIndex: number; xName: string; yName: string; title: string | null; maxAbs: number; colors: PlotColors; showConfidenceIntervals: boolean }) {
  const xValues = uniqueSorted(rows.map((row) => row.concentrations[xIndex]));
  const yValues = uniqueSorted(rows.map((row) => row.concentrations[yIndex])).reverse();
  const lookup = new Map(rows.map((row) => [`${row.concentrations[xIndex]}|${row.concentrations[yIndex]}`, row]));
  const clinicalRows = rows.filter((row) => isClinicalWindowCell(analysis, row, xIndex, yIndex));
  const clinicalX = uniqueSorted(clinicalRows.map((row) => row.concentrations[xIndex]));
  const clinicalY = uniqueSorted(clinicalRows.map((row) => row.concentrations[yIndex]));
  return (
    <figure className="heatmap-figure">
      {title && <figcaption>{title}</figcaption>}
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
            return <span className={`heat-cell${boundary}`} key={`${x}-${y}`} title={row ? `Bliss: ${formatNumber(row.blissInteraction)}${row.blissCiLeft == null || row.blissCiRight == null ? "" : `; 95% CI ${formatNumber(row.blissCiLeft)} to ${formatNumber(row.blissCiRight)}`}` : "Not observed"} style={{ backgroundColor: row ? interactionColor(row.blissInteraction, maxAbs, colors) : "#edf0f2" }}>{row ? <><strong>{formatNumber(row.blissInteraction, 2)}</strong>{showConfidenceIntervals && row.blissCiLeft != null && row.blissCiRight != null && <small>{formatNumber(row.blissCiLeft, 1)} to {formatNumber(row.blissCiRight, 1)}</small>}</> : "—"}</span>;
          }),
        ])}
      </div>
      <div className="heatmap-x-name">{xName}</div>
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

function RegimenNavigator({ regimens, selectedId, onSelect, compact = false }: {
  regimens: Array<Pick<RegimenPreview, "id" | "label">>;
  selectedId: string;
  onSelect: (id: string) => void;
  compact?: boolean;
}) {
  const index = Math.max(0, regimens.findIndex((regimen) => regimen.id === selectedId));
  const choose = (next: number) => onSelect(regimens[(next + regimens.length) % regimens.length].id);
  return (
    <div className={`regimen-navigator${compact ? " compact" : ""}`}>
      <button type="button" aria-label="Previous regimen" onClick={() => choose(index - 1)}>‹</button>
      <select aria-label="Regimen" value={selectedId} onChange={(event) => onSelect(event.target.value)}>
        {regimens.map((regimen) => <option key={regimen.id} value={regimen.id}>{regimen.label}</option>)}
      </select>
      <button type="button" aria-label="Next regimen" onClick={() => choose(index + 1)}>›</button>
    </div>
  );
}

function verifyAnalysisResult(result: AnalysisResult, policy: AnalysisPolicy, micValues: (number | null)[], micTolerance: number, clinical: (number | null)[], units: string[]) {
  if (result.policy.randomSeed !== policy.randomSeed
    || result.policy.bootstrapIterations !== policy.bootstrapIterations
    || result.policy.responseType !== policy.responseType
    || result.policy.baselineCorrection !== policy.baselineCorrection) {
    throw new Error("The analysis backend returned settings that differ from the submitted settings.");
  }
  if (result.micValues.length !== micValues.length || result.micValues.some((value, index) => value !== micValues[index])) {
    throw new Error("The analysis backend returned MIC values that differ from the submitted values.");
  }
  if (result.micZeroTolerance !== micTolerance
    || result.clinicallyRelevantConcentrations.length !== clinical.length
    || result.clinicallyRelevantConcentrations.some((value, index) => value !== clinical[index])
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

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export default App;
