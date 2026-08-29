import { useEffect, useState } from "react";

import {
  compareDrusanoSimulations,
  drusanoDiagnosticPoint,
  drusanoDiagnosticRegression,
  type DrusanoDiagnosticPoint,
  type DrusanoDiagnosticScale,
} from "./analysis";
import { RegimenNavigator } from "./RegimenNavigator";

import type {
  AnalysisType,
  DrusanoCensorLimitSuggestion,
  DrusanoFitResult,
  DrusanoModelSettings,
  DrusanoRegimenSimulationResult,
  DrusanoSimulationEntry,
  InputSettings,
  RegimenPreview,
} from "./types";

export const DRUSANO_GRECO_MODEL = `# Numerical Drusano-Greco Equation 2 prediction model
# d1 and d2 are dimensionless concentration/maximum-tested-concentration covariates.
# E and XM0 are dimensionless; absorbance remains on the imported response scale.
u = d1 / ec50_1
v = d2 / ec50_2
w = alpha_12 * u * v
z_1 = tanh(log(u))
z_2 = tanh(log(v))
h1_d = h1 * exp(b1 * z_1)
h2_d = h2 * exp(b2 * z_2)
h_1 = 1 / h1_d
h_2 = 1 / h2_d
h_12 = (h_1 + h_2) / 2

solve XM0 > 0 such that:
    1 = u / XM0^h_1 + v / XM0^h_2 + w / XM0^h_12

predicted_effect = XM0 / (1 + XM0)
predicted_absorbance = blank + response_span * (1 - predicted_effect)

error_sd = sqrt(lambda^2 + (
    C0 + C1*predicted_absorbance
       + C2*predicted_absorbance^2
       + C3*predicted_absorbance^3
)^2)`;

type FitEntry = { id: string; label: string; fit: DrusanoFitResult };
type FitProgress = { phase: "reference" | "bootstrap"; cycle: number; objectiveFunction: number; completedBootstraps: number; totalBootstraps: number; regimenLabel?: string };

export function ProjectWorkspace({ analysisType, setAnalysisType }: {
  analysisType: AnalysisType;
  setAnalysisType: (value: AnalysisType) => void;
}) {
  return <main className="single-workspace"><section className="content-card stage-card project-card">
    <div className="card-heading"><div><h1>Analysis algorithm</h1><p>Select the interaction framework for this analysis. Imported data and results remain isolated by workflow.</p></div></div>
    <div className="analysis-choice-grid" role="radiogroup" aria-label="Analysis type">
      <label className={analysisType === "bliss" ? "analysis-choice selected" : "analysis-choice"}>
        <input type="radio" name="analysis-type" checked={analysisType === "bliss"} onChange={() => setAnalysisType("bliss")} />
        <span><strong>Bliss</strong><small>Analyze two- and three-drug checkerboards with SynergyFinder+-compatible Bliss scores and regimen ranking.</small></span>
      </label>
      <label className={analysisType === "drusanoGreco" ? "analysis-choice selected" : "analysis-choice"}>
        <input type="radio" name="analysis-type" checked={analysisType === "drusanoGreco"} onChange={() => setAnalysisType("drusanoGreco")} />
        <span><strong>Drusano–Greco</strong><small>Fit the generalized interaction equation to normalized two-drug checkerboard responses with NPAG.</small></span>
      </label>
      <label className={analysisType === "musyc" ? "analysis-choice selected" : "analysis-choice"}>
        <input type="radio" name="analysis-type" checked={analysisType === "musyc"} onChange={() => setAnalysisType("musyc")} />
        <span><strong>MuSyC</strong><small>Fit a two-drug response surface that separates efficacy, directional potency, and cooperativity interactions.</small></span>
      </label>
    </div>
  </section></main>;
}

export function InputTypeControls({ settings, setSettings, analysisType }: {
  settings: InputSettings;
  setSettings: (value: InputSettings) => void;
  analysisType: AnalysisType;
}) {
  const optical = settings.inputType === "absorbance" || settings.inputType === "fluorescence";
  const update = (patch: Partial<InputSettings>) => setSettings({ ...settings, ...patch });
  return <section className="input-settings">
    <h2>Input response</h2>
    <label>Input type<select value={settings.inputType} onChange={(event) => update({ inputType: event.target.value as InputSettings["inputType"] })}>
      <option value="" disabled>Choose input type…</option>
      <option value="absorbance">Absorbance</option><option value="fluorescence">Fluorescence</option><option value="cfu">CFU</option>
    </select></label>
    {analysisType !== "bliss" ? <>
      <div className="normalization-note">
        <strong>Fixed response normalization</strong>
        <p>Every response type is converted to effect as E = 1 − (observation − blank) / (mean growth control − blank).</p>
        <p>For absorbance, responses at or below the user-selected censor limit are retained with CENS = 1. Configure the limit and assay error model on Fit.</p>
      </div>
      <label className="include-control"><input type="checkbox" checked disabled />Blank adjustment</label>
      <label className="include-control"><input type="checkbox" checked disabled />Relative to growth control</label>
      <label>Blank response<input type="number" step="any" value={settings.blankValue ?? ""} onChange={(event) => update({ blankValue: nullableNumber(event.target.value) })} /><span className="field-help">Enter a value greater than 0 only when the imported responses have not already been blank-adjusted. If they are already blank-adjusted, enter 0.</span></label>
    </> : optical && <>
      <label className="include-control"><input type="checkbox" checked={settings.blankAdjustment} onChange={(event) => update({ blankAdjustment: event.target.checked })} />Blank adjustment</label>
      <label className="include-control"><input type="checkbox" checked={settings.relativeToGrowthControl} onChange={(event) => update({ relativeToGrowthControl: event.target.checked })} />Relative to growth control</label>
      <fieldset className="radio-field"><legend>Response direction</legend>
        <label><input type="radio" name="response-direction" checked={settings.responseDirection === "viability"} onChange={() => update({ responseDirection: "viability" })} />Viability</label>
        <label><input type="radio" name="response-direction" checked={settings.responseDirection === "inhibition"} onChange={() => update({ responseDirection: "inhibition" })} />Inhibition</label>
      </fieldset>
    </>}
  </section>;
}

export function DrusanoFitWorkspace({
  fits, busy, progress, fit, continueFit, inputType, settings, setSettings, suggestion,
  suggestionBusy, suggestionError, settingsComplete, regimens,
}: {
  fits: FitEntry[];
  busy: boolean;
  progress: FitProgress | null;
  fit: () => Promise<void>;
  continueFit: (id: string) => Promise<void>;
  inputType: InputSettings["inputType"];
  settings: DrusanoModelSettings;
  setSettings: (value: DrusanoModelSettings) => void;
  suggestion: DrusanoCensorLimitSuggestion | null;
  suggestionBusy: boolean;
  suggestionError: string | null;
  settingsComplete: boolean;
  regimens: RegimenPreview[];
}) {
  const [selectedId, setSelectedId] = useState<string | null>(fits[0]?.id ?? null);
  const [diagnosticScale, setDiagnosticScale] = useState<DrusanoDiagnosticScale>("effect");
  useEffect(() => {
    if (!fits.some((entry) => entry.id === selectedId)) setSelectedId(fits[0]?.id ?? null);
  }, [fits, selectedId]);
  const selected = fits.find((entry) => entry.id === selectedId) ?? fits[0] ?? null;
  const result = selected?.fit;
  const selectedRegimen = regimens.find((regimen) => regimen.id === selected?.id);
  const concentrationUnits = selectedRegimen?.concentrationUnits ?? [];
  const canContinue = Boolean(result && !result.converged && result.runCycles >= result.maxCycles);
  const shownPoints = result?.supportPoints.slice().sort((left, right) => right.probability - left.probability).slice(0, 100) ?? [];
  const updateCoefficient = (index: number, value: number | null) => {
    const coefficients = [...settings.errorCoefficients] as DrusanoModelSettings["errorCoefficients"];
    coefficients[index] = value;
    setSettings({ ...settings, errorCoefficients: coefficients });
  };

  return <main className="workspace"><aside className="sidebar">
    <h2>NPAG equation fit</h2>
    <p className="help-text">PMcore jointly estimates EC50₁, EC50₂, h₁,₀, h₂,₀, B₁, B₂, and α₁₂ from all eligible drug-exposed wells in one reference fit. It then performs fixed-dose-grid parametric bootstrap refits to estimate uncertainty.</p>
    {inputType === "absorbance" && <section className="drusano-model-settings">
      <h3>Response censoring</h3>
      <label>Absorbance censor limit (L)<input type="number" step="any" value={settings.responseCensorLimit ?? ""} onChange={(event) => setSettings({ ...settings, responseCensorLimit: nullableNumber(event.target.value) })} /></label>
      <span className="field-help">Responses at or below L are retained as CENS = 1. The transformed boundary must satisfy 0 ≤ E<sub>L</sub> &lt; 1.</span>
      {suggestionBusy ? <p className="help-text">Examining the lower-response frequency distribution…</p>
        : suggestion ? <div className="censor-suggestion"><div><strong>Data suggestion: {format(suggestion.responseCensorLimit)}</strong><span>{suggestion.belowOrEqualCount} of {suggestion.responseCount} drug-exposed responses at or below L · E<sub>L</sub> = {format(suggestion.normalizedEffectLimit)} · density drop {format(suggestion.densityRatio)}×</span></div><button className="secondary-button" disabled={busy} onClick={() => setSettings({ ...settings, responseCensorLimit: suggestion.responseCensorLimit })}>Use suggestion</button></div>
          : <p className="help-text">{suggestionError ? `Suggestion unavailable: ${suggestionError}` : "No clear lower-response frequency break was detected. Enter an assay-validated limit."}</p>}
    </section>}
    <section className="drusano-model-settings">
      <h3>Assay error model</h3>
      <p className="help-text">Error polynomial α(f) = C₀ + C₁f + C₂f² + C₃f³, evaluated on each well's predicted {inputType === "absorbance" ? "absorbance" : "response"}. The total variance is λ² + α(f)². Lambda may start at 0; a zero value leaves that variance component off, while a positive value may be optimized by NPAG.</p>
      <div className="error-coefficient-grid">{settings.errorCoefficients.map((value, index) => <label key={index}>C<sub>{index}</sub><input type="number" step="any" value={value ?? ""} onChange={(event) => updateCoefficient(index, nullableNumber(event.target.value))} /></label>)}</div>
      <label>Initial λ (response units)<input type="number" min="0" step="any" value={settings.lambda ?? ""} onChange={(event) => setSettings({ ...settings, lambda: nullableNumber(event.target.value) })} /></label>
    </section>
    <section className="drusano-model-settings">
      <h3>NPAG runtime</h3>
      <label>Maximum cycles<input type="number" min="1" max="10000" step="1" value={settings.maxCycles ?? ""} onChange={(event) => setSettings({ ...settings, maxCycles: nullableNumber(event.target.value) })} /></label>
      <span className="field-help">The default is 100 cycles. A continuation receives this many additional cycles.</span>
      <label>Parametric bootstraps<input type="number" min="1" max="10000" step="1" value={settings.bootstrapIterations ?? ""} onChange={(event) => setSettings({ ...settings, bootstrapIterations: nullableNumber(event.target.value) })} /></label>
      <label>Bootstrap seed<input type="number" min="0" step="1" value={settings.bootstrapSeed ?? ""} onChange={(event) => setSettings({ ...settings, bootstrapSeed: nullableNumber(event.target.value) })} /></label>
      <span className="field-help">Defaults: 500 bootstraps and seed 123. Every bootstrap retains the fixed dose grid and simulates new responses from the fitted absorbance-scale error and censoring model.</span>
    </section>
    <button className="primary-button full-width" disabled={busy || !settingsComplete} onClick={fit}>{busy ? "Fitting…" : fits.length ? "Refit Equation 2" : "Fit Equation 2 with NPAG"}</button>
    {canContinue && selected && <button className="secondary-button full-width" disabled={busy || !settingsComplete} onClick={() => continueFit(selected.id)}>Continue selected fit</button>}
    {progress && <div className="analysis-progress" role="status" aria-live="polite">
      <div><strong>{progress.regimenLabel ? `${progress.phase === "bootstrap" ? "Bootstrapping" : "Reference fit"}: ${progress.regimenLabel}` : progress.phase === "bootstrap" ? "Bootstrapping regimen" : "Fitting reference regimen"}</strong><span>{progress.phase === "bootstrap" ? `${progress.completedBootstraps} of ${progress.totalBootstraps} bootstrap fits` : `Cycle ${progress.cycle}`}{Number.isFinite(progress.objectiveFunction) ? ` · objective ${format(progress.objectiveFunction)}` : ""}</span></div>
      <progress aria-label="NPAG fit in progress" />
    </div>}
    <div className="side-warning"><strong>Next step:</strong> after the reference fit and bootstrap are available, use Simulate to evaluate constant free-concentration combinations. Two or more completed simulations enable Compare.</div>
  </aside><section className="content-card stage-card">
    <div className="card-heading"><div><h1>Drusano–Greco analysis</h1><p>Generalized Equation 2 fit without the bacterial growth differential equation or a Nelder–Mead solve.</p></div>{fits.length > 0 && <span className="count-badge">{fits.length} fit{fits.length === 1 ? "" : "s"}</span>}</div>
    <div className="stage-content">
      {result ? <>
        {fits.length > 1 && <RegimenNavigator regimens={fits} selectedId={selected?.id ?? fits[0].id} onSelect={setSelectedId} compact label="Fitted regimen" />}
        <div className={result.converged ? "mapping-status ready" : "mapping-status warning"}>{result.converged ? "NPAG converged" : result.runCycles >= result.maxCycles ? "NPAG reached the cycle limit before convergence" : "NPAG stopped before convergence"} after {result.cycles} total cycle{result.cycles === 1 ? "" : "s"}{result.continuedFromCycles > 0 ? ` (${result.runCycles} in the latest continuation)` : ""}. Objective function: {format(result.objectiveFunction)}.</div>
        <div className="mapping-status ready">Reference and bootstrap results are available. You can now proceed to the Simulate tab to evaluate constant free-drug concentrations.</div>
        <div className="summary-metrics">
          <div><span>Eligible wells</span><strong>{result.data.eligibleWellCount}</strong></div>
          <div><span>Growth controls</span><strong>{result.data.controlCount}</strong></div>
          <div><span>Bootstrap vectors</span><strong>{result.supportPoints.length}</strong></div>
          <div><span>Below LOD (CENS = 1)</span><strong>{result.data.censoredCount}</strong></div>
          <div><span>Excluded boundaries</span><strong>{result.data.excludedBoundaryCount}</strong></div>
        </div>
        <fieldset className="radio-field diagnostic-scale-control"><legend>Diagnostic plot scale</legend>
          <label><input type="radio" name="diagnostic-plot-scale" checked={diagnosticScale === "effect"} onChange={() => setDiagnosticScale("effect")} />Normalized effect</label>
          <label><input type="radio" name="diagnostic-plot-scale" checked={diagnosticScale === "absorbance"} onChange={() => setDiagnosticScale("absorbance")} />Absorbance</label>
        </fieldset>
        <ObservedPredictedPlot result={result} scale={diagnosticScale} />
        <ResidualDiagnostics result={result} scale={diagnosticScale} />
        <h2>Reference estimate and bootstrap confidence intervals</h2>
        <div className="result-table-wrap"><table className="result-table"><thead><tr><th>Parameter</th><th>Reference</th><th>Bootstrap mean</th><th>Bootstrap SD</th><th>Median</th><th>95% confidence interval</th><th>Units</th></tr></thead><tbody>{result.parameterSummaries.map((summary, index) => {
          const drugIndex = summary.name === "ec50_1" ? 0 : summary.name === "ec50_2" ? 1 : null;
          const scale = drugIndex == null ? 1 : result.data.maxConcentrations[drugIndex];
          const units = drugIndex == null ? "unitless" : concentrationUnits[drugIndex] || "imported concentration units";
          const lower = summary.percentile2_5 ?? summary.percentile25;
          const upper = summary.percentile97_5 ?? summary.percentile975;
          return <tr key={summary.name}><td><strong>{parameterLabel(summary.name, result.data.drugNames)}</strong></td><td>{format(result.referenceSupportPoint.values[index] * scale)}</td><td>{format(summary.mean * scale)}</td><td>{format(summary.standardDeviation * scale)}</td><td>{format(summary.median * scale)}</td><td>{format((lower ?? Number.NaN) * scale)}–{format((upper ?? Number.NaN) * scale)}</td><td>{units}</td></tr>;
        })}</tbody></table></div>
        <p className="help-text">{result.bootstrapIterations} fixed-grid parametric bootstrap fits with seed {result.bootstrapSeed}; {result.bootstrapConvergedCount} reached the NPAG convergence criterion. Percentile intervals describe sampling uncertainty, not Bayesian credibility.</p>
        <details className="support-points-details"><summary>Bootstrap parameter vectors ({result.supportPoints.length})</summary>
          <p className="help-text">Each vector has empirical probability 1/{result.bootstrapIterations}. EC50 values in this diagnostic table remain internal fractions of the corresponding tested maximum; the summary table above reports rescaled concentrations. {result.supportPoints.length > shownPoints.length && `Showing the first ${shownPoints.length} of ${result.supportPoints.length}.`}</p>
          <div className="result-table-wrap"><table className="result-table"><thead><tr><th>Probability</th>{result.parameterNames.map((name) => <th key={name}>{parameterLabel(name, result.data.drugNames)}</th>)}</tr></thead><tbody>{shownPoints.map((point, index) => <tr key={index}><td>{format(point.probability)}</td>{point.values.map((value, column) => <td key={column}>{format(value)}</td>)}</tr>)}</tbody></table></div>
        </details>
        <h2>Normalization and model data</h2>
        <p className="help-text">Blank: {format(result.data.blankValue)} · mean growth control: {format(result.data.controlMean)}{result.data.responseCensorLimit != null ? ` · response censor limit: ${format(result.data.responseCensorLimit)} · E_L: ${format(result.data.normalizedEffectCensorLimit ?? Number.NaN)}` : " · no response censoring"} · tested maxima: {result.data.drugNames.map((name, index) => `${name} ${format(result.data.maxConcentrations[index])}${concentrationUnits[index] ? ` ${concentrationUnits[index]}` : ""}`).join(" · ")}</p>
        <p className="help-text">Assay error polynomial: ({result.assayError.coefficients.map(format).join(", ")}) · initial λ: {format(result.assayError.initialLambda)} · fitted λ: {format(result.assayError.fittedLambda)}</p>
        {result.data.warnings.map((warning) => <div className="mapping-status warning" key={warning}>{warning}</div>)}
        <div className="mapping-table-wrap"><table className="mapping-table"><thead><tr>{result.data.headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{result.data.rows.slice(0, 20).map((row, index) => <tr key={index}>{row.map((value, column) => <td key={column}>{value}</td>)}</tr>)}</tbody></table></div>
      </> : <div className="empty-state"><div className="empty-icon">⌁</div><h2>No NPAG fit yet</h2><p>Supply the blank response, then fit the predefined generalized interaction equation. Drug concentrations are scaled automatically to their tested maxima.</p></div>}
      <details><summary>Predefined read-only numerical model</summary><p className="help-text">Equation 2 is solved for dimensionless effect at the reference estimate and every bootstrap parameter vector. The predicted effect is then converted back to the imported response scale before the likelihood, error polynomial, and censor limit are applied.</p><pre className="model-code">{result?.modelSource ?? DRUSANO_GRECO_MODEL}</pre></details>
    </div>
  </section></main>;
}

function ObservedPredictedPlot({ result, scale }: { result: DrusanoFitResult; scale: DrusanoDiagnosticScale }) {
  const width = 640;
  const height = 440;
  const margin = { left: 64, right: 24, top: 22, bottom: 58 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const points = result.predictions.map((point) => drusanoDiagnosticPoint(point, scale, result.data.responseCensorLimit));
  const [minimum, maximum] = diagnosticDomain(points, scale);
  const x = (value: number) => margin.left + ((value - minimum) / (maximum - minimum)) * plotWidth;
  const y = (value: number) => margin.top + ((maximum - value) / (maximum - minimum)) * plotHeight;
  const ticks = Array.from({ length: 6 }, (_, index) => minimum + (index / 5) * (maximum - minimum));
  const regression = drusanoDiagnosticRegression(points);
  const noun = scale === "effect" ? "normalized effect" : "absorbance";
  return <section className="drusano-fit-plot">
    <div><h2>Observed vs. predicted {noun}</h2><p className="help-text">Predicted {noun} is on the x-axis and observed {noun} is on the y-axis. Regression statistics use uncensored wells only; {scale === "effect" ? <>upward arrows at E<sub>L</sub> mean observed E ≥ E<sub>L</sub></> : <>downward arrows at L mean observed absorbance ≤ L</>}.</p></div>
    {points.length ? <>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Observed versus predicted ${noun}`}>
        <defs><clipPath id="drusano-plot-clip"><rect x={margin.left} y={margin.top} width={plotWidth} height={plotHeight} /></clipPath></defs>
        {ticks.map((tick) => <g key={tick}><line className="chart-grid" x1={x(tick)} x2={x(tick)} y1={margin.top} y2={height - margin.bottom} /><line className="chart-grid" x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} /><text x={x(tick)} y={height - margin.bottom + 22} textAnchor="middle">{format(tick)}</text><text x={margin.left - 12} y={y(tick) + 4} textAnchor="end">{format(tick)}</text></g>)}
        <line className="chart-axis" x1={margin.left} x2={width - margin.right} y1={height - margin.bottom} y2={height - margin.bottom} />
        <line className="chart-axis" x1={margin.left} x2={margin.left} y1={margin.top} y2={height - margin.bottom} />
        <g clipPath="url(#drusano-plot-clip)">
          <line className="identity-line" x1={x(minimum)} y1={y(minimum)} x2={x(maximum)} y2={y(maximum)} />
          {regression && <line className="regression-line" x1={x(minimum)} y1={y(regression.intercept + regression.slope * minimum)} x2={x(maximum)} y2={y(regression.intercept + regression.slope * maximum)} />}
          {points.map(({ source: point, predicted, observed }) => point.censored
            ? scale === "effect"
              ? <g className={`censor-arrow ${doseClass(point.normalizedDoses)}`} key={point.wellId}><title>{`Well ${point.wellId}: predicted effect ${format(predicted)}; observed effect ≥ ${format(observed)} because response ≤ ${format(result.data.responseCensorLimit ?? Number.NaN)}`}</title><line x1={x(predicted)} x2={x(predicted)} y1={y(observed)} y2={y(observed) - 14} /><path d={`M ${x(predicted) - 5} ${y(observed) - 10} L ${x(predicted)} ${y(observed) - 17} L ${x(predicted) + 5} ${y(observed) - 10} Z`} /></g>
              : <g className={`censor-arrow ${doseClass(point.normalizedDoses)}`} key={point.wellId}><title>{`Well ${point.wellId}: predicted absorbance ${format(predicted)}; observed absorbance ≤ ${format(observed)}`}</title><line x1={x(predicted)} x2={x(predicted)} y1={y(observed)} y2={y(observed) + 14} /><path d={`M ${x(predicted) - 5} ${y(observed) + 10} L ${x(predicted)} ${y(observed) + 17} L ${x(predicted) + 5} ${y(observed) + 10} Z`} /></g>
            : <circle className={`prediction-point ${doseClass(point.normalizedDoses)}`} key={point.wellId} cx={x(predicted)} cy={y(observed)} r="4"><title>{`Well ${point.wellId}: predicted ${format(predicted)}, observed ${format(observed)}`}</title></circle>)}
        </g>
        <text className="chart-axis-title" x={margin.left + plotWidth / 2} y={height - 12} textAnchor="middle">Predicted {noun}</text>
        <text className="chart-axis-title" transform={`translate(18 ${margin.top + plotHeight / 2}) rotate(-90)`} textAnchor="middle">Observed {noun}</text>
      </svg>
      <DoseClassLegend drugNames={result.data.drugNames} />
      <div className="plot-legend"><span><i className="identity-swatch" />Identity: slope 1, intercept 0</span>{regression && <span><i className="regression-swatch" />Observed-on-predicted regression</span>}<span><i className="censored-swatch">{scale === "effect" ? "↑" : "↓"}</i>{scale === "effect" ? <>Censored: observed E ≥ E<sub>L</sub></> : <>Censored: observed absorbance ≤ L</>}</span></div>
      {regression ? <div className="fit-statistics"><span>n = <strong>{regression.observations}</strong></span><span>Slope = <strong>{format(regression.slope)}</strong></span><span>Intercept = <strong>{format(regression.intercept)}</strong></span><span>R² = <strong>{format(regression.rSquared)}</strong></span><span>RMSE = <strong>{format(regression.rootMeanSquaredError)}</strong></span></div> : <p className="help-text">Regression statistics require at least two uncensored predictions with different observed effects.</p>}
      {result.unpredictedCount > 0 && <div className="mapping-status warning">No finite Equation 2 root was found for {result.unpredictedCount} well{result.unpredictedCount === 1 ? "" : "s"}; those wells are omitted from this plot.</div>}
    </> : <div className="mapping-status warning">No finite Equation 2 predictions could be generated for this fit.</div>}
  </section>;
}

function diagnosticDomain(points: DrusanoDiagnosticPoint[], scale: DrusanoDiagnosticScale): [number, number] {
  if (scale === "effect") return [0, 1];
  const values = points.flatMap((point) => [point.observed, point.predicted]).filter(Number.isFinite);
  if (!values.length) return [0, 1];
  const rawMinimum = Math.min(...values);
  const rawMaximum = Math.max(...values);
  const padding = rawMaximum > rawMinimum ? (rawMaximum - rawMinimum) * 0.05 : Math.max(Math.abs(rawMinimum) * 0.05, 0.05);
  return [rawMinimum - padding, rawMaximum + padding];
}

function ResidualDiagnostics({ result, scale }: { result: DrusanoFitResult; scale: DrusanoDiagnosticScale }) {
  const points = result.predictions.map((point) => drusanoDiagnosticPoint(point, scale, result.data.responseCensorLimit))
    .filter((point) => point.residual != null && Number.isFinite(point.residual));
  const noun = scale === "effect" ? "Normalized effect" : "Absorbance";
  if (!points.length) return <section className="drusano-fit-plot"><div><h2>{noun} residual diagnostics</h2><p className="help-text">No uncensored wells with finite reference predictions are available for residual plots.</p></div></section>;
  const residualLimit = Math.max(...points.map((point) => Math.abs(point.residual!)), Number.EPSILON) * 1.08;
  return <section className="residual-diagnostics">
    <div><h2>{noun} residual diagnostics</h2><p className="help-text">Residual = observed {noun.toLowerCase()} − predicted {noun.toLowerCase()} from the reference fit. Censored wells are omitted because their exact values beyond the censor boundary are unknown.</p></div>
    <DoseClassLegend drugNames={result.data.drugNames} />
    <ResidualScatterPlot
      title={`Residual versus predicted ${noun.toLowerCase()}`}
      xLabel={`Predicted ${noun.toLowerCase()}`}
      residualLabel={`${noun} residual`}
      points={points.map((diagnostic) => ({ diagnostic, x: diagnostic.predicted }))}
      residualLimit={residualLimit}
      tickLabel={format}
    />
    <div className="residual-dose-grid">{result.data.drugNames.map((drug, index) => <ResidualScatterPlot
      key={drug}
      title={`Residual versus ${drug} dose`}
      xLabel={`${drug} concentration / tested maximum (log₂(1 + fraction) spacing)`}
      residualLabel={`${noun} residual`}
      points={points.map((diagnostic) => ({ diagnostic, x: Math.log2(1 + diagnostic.source.normalizedDoses[index]) }))}
      residualLimit={residualLimit}
      tickLabel={(value) => format(Math.pow(2, value) - 1)}
      tooltipX={(value) => `${format(Math.pow(2, value) - 1)} × tested maximum`}
      minimumX={0}
    />)}</div>
  </section>;
}

function ResidualScatterPlot({ title, xLabel, residualLabel, points, residualLimit, tickLabel, tooltipX, minimumX }: {
  title: string;
  xLabel: string;
  residualLabel: string;
  points: { diagnostic: DrusanoDiagnosticPoint; x: number }[];
  residualLimit: number;
  tickLabel: (value: number) => string;
  tooltipX?: (value: number) => string;
  minimumX?: number;
}) {
  const width = 640;
  const height = 350;
  const margin = { left: 76, right: 24, top: 20, bottom: 62 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const finite = points.filter(({ x, diagnostic }) => Number.isFinite(x) && diagnostic.residual != null);
  const rawMinimum = Math.min(...finite.map(({ x }) => x));
  const rawMaximum = Math.max(...finite.map(({ x }) => x));
  const padding = rawMaximum > rawMinimum ? (rawMaximum - rawMinimum) * 0.04 : Math.max(Math.abs(rawMinimum) * 0.04, 0.04);
  const xMinimum = minimumX ?? rawMinimum - padding;
  const xMaximum = rawMaximum + padding;
  const x = (value: number) => margin.left + ((value - xMinimum) / (xMaximum - xMinimum)) * plotWidth;
  const y = (value: number) => margin.top + ((residualLimit - value) / (2 * residualLimit)) * plotHeight;
  const xTicks = Array.from({ length: 5 }, (_, index) => xMinimum + (index / 4) * (xMaximum - xMinimum));
  const yTicks = [-residualLimit, -residualLimit / 2, 0, residualLimit / 2, residualLimit];
  return <section className="drusano-fit-plot residual-panel">
    <h3>{title}</h3>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
      <defs><clipPath id={`residual-${title.replace(/[^a-z0-9]/gi, "-")}`}><rect x={margin.left} y={margin.top} width={plotWidth} height={plotHeight} /></clipPath></defs>
      {xTicks.map((tick, index) => <g key={index}><line className="chart-grid" x1={x(tick)} x2={x(tick)} y1={margin.top} y2={height - margin.bottom} /><text x={x(tick)} y={height - margin.bottom + 22} textAnchor="middle">{tickLabel(tick)}</text></g>)}
      {yTicks.map((tick, index) => <g key={index}><line className={tick === 0 ? "residual-zero-line" : "chart-grid"} x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} /><text x={margin.left - 12} y={y(tick) + 4} textAnchor="end">{format(tick)}</text></g>)}
      <line className="chart-axis" x1={margin.left} x2={width - margin.right} y1={height - margin.bottom} y2={height - margin.bottom} />
      <line className="chart-axis" x1={margin.left} x2={margin.left} y1={margin.top} y2={height - margin.bottom} />
      <g clipPath={`url(#residual-${title.replace(/[^a-z0-9]/gi, "-")})`}>{finite.map(({ diagnostic, x: xValue }) => <circle className={`residual-point ${doseClass(diagnostic.source.normalizedDoses)}`} key={diagnostic.source.wellId} cx={x(xValue)} cy={y(diagnostic.residual!)} r="4"><title>{`Well ${diagnostic.source.wellId}: ${tooltipX?.(xValue) ?? format(xValue)}; observed ${format(diagnostic.observed)}; predicted ${format(diagnostic.predicted)}; residual ${format(diagnostic.residual!)}`}</title></circle>)}</g>
      <text className="chart-axis-title" x={margin.left + plotWidth / 2} y={height - 12} textAnchor="middle">{xLabel}</text>
      <text className="chart-axis-title" transform={`translate(18 ${margin.top + plotHeight / 2}) rotate(-90)`} textAnchor="middle">{residualLabel}</text>
    </svg>
  </section>;
}

function DoseClassLegend({ drugNames }: { drugNames: string[] }) {
  return <div className="plot-legend dose-class-legend">
    <span><i className="dose-swatch drug-1" />{drugNames[0] ?? "Drug 1"} alone</span>
    <span><i className="dose-swatch drug-2" />{drugNames[1] ?? "Drug 2"} alone</span>
    <span><i className="dose-swatch combination" />Combination</span>
  </div>;
}

function doseClass(normalizedDoses: number[]): "drug-1" | "drug-2" | "combination" {
  const firstPositive = (normalizedDoses[0] ?? 0) > 1e-12;
  const secondPositive = (normalizedDoses[1] ?? 0) > 1e-12;
  if (firstPositive && !secondPositive) return "drug-1";
  if (!firstPositive && secondPositive) return "drug-2";
  return "combination";
}

export function DrusanoRegimenWorkspace({ fits, regimens, simulations, concentrationValues, setConcentrationValues, simulate }: {
  fits: FitEntry[];
  regimens: RegimenPreview[];
  simulations: Record<string, DrusanoRegimenSimulationResult>;
  concentrationValues: Record<string, Array<number | null>>;
  setConcentrationValues: (id: string, values: Array<number | null>) => void;
  simulate: (id: string, concentrations: number[]) => Promise<DrusanoRegimenSimulationResult>;
}) {
  const [selectedId, setSelectedId] = useState(fits[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!fits.some((entry) => entry.id === selectedId)) setSelectedId(fits[0]?.id ?? "");
    for (const entry of fits) if (!concentrationValues[entry.id]) {
      setConcentrationValues(entry.id, entry.fit.data.maxConcentrations.map(() => null));
    }
  }, [fits, selectedId]);
  const selected = fits.find((entry) => entry.id === selectedId) ?? fits[0];
  if (!selected) return <DrusanoPendingWorkspace stage="regimen" />;
  const regimen = regimens.find((entry) => entry.id === selected.id);
  const units = regimen?.concentrationUnits ?? [];
  const entered = concentrationValues[selected.id] ?? selected.fit.data.maxConcentrations.map(() => null);
  const complete = entered.length === 2 && entered.every((value) => value != null && Number.isFinite(value) && value >= 0);
  const storedResult = simulations[selected.id];
  const result = storedResult && storedResult.concentrations.every((value, index) => value === entered[index]) ? storedResult : null;
  const updateConcentration = (index: number, value: number | null) => {
    const next = [...entered];
    next[index] = value;
    setConcentrationValues(selected.id, next);
  };
  const run = async () => {
    if (!complete) return;
    setBusy(true);
    try {
      await simulate(selected.id, entered as number[]);
    } catch {
      // App-level error banner contains the command failure.
    } finally {
      setBusy(false);
    }
  };

  return <main className="workspace"><aside className="sidebar">
    <h2>Constant-concentration regimen</h2>
    <p className="help-text">Enter each constant free concentration in the imported concentration units. The simulator divides it by that drug’s maximum tested concentration before evaluating Equation 2.</p>
    {fits.length > 1 && <RegimenNavigator regimens={fits} selectedId={selected.id} onSelect={setSelectedId} compact label="Fitted regimen" />}
    <section className="drusano-model-settings">
      {selected.fit.data.drugNames.map((name, index) => <label key={name}>{name} free concentration{units[index] ? ` (${units[index]})` : ""}<input type="number" min="0" step="any" value={entered[index] ?? ""} onChange={(event) => updateConcentration(index, nullableNumber(event.target.value))} /><span className="field-help">Tested maximum: {format(selected.fit.data.maxConcentrations[index])}{units[index] ? ` ${units[index]}` : ""}{entered[index] != null && Number.isFinite(entered[index]) ? ` · ${format(entered[index]! / selected.fit.data.maxConcentrations[index])} × tested maximum` : ""}</span></label>)}
    </section>
    <button className="primary-button full-width" disabled={busy || !complete} onClick={run}>{busy ? "Simulating…" : "Simulate 1,000 effects"}</button>
    <div className="side-warning"><strong>Empirical bootstrap simulation:</strong> each effect draw selects one unclustered bootstrap parameter vector with replacement. No additional parameter variance is added around a vector.</div>
  </aside><section className="content-card stage-card">
    <div className="card-heading"><div><h1>Simulation</h1><p>Distribution of dimensionless effect at constant free-drug concentrations.</p></div>{result && <span className="count-badge">{result.simulationCount.toLocaleString()} simulations</span>}</div>
    <div className="stage-content">{result ? <>
      <div className="mapping-status ready">Simulation complete for {result.drugNames.map((name, index) => `${name} ${format(result.concentrations[index])} (${format(result.normalizedDoses[index])} × tested maximum)`).join(" · ")}.</div>
      <div className="summary-metrics">
        <div><span>Mean E</span><strong>{format(result.summary.mean)}</strong></div>
        <div><span>SD</span><strong>{format(result.summary.standardDeviation)}</strong></div>
        <div><span>Median</span><strong>{format(result.summary.median)}</strong></div>
        <div><span>95% interval</span><strong>{format(result.summary.percentile2_5)}–{format(result.summary.percentile97_5)}</strong></div>
        <div><span>Range</span><strong>{format(result.summary.minimum)}–{format(result.summary.maximum)}</strong></div>
      </div>
      <EffectDensityPlot result={result} />
      <h2>Simulation summary</h2>
      <div className="result-table-wrap"><table className="result-table"><thead><tr><th>n</th><th>Mean</th><th>SD</th><th>Minimum</th><th>2.5%</th><th>25%</th><th>Median</th><th>75%</th><th>97.5%</th><th>Maximum</th></tr></thead><tbody><tr><td>{result.simulationCount}</td><td>{format(result.summary.mean)}</td><td>{format(result.summary.standardDeviation)}</td><td>{format(result.summary.minimum)}</td><td>{format(result.summary.percentile2_5)}</td><td>{format(result.summary.percentile25)}</td><td>{format(result.summary.median)}</td><td>{format(result.summary.percentile75)}</td><td>{format(result.summary.percentile97_5)}</td><td>{format(result.summary.maximum)}</td></tr></tbody></table></div>
      <p className="help-text">Seed: {result.seed} · empirical bootstrap vectors: {result.supportPointCount} · rejected parameter/root draws redrawn: {result.rejectedDraws}.</p>
    </> : <div className="empty-state"><div className="empty-icon">⌁</div><h2>No regimen simulation yet</h2><p>Enter both constant free concentrations and draw 1,000 effects from the empirical bootstrap parameter distribution.</p></div>}</div>
  </section></main>;
}

export function DrusanoComparisonWorkspace({ entries }: { entries: DrusanoSimulationEntry[] }) {
  const result = compareDrusanoSimulations(entries);
  return <main className="single-workspace"><section className="content-card comparison-card">
    <div className="card-heading"><div><h1>Drusano regimen comparison</h1><p>Regimens are ranked by median simulated efficacy at the concentrations entered on Simulate.</p></div><span className="count-badge">{entries.length} simulations</span></div>
    <div className="comparison-content"><section className="comparison-section">
      <h2>Median predicted efficacy ranking</h2>
      <div className="result-table-wrap"><table className="result-table ranking-table"><thead><tr><th>Rank</th><th>Regimen</th><th>Median E</th><th>Mean E</th><th>95% interval</th><th>Simulations</th></tr></thead><tbody>
        {result.rankings.map((entry) => <tr key={entry.id}><td>{entry.rank}</td><td><strong>{entry.label}</strong></td><td>{format(entry.simulation.summary.median)}</td><td>{format(entry.simulation.summary.mean)}</td><td>{format(entry.simulation.summary.percentile2_5)}–{format(entry.simulation.summary.percentile97_5)}</td><td>{entry.simulation.simulationCount.toLocaleString()}</td></tr>)}
      </tbody></table></div>
      <p className="policy-note">This is a descriptive model-based ranking at the concentrations selected on Simulate. Inferential tests are intentionally omitted because the 1,000 Monte Carlo draws are resamples from fitted bootstrap vectors, not independent biological replicates.</p>
    </section></div>
  </section></main>;
}

function EffectDensityPlot({ result }: { result: DrusanoRegimenSimulationResult }) {
  const width = 680;
  const height = 360;
  const margin = { left: 62, right: 24, top: 20, bottom: 54 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const bandwidth = Math.max(0.01, 1.06 * result.summary.standardDeviation * Math.pow(result.effects.length, -0.2));
  const density = Array.from({ length: 121 }, (_, index) => {
    const effect = index / 120;
    const value = result.effects.reduce((sum, sample) => {
      const z = (effect - sample) / bandwidth;
      return sum + Math.exp(-0.5 * z * z);
    }, 0) / (result.effects.length * bandwidth * Math.sqrt(2 * Math.PI));
    return { effect, value };
  });
  const maxDensity = Math.max(...density.map((point) => point.value), Number.EPSILON);
  const x = (value: number) => margin.left + value * plotWidth;
  const y = (value: number) => margin.top + (1 - value / maxDensity) * plotHeight;
  const line = density.map((point, index) => `${index === 0 ? "M" : "L"} ${x(point.effect)} ${y(point.value)}`).join(" ");
  const area = `${line} L ${x(1)} ${y(0)} L ${x(0)} ${y(0)} Z`;
  const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1];
  return <section className="drusano-fit-plot"><div><h2>Simulated effect density</h2><p className="help-text">Gaussian kernel density estimate of the 1,000 dimensionless Equation 2 effects.</p></div><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Density of simulated normalized effects">
    {ticks.map((tick) => <g key={tick}><line className="chart-grid" x1={x(tick)} x2={x(tick)} y1={margin.top} y2={height - margin.bottom} /><text x={x(tick)} y={height - margin.bottom + 22} textAnchor="middle">{tick.toFixed(1)}</text></g>)}
    <line className="chart-axis" x1={margin.left} x2={width - margin.right} y1={height - margin.bottom} y2={height - margin.bottom} />
    <line className="chart-axis" x1={margin.left} x2={margin.left} y1={margin.top} y2={height - margin.bottom} />
    <path className="effect-density-area" d={area} /><path className="effect-density-line" d={line} />
    <text className="chart-axis-title" x={margin.left + plotWidth / 2} y={height - 10} textAnchor="middle">Simulated normalized effect (E)</text>
    <text className="chart-axis-title" transform={`translate(18 ${margin.top + plotHeight / 2}) rotate(-90)`} textAnchor="middle">Density</text>
  </svg></section>;
}

export function DrusanoPendingWorkspace({ stage }: { stage: "regimen" | "compare" }) {
  const copy = {
    regimen: ["Simulation", "Complete the reference NPAG fit and bootstrap before simulating a constant free-concentration regimen."],
    compare: ["Regimen comparison", "Complete simulations for at least two fitted regimens to compare their predicted efficacy distributions."],
  }[stage];
  return <main className="single-workspace"><section className="content-card stage-card"><div className="card-heading"><div><h1>{copy[0]}</h1><p>{copy[1]}</p></div></div><div className="empty-state"><div className="empty-icon">⌛</div><h2>Not yet implemented</h2><p>Complete and validate the reference fit and bootstrap before proceeding to simulations.</p></div></section></main>;
}

function nullableNumber(value: string): number | null {
  if (value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parameterLabel(name: string, drugNames: string[] = []): string {
  return ({ ec50_1: `EC50₁${drugNames[0] ? ` (${drugNames[0]})` : ""}`, ec50_2: `EC50₂${drugNames[1] ? ` (${drugNames[1]})` : ""}`, h1: "h₁,₀", h2: "h₂,₀", b1: "B₁", b2: "B₂", alpha_12: "α₁₂" } as Record<string, string>)[name] ?? name;
}

function format(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  if (absolute !== 0 && (absolute < 0.001 || absolute >= 10000)) return value.toExponential(4);
  return value.toLocaleString(undefined, { maximumSignificantDigits: 6 });
}
