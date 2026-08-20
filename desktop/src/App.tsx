import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";

import { aggregateBliss, buildMapping, compareRegimens, exceedanceDomain, formatNumber, inactiveDrugPairSummary, roleLabel, validateRoles } from "./analysis";
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
  ResponseType,
} from "./types";
import "./App.css";

type Page = "import" | "analyze" | "compare";
type ResultTab = "summary" | "heatmap" | "bar" | "processed";
type AnalysisProgress = { completedIterations: number; totalIterations: number };

const BarPlot = lazy(() => import("./BarPlot"));
const appBuild = "0.7.0";

const roleOptions: ColumnRole[] = ["ignore", "drugA", "drugB", "drugC", "response"];

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
  const [stratifyIndex, setStratifyIndex] = useState(2);
  const [responseType, setResponseType] = useState<ResponseType>("viability");
  const [baselineCorrection, setBaselineCorrection] = useState<BaselineCorrection>("none");
  const [bootstrapIterations, setBootstrapIterations] = useState(10);
  const [randomSeed, setRandomSeed] = useState(123);
  const [showConfidenceIntervals, setShowConfidenceIntervals] = useState(false);
  const [micZeroTolerance, setMicZeroTolerance] = useState(5);
  const [micValues, setMicValues] = useState<(number | null)[]>([]);
  const [micEstimates, setMicEstimates] = useState<MicEstimate[]>([]);
  const [micBusy, setMicBusy] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [colors, setColors] = useState<PlotColors>(defaultPlotColors);
  const [comparisonRegimens, setComparisonRegimens] = useState<ComparisonRegimen[]>([]);
  const [comparisonSettings, setComparisonSettings] = useState(initialComparisonSettings);
  const [editingComparisonId, setEditingComparisonId] = useState<string | null>(null);
  const suppressNextMicInference = useRef(false);

  useEffect(() => {
    loadPlotColors().then(setColors).catch(() => undefined);
  }, []);

  const mappingErrors = useMemo(() => validateRoles(roles), [roles]);
  const currentMapping = useMemo(
    () => preview ? buildMapping(preview, roles) : null,
    [preview, roles],
  );

  useEffect(() => {
    if (!preview || !currentMapping) {
      setMicValues([]);
      setMicEstimates([]);
      return;
    }
    if (suppressNextMicInference.current) {
      suppressNextMicInference.current = false;
      setMicBusy(false);
      setMicError(null);
      return;
    }
    let cancelled = false;
    setMicBusy(true);
    setMicError(null);
    invoke<MicEstimate[]>("infer_mics", {
      request: {
        import: importRequest,
        mapping: currentMapping,
        responseType,
        zeroTolerance: micZeroTolerance,
      },
    }).then((estimates) => {
      if (cancelled) return;
      setMicEstimates(estimates);
      setMicValues(estimates.map((estimate) => estimate.mic));
    }).catch((reason) => {
      if (!cancelled) setMicError(errorMessage(reason));
    }).finally(() => {
      if (!cancelled) setMicBusy(false);
    });
    return () => { cancelled = true; };
  }, [preview, currentMapping, importRequest, responseType, micZeroTolerance]);

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
    setEditingComparisonId(null);
    setError(null);
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
      setAnalysis(null);
    } catch (reason) {
      setPreview(null);
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function runAnalysis(preserveView = false) {
    if (!preview) return;
    const mapping = buildMapping(preview, roles);
    if (!mapping) return;
    if (micValues.length !== mapping.drugs.length || micValues.some((value) => value === null || !Number.isFinite(value) || value <= 0)) {
      setError("Enter one positive MIC value for each mapped drug before analysis.");
      return;
    }
    setBusy(true);
    setAnalysisProgress({ completedIterations: 0, totalIterations: bootstrapIterations });
    setError(null);
    try {
      const requestedPolicy: AnalysisPolicy = {
        mode: "synergyFinderPlus",
        responseType,
        baselineCorrection,
        bootstrapIterations,
        randomSeed,
        cellAdditiveThreshold: 10,
        odCensorThreshold: 0,
        allowIncompleteGrid: true,
      };
      const onProgress = new Channel<AnalysisProgress>();
      onProgress.onmessage = setAnalysisProgress;
      const result = await invoke<AnalysisResult>("analyze_table", {
        request: {
          import: importRequest,
          mapping,
          micValues,
          micZeroTolerance,
          policy: requestedPolicy,
        },
        onProgress,
      });
      if (
        result.policy.randomSeed !== requestedPolicy.randomSeed
        || result.policy.bootstrapIterations !== requestedPolicy.bootstrapIterations
        || result.policy.responseType !== requestedPolicy.responseType
        || result.policy.baselineCorrection !== requestedPolicy.baselineCorrection
      ) {
        throw new Error("The analysis backend returned settings that differ from the submitted settings.");
      }
      if (result.micValues.length !== micValues.length || result.micValues.some((value, index) => value !== micValues[index])) {
        throw new Error("The analysis backend returned MIC values that differ from the submitted values.");
      }
      if (result.micZeroTolerance !== micZeroTolerance) {
        throw new Error("The analysis backend returned a MIC tolerance that differs from the submitted value.");
      }
      const combinationScores = result.processed
        .filter((row) => row.concentrations.every((value) => value > 0))
        .map((row) => row.blissInteraction);
      const calculatedMean = combinationScores.reduce((sum, value) => sum + value, 0) / combinationScores.length;
      if (!Number.isFinite(calculatedMean) || Math.abs(calculatedMean - result.summary.meanBliss) > 1e-9) {
        throw new Error("The returned Bliss summary does not match the returned combination-level scores.");
      }
      setAnalysis(result);
      if (editingComparisonId) {
        setComparisonRegimens((current) => current.map((regimen) => regimen.id === editingComparisonId ? {
          ...regimen,
          analysis: result,
          source: {
            importRequest: { ...importRequest },
            preview,
            roles: [...roles],
            worksheets: [...worksheets],
            micEstimates: micEstimates.map((estimate) => ({ ...estimate })),
          },
        } : regimen));
      }
      if (!preserveView) {
        setStratifyIndex(result.drugNames.length - 1);
        setPage("analyze");
        setTab("summary");
      }
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
      setAnalysisProgress(null);
    }
  }

  function updateRange(field: keyof ImportRequest, value: number | string | null) {
    setImportRequest((current) => ({ ...current, [field]: value }));
  }

  async function quitApplication() {
    try {
      await invoke("quit_application");
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  function addCurrentToComparison() {
    if (!analysis) return;
    const baseLabel = analysis.drugNames.join(" + ");
    const duplicateCount = comparisonRegimens.filter((regimen) => regimen.label === baseLabel || regimen.label.startsWith(`${baseLabel} (`)).length;
    const label = duplicateCount ? `${baseLabel} (${duplicateCount + 1})` : baseLabel;
    setComparisonRegimens((current) => [...current, {
      id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${current.length}`,
      label,
      analysis,
      source: preview ? {
        importRequest: { ...importRequest },
        preview,
        roles: [...roles],
        worksheets: [...worksheets],
        micEstimates: micEstimates.map((estimate) => ({ ...estimate })),
      } : undefined,
    }]);
    setEditingComparisonId(null);
    setPage("compare");
  }

  function editComparisonRegimen(regimen: ComparisonRegimen) {
    if (!regimen.source) {
      setError("This comparison entry does not contain editable import context. Re-import it once to enable editing.");
      return;
    }
    suppressNextMicInference.current = true;
    setImportRequest({ ...regimen.source.importRequest });
    setPreview(regimen.source.preview);
    setRoles([...regimen.source.roles]);
    setWorksheets([...regimen.source.worksheets]);
    setAnalysis(regimen.analysis);
    setResponseType(regimen.analysis.policy.responseType);
    setBaselineCorrection(regimen.analysis.policy.baselineCorrection);
    setBootstrapIterations(regimen.analysis.policy.bootstrapIterations);
    setRandomSeed(regimen.analysis.policy.randomSeed);
    setMicValues([...regimen.analysis.micValues]);
    setMicEstimates(regimen.source.micEstimates.map((estimate) => ({ ...estimate })));
    setMicZeroTolerance(regimen.analysis.micZeroTolerance);
    setStratifyIndex(regimen.analysis.drugNames.length - 1);
    setEditingComparisonId(regimen.id);
    setError(null);
    setTab("summary");
    setPage("analyze");
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
            Import &amp; map
          </button>
          <button
            className={page === "analyze" ? "nav-active" : ""}
            disabled={!analysis}
            onClick={() => setPage("analyze")}
          >
            Analyze
          </button>
          <button
            className={page === "compare" ? "nav-active" : ""}
            disabled={comparisonRegimens.length === 0}
            onClick={() => setPage("compare")}
          >
            Compare{comparisonRegimens.length > 0 ? ` (${comparisonRegimens.length})` : ""}
          </button>
        </nav>
        <button className="quit-button" onClick={quitApplication}>
          Quit
        </button>
      </header>

      {error && (
        <div className="global-error" role="alert">
          <strong>Could not continue.</strong> {error}
          <button aria-label="Dismiss error" onClick={() => setError(null)}>×</button>
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
              <NumberField label="Rows to read" value={importRequest.rowLimit} min={0} onChange={(value) => updateRange("rowLimit", value)} />
              <NumberField label="Columns to read" value={importRequest.columnLimit} min={0} onChange={(value) => updateRange("columnLimit", value)} />
            </div>
            <p className="help-text">Use 0 to read every remaining row or column. The start row is the header row.</p>
            <AnalysisSettingsControls
              responseType={responseType}
              setResponseType={setResponseType}
              baselineCorrection={baselineCorrection}
              setBaselineCorrection={setBaselineCorrection}
              bootstrapIterations={bootstrapIterations}
              setBootstrapIterations={setBootstrapIterations}
              randomSeed={randomSeed}
              setRandomSeed={setRandomSeed}
            />
            <button className="secondary-button full-width" disabled={!importRequest.path || busy} onClick={() => loadPreview()}>
              {busy ? "Reading…" : "Refresh selected range"}
            </button>
          </aside>

          <section className="content-card mapping-card">
            <div className="card-heading">
              <div>
                <h1>Selected range and column assignments</h1>
                <p>Assign each required role once. Drug C is optional.</p>
              </div>
              {preview && <span className="count-badge">{preview.totalRows} rows × {preview.totalColumns} columns</span>}
            </div>

            {!preview ? (
              <EmptyState busy={busy} />
            ) : (
              <>
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
                      {preview.rows.map((row, rowIndex) => (
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
                  {mappingErrors.length ? mappingErrors.join(" ") : "Ready to analyze the mapped numeric columns."}
                </div>
                {currentMapping && (
                  <section className="mic-panel">
                    <h2>MIC-relative comparison coordinates</h2>
                    <p className="help-text">MICs are inferred from single-agent wells as the lowest dose whose mean viability is within ± the zero tolerance. Review or overwrite them before analysis.</p>
                    <label>
                      MIC zero tolerance (percentage points)
                      <input type="number" min={0} step="any" value={micZeroTolerance} onChange={(event) => setMicZeroTolerance(Math.max(0, Number(event.target.value) || 0))} />
                    </label>
                    <div className="range-grid">
                      {currentMapping.drugs.map((drug, index) => (
                        <label key={`${drug.name}-${index}`}>
                          {drug.name} MIC
                          <input
                            type="number"
                            min="0"
                            step="any"
                            value={micValues[index] ?? ""}
                            onChange={(event) => {
                              const next = [...micValues];
                              const value = Number(event.target.value);
                              next[index] = event.target.value === "" || !Number.isFinite(value) ? null : value;
                              setMicValues(next);
                            }}
                          />
                          <span className="field-help">{micEstimates[index]?.mic == null ? `No qualifying MIC among ${micEstimates[index]?.singleAgentLevels ?? 0} levels.` : `Inferred at mean viability ${formatNumber(micEstimates[index].meanResponseAtMic ?? NaN)}%.`}</span>
                        </label>
                      ))}
                    </div>
                    {micBusy && <p className="help-text">Inferring MICs…</p>}
                    {micError && <p className="side-warning">{micError}</p>}
                  </section>
                )}
                <button className="success-button" disabled={mappingErrors.length > 0 || busy || micBusy || micValues.some((value) => value === null || value <= 0)} onClick={() => runAnalysis()}>
                  {busy ? "Analyzing…" : "Analyze with Bliss"}
                </button>
                {analysisProgress && <AnalysisProgressBar progress={analysisProgress} />}
              </>
            )}
          </section>
        </main>
      ) : page === "analyze" ? (
        <AnalysisWorkspace
          analysis={analysis!}
          tab={tab}
          setTab={setTab}
          stratifyIndex={stratifyIndex}
          setStratifyIndex={setStratifyIndex}
          colors={colors}
          setColors={setColors}
          responseType={responseType}
          setResponseType={setResponseType}
          baselineCorrection={baselineCorrection}
          setBaselineCorrection={setBaselineCorrection}
          bootstrapIterations={bootstrapIterations}
          setBootstrapIterations={setBootstrapIterations}
          randomSeed={randomSeed}
          setRandomSeed={setRandomSeed}
          showConfidenceIntervals={showConfidenceIntervals}
          setShowConfidenceIntervals={setShowConfidenceIntervals}
          rerun={() => runAnalysis(true)}
          busy={busy}
          analysisProgress={analysisProgress}
          addToComparison={addCurrentToComparison}
          alreadyAdded={comparisonRegimens.some((regimen) => regimen.analysis === analysis)}
          comparisonEditLabel={comparisonRegimens.find((regimen) => regimen.id === editingComparisonId)?.label ?? null}
        />
      ) : (
        <ComparisonWorkspace
          regimens={comparisonRegimens}
          settings={comparisonSettings}
          setSettings={setComparisonSettings}
          setRegimens={(next) => {
            setComparisonRegimens(next);
            if (editingComparisonId && !next.some((regimen) => regimen.id === editingComparisonId)) {
              setEditingComparisonId(null);
            }
          }}
          editRegimen={editComparisonRegimen}
          importAnother={() => {
            setEditingComparisonId(null);
            setPage("import");
          }}
        />
      )}
    </div>
  );
}

function NumberField({ label, value, min, onChange, help }: { label: string; value: number; min: number; onChange: (value: number) => void; help?: string }) {
  return (
    <label>
      <span className="setting-label">{label}{help && <InfoTip text={help} />}</span>
      <input type="number" min={min} step={1} value={value} onChange={(event) => onChange(Math.max(min, Number(event.target.value) || 0))} />
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

function AnalysisSettingsControls({ responseType, setResponseType, baselineCorrection, setBaselineCorrection, bootstrapIterations, setBootstrapIterations, randomSeed, setRandomSeed }: {
  responseType: ResponseType;
  setResponseType: (value: ResponseType) => void;
  baselineCorrection: BaselineCorrection;
  setBaselineCorrection: (value: BaselineCorrection) => void;
  bootstrapIterations: number;
  setBootstrapIterations: (value: number) => void;
  randomSeed: number;
  setRandomSeed: (value: number) => void;
}) {
  return (
    <div className="od-display-controls">
      <label>
        <span className="setting-label">Response type<InfoTip text="Choose Viability (%) when untreated controls are near 100; Fractional viability when controls are near 1; Inhibition (%) when untreated controls are near 0 and larger values mean more inhibition; Raw OD only for unnormalized absorbance values. Raw OD should already be blank-corrected." /></span>
        <select value={responseType} onChange={(event) => setResponseType(event.target.value as ResponseType)}>
          <option value="viability">Viability (%)</option>
          <option value="viabilityFraction">Fractional viability (0–1)</option>
          <option value="inhibition">Inhibition (%)</option>
          <option value="rawOd">Raw OD</option>
        </select>
      </label>
      <label>
        <span className="setting-label">Synergy baseline correction<InfoTip text="Non leaves responses unchanged. Part adjusts only negative inhibition values (viability above 100%). All applies the fitted single-agent baseline adjustment to every response. Use Non for direct benchmarking unless a correction was prespecified." /></span>
        <select value={baselineCorrection} onChange={(event) => setBaselineCorrection(event.target.value as BaselineCorrection)}>
          <option value="none">Non (no correction)</option>
          <option value="part">Part (negative values)</option>
          <option value="all">All values</option>
        </select>
      </label>
      <NumberField label="Bootstrap iterations" value={bootstrapIterations} min={2} onChange={setBootstrapIterations} help="The number of parametric replicate datasets the native engine simulates. More iterations stabilize the score, p-value, and confidence intervals but take longer. Use at least 1,000 for final reporting when practical." />
      <NumberField label="Random seed" value={randomSeed} min={0} onChange={setRandomSeed} help="Initializes the native R-compatible random-number generator so the bootstrap is reproducible. The same data, settings, iteration count, and seed produce the same result." />
      <span className="field-help">Native Rust profile benchmarked against synergyfinder 3.20.0; no imputation or added noise.</span>
    </div>
  );
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
      <div><strong>Calculating Bliss surfaces</strong><span>{completed} / {total} iterations · {percentage}%</span></div>
      <progress max={total} value={completed} aria-label={`Bliss calculation progress: ${percentage}%`} />
    </div>
  );
}

function AnalysisWorkspace({ analysis, tab, setTab, stratifyIndex, setStratifyIndex, colors, setColors, responseType, setResponseType, baselineCorrection, setBaselineCorrection, bootstrapIterations, setBootstrapIterations, randomSeed, setRandomSeed, showConfidenceIntervals, setShowConfidenceIntervals, rerun, busy, analysisProgress, addToComparison, alreadyAdded, comparisonEditLabel }: {
  analysis: AnalysisResult;
  tab: ResultTab;
  setTab: (tab: ResultTab) => void;
  stratifyIndex: number;
  setStratifyIndex: (index: number) => void;
  colors: PlotColors;
  setColors: (colors: PlotColors) => void;
  responseType: ResponseType;
  setResponseType: (value: ResponseType) => void;
  baselineCorrection: BaselineCorrection;
  setBaselineCorrection: (value: BaselineCorrection) => void;
  bootstrapIterations: number;
  setBootstrapIterations: (value: number) => void;
  randomSeed: number;
  setRandomSeed: (value: number) => void;
  showConfidenceIntervals: boolean;
  setShowConfidenceIntervals: (value: boolean) => void;
  rerun: () => Promise<void>;
  busy: boolean;
  analysisProgress: AnalysisProgress | null;
  addToComparison: () => void;
  alreadyAdded: boolean;
  comparisonEditLabel: string | null;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const settingsChanged = responseType !== analysis.policy.responseType
    || baselineCorrection !== analysis.policy.baselineCorrection
    || bootstrapIterations !== analysis.policy.bootstrapIterations
    || randomSeed !== analysis.policy.randomSeed;

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
          {comparisonEditLabel && (
            <div className="comparison-edit-notice" role="status">
              <strong>Editing “{comparisonEditLabel}”</strong>
              <span>Recalculate to replace this comparison result in place.</span>
            </div>
          )}
          <p className="combination-name">{analysis.drugNames.join(" + ")}</p>
          <p className="help-text">Native SynergyFinder+ compatible Bliss · scores in percentage points.</p>
          <p className="help-text">MICs: {analysis.drugNames.map((name, index) => `${name} ${analysis.micValues[index]}`).join(" · ")}</p>
          <p className="help-text">MIC inference tolerance: ±{analysis.micZeroTolerance} viability percentage points.</p>
        </section>
        <AnalysisSettingsControls
          responseType={responseType}
          setResponseType={setResponseType}
          baselineCorrection={baselineCorrection}
          setBaselineCorrection={setBaselineCorrection}
          bootstrapIterations={bootstrapIterations}
          setBootstrapIterations={setBootstrapIterations}
          randomSeed={randomSeed}
          setRandomSeed={setRandomSeed}
        />
        <button className="secondary-button full-width" disabled={busy} onClick={rerun}>
          {busy ? "Recalculating…" : "Recalculate"}
        </button>
        {analysisProgress && <AnalysisProgressBar progress={analysisProgress} />}
        <p className={settingsChanged ? "side-warning" : "help-text"}>
          Displayed result calculated with seed {analysis.policy.randomSeed} and {analysis.policy.bootstrapIterations} iterations.
          {settingsChanged ? " Settings have changed; click Recalculate." : ""}
        </p>
        {analysis.drugNames.length === 3 && (
          <label>
            Stratify / facet by
            <select value={stratifyIndex} onChange={(event) => setStratifyIndex(Number(event.target.value))}>
              {analysis.drugNames.map((name, index) => <option value={index} key={name}>{name}</option>)}
            </select>
          </label>
        )}
        <label className="switch-control confidence-toggle">
          <input type="checkbox" checked={showConfidenceIntervals} onChange={(event) => setShowConfidenceIntervals(event.target.checked)} />
          Show 95% confidence intervals
        </label>
        <button className="success-button full-width comparison-add" disabled={alreadyAdded || comparisonEditLabel !== null} onClick={addToComparison}>
          {comparisonEditLabel ? "Linked to comparison" : alreadyAdded ? "Added to comparison" : "Add to comparison"}
        </button>
        <p className="help-text">{comparisonEditLabel ? "Successful recalculation updates the existing entry and keeps its name." : "Add this analysis to the MIC-relative regimen comparison."}</p>
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

function ComparisonWorkspace({ regimens, settings, setSettings, setRegimens, editRegimen, importAnother }: {
  regimens: ComparisonRegimen[];
  settings: ComparisonSettings;
  setSettings: (settings: ComparisonSettings) => void;
  setRegimens: (regimens: ComparisonRegimen[]) => void;
  editRegimen: (regimen: ComparisonRegimen) => void;
  importAnother: () => void;
}) {
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
          <span className="count-badge">{regimens.length} regimen{regimens.length === 1 ? "" : "s"}</span>
        </div>
        <div className="comparison-content">
          {cohorts.map((cohort) => (
            <ComparisonCohort
              key={cohort.drugCount}
              drugCount={cohort.drugCount}
              regimens={cohort.regimens}
              settings={settings}
              rename={(id, label) => setRegimens(regimens.map((regimen) => regimen.id === id ? { ...regimen, label } : regimen))}
              remove={(id) => setRegimens(regimens.filter((regimen) => regimen.id !== id))}
              edit={editRegimen}
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

function ComparisonCohort({ drugCount, regimens, settings, rename, remove, edit }: {
  drugCount: 2 | 3;
  regimens: ComparisonRegimen[];
  settings: ComparisonSettings;
  rename: (id: string, label: string) => void;
  remove: (id: string) => void;
  edit: (regimen: ComparisonRegimen) => void;
}) {
  const result = regimens.length >= 2 ? compareRegimens(regimens, settings) : null;
  return (
    <section className="comparison-section">
      <h2>{drugCount}-drug regimens</h2>
      <div className="regimen-list">
        {regimens.map((regimen) => (
          <div className="regimen-item" key={regimen.id}>
            <input aria-label={`Name for ${regimen.label}`} value={regimen.label} onChange={(event) => rename(regimen.id, event.target.value)} />
            <span>
              {regimen.analysis.processed.filter((row) => row.concentrations.every((value) => value > 0)).length} locations · MICs {regimen.analysis.micValues.join(" / ")}
            </span>
            <div className="regimen-actions">
              <button className="edit-regimen-button" aria-label={`Edit ${regimen.label}`} title="Edit and recalculate this regimen" onClick={() => edit(regimen)}>✎</button>
              <button aria-label={`Remove ${regimen.label}`} onClick={() => remove(regimen.id)}>Remove</button>
            </div>
          </div>
        ))}
      </div>
      {!result ? <div className="comparison-empty">Add one more {drugCount}-drug regimen to calculate its ranking.</div> : (
        <>
          <h3>Overall ranking</h3>
          <div className="result-table-wrap">
            <table className="result-table ranking-table">
              <thead><tr><th>Rank</th><th>Regimen</th><th>Exceedance AUC</th><th>Avg. win probability</th><th>Eligible locations</th><th>Bliss ≥ {formatPercent(settings.synergyThresholds[0])}</th><th>Bliss ≥ {formatPercent(settings.synergyThresholds[1])}</th><th>Bliss ≤ −{formatPercent(settings.antagonismThreshold)}</th></tr></thead>
              <tbody>{result.rankings.map((row) => <tr key={row.regimen.id}><td>{row.rank}</td><td><strong>{row.regimen.label}</strong></td><td>{row.exceedanceAuc === null ? "—" : formatNumber(row.exceedanceAuc)}</td><td>{formatProbability(row.averageWinProbability)}</td><td>{row.eligibleLocations}</td><td>{formatProbability(row.synergyBreadth[0])}</td><td>{formatProbability(row.synergyBreadth[1])}</td><td>{formatProbability(row.antagonismBurden)}</td></tr>)}</tbody>
            </table>
          </div>
          <h3 className="title-with-info">Synergy exceedance curves<InfoTip text="For every Bliss threshold on the horizontal axis, the curve shows the percentage of eligible combination locations whose Bliss score is at least that threshold. A curve that stays higher and extends farther right indicates broader and stronger positive interaction. Exceedance AUC integrates this proportion over the shared displayed threshold range; larger AUC ranks higher. Eligibility follows the minimum observed-effect filter. The curve is descriptive and does not itself provide a p-value or confidence interval." /></h3>
          <ExceedanceChart regimens={regimens} minimumEffect={settings.minimumEffect} />
          <h3>Pairwise probability of superiority</h3>
          <div className="result-table-wrap">
            <table className="result-table pairwise-table">
              <thead><tr><th>Regimen</th>{regimens.map((regimen) => <th key={regimen.id}>{regimen.label}</th>)}</tr></thead>
              <tbody>{regimens.map((left) => <tr key={left.id}><td><strong>{left.label}</strong></td>{regimens.map((right) => {
                const cell = result.pairwise.find((value) => value.leftId === left.id && value.rightId === right.id)!;
                return <td key={right.id} title={`${cell.matchedLocations} matched location${cell.matchedLocations === 1 ? "" : "s"}`}>{formatProbability(cell.winProbability)}<small>n={cell.matchedLocations}</small></td>;
              })}</tr>)}</tbody>
            </table>
          </div>
          <p className="policy-note">Ranking is by descending exceedance AUC over the cohort's shared Bliss-threshold range. Pairwise rows are compared only where every component is present, observed effect meets the filter, and normalized dose coordinates match. Ties count as half a win. These are descriptive results; confidence intervals require replicate experiments and hierarchical resampling.</p>
        </>
      )}
    </section>
  );
}

const comparisonLineColors = ["#235789", "#27824b", "#c26b18", "#8b4fa3", "#b33b4d", "#287f84", "#6d7131", "#555f6a"];

function ExceedanceChart({ regimens, minimumEffect }: { regimens: ComparisonRegimen[]; minimumEffect: number }) {
  const series = regimens.map((regimen) => ({
    regimen,
    values: regimen.analysis.processed
      .filter((row) => row.concentrations.every((value) => value > 0) && row.effect >= minimumEffect)
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

function SummaryPanel({ analysis, stratifyIndex, showConfidenceIntervals }: { analysis: AnalysisResult; stratifyIndex: number; showConfidenceIntervals: boolean }) {
  const strata = analysis.drugNames.length === 3 ? groupedSummaries(analysis, stratifyIndex) : [];
  const overall = aggregateBliss(analysis.processed.filter((row) => row.concentrations.every((value) => value > 0)));
  const pairAxes = analysis.drugNames.map((_, index) => index).filter((index) => index !== stratifyIndex);
  const pair = inactiveDrugPairSummary(analysis, stratifyIndex);
  return (
    <div className="summary-panel">
      <h1>Bliss interaction summary</h1>
      <div className="metrics-grid">
        <Metric label="Bliss synergy score" value={formatNumber(analysis.summary.meanBliss)} />
        <Metric label="Combination locations" value={String(analysis.summary.combinationCount)} />
        <Metric label="P value vs zero" value={analysis.summary.pValue ?? "—"} />
        <Metric label="Score unit" value="percentage points" />
      </div>
      <table className="result-table summary-table">
        <thead><tr>{strata.length > 0 && <th>{analysis.drugNames[stratifyIndex]}</th>}<th>Mean Bliss synergy</th>{showConfidenceIntervals && <th>Approx. 95% CI</th>}<th>Interpretation</th></tr></thead>
        <tbody>
          {strata.map((stratum) => <tr key={stratum.concentration}><td>{stratum.concentration}</td><td>{formatNumber(stratum.mean)}</td>{showConfidenceIntervals && <td>{formatCi(stratum)}</td>}<td>{synergyFinderInterpretation(stratum.mean)}</td></tr>)}
          <tr><td>{strata.length > 0 ? "Overall" : formatNumber(analysis.summary.meanBliss)}</td>{strata.length > 0 && <td>{formatNumber(analysis.summary.meanBliss)}</td>}{showConfidenceIntervals && <td>{formatCi(overall)}</td>}<td><span className={`interpretation ${analysis.summary.interpretation}`}>{capitalize(analysis.summary.interpretation)}</span></td></tr>
        </tbody>
      </table>
      {pair && (
        <div className="pair-summary">
          <strong>{pairAxes.map((index) => analysis.drugNames[index]).join(" + ")} when {analysis.drugNames[stratifyIndex]} = 0:</strong>
          <span>mean Bliss {formatNumber(pair.mean)}{showConfidenceIntervals ? `; approximate 95% CI ${formatCi(pair)}` : ""} ({pair.count} locations)</span>
        </div>
      )}
      <p className="policy-note">The matrix score is the mean over locations where every drug concentration is positive, matching synergyfinder 3.20.0.</p>
      {showConfidenceIntervals && <p className="policy-note">Summary confidence intervals are approximate and propagate the cellwise bootstrap SEMs; heatmap intervals are the native engine's empirical cellwise bootstrap intervals.</p>}
    </div>
  );
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
      <div className="facet-grid">
        {facetValues.map((facet) => {
          const rows = facet === null ? analysis.processed : analysis.processed.filter((row) => row.concentrations[stratifyIndex] === facet);
          return <Heatmap key={facet ?? "all"} rows={rows} xIndex={axes[1]} yIndex={axes[0]} xName={analysis.drugNames[axes[1]]} yName={analysis.drugNames[axes[0]]} title={facet === null ? null : `${analysis.drugNames[stratifyIndex]} = ${facet}`} maxAbs={maxAbs} colors={colors} showConfidenceIntervals={showConfidenceIntervals} />;
        })}
      </div>
    </div>
  );
}

function Heatmap({ rows, xIndex, yIndex, xName, yName, title, maxAbs, colors, showConfidenceIntervals }: { rows: ProcessedCombination[]; xIndex: number; yIndex: number; xName: string; yName: string; title: string | null; maxAbs: number; colors: PlotColors; showConfidenceIntervals: boolean }) {
  const xValues = uniqueSorted(rows.map((row) => row.concentrations[xIndex]));
  const yValues = uniqueSorted(rows.map((row) => row.concentrations[yIndex])).reverse();
  const lookup = new Map(rows.map((row) => [`${row.concentrations[xIndex]}|${row.concentrations[yIndex]}`, row]));
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
            return <span className="heat-cell" key={`${x}-${y}`} title={row ? `Bliss: ${formatNumber(row.blissInteraction)}${row.blissCiLeft == null || row.blissCiRight == null ? "" : `; 95% CI ${formatNumber(row.blissCiLeft)} to ${formatNumber(row.blissCiRight)}`}` : "Not observed"} style={{ backgroundColor: row ? interactionColor(row.blissInteraction, maxAbs, colors) : "#edf0f2" }}>{row ? <><strong>{formatNumber(row.blissInteraction, 2)}</strong>{showConfidenceIntervals && row.blissCiLeft != null && row.blissCiRight != null && <small>{formatNumber(row.blissCiLeft, 1)} to {formatNumber(row.blissCiRight, 1)}</small>}</> : "—"}</span>;
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
          <thead><tr>{analysis.drugNames.map((name) => <th key={name}>{name}</th>)}{analysis.drugNames.map((name) => <th key={`mic-${name}`}>{name} log₂(dose/MIC)</th>)}<th>Original response</th><th>Inhibition (%)</th>{analysis.drugNames.map((name) => <th key={`effect-${name}`}>{name} inhibition</th>)}<th>Bliss expected</th><th>Bliss synergy</th><th>95% CI</th><th>Replicates</th></tr></thead>
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
  return uniqueSorted(analysis.processed.filter((row) => row.concentrations.every((value) => value > 0)).map((row) => row.concentrations[index])).map((concentration) => {
    const rows = analysis.processed.filter((row) => row.concentrations.every((value) => value > 0) && row.concentrations[index] === concentration);
    return { concentration, ...aggregateBliss(rows) };
  });
}

function formatCi(summary: { ciLeft: number | null; ciRight: number | null }) {
  return summary.ciLeft == null || summary.ciRight == null ? "—" : `${formatNumber(summary.ciLeft)} to ${formatNumber(summary.ciRight)}`;
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
