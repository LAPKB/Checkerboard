import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";

import { diamondRankingScore } from "./analysis";
import { RegimenNavigator } from "./RegimenNavigator";
import type { ColumnMapping, DiamondCurve, DiamondIsoboleDiagnostic, DiamondLayoutCheck, DiamondPolicy, DiamondRegimen, DiamondRepeatLayout, DiamondResult, ImportRequest, InputSettings } from "./types";

type Progress = { completedIterations: number; totalIterations: number; regimenLabel?: string };

export type DiamondLayoutRequest = {
  label: string;
  units: string[];
  request: {
    import: ImportRequest;
    mapping: ColumnMapping;
    doseAnchors: number[];
    diagonalToleranceLog2: number;
    policy: DiamondPolicy;
    regimenDrugNames: string[];
    organism: string | null;
    organismColumn: number | null;
  };
};

export function DiamondAnchorExplanation() {
  return <div className="method-card"><strong>What do dose anchors mean?</strong>
    <p>An anchor is a reference concentration, in that drug’s imported units. Concentration ÷ assigned anchor gives the dose in anchor units. Combination wells belong to the diagonal when every active drug has approximately the same dose in anchor units.</p>
    <p><strong>Closest Anchor:</strong> the tested single-agent concentration nearest the fitted IC50 on a log₂ scale. It may not match the ratio used to prepare the combinations, and its measured inhibition need not be 50%.</p>
    <p><strong>Maximum Dose Retention:</strong> the anchor concentration from the measured combination direction that retains the most dose levels at the current tolerance. Read the drug values together as one anchor set; this is a layout reference, not an IC50 estimate.</p>
    <p><strong>Assigned dose anchor:</strong> the editable value actually used to select combination wells and express dose. Choose assigned anchors whose ratios match the experimental dilution direction. For example, anchors of 500 µM and 0.0625 µg/mL accept combinations of 250 µM + 0.03125 µg/mL: each is 0.5 anchor units.</p>
    <p>A layout-compatible anchor is not a new IC50 estimate or MIC. Multiplying all anchors by the same positive factor preserves the diagonal; changing their ratios selects a different direction and can change the fitted result. Check each regimen below before calculating.</p>
  </div>;
}

export type DiamondLayoutResult = { check?: DiamondLayoutCheck; error?: string };

export function diamondRetentionAssignments(
  assignments: { key: string; organism: string | null; name: string }[],
  checks: DiamondLayoutRequest[], results: DiamondLayoutResult[] | null,
): { values: Record<string, number>; conflict: boolean; complete: boolean } {
  const values: Record<string, number> = {};
  let conflict = false;
  for (const assignment of assignments) {
    const candidates = checks.flatMap((entry, i) => {
      if (entry.request.organism !== assignment.organism) return [];
      const index = entry.request.regimenDrugNames.indexOf(assignment.name);
      const value = index < 0 ? null : results?.[i]?.check?.compatibleAnchors?.[index];
      return value != null && Number.isFinite(value) && value > 0 ? [value] : [];
    });
    const matches = checks.filter((entry) => entry.request.organism === assignment.organism
      && entry.request.regimenDrugNames.includes(assignment.name)).length;
    if (candidates.some((value) => value !== candidates[0])) conflict = true;
    if (matches > 0 && candidates.length === matches && candidates.every((value) => value === candidates[0])) {
      values[assignment.key] = candidates[0];
    }
  }
  return { values, conflict, complete: !conflict && assignments.length > 0 && Object.keys(values).length === assignments.length };
}

export function useDiamondLayoutChecks(checks: DiamondLayoutRequest[]) {
  const key = JSON.stringify(checks);
  const [state, setState] = useState<{ key: string; results: DiamondLayoutResult[] } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const requests = JSON.parse(key) as DiamondLayoutRequest[];
    const timer = window.setTimeout(() => {
      void Promise.all(requests.map(async ({ request }) => {
        try { return { check: await invoke<DiamondLayoutCheck>("check_diamond_layout", { request }) }; }
        catch (reason) { return { error: typeof reason === "object" && reason && "message" in reason ? String(reason.message) : String(reason) }; }
      })).then((results) => { if (!cancelled) setState({ key, results }); });
    }, 200);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [key]);
  return state?.key === key ? state.results : null;
}

export function DiamondAnchorGuidance({ checks, results }: { checks: DiamondLayoutRequest[]; results: DiamondLayoutResult[] | null }) {
  if (!checks.length) return <p className="help-text">Enter positive assigned anchors for all drugs to check combination coverage.</p>;
  if (!results) return <p className="help-text" role="status">Checking assigned anchors against the measured combination doses…</p>;
  return <div className="diamond-anchor-guidance" aria-live="polite">{checks.map((entry, i) => {
    const { check, error } = results[i];
    if (!check) return <div className="side-warning" key={i}><strong>{entry.label}</strong><p>Could not check dose layout: {error}</p></div>;
    const insufficient = check.retainedLocations < 3;
    return <div className={insufficient ? "side-warning" : "method-card"} key={i}>
      <strong>{entry.label}: {check.retainedLocations} of {check.combinationLocations} combination dose levels retained</strong>
      <p>At tolerance {entry.request.diagonalToleranceLog2} log₂, the assigned anchors exclude {check.combinationLocations - check.retainedLocations} full-combination dose levels. Replicates count as one level; controls and single agents are checked separately during analysis.</p>
      {insufficient && <><p>{check.retainedLocations === 0 && check.combinationLocations > 0 ? "All measured full-combination doses would be excluded. " : ""}DiaMOND requires at least three retained full-combination dose levels.</p>
        {check.compatibleAnchors && check.compatibleLocations >= 3 ? <><p><strong>Layout-compatible example — enter these as the assigned dose anchors:</strong></p>
          <ul>{check.compatibleAnchors.map((anchor, index) => <li key={index}>{entry.request.regimenDrugNames[index]}: <strong>{anchor}</strong> {entry.units[index]}</li>)}</ul>
          <p>This measured concentration ratio retains {check.compatibleLocations} combination dose levels at the current tolerance. Review it against the plate preparation, then update the assignments on Dose anchors. Shared organism–drug assignments also affect other selected regimens; recheck their coverage.</p></>
          : <p>No measured full-combination direction retains three levels at this tolerance. Check the concentration mapping, experimental dilution ratios, and available dose levels. Increasing tolerance can combine different directions; use it only for justified dispensing or rounding differences.</p>}
      </>}
    </div>;
  })}</div>;
}

export function DiamondRetentionCell({ organism, drug, checks, results }: {
  organism: string | null; drug: string; checks: DiamondLayoutRequest[]; results: DiamondLayoutResult[] | null;
}) {
  const matching = checks.map((entry, i) => ({ entry, result: results?.[i] }))
    .filter(({ entry }) => (entry.request.organism ?? null) === organism && entry.request.regimenDrugNames.includes(drug));
  if (!matching.length) return <>—</>;
  if (!results) return <>Checking…</>;
  return <>{matching.map(({ entry, result }, i) => {
    const check = result?.check;
    const index = entry.request.regimenDrugNames.indexOf(drug);
    const anchor = check?.compatibleAnchors?.[index];
    return <div key={i}>
      <strong>{anchor == null ? "—" : anchor.toLocaleString(undefined, { maximumSignificantDigits: 8 })}</strong>
      <small className="table-note">{matching.length > 1 ? `${entry.label}: ` : ""}{check ? `${check.compatibleLocations}/${check.combinationLocations} full-combination levels` : result?.error ?? "Layout unavailable"}</small>
      {check && <small className="table-note">Assigned: {check.retainedLocations}/{check.combinationLocations} retained</small>}
    </div>;
  })}</>;
}

export function DiamondRepeatLayouts({ checks, results }: { checks: DiamondLayoutRequest[]; results: DiamondLayoutResult[] | null }) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const keyOf = (entry: DiamondLayoutRequest) => JSON.stringify([entry.request.organism, entry.request.regimenDrugNames]);
  const selectedIndex = Math.max(0, checks.findIndex((entry) => keyOf(entry) === selectedKey));
  return <section className="diamond-repeat-layout"><h2>Suggested layout for a repeat experiment</h2>
    <p>This IC50-centered plan targets equal normalized doses and retention of every planned combination. It is a starting design, not a guarantee of the best biological precision. It replaces the dilution direction for a new experiment; it does not change the imported measurements.</p>
    {!results && <p role="status">Waiting for fitted IC50 values and dose-layout checks…</p>}
    {checks.length > 1 && <div className="diamond-layout-selector"><RegimenNavigator
      regimens={checks.map((entry) => ({ id: keyOf(entry), label: entry.label }))}
      selectedId={keyOf(checks[selectedIndex])} onSelect={setSelectedKey} label="Suggested layout" />
      <span className="help-text">Layout {selectedIndex + 1} of {checks.length}</span></div>}
    {checks.slice(selectedIndex, selectedIndex + 1).map((entry) => {
      const result = results?.[selectedIndex];
      const plan = result?.check?.repeatLayout;
      return <section className="diamond-repeat-regimen" key={keyOf(entry)}><h3>{entry.label}</h3>
        {!plan ? <p className="help-text">{result?.error ?? (results ? "A complete layout needs a finite positive fitted IC50 for every drug and positive concentrations within the supported numeric range. Confirm the single-agent curves first." : "Preparing layout…")}</p>
          : <>
            <p><strong>Use these assigned anchors for the repeat:</strong> {entry.request.regimenDrugNames.map((name, index) => `${name}: ${plan.anchors[index].toLocaleString(undefined, { maximumSignificantDigits: 8 })} ${entry.units[index] ?? ""}`).join("; ")}. These follow the rounded dilution ratio and may differ from the fitted IC50 values.</p>
            <p>Each drug’s highest concentration starts at 16 × fitted IC50. Values from 1 to below 10 round to the nearest integer; values of 10 or more round to the nearest multiple of 5. Values below 1 retain decimal precision with one significant digit. The eight lower concentrations are successive twofold dilutions. The grid axes show final well concentrations, including zero for the control and single-agent row and column.</p>
            <p><strong>{plan.retainedLocations}/{plan.combinationLocations} planned combination levels retained</strong> at tolerance {entry.request.diagonalToleranceLog2} log₂. Include an untreated control and replicate the controls and every dose level to estimate uncertainty. Verify stock availability and solubility before plate preparation.</p>
            {plan.warnings.map((warning) => <p className="side-warning" key={warning}>{warning}</p>)}
            <DiamondRepeatGrid plan={plan} drugNames={entry.request.regimenDrugNames} units={entry.units} />
            <p className="help-text">Italic ICxx labels show the fitted single-agent inhibition percentage at that concentration, rounded to one decimal place. For example, IC50 means approximately 50% inhibition. These are model estimates, not observed responses; rounded planning anchors need not be IC50.</p>
            <p className="help-text">Control = no drug; Single = one drug; Mix = planned combination; — = unused intersection. Measure the marked wells, including replicates. Filling every intersection would add off-diagonal combinations. For three drugs, additional grids show the third-drug concentrations. Confirm that the measured response transition falls within the planned range.</p>
            <p className="help-text">Method basis: <a href="https://pubmed.ncbi.nlm.nih.gov/29026882/" target="_blank" rel="noreferrer">Cokol et al., 2017 (DiaMOND)</a>. The twofold range is this app’s planning choice.</p>
          </>}
      </section>;
    })}
  </section>;
}

export function DiamondRepeatGrid({ plan, drugNames, units }: { plan: DiamondRepeatLayout; drugNames: string[]; units: string[] }) {
  const number = (value: number) => value.toLocaleString(undefined, { maximumSignificantDigits: 10 });
  const doseHeader = (drug: number, index: number) => {
    const level = plan.inhibitionLevels[drug]?.[index];
    return <>{number(plan.dilutions[drug][index])}{level != null && <em className="diamond-dose-ic" title={`Fitted single-agent inhibition: ${level.toLocaleString(undefined, { maximumFractionDigits: 3 })}%`}>IC{level.toLocaleString(undefined, { maximumFractionDigits: 1 })}</em>}</>;
  };
  const planned = new Set(plan.locations.map((location) => location.concentrations.join("|")));
  const slices = plan.dilutions[2] ?? [0];
  const grid = (third: number) => <div className="result-table-wrap"><table className="diamond-repeat-grid">
    <caption>{drugNames[0]} ({units[0] || "imported units"}) →{drugNames.length === 3 ? ` · ${drugNames[2]} = ${number(third)} ${units[2] ?? ""}` : ""}</caption>
    <thead><tr><th scope="col">{drugNames[1]} ({units[1] || "imported units"}) ↓</th>{plan.dilutions[0].map((dose, index) => <th scope="col" key={dose}>{doseHeader(0, index)}</th>)}</tr></thead>
    <tbody>{plan.dilutions[1].map((y, index) => <tr key={y}><th scope="row">{doseHeader(1, index)}</th>{plan.dilutions[0].map((x) => {
      const concentrations = drugNames.length === 3 ? [x, y, third] : [x, y];
      const active = concentrations.filter((c) => c > 0).length;
      const included = active === 0 || planned.has(concentrations.join("|"));
      const label = !included ? "—" : active === 0 ? "Control" : active === 1 ? "Single" : "Mix";
      return <td key={x} className={!included ? "unused" : active === 0 ? "control" : active === 1 ? "single" : "combination"}
        aria-label={`${drugNames.map((name, i) => `${name} ${number(concentrations[i])} ${units[i] ?? ""}`).join(", ")}: ${included ? label : "unused"}`}>{label}</td>;
    })}</tr>)}</tbody>
  </table></div>;
  return <div className="diamond-repeat-grids">{grid(slices[0])}{slices.slice(1).map((third) => <details key={third}><summary>{drugNames[2]} = {number(third)} {units[2]}</summary>{grid(third)}</details>)}</div>;
}

export function DiamondSetupWorkspace({
  inputType, responseCensorLimit, setResponseCensorLimit, bootstrapIterations,
  setBootstrapIterations, randomSeed, setRandomSeed, diagonalToleranceLog2,
  setDiagonalToleranceLog2, calculate, busy, progress, settingsComplete,
  anchorGuidance,
}: {
  inputType: InputSettings["inputType"];
  responseCensorLimit: number | null;
  setResponseCensorLimit: (value: number | null) => void;
  bootstrapIterations: number;
  setBootstrapIterations: (value: number) => void;
  randomSeed: number;
  setRandomSeed: (value: number) => void;
  diagonalToleranceLog2: number;
  setDiagonalToleranceLog2: (value: number) => void;
  calculate: () => Promise<void>;
  busy: boolean;
  progress: Progress | null;
  settingsComplete: boolean;
  anchorGuidance: ReactNode;
}) {
  return <main className="workspace analysis-setup-workspace"><aside className="sidebar">
    {(inputType === "absorbance" || inputType === "count") && <label>Response censor limit
      <input type="number" min={inputType === "count" ? 1 : 0} step="any" value={responseCensorLimit ?? ""} onChange={(event) => setResponseCensorLimit(nullable(event.target.value))} />
      <span className="field-help">Responses at or below this limit are censored before normalization.</span>
    </label>}
    <label>Bootstrap iterations<input type="number" min={2} step={1} value={bootstrapIterations} onChange={(event) => setBootstrapIterations(Math.max(2, Number(event.target.value) || 2))} /></label>
    <label>Random seed<input type="number" min={0} step={1} value={randomSeed} onChange={(event) => setRandomSeed(Math.max(0, Number(event.target.value) || 0))} /></label>
    <label>Diagonal tolerance (log₂ units)<input type="number" min={0} step="0.01" value={diagonalToleranceLog2} onChange={(event) => setDiagonalToleranceLog2(Math.max(0, Number(event.target.value) || 0))} />
      <span className="field-help">Active drug concentrations divided by their dose anchors must agree within this log₂ range.</span>
    </label>
  </aside><section className="content-card stage-card">
    <div className="card-heading"><div><h1>DiaMOND analysis</h1><p>Fit the single-agent and equipotent combination diagonals, then calculate Loewe FIC50 and FIC90. Off-diagonal wells do not enter the primary fits; complete checkerboards additionally receive full-isobole diagnostics.</p></div></div>
    <div className="stage-content">
      <DiamondAnchorExplanation />
      {anchorGuidance}
      <div className="method-card"><strong>Normalized response scale</strong><p>Control-normalized viability may be supplied as a fraction or percentage. DiaMOND detects the scale from the all-zero drug controls: a mean near 1 is fractional and a mean near 100 is percentage. Response censoring is not applied to normalized viability; it is used only for raw instrument measurements.</p></div>
      <button className="success-button calculate-button" disabled={busy || !settingsComplete} onClick={calculate}>{busy ? "Calculating…" : "Calculate DiaMOND"}</button>
      {progress && <ProgressBar progress={progress} />}
    </div>
  </section></main>;
}

export function DiamondResultsWorkspace({ entries, selected, select, returnToAnalyze }: {
  entries: DiamondRegimen[];
  selected: DiamondRegimen;
  select: (entry: DiamondRegimen) => void;
  returnToAnalyze: () => void;
}) {
  const [tab, setTab] = useState<"summary" | "diamondPlots" | "curves" | "processed">("summary");
  const [requestedPlotLevel, setRequestedPlotLevel] = useState(50);
  const result = selected.result;
  const availablePlotLevels = result.totalScores.map((score) => score.inhibitionLevel);
  const plotLevel = availablePlotLevels.includes(requestedPlotLevel)
    ? requestedPlotLevel
    : availablePlotLevels.includes(50) ? 50 : availablePlotLevels[0] ?? 50;
  const plotScore = scoreFor(result.totalScores, plotLevel);
  const plotDiagnostics = (result.isoboleDiagnostics ?? [])
    .filter((diagnostic) => diagnostic.inhibitionLevel === plotLevel);
  return <main className="workspace analysis-workspace"><aside className="sidebar">
    <section><h2>DiaMOND analysis</h2>
      {entries.length > 1 && <RegimenNavigator regimens={entries} selectedId={selected.id} onSelect={(id) => { const entry = entries.find((item) => item.id === id); if (entry) select(entry); }} compact />}
      <p className="combination-name">{result.drugNames.join(" + ")}</p>
      <p className="help-text">Native Loewe-additive DiaMOND · FIC &lt; 1 synergy · FIC &gt; 1 antagonism.</p>
      <p className="help-text">Dose anchors: {result.drugNames.map((name, i) => `${name} ${fmt(result.doseAnchors[i])}${result.concentrationUnits[i] ? ` ${result.concentrationUnits[i]}` : ""}`).join(" · ")}</p>
    </section>
    {plotScore && <section className="diamond-sidebar-isobole"><h3>FIC{plotLevel} isobole comparison</h3>
      {plotDiagnostics.length > 0 ? plotDiagnostics.map((diagnostic) => <p key={diagnostic.drugIndices.join("-")}>{diagnostic.surfaceFic == null
        ? `The full-checkerboard IC${plotLevel} isobole for ${diagnostic.drugNames.join(" + ")} does not intersect the equipotent ray inside the observed grid.`
        : `The full-checkerboard IC${plotLevel} isobole for ${diagnostic.drugNames.join(" + ")} intersects the equipotent ray at FIC ${fmt(diagnostic.surfaceFic)}, versus primary diagonal FIC ${fmt(diagnostic.primaryFic)} (|log₂ ratio| ${fmt(diagnostic.absoluteLog2Difference ?? 0)} ${diagnostic.agreesWithPrimary === false ? ">" : "≤"} 0.5).${diagnostic.agreesWithPrimary === false ? " This is a material disagreement." : " These estimates agree within the diagnostic threshold."}`}</p>)
        : <p><strong>Full checkerboard:</strong> not available for this inhibition level.</p>}
      <p className="help-text">The FIC50/FIC90 toggle in DiaMOND plots updates this comparison.</p>
    </section>}
    <p className="help-text">FIC &lt; 1 is synergistic; FIC = 1 is additive; FIC &gt; 1 is antagonistic. A 95% CI spanning 1 is labeled additive.</p>
    <p className="help-text">Diagonal tolerance {fmt(result.policy.diagonalToleranceLog2)} log₂ · seed {result.policy.randomSeed} · {result.policy.bootstrapIterations} iterations.</p>
    <button className="secondary-button full-width" onClick={returnToAnalyze}>Return to Analyze and rerun</button>
    {result.warnings.map((warning) => <div className="side-warning" key={warning}>{warning}</div>)}
  </aside><section className="content-card results-card">
    <div className="result-tabs" role="tablist">
      <button className={tab === "summary" ? "tab-active" : ""} onClick={() => setTab("summary")}>Summary</button>
      <button className={tab === "diamondPlots" ? "tab-active" : ""} onClick={() => setTab("diamondPlots")}>DiaMOND plots</button>
      <button className={tab === "curves" ? "tab-active" : ""} onClick={() => setTab("curves")}>Dose responses</button>
      <button className={tab === "processed" ? "tab-active" : ""} onClick={() => setTab("processed")}>Processed data</button>
    </div>
    <div className="result-panel">
      {tab === "summary" && <DiamondSummary result={result} />}
      {tab === "diamondPlots" && <DiamondPlots result={result} level={plotLevel} setLevel={setRequestedPlotLevel} />}
      {tab === "curves" && <DiamondCurves result={result} />}
      {tab === "processed" && <DiamondProcessed result={result} />}
    </div>
  </section></main>;
}

export function DiamondComparisonWorkspace({ entries, grouping, setGrouping, importAnother }: {
  entries: DiamondRegimen[];
  grouping: "organism" | "regimen";
  setGrouping: (value: "organism" | "regimen") => void;
  importAnother: () => void;
}) {
  const [rankingLevel, setRankingLevel] = useState<50 | 90>(50);
  const groups = new Map<string, DiamondRegimen[]>();
  for (const entry of entries) {
    const key = grouping === "organism" ? entry.organism || "Unspecified organism" : entry.regimenLabel || entry.label;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return <main className="workspace comparison-workspace"><aside className="sidebar"><h2>DiaMOND comparison</h2>
    <label>Group comparisons by<select value={grouping} onChange={(event) => setGrouping(event.target.value as "organism" | "regimen")}><option value="organism">Organism</option><option value="regimen">Regimen</option></select></label>
    <label>Sort regimens by<select value={rankingLevel} onChange={(event) => setRankingLevel(Number(event.target.value) as 50 | 90)}><option value={50}>FIC50</option><option value={90}>FIC90</option></select></label>
    <p className="help-text">Regimens are ranked by total FIC{rankingLevel}; analyses without that estimate appear last. Lower FIC indicates greater synergy.</p>
    <button className="primary-button full-width" onClick={importAnother}>Import another regimen</button>
  </aside><section className="content-card comparison-card"><div className="comparison-content">
    {[...groups.entries()].flatMap(([group, members]) => ([2, 3] as const).map((count) => ({ group, count, members: members.filter((entry) => entry.result.drugNames.length === count) })).filter((cohort) => cohort.members.length)).map((cohort) => {
      const ranked = [...cohort.members].sort((a, b) => {
        const difference = diamondRankingScore(a.result, rankingLevel) - diamondRankingScore(b.result, rankingLevel);
        return Number.isNaN(difference) ? a.label.localeCompare(b.label) : difference || a.label.localeCompare(b.label);
      });
      return <section className="comparison-section" key={`${cohort.group}-${cohort.count}`}><h2>{grouping === "organism" ? "Organism" : "Regimen"}: {cohort.group} · {cohort.count}-drug analyses</h2>
        <div className="result-table-wrap"><table className="result-table ranking-table"><thead><tr><th>Rank</th><th>Regimen</th><th>FIC50</th><th>FIC90</th>{cohort.count === 3 && <th>Emergent FIC{rankingLevel}</th>}</tr></thead><tbody>
          {ranked.map((entry, index) => <tr key={entry.id}><td>{index + 1}</td><td>{entry.label}</td><td>{scoreText(entry.result, 50)}</td><td>{scoreText(entry.result, 90)}</td>{cohort.count === 3 && <td>{scoreText(entry.result, rankingLevel, true)}</td>}</tr>)}
        </tbody></table></div>
      </section>;
    })}
  </div></section></main>;
}

function DiamondSummary({ result }: { result: DiamondResult }) {
  return <div className="summary-panel"><h1>DiaMOND interaction summary</h1>
    <div className="metrics-grid">{result.totalScores.map((score) => <div className="metric" key={score.inhibitionLevel}><span>Total FIC{score.inhibitionLevel}{score.inhibitionLevel === 50 ? " · primary" : ""}</span><strong>{fmt(score.fic)}</strong><small>{score.interpretation}{score.ciLower != null && score.ciUpper != null ? ` · 95% CI ${fmt(score.ciLower)}–${fmt(score.ciUpper)}` : ""}</small></div>)}</div>
    <ScoreTable title="Total interaction" scores={result.totalScores} showLog2={false} />
    {result.emergentScores.length > 0 && <ScoreTable title="Emergent three-drug interaction" scores={result.emergentScores} />}
    {result.pairwiseSummaries.map((pair) => <ScoreTable key={pair.drugNames.join("+")} title={`Pairwise face: ${pair.drugNames.join(" + ")}`} scores={pair.scores} />)}
  </div>;
}

function ScoreTable({ title, scores, showLog2 = true }: { title: string; scores: DiamondResult["totalScores"]; showLog2?: boolean }) {
  return <section><h2>{title}</h2><div className="result-table-wrap"><table className="result-table"><thead><tr><th>Level</th><th>Observed dose</th><th>Expected dose</th><th>FIC</th>{showLog2 && <th>log₂(FIC)</th>}<th>95% CI</th><th>Interpretation</th></tr></thead><tbody>
    {scores.map((score) => <tr key={score.inhibitionLevel}><td>IC{score.inhibitionLevel}</td><td>{fmt(score.observedDose)}</td><td>{fmt(score.expectedDose)}</td><td>{fmt(score.fic)}</td>{showLog2 && <td>{fmt(score.log2Fic)}</td>}<td>{score.ciLower == null || score.ciUpper == null ? "—" : `${fmt(score.ciLower)}–${fmt(score.ciUpper)}`}</td><td><span className={`interpretation ${score.interpretation}`}>{score.interpretation}</span></td></tr>)}
  </tbody></table></div></section>;
}

function DiamondPlots({ result, level, setLevel }: { result: DiamondResult; level: number; setLevel: (level: number) => void }) {
  const availableLevels = result.totalScores.map((score) => score.inhibitionLevel);
  const isoboles = (result.isoboleDiagnostics ?? [])
    .filter((diagnostic) => diagnostic.inhibitionLevel === level);
  return <div className="diamond-plots-panel">
    <div className="diamond-plot-toolbar"><div><h1>DiaMOND interaction plots</h1><p>Observed combination potency is compared with the Loewe-additive expectation at a common inhibition level.</p></div><div className="level-toggle" role="group" aria-label="DiaMOND inhibition level">
      {[50, 90].map((candidate) => <button key={candidate} disabled={!availableLevels.includes(candidate)} className={level === candidate ? "tab-active" : ""} onClick={() => setLevel(candidate)}>FIC{candidate}</button>)}
    </div></div>
    <div className="diamond-method-grid">
      {result.drugNames.length === 2 ? <PairGeometryPlot result={result} level={level} /> : <TripleGeometryPlot result={result} level={level} />}
      <RelativeFicPlot result={result} level={level} />
    </div>
    <section className="diamond-isobole-section"><h2>Full-checkerboard isobole diagnostics</h2>
      <p>These contours use off-diagonal observations only as a diagnostic. The fitted-diagonal FIC and bootstrap interval remain the primary result.</p>
      {isoboles.length > 0
        ? <div className="diamond-method-grid">{isoboles.map((diagnostic) => <FullIsobolePlot result={result} diagnostic={diagnostic} key={`${diagnostic.drugIndices.join("-")}-${level}`} />)}</div>
        : <div className="method-card"><strong>Complete checkerboard required</strong><p>No complete two-drug grid reaches IC{level}. Missing cells are not imputed and contours are not extrapolated. For three-drug assays, each complete zero-third-drug face is checked separately.</p></div>}
    </section>
  </div>;
}

function FullIsobolePlot({ result, diagnostic }: { result: DiamondResult; diagnostic: DiamondIsoboleDiagnostic }) {
  const [first, second] = diagnostic.drugIndices;
  const [firstIc, secondIc] = diagnostic.singleDrugIcs;
  const locations = result.assayLocations.filter((location) => location.concentrations.every((concentration, index) =>
    index === first || index === second || Math.abs(concentration) < 1e-12)).map((location) => ({
      ...location,
      x: location.concentrations[first] / firstIc,
      y: location.concentrations[second] / secondIc,
    }));
  const contourCoordinates = diagnostic.contourSegments.flatMap((segment) => [segment.start, segment.end]);
  const maxX = Math.max(1.2, ...locations.map((point) => point.x), ...contourCoordinates.map((point) => point[0]));
  const maxY = Math.max(1.2, ...locations.map((point) => point.y), ...contourCoordinates.map((point) => point[1]));
  const width = 600, height = 450, left = 82, right = 34, top = 38, bottom = 72;
  const plotWidth = width-left-right, plotHeight = height-top-bottom;
  const x = (value: number) => left + value/maxX*plotWidth;
  const y = (value: number) => top + (maxY-value)/maxY*plotHeight;
  const xLevels = unique(locations.map((point) => point.x));
  const yLevels = unique(locations.map((point) => point.y));
  const cellWidth = Math.max(5, Math.min(32, plotWidth/Math.max(2, xLevels.length)*0.8));
  const cellHeight = Math.max(5, Math.min(32, plotHeight/Math.max(2, yLevels.length)*0.8));
  const directionTotal = diagnostic.rayDirection[0] + diagnostic.rayDirection[1];
  const primary = directionTotal > 0 ? [
    diagnostic.primaryFic*diagnostic.rayDirection[0]/directionTotal,
    diagnostic.primaryFic*diagnostic.rayDirection[1]/directionTotal,
  ] : null;
  const rayScale = Math.min(maxX/diagnostic.rayDirection[0], maxY/diagnostic.rayDirection[1])*0.96;
  const agrees = diagnostic.agreesWithPrimary;
  return <figure className="diamond-method-figure"><h2>{diagnostic.drugNames.join(" + ")} IC{diagnostic.inhibitionLevel} isobole</h2><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${diagnostic.drugNames.join(" plus ")} full checkerboard IC${diagnostic.inhibitionLevel} isobole diagnostic`}>
    <rect x={left} y={top} width={plotWidth} height={plotHeight} className="diamond-plot-background" />
    {locations.map((point, index) => <rect className="diamond-assay-cell" key={index} x={x(point.x)-cellWidth/2} y={y(point.y)-cellHeight/2} width={cellWidth} height={cellHeight} rx="2" fill={inhibitionColor(point.meanInhibition)}><title>{diagnostic.drugNames[0]} {fmt(point.concentrations[first])}; {diagnostic.drugNames[1]} {fmt(point.concentrations[second])}; {fmt(point.meanInhibition)}% inhibition</title></rect>)}
    <line className="chart-axis" x1={left} y1={y(0)} x2={left+plotWidth} y2={y(0)} /><line className="chart-axis" x1={x(0)} y1={top} x2={x(0)} y2={top+plotHeight} />
    <line className="diamond-isobole" x1={x(1)} y1={y(0)} x2={x(0)} y2={y(1)} />
    <line className="diamond-dose-ray" x1={x(0)} y1={y(0)} x2={x(rayScale*diagnostic.rayDirection[0])} y2={y(rayScale*diagnostic.rayDirection[1])} />
    {diagnostic.contourSegments.map((segment, index) => <line className="diamond-observed-contour" key={index} x1={x(segment.start[0])} y1={y(segment.start[1])} x2={x(segment.end[0])} y2={y(segment.end[1])} />)}
    {primary && <rect className="diamond-primary-marker" x={x(primary[0])-6} y={y(primary[1])-6} width="12" height="12" transform={`rotate(45 ${x(primary[0])} ${y(primary[1])})`}><title>Primary fitted-diagonal FIC = {fmt(diagnostic.primaryFic)}</title></rect>}
    {diagnostic.rayIntersection && <circle className={agrees === false ? "diamond-surface-marker disagreement" : "diamond-surface-marker"} cx={x(diagnostic.rayIntersection[0])} cy={y(diagnostic.rayIntersection[1])} r="8"><title>Surface-derived FIC = {diagnostic.surfaceFic == null ? "not estimable" : fmt(diagnostic.surfaceFic)}</title></circle>}
    <text className="chart-axis-title" x={left+plotWidth/2} y={height-18} textAnchor="middle">{diagnostic.drugNames[0]} dose / single-drug IC{diagnostic.inhibitionLevel}</text>
    <text className="chart-axis-title" transform={`translate(20 ${top+plotHeight/2}) rotate(-90)`} textAnchor="middle">{diagnostic.drugNames[1]} dose / single-drug IC{diagnostic.inhibitionLevel}</text>
  </svg><figcaption><span>Muted blue squares: observed checkerboard locations; darker squares indicate greater mean inhibition. Magenta: interpolated observed IC{diagnostic.inhibitionLevel} contour. Blue dashed: additive isobole. Gold: equipotent ray. Semitransparent diamond: primary fitted-diagonal FIC. Semitransparent circle: surface intersection.</span><span>{diagnostic.surfaceFic == null
    ? "The observed contour does not cross the equipotent ray inside the tested grid."
    : `Surface FIC ${fmt(diagnostic.surfaceFic)} versus primary FIC ${fmt(diagnostic.primaryFic)} · |log₂ ratio| ${fmt(diagnostic.absoluteLog2Difference ?? 0)} · ${agrees === false ? "material disagreement" : "agreement within 0.5 log₂"}.`}{diagnostic.rayIntersectionCount > 1 ? ` ${diagnostic.rayIntersectionCount} crossings were found; the lowest-dose crossing is marked.` : ""}</span><span>Complete observed grid: {diagnostic.gridShape[0]} × {diagnostic.gridShape[1]} locations.</span></figcaption></figure>;
}

function PairGeometryPlot({ result, level }: { result: DiamondResult; level: number }) {
  const singles = [0, 1].map((index) => curveFor(result, [index]));
  const score = scoreFor(result.totalScores, level);
  const singleIcs = singles.map((curve) => curve ? icForLevel(curve, level) : null);
  if (!score || singleIcs.some((value) => value == null || value <= 0)) return <PlotUnavailable title="Pairwise isobole" />;
  const [icX, icY] = singleIcs as number[];
  const locations = (result.assayLocations ?? []).filter((location) => location.concentrations.length >= 2);
  const relative = locations.map((location) => ({
    ...location,
    x: location.concentrations[0] / result.doseAnchors[0] / icX,
    y: location.concentrations[1] / result.doseAnchors[1] / icY,
  }));
  const maxX = Math.max(1.2, ...relative.map((point) => point.x));
  const maxY = Math.max(1.2, ...relative.map((point) => point.y));
  const width = 560, height = 430, left = 78, right = 34, top = 34, bottom = 70;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const x = (value: number) => left + value / maxX * plotWidth;
  const y = (value: number) => top + (maxY - value) / maxY * plotHeight;
  const xLevels = unique(relative.map((point) => point.x));
  const yLevels = unique(relative.map((point) => point.y));
  const cellWidth = Math.max(5, Math.min(34, plotWidth / Math.max(2, xLevels.length) * 0.82));
  const cellHeight = Math.max(5, Math.min(34, plotHeight / Math.max(2, yLevels.length) * 0.82));
  const observedEach = score.observedDose / 2;
  const expectedEach = score.expectedDose / 2;
  const observed = { x: observedEach / icX, y: observedEach / icY };
  const expected = { x: expectedEach / icX, y: expectedEach / icY };
  return <figure className="diamond-method-figure"><h2>Pairwise checkerboard and isobole</h2><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${result.drugNames.join(" plus ")} FIC${level} checkerboard and isobole`}>
    <rect x={left} y={top} width={plotWidth} height={plotHeight} className="diamond-plot-background" />
    {relative.map((point, index) => <rect className="diamond-assay-cell" key={index} x={x(point.x)-cellWidth/2} y={y(point.y)-cellHeight/2} width={cellWidth} height={cellHeight} rx="2" fill={inhibitionColor(point.meanInhibition)}><title>{result.drugNames[0]} {fmt(point.concentrations[0])}; {result.drugNames[1]} {fmt(point.concentrations[1])}; {fmt(point.meanInhibition)}% inhibition</title></rect>)}
    <line className="chart-axis" x1={left} y1={y(0)} x2={left+plotWidth} y2={y(0)} /><line className="chart-axis" x1={x(0)} y1={top} x2={x(0)} y2={top+plotHeight} />
    <line className="diamond-isobole" x1={x(1)} y1={y(0)} x2={x(0)} y2={y(1)} />
    <line className="diamond-dose-ray" x1={x(0)} y1={y(0)} x2={x(observed.x*1.12)} y2={y(observed.y*1.12)} />
    <circle className="diamond-single-marker" cx={x(1)} cy={y(0)} r="9" /><circle className="diamond-single-marker" cx={x(0)} cy={y(1)} r="9" />
    <rect className="diamond-expected-marker" x={x(expected.x)-6} y={y(expected.y)-6} width="12" height="12" transform={`rotate(45 ${x(expected.x)} ${y(expected.y)})`} />
    <circle className="diamond-observed-marker" cx={x(observed.x)} cy={y(observed.y)} r="10" fill={interactionColor(score.interpretation)} stroke="#20262d" strokeWidth="2"><title>Observed FIC{level} = {fmt(score.fic)} ({score.interpretation})</title></circle>
    <text className="chart-axis-title" x={left+plotWidth/2} y={height-18} textAnchor="middle">{result.drugNames[0]} dose / single-drug IC{level}</text>
    <text className="chart-axis-title" transform={`translate(20 ${top+plotHeight/2}) rotate(-90)`} textAnchor="middle">{result.drugNames[1]} dose / single-drug IC{level}</text>
    <text x={left+10} y={top+20} className="diamond-plot-label">FIC{level} {fmt(score.fic)} · {score.interpretation}</text>
  </svg><figcaption>Muted blue squares are observed checkerboard locations; darker squares indicate greater mean inhibition. The dashed blue line is the additive isobole and the gold line is the equipotent ray. The semitransparent blue diamond is the expected combination dose. The semitransparent circle is the observed combination dose: green means synergistic, pale gray means additive, and red means antagonistic.</figcaption></figure>;
}

function TripleGeometryPlot({ result, level }: { result: DiamondResult; level: number }) {
  const singles = [0, 1, 2].map((index) => curveFor(result, [index]));
  const singleIcs = singles.map((curve) => curve ? icForLevel(curve, level) : null);
  const total = scoreFor(result.totalScores, level);
  if (!total || singleIcs.some((value) => value == null || value <= 0)) return <PlotUnavailable title="Three-drug interaction geometry" />;
  const ics = singleIcs as number[];
  const pointForCurve = (curve: DiamondCurve) => {
    const dose = icForLevel(curve, level);
    if (dose == null) return null;
    const each = dose / curve.drugIndices.length;
    const point = [0, 0, 0];
    for (const index of curve.drugIndices) point[index] = each / ics[index];
    return point;
  };
  const pairPoints = result.curves.filter((curve) => curve.drugIndices.length === 2).map(pointForCurve).filter(isPoint3);
  const fullCurve = curveFor(result, [0, 1, 2]);
  const observed = fullCurve ? pointForCurve(fullCurve) : null;
  if (!observed) return <PlotUnavailable title="Three-drug interaction geometry" />;
  const maxCoordinate = Math.max(1.25, ...pairPoints.flat(), ...observed);
  const origin = [300, 315] as const;
  const scale = 185 / maxCoordinate;
  const project = (point: number[]) => ({ x: origin[0] + (point[1]-point[0])*scale*0.78, y: origin[1] + (point[0]+point[1])*scale*0.34-point[2]*scale });
  const axes = [[1,0,0],[0,1,0],[0,0,1]].map(project);
  const projectedPairs = pairPoints.map(project);
  const projectedObserved = project(observed);
  const emergent = scoreFor(result.emergentScores, level);
  const totalColor = interactionColor(total.interpretation);
  const emergentColor = emergent ? interactionColor(emergent.interpretation) : totalColor;
  const r = 11;
  return <figure className="diamond-method-figure"><h2>Three-drug interaction geometry</h2><svg viewBox="0 0 600 430" role="img" aria-label={`${result.drugNames.join(" plus ")} FIC${level} three-drug geometry`}>
    <polygon points={axes.map((point) => `${point.x},${point.y}`).join(" ")} className="diamond-single-plane" />
    {projectedPairs.length === 3 && <polygon points={projectedPairs.map((point) => `${point.x},${point.y}`).join(" ")} className="diamond-pair-plane" />}
    {axes.map((point, index) => <g key={result.drugNames[index]}><line className="chart-axis" x1={origin[0]} y1={origin[1]} x2={point.x} y2={point.y} /><circle className="diamond-single-marker" cx={point.x} cy={point.y} r="8" /><text x={point.x} y={point.y-14} textAnchor="middle" className="diamond-axis-label">{result.drugNames[index]} IC{level}</text></g>)}
    {projectedPairs.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r="7" className="diamond-pair-marker"><title>Observed pairwise IC{level}</title></circle>)}
    <line className="diamond-dose-ray" x1={origin[0]} y1={origin[1]} x2={projectedObserved.x} y2={projectedObserved.y} />
    <circle className="diamond-observed-marker" cx={projectedObserved.x} cy={projectedObserved.y} r={r} fill={totalColor} stroke="#20262d" strokeWidth="2" />
    {emergent && <path className="diamond-observed-marker" d={`M ${projectedObserved.x-r} ${projectedObserved.y} L ${projectedObserved.x+r} ${projectedObserved.y} A ${r} ${r} 0 0 1 ${projectedObserved.x-r} ${projectedObserved.y} Z`} fill={emergentColor} stroke="#20262d" strokeWidth="1" />}
    <text x="22" y="28" className="diamond-plot-label">Total FIC{level} {fmt(total.fic)} · {total.interpretation}</text>
    <text x="22" y="50" className="diamond-plot-label">Emergent FIC{level} {emergent ? `${fmt(emergent.fic)} · ${emergent.interpretation}` : "not estimable"}</text>
  </svg><figcaption>Blue plane: additive expectation from single drugs. Magenta plane: expectation from measured pairs. The semitransparent triple point is split by total (top) and emergent (bottom) interaction where both are estimable. Green means synergistic, pale gray means additive, and red means antagonistic.</figcaption></figure>;
}

function RelativeFicPlot({ result, level }: { result: DiamondResult; level: number }) {
  const score = scoreFor(result.totalScores, level);
  const singles = result.curves.filter((curve) => curve.drugIndices.length === 1);
  const combination = result.curves.find((curve) => curve.drugIndices.length === result.drugNames.length);
  if (!score || !combination || singles.some((curve) => icForLevel(curve, level) == null)) return <PlotUnavailable title={`Relative FIC${level} dose responses`} />;
  const curves = [...singles, combination];
  const colors = ["#dc6b35", "#2867b2", "#7b4ab5", "#171a1e"];
  const width = 620, height = 410, left = 70, right = 28, top = 32, bottom = 66;
  const intervalUpper = score.ciUpper != null && Number.isFinite(score.ciUpper) ? score.ciUpper : score.fic;
  const maxX = Math.max(2.2, intervalUpper * 1.2);
  const x = (value: number) => left + value / maxX * (width-left-right);
  const y = (value: number) => top + (100-value) / 100 * (height-top-bottom);
  const samples = Array.from({ length: 140 }, (_, index) => maxX*index/139);
  return <figure className="diamond-method-figure diamond-relative-figure"><h2>Relative FIC{level} dose responses</h2><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Relative FIC${level} single and combination dose responses`}>
    <rect className="diamond-synergy-region" x={left} y={top} width={x(1)-left} height={height-top-bottom} />
    <rect className="diamond-antagonism-region" x={x(1)} y={top} width={width-right-x(1)} height={height-top-bottom} />
    {[0, level, 100].map((tick) => <g key={tick}><line className="chart-grid" x1={left} x2={width-right} y1={y(tick)} y2={y(tick)} /><text x={left-8} y={y(tick)+4} textAnchor="end">{tick}</text></g>)}
    <line className="chart-axis" x1={left} x2={width-right} y1={height-bottom} y2={height-bottom} /><line className="chart-axis" x1={left} x2={left} y1={top} y2={height-bottom} />
    <line className="diamond-expected-dose" x1={x(1)} x2={x(1)} y1={top} y2={height-bottom} />
    {curves.map((curve, index) => {
      const isCombination = curve === combination;
      const divisor = isCombination ? score.expectedDose : icForLevel(curve, level)!;
      const path = samples.map((relativeDose, pointIndex) => `${pointIndex ? "L" : "M"}${x(relativeDose)},${y(hill(curve, relativeDose*divisor))}`).join(" ");
      return <path key={curve.drugNames.join("+")} d={path} fill="none" stroke={colors[index]} strokeWidth={isCombination ? 3.5 : 2.5} />;
    })}
    {singles.map((curve, index) => <circle key={curve.drugNames[0]} cx={x(1)} cy={y(level)} r="5" fill={colors[index]} />)}
    {score.ciLower != null && score.ciUpper != null && <g className="diamond-ci-whisker">
      <line x1={x(score.ciLower)} x2={x(score.ciUpper)} y1={y(level)} y2={y(level)} />
      <line x1={x(score.ciLower)} x2={x(score.ciLower)} y1={y(level)-8} y2={y(level)+8} />
      <line x1={x(score.ciUpper)} x2={x(score.ciUpper)} y1={y(level)-8} y2={y(level)+8} />
      <title>Bootstrap 95% CI for relative combination IC{level}: {fmt(score.ciLower)} to {fmt(score.ciUpper)}</title>
    </g>}
    <circle cx={x(score.fic)} cy={y(level)} r="7" fill={colors[curves.length-1]} stroke="#fff" strokeWidth="2" />
    <text className="diamond-region-label synergy" x={(left+x(1))/2} y={top+16} textAnchor="middle">Synergy · FIC &lt; 1</text>
    <text className="diamond-region-label antagonism" x={(x(1)+width-right)/2} y={top+16} textAnchor="middle">Antagonism · FIC &gt; 1</text>
    <text className="chart-axis-title" x={(left+width-right)/2} y={height-16} textAnchor="middle">Relative dose (additive expected IC{level} = 1)</text>
    <text className="chart-axis-title" transform={`translate(19 ${(top+height-bottom)/2}) rotate(-90)`} textAnchor="middle">Growth inhibition (%)</text>
    <text x={x(1)+6} y={top+16} className="diamond-plot-label">Additive expectation</text>
  </svg><figcaption><span className="diamond-inline-legend">{curves.map((curve, index) => <span key={curve.drugNames.join("+")}><i style={{ background: colors[index] }} />{curve.drugNames.join(" + ")}</span>)}</span><span>Combination IC{level} values left of the additive expectation at relative dose 1 are synergistic; values to its right are antagonistic. The combination reaches IC{level} at relative dose {fmt(score.fic)}; this is FIC{level}.{score.ciLower != null && score.ciUpper != null ? ` Horizontal whiskers show its bootstrap 95% CI (${fmt(score.ciLower)}–${fmt(score.ciUpper)}).` : " No whisker is shown when replicate bootstrap intervals are unavailable."}</span></figcaption></figure>;
}

function PlotUnavailable({ title }: { title: string }) { return <figure className="diamond-method-figure diamond-plot-unavailable"><h2>{title}</h2><p>This plot cannot be drawn because one or more fitted curves do not reach the selected inhibition level.</p></figure>; }
function curveFor(result: DiamondResult, indices: number[]) { return result.curves.find((curve) => curve.drugIndices.length === indices.length && curve.drugIndices.every((value, index) => value === indices[index])); }
function icForLevel(curve: DiamondCurve, level: number) { return level === 90 ? curve.fit.ic90 : curve.fit.ic50; }
function scoreFor(scores: DiamondResult["totalScores"], level: number) { return scores.find((score) => score.inhibitionLevel === level); }
function isPoint3(point: number[] | null): point is number[] { return point != null; }
function unique(values: number[]) { return [...new Set(values)].sort((left, right) => left-right); }
function interactionColor(value: string) { return value === "synergistic" ? "#23b14d" : value === "antagonistic" ? "#e03b32" : "#f3f4f5"; }
function inhibitionColor(inhibition: number) { const amount = Math.max(0, Math.min(1, inhibition/100)); const low = [245,249,255], high = [8,29,88]; return `rgb(${low.map((value,index) => Math.round(value+(high[index]-value)*amount)).join(",")})`; }

function DiamondCurves({ result }: { result: DiamondResult }) {
  return <div className="diamond-curve-grid">{result.curves.map((curve) => <CurvePlot curve={curve} key={curve.drugNames.join("+")} />)}</div>;
}

function CurvePlot({ curve }: { curve: DiamondCurve }) {
  const width = 520, height = 300, left = 54, top = 22, right = 16, bottom = 45;
  const maxDose = Math.max(...curve.points.map((point) => point.normalizedTotalDose)) * 1.05;
  const x = (dose: number) => left + dose / maxDose * (width - left - right);
  const y = (effect: number) => top + (100 - effect) / 100 * (height - top - bottom);
  const samples = Array.from({ length: 100 }, (_, i) => maxDose * i / 99);
  const path = samples.map((dose, i) => `${i ? "L" : "M"}${x(dose)},${y(hill(curve, dose))}`).join(" ");
  return <figure className="exceedance-figure"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${curve.drugNames.join(" plus ")} DiaMOND dose response`}>
    {[0, 50, 90, 100].map((tick) => <g key={tick}><line className="chart-grid" x1={left} x2={width-right} y1={y(tick)} y2={y(tick)} /><text x={left-7} y={y(tick)+4} textAnchor="end">{tick}</text></g>)}
    <line className="chart-axis" x1={left} x2={width-right} y1={height-bottom} y2={height-bottom} /><line className="chart-axis" x1={left} x2={left} y1={top} y2={height-bottom} />
    <path d={path} fill="none" stroke="#235789" strokeWidth="2.5" />
    {curve.points.map((point) => <circle key={point.normalizedTotalDose} cx={x(point.normalizedTotalDose)} cy={y(point.meanInhibition)} r="4" fill="#cc5a3d"><title>{fmt(point.normalizedTotalDose)} dose units · {fmt(point.meanInhibition)}% inhibition</title></circle>)}
    <text className="chart-axis-title" x={(left + width-right)/2} y={height-8} textAnchor="middle">Total normalized dose</text><text className="chart-axis-title" transform={`translate(15 ${(top+height-bottom)/2}) rotate(-90)`} textAnchor="middle">Inhibition (%)</text>
  </svg><figcaption><span><strong>{curve.drugNames.join(" + ")}</strong> · E∞ {fmt(curve.fit.maximumInhibition)}% · EC50 {fmt(curve.fit.ec50)} · h {fmt(curve.fit.hillSlope)} · R² {fmt(curve.fit.rSquared)}</span></figcaption></figure>;
}

function DiamondProcessed({ result }: { result: DiamondResult }) {
  return <div className="processed-panel"><h1>DiaMOND diagonal data</h1><div className="result-table-wrap"><table className="result-table"><thead><tr><th>Curve</th><th>Total normalized dose</th>{result.drugNames.map((name, i) => <th key={name}>{name}{result.concentrationUnits[i] ? ` (${result.concentrationUnits[i]})` : ""}</th>)}<th>Mean inhibition</th><th>Replicates</th></tr></thead><tbody>
    {result.curves.flatMap((curve) => curve.points.map((point) => <tr key={`${curve.drugNames.join("+")}-${point.normalizedTotalDose}`}><td>{curve.drugNames.join(" + ")}</td><td>{fmt(point.normalizedTotalDose)}</td>{point.concentrations.map((value, i) => <td key={i}>{fmt(value)}</td>)}<td>{fmt(point.meanInhibition)}%</td><td>{point.replicateCount}</td></tr>))}
  </tbody></table></div></div>;
}

function ProgressBar({ progress }: { progress: Progress }) { const total = Math.max(1, progress.totalIterations); const completed = Math.min(total, progress.completedIterations); return <div className="analysis-progress" role="status"><div><strong>{progress.regimenLabel ? `Bootstrapping ${progress.regimenLabel}` : "Calculating DiaMOND"}</strong><span>{completed} / {total} iterations</span></div><progress max={total} value={completed} /></div>; }
function hill(curve: DiamondCurve, dose: number) { const fit = curve.fit; return dose <= 0 ? 0 : fit.maximumInhibition / (1 + Math.pow(fit.ec50 / dose, fit.hillSlope)); }
function scoreText(result: DiamondResult, level: number, emergent = false) { const score = (emergent ? result.emergentScores : result.totalScores).find((item) => item.inhibitionLevel === level); return score ? fmt(score.fic) : "—"; }
function fmt(value: number) { return Number.isFinite(value) ? value.toLocaleString(undefined, { maximumSignificantDigits: 4 }) : "—"; }
function nullable(value: string) { if (!value) return null; const number = Number(value); return Number.isFinite(number) ? number : null; }
