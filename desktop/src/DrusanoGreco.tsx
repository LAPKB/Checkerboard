import { useEffect, useState } from "react";

import type {
  AnalysisType,
  DrusanoCensorLimitSuggestion,
  DrusanoFitResult,
  DrusanoModelSettings,
  DrusanoRegimenSimulationResult,
  InputSettings,
  RegimenPreview,
} from "./types";

export const DRUSANO_GRECO_MODEL = `# Numerical Drusano-Greco Equation 2 prediction model
# d1 and d2 are dimensionless dose/MIC covariates.
# E and XM0 are dimensionless; absorbance remains on the imported response scale.

u = d1 / ec50_1
v = d2 / ec50_2
w = alpha_12 * u * v
h_1 = 1 / h1
h_2 = 1 / h2
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
type FitProgress = { cycle: number; objectiveFunction: number; regimenLabel?: string };

export function ProjectWorkspace({ analysisType, setAnalysisType }: {
  analysisType: AnalysisType;
  setAnalysisType: (value: AnalysisType) => void;
}) {
  return <main className="single-workspace"><section className="content-card stage-card project-card">
    <div className="card-heading"><div><h1>Project analysis</h1><p>Select the interaction framework for this project. Imported data and results remain isolated by workflow.</p></div></div>
    <div className="analysis-choice-grid" role="radiogroup" aria-label="Analysis type">
      <label className={analysisType === "bliss" ? "analysis-choice selected" : "analysis-choice"}>
        <input type="radio" name="analysis-type" checked={analysisType === "bliss"} onChange={() => setAnalysisType("bliss")} />
        <span><strong>Bliss</strong><small>Analyze two- and three-drug checkerboards with SynergyFinder+-compatible Bliss scores and regimen ranking.</small></span>
      </label>
      <label className={analysisType === "drusanoGreco" ? "analysis-choice selected" : "analysis-choice"}>
        <input type="radio" name="analysis-type" checked={analysisType === "drusanoGreco"} onChange={() => setAnalysisType("drusanoGreco")} />
        <span><strong>Drusano–Greco</strong><small>Fit the generalized interaction equation to normalized two-drug checkerboard responses with NPAG.</small></span>
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
    {analysisType === "drusanoGreco" ? <>
      <div className="normalization-note">
        <strong>Fixed response normalization</strong>
        <p>Every response type is converted to effect as E = 1 − (observation − blank) / (mean growth control − blank).</p>
        <p>For absorbance, responses at or below the user-selected censor limit are retained with CENS = 1. Configure the limit and assay error model on Analyze.</p>
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

export function DrusanoAnalyzeWorkspace({
  fits, busy, progress, fit, continueFit, inputType, settings, setSettings, suggestion,
  suggestionBusy, suggestionError, settingsComplete,
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
}) {
  const [selectedId, setSelectedId] = useState<string | null>(fits[0]?.id ?? null);
  useEffect(() => {
    if (!fits.some((entry) => entry.id === selectedId)) setSelectedId(fits[0]?.id ?? null);
  }, [fits, selectedId]);
  const selected = fits.find((entry) => entry.id === selectedId) ?? fits[0] ?? null;
  const result = selected?.fit;
  const canContinue = Boolean(result && !result.converged && result.runCycles >= result.maxCycles);
  const shownPoints = result?.supportPoints.slice().sort((left, right) => right.probability - left.probability).slice(0, 100) ?? [];
  const updateCoefficient = (index: number, value: number | null) => {
    const coefficients = [...settings.errorCoefficients] as DrusanoModelSettings["errorCoefficients"];
    coefficients[index] = value;
    setSettings({ ...settings, errorCoefficients: coefficients });
  };

  return <main className="workspace"><aside className="sidebar">
    <h2>NPAG equation fit</h2>
    <p className="help-text">PMcore fits five parameter distributions using a numerical Equation 2 effect solve and an absorbance-scale likelihood. Each eligible drug-exposed well is a separate subject and each imported regimen is fitted separately.</p>
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
    </section>
    <button className="primary-button full-width" disabled={busy || !settingsComplete} onClick={fit}>{busy ? "Fitting…" : fits.length ? "Refit Equation 2" : "Fit Equation 2 with NPAG"}</button>
    {canContinue && selected && <button className="secondary-button full-width" disabled={busy || !settingsComplete} onClick={() => continueFit(selected.id)}>Continue selected fit</button>}
    {progress && <div className="analysis-progress" role="status" aria-live="polite">
      <div><strong>{progress.regimenLabel ? `Fitting ${progress.regimenLabel}` : "Fitting regimen"}</strong><span>Cycle {progress.cycle}{Number.isFinite(progress.objectiveFunction) ? ` · objective ${format(progress.objectiveFunction)}` : ""}</span></div>
      <progress aria-label="NPAG fit in progress" />
    </div>}
    <div className="side-warning"><strong>Next step:</strong> after a support-point fit is available, use Regimen to simulate a constant free-concentration combination. Cross-regimen comparisons remain disabled.</div>
  </aside><section className="content-card stage-card">
    <div className="card-heading"><div><h1>Drusano–Greco analysis</h1><p>Generalized Equation 2 fit without the bacterial growth differential equation or a Nelder–Mead solve.</p></div>{fits.length > 0 && <span className="count-badge">{fits.length} fit{fits.length === 1 ? "" : "s"}</span>}</div>
    <div className="stage-content">
      {result ? <>
        {fits.length > 1 && <label className="compact-setting">Regimen<select value={selected?.id ?? ""} onChange={(event) => setSelectedId(event.target.value)}>{fits.map((entry) => <option value={entry.id} key={entry.id}>{entry.label}</option>)}</select></label>}
        <div className={result.converged ? "mapping-status ready" : "mapping-status warning"}>{result.converged ? "NPAG converged" : result.runCycles >= result.maxCycles ? "NPAG reached the cycle limit before convergence" : "NPAG stopped before convergence"} after {result.cycles} total cycle{result.cycles === 1 ? "" : "s"}{result.continuedFromCycles > 0 ? ` (${result.runCycles} in the latest continuation)` : ""}. Objective function: {format(result.objectiveFunction)}.</div>
        <div className="mapping-status ready">Support-point results are available. You can now proceed to the Regimen tab to simulate constant free-drug concentrations.</div>
        <div className="summary-metrics">
          <div><span>Eligible subjects</span><strong>{result.data.subjectCount}</strong></div>
          <div><span>Growth controls</span><strong>{result.data.controlCount}</strong></div>
          <div><span>Support points</span><strong>{result.supportPoints.length}</strong></div>
          <div><span>Below LOD (CENS = 1)</span><strong>{result.data.censoredCount}</strong></div>
          <div><span>Excluded boundaries</span><strong>{result.data.excludedBoundaryCount}</strong></div>
        </div>
        <ObservedPredictedPlot result={result} />
        <h2>Parameter distributions</h2>
        <div className="result-table-wrap"><table className="result-table"><thead><tr><th>Parameter</th><th>Weighted mean</th><th>Weighted SD</th><th>Units</th></tr></thead><tbody>{result.parameterSummaries.map((summary) => <tr key={summary.name}><td><strong>{parameterLabel(summary.name)}</strong></td><td>{format(summary.mean)}</td><td>{format(summary.standardDeviation)}</td><td>{summary.name.startsWith("ec50") ? "× MIC" : "unitless"}</td></tr>)}</tbody></table></div>
        <details className="support-points-details"><summary>NPAG support points ({result.supportPoints.length})</summary>
          <p className="help-text">Sorted by probability. {result.supportPoints.length > shownPoints.length && `Showing the first ${shownPoints.length} of ${result.supportPoints.length}.`}</p>
          <div className="result-table-wrap"><table className="result-table"><thead><tr><th>Probability</th>{result.parameterNames.map((name) => <th key={name}>{parameterLabel(name)}</th>)}</tr></thead><tbody>{shownPoints.map((point, index) => <tr key={index}><td>{format(point.probability)}</td>{point.values.map((value, column) => <td key={column}>{format(value)}</td>)}</tr>)}</tbody></table></div>
        </details>
        <h2>Normalization and model data</h2>
        <p className="help-text">Blank: {format(result.data.blankValue)} · mean growth control: {format(result.data.controlMean)}{result.data.responseCensorLimit != null ? ` · response censor limit: ${format(result.data.responseCensorLimit)} · E_L: ${format(result.data.normalizedEffectCensorLimit ?? Number.NaN)}` : " · no response censoring"} · MICs: {result.data.drugNames.map((name, index) => `${name} ${format(result.data.micValues[index])}`).join(" · ")}</p>
        <p className="help-text">Assay error polynomial: ({result.assayError.coefficients.map(format).join(", ")}) · initial λ: {format(result.assayError.initialLambda)} · fitted λ: {format(result.assayError.fittedLambda)}</p>
        {result.data.warnings.map((warning) => <div className="mapping-status warning" key={warning}>{warning}</div>)}
        <div className="mapping-table-wrap"><table className="mapping-table"><thead><tr>{result.data.headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{result.data.rows.slice(0, 20).map((row, index) => <tr key={index}>{row.map((value, column) => <td key={column}>{value}</td>)}</tr>)}</tbody></table></div>
      </> : <div className="empty-state"><div className="empty-icon">⌁</div><h2>No NPAG fit yet</h2><p>Assign MICs, supply the blank response, then fit the predefined generalized interaction equation.</p></div>}
      <details><summary>Predefined read-only numerical model</summary><p className="help-text">Equation 2 is solved for dimensionless effect at every parameter support point. The predicted effect is then converted back to the imported response scale before the likelihood, error polynomial, and censor limit are applied.</p><pre className="model-code">{result?.modelSource ?? DRUSANO_GRECO_MODEL}</pre></details>
    </div>
  </section></main>;
}

function ObservedPredictedPlot({ result }: { result: DrusanoFitResult }) {
  const width = 640;
  const height = 440;
  const margin = { left: 64, right: 24, top: 22, bottom: 58 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const x = (value: number) => margin.left + value * plotWidth;
  const y = (value: number) => margin.top + (1 - value) * plotHeight;
  const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1];
  const regression = result.regression;
  return <section className="drusano-fit-plot">
    <div><h2>Observed vs. predicted effect</h2><p className="help-text">Predicted effect is on the x-axis and observed effect is on the y-axis. Regression statistics use uncensored wells only; upward arrows at E<sub>L</sub> mark censored observations whose true effects are E ≥ E<sub>L</sub>.</p></div>
    {result.predictions.length ? <>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Observed versus predicted normalized effect">
        <defs><clipPath id="drusano-plot-clip"><rect x={margin.left} y={margin.top} width={plotWidth} height={plotHeight} /></clipPath></defs>
        {ticks.map((tick) => <g key={tick}><line className="chart-grid" x1={x(tick)} x2={x(tick)} y1={margin.top} y2={height - margin.bottom} /><line className="chart-grid" x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} /><text x={x(tick)} y={height - margin.bottom + 22} textAnchor="middle">{tick.toFixed(1)}</text><text x={margin.left - 12} y={y(tick) + 4} textAnchor="end">{tick.toFixed(1)}</text></g>)}
        <line className="chart-axis" x1={margin.left} x2={width - margin.right} y1={height - margin.bottom} y2={height - margin.bottom} />
        <line className="chart-axis" x1={margin.left} x2={margin.left} y1={margin.top} y2={height - margin.bottom} />
        <g clipPath="url(#drusano-plot-clip)">
          <line className="identity-line" x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} />
          {regression && <line className="regression-line" x1={x(0)} y1={y(regression.intercept)} x2={x(1)} y2={y(regression.intercept + regression.slope)} />}
          {result.predictions.map((point) => point.censored
            ? <g className="censor-arrow" key={point.subjectId}><title>{`Subject ${point.subjectId}: predicted effect ${format(point.predictedEffect)}; observed effect ≥ ${format(point.observedEffect)} because response ≤ ${format(result.data.responseCensorLimit ?? Number.NaN)}`}</title><line x1={x(point.predictedEffect)} x2={x(point.predictedEffect)} y1={y(point.observedEffect)} y2={y(point.observedEffect) - 14} /><path d={`M ${x(point.predictedEffect) - 5} ${y(point.observedEffect) - 10} L ${x(point.predictedEffect)} ${y(point.observedEffect) - 17} L ${x(point.predictedEffect) + 5} ${y(point.observedEffect) - 10} Z`} /></g>
            : <circle className="prediction-point" key={point.subjectId} cx={x(point.predictedEffect)} cy={y(point.observedEffect)} r="4"><title>{`Subject ${point.subjectId}: predicted ${format(point.predictedEffect)}, observed ${format(point.observedEffect)}`}</title></circle>)}
        </g>
        <text className="chart-axis-title" x={margin.left + plotWidth / 2} y={height - 12} textAnchor="middle">Predicted normalized effect</text>
        <text className="chart-axis-title" transform={`translate(18 ${margin.top + plotHeight / 2}) rotate(-90)`} textAnchor="middle">Observed normalized effect</text>
      </svg>
      <div className="plot-legend"><span><i className="identity-swatch" />Identity: slope 1, intercept 0</span>{regression && <span><i className="regression-swatch" />Observed-on-predicted regression</span>}<span><i className="censored-swatch">↑</i>Censored: observed E ≥ E<sub>L</sub></span></div>
      {regression ? <div className="fit-statistics"><span>n = <strong>{regression.observations}</strong></span><span>Slope = <strong>{format(regression.slope)}</strong></span><span>Intercept = <strong>{format(regression.intercept)}</strong></span><span>R² = <strong>{format(regression.rSquared)}</strong></span><span>RMSE = <strong>{format(regression.rootMeanSquaredError)}</strong></span></div> : <p className="help-text">Regression statistics require at least two uncensored predictions with different observed effects.</p>}
      {result.unpredictedCount > 0 && <div className="mapping-status warning">No finite Equation 2 root was found for {result.unpredictedCount} subject{result.unpredictedCount === 1 ? "" : "s"}; those subjects are omitted from this plot.</div>}
    </> : <div className="mapping-status warning">No finite Equation 2 predictions could be generated for this fit.</div>}
  </section>;
}

export function DrusanoRegimenWorkspace({ fits, regimens, simulations, simulate }: {
  fits: FitEntry[];
  regimens: RegimenPreview[];
  simulations: Record<string, DrusanoRegimenSimulationResult>;
  simulate: (id: string, concentrations: number[]) => Promise<DrusanoRegimenSimulationResult>;
}) {
  const [selectedId, setSelectedId] = useState(fits[0]?.id ?? "");
  const [concentrations, setConcentrations] = useState<Record<string, Array<number | null>>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!fits.some((entry) => entry.id === selectedId)) setSelectedId(fits[0]?.id ?? "");
    setConcentrations((current) => {
      const next = { ...current };
      for (const entry of fits) {
        if (!next[entry.id]) next[entry.id] = entry.fit.data.micValues.map(() => null);
      }
      return next;
    });
  }, [fits, selectedId]);
  const selected = fits.find((entry) => entry.id === selectedId) ?? fits[0];
  if (!selected) return <DrusanoPendingWorkspace stage="regimen" />;
  const regimen = regimens.find((entry) => entry.id === selected.id);
  const units = regimen?.concentrationUnits ?? [];
  const entered = concentrations[selected.id] ?? selected.fit.data.micValues.map(() => null);
  const complete = entered.length === 2 && entered.every((value) => value != null && Number.isFinite(value) && value >= 0);
  const storedResult = simulations[selected.id];
  const result = storedResult && storedResult.concentrations.every((value, index) => value === entered[index]) ? storedResult : null;
  const updateConcentration = (index: number, value: number | null) => {
    const next = [...entered];
    next[index] = value;
    setConcentrations((current) => ({ ...current, [selected.id]: next }));
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
    <p className="help-text">Enter the constant free concentration of each drug on the same scale as its MIC. The simulator converts each value to concentration/MIC before evaluating Equation 2.</p>
    {fits.length > 1 && <label>Fitted regimen<select value={selected.id} onChange={(event) => setSelectedId(event.target.value)}>{fits.map((entry) => <option value={entry.id} key={entry.id}>{entry.label}</option>)}</select></label>}
    <section className="drusano-model-settings">
      {selected.fit.data.drugNames.map((name, index) => <label key={name}>{name} free concentration{units[index] ? ` (${units[index]})` : ""}<input type="number" min="0" step="any" value={entered[index] ?? ""} onChange={(event) => updateConcentration(index, nullableNumber(event.target.value))} /><span className="field-help">MIC: {format(selected.fit.data.micValues[index])}{entered[index] != null && Number.isFinite(entered[index]) ? ` · ${format(entered[index]! / selected.fit.data.micValues[index])} × MIC` : ""}</span></label>)}
    </section>
    <button className="primary-button full-width" disabled={busy || !complete} onClick={run}>{busy ? "Simulating…" : "Simulate 1,000 effects"}</button>
    <div className="side-warning"><strong>Split population simulation:</strong> each NPAG support point is a mode mean, its fitted probability is the mode probability, and the weighted population covariance is divided by the number of support points.</div>
  </aside><section className="content-card stage-card">
    <div className="card-heading"><div><h1>Regimen simulation</h1><p>Distribution of dimensionless effect at constant free-drug concentrations.</p></div>{result && <span className="count-badge">{result.simulationCount.toLocaleString()} simulations</span>}</div>
    <div className="stage-content">{result ? <>
      <div className="mapping-status ready">Simulation complete for {result.drugNames.map((name, index) => `${name} ${format(result.concentrations[index])} (${format(result.normalizedDoses[index])} × MIC)`).join(" · ")}.</div>
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
      <p className="help-text">Seed: {result.seed} · support-point modes: {result.supportPointCount} · rejected parameter/root draws redrawn: {result.rejectedDraws}.</p>
    </> : <div className="empty-state"><div className="empty-icon">⌁</div><h2>No regimen simulation yet</h2><p>Enter both constant free concentrations and run the 1,000-draw split population simulation.</p></div>}</div>
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

export function DrusanoPendingWorkspace({ stage }: { stage: "regimen" | "results" | "compare" }) {
  const copy = {
    regimen: ["Regimen simulation", "Complete an NPAG support-point fit before simulating a constant free-concentration regimen."],
    results: ["Simulation results", "This stage is intentionally outside the current Equation 2 fitting milestone."],
    compare: ["Regimen comparison", "This stage is intentionally outside the current Equation 2 fitting milestone."],
  }[stage];
  return <main className="single-workspace"><section className="content-card stage-card"><div className="card-heading"><div><h1>{copy[0]}</h1><p>{copy[1]}</p></div></div><div className="empty-state"><div className="empty-icon">⌛</div><h2>Not yet implemented</h2><p>Complete and validate the NPAG support-point fit before proceeding to simulations.</p></div></section></main>;
}

function nullableNumber(value: string): number | null {
  if (value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parameterLabel(name: string): string {
  return ({ ec50_1: "EC50₁", ec50_2: "EC50₂", h1: "h₁", h2: "h₂", alpha_12: "α₁₂" } as Record<string, string>)[name] ?? name;
}

function format(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  if (absolute !== 0 && (absolute < 0.001 || absolute >= 10000)) return value.toExponential(4);
  return value.toLocaleString(undefined, { maximumSignificantDigits: 6 });
}
