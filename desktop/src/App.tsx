import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";

import { buildMapping, compareRegimens, formatNumber, roleLabel, validateRoles } from "./analysis";
import logo from "./assets/logo.png";
import {
  defaultPlotColors,
  loadPlotColors,
  savePlotColors,
  type PlotColors,
} from "./preferences";
import type {
  AnalysisResult,
  AppError,
  ColumnRole,
  ComparisonRegimen,
  ComparisonSettings,
  ImportPreview,
  ImportRequest,
  ProcessedCombination,
} from "./types";
import "./App.css";

type Page = "import" | "analyze" | "compare";
type ResultTab = "summary" | "heatmap" | "bar" | "processed";

const BarPlot = lazy(() => import("./BarPlot"));

const roleOptions: ColumnRole[] = ["ignore", "drugA", "drugB", "drugC", "od"];

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
  synergyThresholds: [0.1, 0.2],
  antagonismThreshold: 0.1,
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
  const [error, setError] = useState<string | null>(null);
  const [stratifyIndex, setStratifyIndex] = useState(2);
  const [odThreshold, setOdThreshold] = useState(0.05);
  const [showCensoredOd, setShowCensoredOd] = useState(true);
  const [colors, setColors] = useState<PlotColors>(defaultPlotColors);
  const [comparisonRegimens, setComparisonRegimens] = useState<ComparisonRegimen[]>([]);
  const [comparisonSettings, setComparisonSettings] = useState(initialComparisonSettings);

  useEffect(() => {
    loadPlotColors().then(setColors).catch(() => undefined);
  }, []);

  const mappingErrors = useMemo(() => validateRoles(roles), [roles]);

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

  async function runAnalysis(threshold = odThreshold, preserveView = false) {
    if (!preview) return;
    const mapping = buildMapping(preview, roles);
    if (!mapping) return;
    setBusy(true);
    setError(null);
    try {
      const result = await invoke<AnalysisResult>("analyze_table", {
        request: {
          import: importRequest,
          mapping,
          policy: {
            cellAdditiveThreshold: 0.05,
            odCensorThreshold: threshold,
            allowIncompleteGrid: true,
          },
        },
      });
      setAnalysis(result);
      if (!preserveView) {
        setStratifyIndex(result.drugNames.length - 1);
        setPage("analyze");
        setTab("summary");
      }
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
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
    }]);
    setPage("compare");
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <img className="brand-mark" src={logo} alt="Pmetrics logo" />
          <span>Checkerboard Bliss</span>
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
            <OdDisplayControls
              threshold={odThreshold}
              onThresholdChange={setOdThreshold}
              showCensored={showCensoredOd}
              onShowCensoredChange={setShowCensoredOd}
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
                            const censored = roles[columnIndex] === "od" && shouldCensorOd(value, odThreshold);
                            return (
                              <td
                                className={showCensoredOd && censored ? "censored-value" : undefined}
                                title={showCensoredOd && censored ? `Original OD: ${value}; analyzed as 0` : value ?? ""}
                                key={columnIndex}
                              >
                                {showCensoredOd && censored ? displayCell("0") : displayCell(value)}
                              </td>
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
                <button className="success-button" disabled={mappingErrors.length > 0 || busy} onClick={() => runAnalysis()}>
                  {busy ? "Analyzing…" : "Analyze with Bliss"}
                </button>
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
          odThreshold={odThreshold}
          setOdThreshold={setOdThreshold}
          showCensoredOd={showCensoredOd}
          setShowCensoredOd={setShowCensoredOd}
          applyThreshold={() => runAnalysis(odThreshold, true)}
          busy={busy}
          addToComparison={addCurrentToComparison}
          alreadyAdded={comparisonRegimens.some((regimen) => regimen.analysis === analysis)}
        />
      ) : (
        <ComparisonWorkspace
          regimens={comparisonRegimens}
          settings={comparisonSettings}
          setSettings={setComparisonSettings}
          setRegimens={setComparisonRegimens}
          importAnother={() => setPage("import")}
        />
      )}
    </div>
  );
}

function NumberField({ label, value, min, onChange }: { label: string; value: number; min: number; onChange: (value: number) => void }) {
  return (
    <label>
      {label}
      <input type="number" min={min} step={1} value={value} onChange={(event) => onChange(Math.max(min, Number(event.target.value) || 0))} />
    </label>
  );
}

function OdDisplayControls({ threshold, onThresholdChange, showCensored, onShowCensoredChange }: {
  threshold: number;
  onThresholdChange: (value: number) => void;
  showCensored: boolean;
  onShowCensoredChange: (value: boolean) => void;
}) {
  return (
    <div className="od-display-controls">
      <label>
        OD censor threshold
        <input
          type="number"
          min={0}
          step={0.001}
          value={threshold}
          onChange={(event) => onThresholdChange(Math.max(0, Number(event.target.value) || 0))}
        />
      </label>
      <label className="switch-field">
        Display
        <span className="switch-control">
          <input
            type="checkbox"
            checked={showCensored}
            onChange={(event) => onShowCensoredChange(event.target.checked)}
          />
          <span>{showCensored ? "Censored OD" : "Original OD"}</span>
        </span>
      </label>
      <span className="field-help">Negative OD values and values with absolute magnitude below the threshold are analyzed as zero. Displayed censored values are highlighted.</span>
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

function AnalysisWorkspace({ analysis, tab, setTab, stratifyIndex, setStratifyIndex, colors, setColors, odThreshold, setOdThreshold, showCensoredOd, setShowCensoredOd, applyThreshold, busy, addToComparison, alreadyAdded }: {
  analysis: AnalysisResult;
  tab: ResultTab;
  setTab: (tab: ResultTab) => void;
  stratifyIndex: number;
  setStratifyIndex: (index: number) => void;
  colors: PlotColors;
  setColors: (colors: PlotColors) => void;
  odThreshold: number;
  setOdThreshold: (value: number) => void;
  showCensoredOd: boolean;
  setShowCensoredOd: (value: boolean) => void;
  applyThreshold: () => Promise<void>;
  busy: boolean;
  addToComparison: () => void;
  alreadyAdded: boolean;
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
          <p className="combination-name">{analysis.drugNames.join(" + ")}</p>
          <p className="help-text">Control mean OD: {formatNumber(analysis.control.meanOd)} from {analysis.control.replicateCount} replicate{analysis.control.replicateCount === 1 ? "" : "s"}.</p>
        </section>
        <OdDisplayControls
          threshold={odThreshold}
          onThresholdChange={setOdThreshold}
          showCensored={showCensoredOd}
          onShowCensoredChange={setShowCensoredOd}
        />
        <button className="secondary-button full-width" disabled={busy} onClick={applyThreshold}>
          {busy ? "Applying…" : "Apply OD censoring"}
        </button>
        {analysis.drugNames.length === 3 && (
          <label>
            Stratify / facet by
            <select value={stratifyIndex} onChange={(event) => setStratifyIndex(Number(event.target.value))}>
              {analysis.drugNames.map((name, index) => <option value={index} key={name}>{name}</option>)}
            </select>
          </label>
        )}
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
        <hr />
        <button className="success-button full-width comparison-add" disabled={alreadyAdded} onClick={addToComparison}>
          {alreadyAdded ? "Added to comparison" : "Add to comparison"}
        </button>
        <p className="help-text">Add two or more analyzed regimens, then rank them at matched relative dose locations.</p>
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
          {tab === "summary" && <SummaryPanel analysis={analysis} stratifyIndex={stratifyIndex} />}
          {tab === "heatmap" && <HeatmapPanel analysis={analysis} stratifyIndex={stratifyIndex} colors={colors} />}
          {tab === "bar" && (
            <Suspense fallback={<div className="empty-state"><h2>Loading interactive plot…</h2></div>}>
              <BarPlot analysis={analysis} stratifyIndex={stratifyIndex} colors={colors} />
            </Suspense>
          )}
          {tab === "processed" && <ProcessedTable analysis={analysis} showCensoredOd={showCensoredOd} />}
        </div>
      </section>
    </main>
  );
}

function ComparisonWorkspace({ regimens, settings, setSettings, setRegimens, importAnother }: {
  regimens: ComparisonRegimen[];
  settings: ComparisonSettings;
  setSettings: (settings: ComparisonSettings) => void;
  setRegimens: (regimens: ComparisonRegimen[]) => void;
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
            <p>Probability of superiority at matched relative dose coordinates.</p>
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
            />
          ))}
        </div>
      </section>
    </main>
  );
}

function ComparisonPercentField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return <label>{label} (%)<input type="number" step={1} value={value * 100} onChange={(event) => onChange(Math.max(0, Number(event.target.value) || 0) / 100)} /></label>;
}

function ComparisonCohort({ drugCount, regimens, settings, rename, remove }: {
  drugCount: 2 | 3;
  regimens: ComparisonRegimen[];
  settings: ComparisonSettings;
  rename: (id: string, label: string) => void;
  remove: (id: string) => void;
}) {
  const result = regimens.length >= 2 ? compareRegimens(regimens, settings) : null;
  return (
    <section className="comparison-section">
      <h2>{drugCount}-drug regimens</h2>
      <div className="regimen-list">
        {regimens.map((regimen) => (
          <div className="regimen-item" key={regimen.id}>
            <input aria-label={`Name for ${regimen.label}`} value={regimen.label} onChange={(event) => rename(regimen.id, event.target.value)} />
            <span>{regimen.analysis.processed.filter((row) => row.concentrations.every((value) => value > 0)).length} combination locations</span>
            <button aria-label={`Remove ${regimen.label}`} onClick={() => remove(regimen.id)}>Remove</button>
          </div>
        ))}
      </div>
      {!result ? <div className="comparison-empty">Add one more {drugCount}-drug regimen to calculate its ranking.</div> : (
        <>
          <h3>Overall ranking</h3>
          <div className="result-table-wrap">
            <table className="result-table ranking-table">
              <thead><tr><th>Rank</th><th>Regimen</th><th>Avg. win probability</th><th>Eligible locations</th><th>Bliss ≥ {formatPercent(settings.synergyThresholds[0])}</th><th>Bliss ≥ {formatPercent(settings.synergyThresholds[1])}</th><th>Bliss ≤ −{formatPercent(settings.antagonismThreshold)}</th></tr></thead>
              <tbody>{result.rankings.map((row) => <tr key={row.regimen.id}><td>{row.rank}</td><td><strong>{row.regimen.label}</strong></td><td>{formatProbability(row.averageWinProbability)}</td><td>{row.eligibleLocations}</td><td>{formatProbability(row.synergyBreadth[0])}</td><td>{formatProbability(row.synergyBreadth[1])}</td><td>{formatProbability(row.antagonismBurden)}</td></tr>)}</tbody>
            </table>
          </div>
          <h3>Synergy exceedance curves</h3>
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
          <p className="policy-note">Rows are compared only where every component is present, observed effect meets the filter, and normalized dose coordinates match. Ties count as half a win. These are descriptive results; confidence intervals require replicate experiments and hierarchical resampling.</p>
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
  let minimum = Math.min(0, ...allValues);
  let maximum = Math.max(0, ...allValues);
  if (maximum - minimum < 0.01) {
    minimum -= 0.01;
    maximum += 0.01;
  }
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
  return `${(value * 100).toFixed(value * 100 % 1 ? 1 : 0)}%`;
}

function SummaryPanel({ analysis, stratifyIndex }: { analysis: AnalysisResult; stratifyIndex: number }) {
  const strata = analysis.drugNames.length === 3 ? groupedSummaries(analysis, stratifyIndex) : [];
  return (
    <div className="summary-panel">
      <h1>Bliss interaction summary</h1>
      <div className="metrics-grid">
        <Metric label="Bliss sum" value={formatNumber(analysis.summary.sumBliss)} />
        <Metric label="Mean Bliss" value={formatNumber(analysis.summary.meanBliss)} />
        <Metric label="Positive sum" value={formatNumber(analysis.summary.positiveSum)} />
        <Metric label="Negative sum" value={formatNumber(analysis.summary.negativeSum)} />
      </div>
      <table className="result-table summary-table">
        <thead><tr>{strata.length > 0 && <th>{analysis.drugNames[stratifyIndex]}</th>}<th>Bliss Sum</th><th>Interpretation</th></tr></thead>
        <tbody>
          {strata.map((stratum) => <tr key={stratum.concentration}><td>{stratum.concentration}</td><td>{formatNumber(stratum.sum)}</td><td>{legacyInterpretation(stratum.sum)}</td></tr>)}
          <tr><td>{strata.length > 0 ? "Total" : formatNumber(analysis.summary.sumBliss)}</td>{strata.length > 0 && <td>{formatNumber(analysis.summary.sumBliss)}</td>}<td><span className={`interpretation ${analysis.summary.interpretation}`}>{capitalize(analysis.summary.interpretation)}</span></td></tr>
        </tbody>
      </table>
      <p className="policy-note">Legacy aggregate thresholds are preserved for compatibility. Mean and signed sums are shown because the total depends on grid size.</p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}

function HeatmapPanel({ analysis, stratifyIndex, colors }: { analysis: AnalysisResult; stratifyIndex: number; colors: PlotColors }) {
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
          return <Heatmap key={facet ?? "all"} rows={rows} xIndex={axes[1]} yIndex={axes[0]} xName={analysis.drugNames[axes[1]]} yName={analysis.drugNames[axes[0]]} title={facet === null ? null : `${analysis.drugNames[stratifyIndex]} = ${facet}`} maxAbs={maxAbs} colors={colors} />;
        })}
      </div>
    </div>
  );
}

function Heatmap({ rows, xIndex, yIndex, xName, yName, title, maxAbs, colors }: { rows: ProcessedCombination[]; xIndex: number; yIndex: number; xName: string; yName: string; title: string | null; maxAbs: number; colors: PlotColors }) {
  const xValues = uniqueSorted(rows.map((row) => row.concentrations[xIndex]));
  const yValues = uniqueSorted(rows.map((row) => row.concentrations[yIndex])).reverse();
  const lookup = new Map(rows.map((row) => [`${row.concentrations[xIndex]}|${row.concentrations[yIndex]}`, row]));
  return (
    <figure className="heatmap-figure">
      {title && <figcaption>{title}</figcaption>}
      <div className="heatmap-y-name">{yName}</div>
      <div className="heatmap-grid" style={{ gridTemplateColumns: `3.2rem repeat(${xValues.length}, minmax(3rem, 1fr))` }}>
        <span />
        {xValues.map((value) => <span className="axis-label" key={`x-${value}`}>{value}</span>)}
        {yValues.flatMap((y) => [
          <span className="axis-label" key={`yl-${y}`}>{y}</span>,
          ...xValues.map((x) => {
            const row = lookup.get(`${x}|${y}`);
            return <span className="heat-cell" key={`${x}-${y}`} title={row ? `Bliss: ${formatNumber(row.blissInteraction)}` : "Not observed"} style={{ backgroundColor: row ? interactionColor(row.blissInteraction, maxAbs, colors) : "#edf0f2" }}>{row ? formatNumber(row.blissInteraction, 2) : "—"}</span>;
          }),
        ])}
      </div>
      <div className="heatmap-x-name">{xName}</div>
    </figure>
  );
}

function ProcessedTable({ analysis, showCensoredOd }: { analysis: AnalysisResult; showCensoredOd: boolean }) {
  return (
    <div className="processed-panel">
      <h1>Processed combinations</h1>
      <div className="result-table-wrap">
        <table className="result-table">
          <thead><tr>{analysis.drugNames.map((name) => <th key={name}>{name}</th>)}<th>Mean OD</th><th>Effect</th>{analysis.drugNames.map((name) => <th key={`effect-${name}`}>Effect {name}</th>)}<th>Bliss expected</th><th>Bliss interaction</th><th>Replicates</th></tr></thead>
          <tbody>{analysis.processed.map((row, index) => <tr key={index}>{row.concentrations.map((value, column) => <td key={column}>{value}</td>)}<td className={showCensoredOd && row.censoredReplicateCount > 0 ? "censored-value" : undefined} title={row.censoredReplicateCount > 0 ? `${row.censoredReplicateCount} of ${row.replicateCount} OD values censored; original mean ${formatNumber(row.meanOriginalOd)}` : undefined}>{formatNumber(showCensoredOd ? row.meanCensoredOd : row.meanOriginalOd)}</td><td>{formatNumber(row.effect)}</td>{row.singleAgentEffects.map((value, column) => <td key={column}>{formatNumber(value)}</td>)}<td>{formatNumber(row.blissExpected)}</td><td className={row.interpretation}>{formatNumber(row.blissInteraction)}</td><td>{row.replicateCount}</td></tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="color-field">{label}<span><input type="color" value={value} onChange={(event) => onChange(event.target.value)} /><input value={value} onChange={(event) => onChange(event.target.value)} /></span></label>;
}

function groupedSummaries(analysis: AnalysisResult, index: number) {
  return uniqueSorted(analysis.processed.map((row) => row.concentrations[index])).map((concentration) => ({
    concentration,
    sum: analysis.processed.filter((row) => row.concentrations[index] === concentration).reduce((total, row) => total + row.blissInteraction, 0),
  }));
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

function legacyInterpretation(value: number) {
  return value > 1 ? "Synergistic" : value < 0 ? "Antagonistic" : "Additive";
}

function displayCell(value?: string) {
  if (value === undefined || value === "") return "";
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(3) : value;
}

function shouldCensorOd(value: string | undefined, threshold: number) {
  if (value === undefined || value.trim() === "") return false;
  const numeric = Number(value);
  return Number.isFinite(numeric) && (numeric < 0 || Math.abs(numeric) < threshold);
}

function errorMessage(reason: unknown) {
  if (reason && typeof reason === "object" && "message" in reason) return String((reason as AppError).message);
  return typeof reason === "string" ? reason : "An unexpected error occurred.";
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export default App;
