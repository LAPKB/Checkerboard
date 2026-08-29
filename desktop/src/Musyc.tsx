import { useEffect, useState } from "react";
import { RegimenNavigator } from "./RegimenNavigator";

import type { DrusanoCensorLimitSuggestion, InputSettings, MusycFitResult, MusycModelSettings, RegimenPreview } from "./types";

type FitEntry = { id: string; label: string; fit: MusycFitResult };
type FitProgress = { phase: "reference" | "bootstrap"; iteration: number; objectiveFunction: number; completedBootstraps: number; totalBootstraps: number; regimenLabel?: string };

export function MusycFitWorkspace({ fits, busy, progress, fit, inputType, settings, setSettings, suggestion, suggestionBusy, suggestionError, settingsComplete, regimens }: {
  fits: FitEntry[];
  busy: boolean;
  progress: FitProgress | null;
  fit: () => Promise<void>;
  inputType: InputSettings["inputType"];
  settings: MusycModelSettings;
  setSettings: (value: MusycModelSettings) => void;
  suggestion: DrusanoCensorLimitSuggestion | null;
  suggestionBusy: boolean;
  suggestionError: string | null;
  settingsComplete: boolean;
  regimens: RegimenPreview[];
}) {
  const [selectedId, setSelectedId] = useState<string | null>(fits[0]?.id ?? null);
  useEffect(() => {
    if (!fits.some((entry) => entry.id === selectedId)) setSelectedId(fits[0]?.id ?? null);
  }, [fits, selectedId]);
  const selected = fits.find((entry) => entry.id === selectedId) ?? fits[0] ?? null;
  const result = selected?.fit;
  const regimen = regimens.find((entry) => entry.id === selected?.id);
  const units = regimen?.concentrationUnits ?? [];

  return <main className="workspace"><aside className="sidebar">
    <h2>MuSyC surface fit</h2>
    <p className="help-text">Fit the two-drug four-state MuSyC model. Potency interactions are directional (α₁₂ and α₂₁), efficacy is represented by E₃ and β, and cooperativity interactions by γ₁₂ and γ₂₁.</p>
    {inputType === "absorbance" && <section className="drusano-model-settings">
      <h3>Response censoring</h3>
      <label>Absorbance censor limit (L)<input type="number" step="any" value={settings.responseCensorLimit ?? ""} onChange={(event) => setSettings({ ...settings, responseCensorLimit: nullableNumber(event.target.value) })} /></label>
      <span className="field-help">Responses at or below L are retained as one-sided observations. MuSyC fits normalized inhibition, so censored wells mean observed E ≥ E<sub>L</sub>.</span>
      {suggestionBusy ? <p className="help-text">Examining the lower-response frequency distribution…</p>
        : suggestion ? <div className="censor-suggestion"><div><strong>Data suggestion: {format(suggestion.responseCensorLimit)}</strong><span>{suggestion.belowOrEqualCount} of {suggestion.responseCount} responses at or below L · E<sub>L</sub> = {format(suggestion.normalizedEffectLimit)}</span></div><button className="secondary-button" disabled={busy} onClick={() => setSettings({ ...settings, responseCensorLimit: suggestion.responseCensorLimit })}>Use suggestion</button></div>
          : <p className="help-text">{suggestionError ? `Suggestion unavailable: ${suggestionError}` : "No clear lower-response frequency break was detected. Enter an assay-validated limit."}</p>}
    </section>}
    <section className="drusano-model-settings">
      <h3>Optimizer</h3>
      <label>Maximum iterations<input type="number" min="100" max="50000" step="100" value={settings.maxIterations ?? ""} onChange={(event) => setSettings({ ...settings, maxIterations: nullableNumber(event.target.value) })} /></label>
      <span className="field-help">The default is 5,000 bounded nonlinear least-squares iterations. Monotherapy observations initialize E₁, E₂, C₁, C₂, h₁, and h₂ before the joint surface fit.</span>
      <label>Bootstrap fits<input type="number" min="1" max="10000" step="1" value={settings.bootstrapIterations ?? ""} onChange={(event) => setSettings({ ...settings, bootstrapIterations: nullableNumber(event.target.value) })} /></label>
      <label>Bootstrap seed<input type="number" min="0" step="1" value={settings.bootstrapSeed ?? ""} onChange={(event) => setSettings({ ...settings, bootstrapSeed: nullableNumber(event.target.value) })} /></label>
      <span className="field-help">Defaults: 500 fixed-dose-grid parametric bootstrap fits with seed 123.</span>
    </section>
    <button className="primary-button full-width" disabled={busy || !settingsComplete} onClick={fit}>{busy ? "Fitting MuSyC…" : fits.length ? "Refit MuSyC" : "Fit MuSyC"}</button>
    {progress && <div className="analysis-progress" role="status" aria-live="polite">
      <div><strong>{progress.regimenLabel ? `${progress.phase === "bootstrap" ? "Bootstrapping" : "Reference fit"}: ${progress.regimenLabel}` : progress.phase === "bootstrap" ? "Bootstrapping MuSyC" : "Fitting MuSyC reference"}</strong><span>{progress.phase === "bootstrap" ? `${progress.completedBootstraps} of ${progress.totalBootstraps} bootstrap fits` : `Iteration ${progress.iteration}`}{Number.isFinite(progress.objectiveFunction) ? ` · objective ${format(progress.objectiveFunction)}` : ""}</span></div>
      {progress.phase === "bootstrap" ? <progress value={progress.completedBootstraps} max={Math.max(1, progress.totalBootstraps)} /> : <progress />}
    </div>}
    <div className="side-warning"><strong>Interpretation:</strong> positive β means the fitted combination state is more efficacious than the stronger monotherapy. α &gt; 1 indicates increased potency; γ &gt; 1 indicates increased cooperativity.</div>
  </aside><section className="content-card stage-card">
    <div className="card-heading"><div><h1>MuSyC analysis</h1><p>Separate estimates of efficacy, directional potency, and directional cooperativity interactions.</p></div>{fits.length > 0 && <span className="count-badge">{fits.length} fit{fits.length === 1 ? "" : "s"}</span>}</div>
    <div className="stage-content">{result ? <>
      {fits.length > 1 && <RegimenNavigator regimens={fits} selectedId={selected?.id ?? fits[0].id} onSelect={setSelectedId} compact label="Displayed regimen" />}
      <div className={result.converged ? "mapping-status ready" : "mapping-status warning"}>{result.converged ? "MuSyC converged" : "MuSyC reached the iteration limit"} after {result.iterations.toLocaleString()} iterations. Mean squared one-sided residual objective: {format(result.objectiveFunction)}.</div>
      <div className="summary-metrics">
        <div><span>Median β (95% CI)</span><strong>{format(result.efficacyBetaSummary?.median ?? Number.NaN)} ({formatInterval(result.efficacyBetaSummary)})</strong></div>
        <div><span>Median E₃ (95% CI)</span><strong>{format(result.combinationEfficacySummary?.median ?? Number.NaN)} ({formatInterval(result.combinationEfficacySummary)})</strong></div>
        <div><span>Observed/predicted R²</span><strong>{format(result.regression?.rSquared ?? Number.NaN)}</strong></div>
        <div><span>RMSE</span><strong>{format(result.regression?.rootMeanSquaredError ?? Number.NaN)}</strong></div>
        <div><span>Below LOD</span><strong>{result.data.censoredCount}</strong></div>
      </div>
      <MusycObservedPredicted result={result} />
      <h2>Derived efficacy bootstrap summaries</h2>
      <div className="result-table-wrap"><table className="result-table"><thead><tr><th>Quantity</th><th>Reference</th><th>Bootstrap mean</th><th>Bootstrap SD</th><th>Median</th><th>95% confidence interval</th></tr></thead><tbody>
        <DistributionSummaryRow label="β efficacy synergy" reference={result.efficacyBeta} summary={result.efficacyBetaSummary} />
        <DistributionSummaryRow label="E₃ combination efficacy" reference={result.combinationEfficacy} summary={result.combinationEfficacySummary} />
      </tbody></table></div>
      <h2>Reference estimates and bootstrap confidence intervals</h2>
      <div className="result-table-wrap"><table className="result-table"><thead><tr><th>Parameter</th><th>Reference</th><th>Bootstrap mean</th><th>Bootstrap SD</th><th>Median</th><th>95% confidence interval</th><th>Units</th></tr></thead><tbody>{result.parameters.map((parameter) => {
        const drugIndex = parameter.name === "c1" ? 0 : parameter.name === "c2" ? 1 : null;
        const scale = drugIndex == null ? 1 : result.data.maxConcentrations[drugIndex];
        const summary = result.parameterSummaries.find((entry) => entry.name === parameter.name);
        return <tr key={parameter.name} title={parameterMeaning(parameter.name)}><td><strong>{parameterLabel(parameter.name, result.data.drugNames)}</strong>{parameter.fixed ? " (fixed)" : ""}</td><td>{format(parameter.value * scale)}</td><td>{format((summary?.mean ?? Number.NaN) * scale)}</td><td>{format((summary?.standardDeviation ?? Number.NaN) * scale)}</td><td>{format((summary?.median ?? Number.NaN) * scale)}</td><td>{format((summary?.percentile2_5 ?? Number.NaN) * scale)}–{format((summary?.percentile97_5 ?? Number.NaN) * scale)}</td><td>{drugIndex == null ? "unitless" : units[drugIndex] || "imported concentration units"}</td></tr>;
      })}</tbody></table></div>
      <p className="help-text">{result.bootstrapIterations} fixed-dose-grid parametric bootstrap fits with seed {result.bootstrapSeed}; {result.bootstrapConvergedCount} converged. Residual SD on normalized effect: {format(result.residualStandardDeviation)}. C₁ and C₂ are rescaled to imported units; E₀ is fixed at 0.</p>
      {result.warnings.map((warning) => <div className="mapping-status warning" key={warning}>{warning}</div>)}
      <details><summary>Read-only MuSyC model</summary><pre className="model-code">{result.modelSource}</pre></details>
    </> : <div className="empty-state"><div className="empty-icon">⌁</div><h2>No MuSyC fit yet</h2><p>Complete response normalization, fit the two-drug surface, and generate its bootstrap confidence intervals. Multiple fitted regimens can then be ranked on Compare.</p></div>}</div>
  </section></main>;
}

function DistributionSummaryRow({ label, reference, summary }: { label: string; reference: number; summary: MusycFitResult["efficacyBetaSummary"] }) {
  return <tr><td><strong>{label}</strong></td><td>{format(reference)}</td><td>{format(summary?.mean ?? Number.NaN)}</td><td>{format(summary?.standardDeviation ?? Number.NaN)}</td><td>{format(summary?.median ?? Number.NaN)}</td><td>{formatInterval(summary)}</td></tr>;
}

export function MusycComparisonWorkspace({ fits }: { fits: FitEntry[] }) {
  const [metric, setMetric] = useState<"beta" | "e3">("beta");
  const ranked = fits.slice().sort((left, right) => {
    const leftValue = metric === "beta" ? left.fit.efficacyBetaSummary?.median : left.fit.combinationEfficacySummary?.median;
    const rightValue = metric === "beta" ? right.fit.efficacyBetaSummary?.median : right.fit.combinationEfficacySummary?.median;
    return finiteRank(rightValue) - finiteRank(leftValue) || left.label.localeCompare(right.label);
  });
  return <main className="single-workspace"><section className="content-card comparison-card">
    <div className="card-heading"><div><h1>MuSyC efficacy comparison</h1><p>Rank regimens using the bootstrap distributions from their fitted response surfaces.</p></div><span className="count-badge">{fits.length} fits</span></div>
    <div className="comparison-content"><section className="comparison-section">
      <label className="compact-setting">Rank by<select value={metric} onChange={(event) => setMetric(event.target.value as "beta" | "e3")}><option value="beta">Bootstrap median β efficacy synergy</option><option value="e3">Bootstrap median E₃ absolute efficacy</option></select></label>
      <div className="result-table-wrap"><table className="result-table ranking-table"><thead><tr><th>Rank</th><th>Regimen</th><th>Reference β</th><th>Bootstrap median β</th><th>β 95% interval</th><th>Reference E₃</th><th>Bootstrap median E₃</th><th>E₃ 95% interval</th></tr></thead><tbody>
        {ranked.map((entry, index) => <tr key={entry.id}><td>{index + 1}</td><td><strong>{entry.label}</strong></td><td>{format(entry.fit.efficacyBeta)}</td><td>{format(entry.fit.efficacyBetaSummary?.median ?? Number.NaN)}</td><td>{formatInterval(entry.fit.efficacyBetaSummary)}</td><td>{format(entry.fit.combinationEfficacy)}</td><td>{format(entry.fit.combinationEfficacySummary?.median ?? Number.NaN)}</td><td>{formatInterval(entry.fit.combinationEfficacySummary)}</td></tr>)}
      </tbody></table></div>
      <p className="policy-note">The selected bootstrap median determines rank. β measures efficacy synergy relative to the stronger fitted monotherapy; E₃ measures absolute combination-state efficacy. Review both because a regimen can have strong absolute efficacy without a positive β, or vice versa.</p>
    </section></div>
  </section></main>;
}

function MusycObservedPredicted({ result }: { result: MusycFitResult }) {
  const width = 620, height = 400;
  const margin = { left: 62, right: 22, top: 20, bottom: 56 };
  const x = (value: number) => margin.left + value * (width - margin.left - margin.right);
  const y = (value: number) => margin.top + (1 - value) * (height - margin.top - margin.bottom);
  const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1];
  return <section className="drusano-fit-plot"><div><h2>Observed vs. predicted normalized effect</h2><p className="help-text">Predicted effect is on the x-axis. Censored observations are shown at E<sub>L</sub> and contribute a one-sided residual.</p></div><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="MuSyC observed versus predicted normalized effect">
    {ticks.map((tick) => <g key={tick}><line className="chart-grid" x1={x(tick)} x2={x(tick)} y1={margin.top} y2={height - margin.bottom} /><line className="chart-grid" x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} /><text x={x(tick)} y={height - margin.bottom + 22} textAnchor="middle">{tick.toFixed(1)}</text><text x={margin.left - 10} y={y(tick) + 4} textAnchor="end">{tick.toFixed(1)}</text></g>)}
    <line className="identity-line" x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} />
    {result.predictions.map((point) => <circle className={`prediction-point ${doseClass(point.normalizedDoses)}`} key={point.wellId} cx={x(point.predictedEffect)} cy={y(point.observedEffect)} r="4"><title>{`Well ${point.wellId}: predicted ${format(point.predictedEffect)}, observed ${point.censored ? "≥ " : ""}${format(point.observedEffect)}`}</title></circle>)}
    <text className="chart-axis-title" x={(margin.left + width - margin.right) / 2} y={height - 10} textAnchor="middle">Predicted normalized effect</text>
    <text className="chart-axis-title" transform={`translate(18 ${(margin.top + height - margin.bottom) / 2}) rotate(-90)`} textAnchor="middle">Observed normalized effect</text>
  </svg></section>;
}

function parameterLabel(name: string, drugs: string[]) {
  return ({ e0: "E₀", e1: `E₁ (${drugs[0] ?? "Drug 1"})`, e2: `E₂ (${drugs[1] ?? "Drug 2"})`, e3: "E₃", c1: `C₁ / EC50 (${drugs[0] ?? "Drug 1"})`, c2: `C₂ / EC50 (${drugs[1] ?? "Drug 2"})`, h1: "h₁", h2: "h₂", alpha_12: "α₁₂", alpha_21: "α₂₁", gamma_12: "γ₁₂", gamma_21: "γ₂₁" } as Record<string, string>)[name] ?? name;
}

function parameterMeaning(name: string) {
  return ({ e0: "Untreated baseline effect", e1: "Drug 1 maximal efficacy", e2: "Drug 2 maximal efficacy", e3: "Combination-state maximal efficacy", c1: "Drug 1 monotherapy potency", c2: "Drug 2 monotherapy potency", h1: "Drug 1 Hill slope", h2: "Drug 2 Hill slope", alpha_12: "Drug 1-induced fold change in drug 2 potency", alpha_21: "Drug 2-induced fold change in drug 1 potency", gamma_12: "Drug 1-induced fold change in drug 2 cooperativity", gamma_21: "Drug 2-induced fold change in drug 1 cooperativity" } as Record<string, string>)[name] ?? "";
}

function doseClass(doses: number[]) {
  if ((doses[0] ?? 0) > 0 && (doses[1] ?? 0) <= 0) return "drug-1";
  if ((doses[1] ?? 0) > 0 && (doses[0] ?? 0) <= 0) return "drug-2";
  return "combination";
}

function nullableNumber(value: string): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteRank(value: number | null | undefined) { return value != null && Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY; }
function formatInterval(value: MusycFitResult["efficacyBetaSummary"]) { return value ? `${format(value.percentile2_5)}–${format(value.percentile97_5)}` : "—"; }
function format(value: number) { return Number.isFinite(value) ? value.toLocaleString(undefined, { maximumSignificantDigits: 6 }) : "—"; }
