import { useState } from "react";
import type { DiamondLayoutRequest, DiamondLayoutResult } from "./Diamond";
import "./DiamondAnalysisPlate.css";

const number = (value: number) => value.toLocaleString(undefined, { maximumSignificantDigits: 8 });
const short = (value: number) => value === 0 ? "0" : value < 0.01 || value >= 10_000
  ? value.toExponential(1).replace(/\.0e/, "e").replace(/e\+/, "e") : value.toLocaleString(undefined, { maximumSignificantDigits: 3 });

export function DiamondAnalysisPlate({ entry, result }: { entry?: DiamondLayoutRequest; result?: DiamondLayoutResult }) {
  const [sliceDrug, setSliceDrug] = useState(2);
  const [requestedSlice, setRequestedSlice] = useState(0);
  const plate = result?.check?.analysisPlate;
  if (!entry || !plate) return <aside className="diamond-analysis-plate"><h2>Assigned-anchor analysis layout</h2>
    <p className="help-text" role="status">{result?.error ?? (entry ? "Checking assigned anchors against imported concentrations…" : "Enter positive assigned dose anchors to preview the selected concentrations.")}</p>
  </aside>;

  const names = entry.request.regimenDrugNames;
  const units = entry.units;
  const sliced = names.length === 3;
  const axes = names.map((_, index) => index).filter((index) => !sliced || index !== sliceDrug);
  // Put the longer concentration series across the plate for every displayed pair.
  const [xDrug, yDrug] = plate.dilutions[axes[1]].length > plate.dilutions[axes[0]].length
    ? [axes[1], axes[0]] : axes;
  const slices = sliced ? plate.dilutions[sliceDrug] : [0];
  const slice = Math.min(requestedSlice, slices.length - 1);
  const dosesX = plate.dilutions[xDrug];
  const dosesY = plate.dilutions[yDrug];
  const rows = Math.max(8, dosesY.length);
  const columns = Math.max(12, dosesX.length, rows + 1);
  const width = 66 + (columns - 1) * 36 + 38;
  const height = 53 + (rows - 1) * 36 + 35;
  const locations = new Map(plate.locations.map((location) => [location.concentrations.join("|"), location]));
  const drugLabel = (index: number) => `${names[index]}${units[index] ? ` (${units[index]})` : ""}`;
  const visibleLocations = plate.locations.filter((location) => !sliced || location.concentrations[sliceDrug] === slices[slice]);
  const selected = visibleLocations.filter((location) => location.selected && location.replicateCount > 0).length;
  const missing = visibleLocations.filter((location) => location.selected && location.replicateCount === 0).length;
  const hasIdeal = plate.idealAnchors.length === names.length && plate.idealAnchors.every((anchor) => anchor != null);
  return <aside className="diamond-analysis-plate">
    <h2>Assigned-anchor analysis layout</h2>
    <p className="help-text"><strong>{selected} locations with data selected</strong> · {missing} selected {missing === 1 ? "intersection has" : "intersections have"} no response data and {missing === 1 ? "is" : "are"} not analyzed.</p>
    {sliced && <div className="diamond-analysis-plate-toolbar">
      <label>Page by drug<select aria-label="Analysis plate slice drug" value={sliceDrug} onChange={(event) => { setSliceDrug(Number(event.target.value)); setRequestedSlice(0); }}>
        {names.map((name, index) => <option key={index} value={index}>{name}</option>)}
      </select></label>
      <label>{drugLabel(sliceDrug)} concentration<select aria-label="Analysis plate slice concentration" value={slice} onChange={(event) => setRequestedSlice(Number(event.target.value))}>
        {slices.map((dose, index) => <option key={dose} value={index}>{number(dose)}{units[sliceDrug] ? ` ${units[sliceDrug]}` : ""}</option>)}
      </select></label>
      <div className="diamond-analysis-page-controls"><button type="button" className="secondary-button" aria-label="Previous analysis plate concentration" disabled={slice === 0} onClick={() => setRequestedSlice(slice - 1)}>‹</button>
        <span>Concentration {slice + 1} of {slices.length}</span><button type="button" className="secondary-button" aria-label="Next analysis plate concentration" disabled={slice === slices.length - 1} onClick={() => setRequestedSlice(slice + 1)}>›</button></div>
    </div>}
    <p className="diamond-analysis-axis-label"><strong>{drugLabel(xDrug)} →</strong><br />{drugLabel(yDrug)} ↓{sliced ? ` · ${names[sliceDrug]} = ${number(slices[slice])}${units[sliceDrug] ? ` ${units[sliceDrug]}` : ""}` : ""}</p>
    <svg className="diamond-analysis-plate-grid" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${names.join(" plus ")} assigned-anchor concentration layout${sliced ? `; ${names[sliceDrug]} = ${number(slices[slice])}${units[sliceDrug] ? ` ${units[sliceDrug]}` : ""}` : ""}`}>
      <rect className="diamond-analysis-plate-frame" x="2" y="2" width={width - 4} height={height - 4} rx="18" />
      {dosesX.map((dose, column) => <text className="diamond-analysis-dose-header" x={66 + column * 36} y="28" textAnchor="middle" key={column}><title>{`${names[xDrug]}: ${number(dose)}${units[xDrug] ? ` ${units[xDrug]}` : ""}`}</title>{short(dose)}</text>)}
      {Array.from({ length: rows }, (_, row) => <g key={row}>
        {dosesY[row] != null && <text className="diamond-analysis-dose-header" x="44" y={56 + row * 36} textAnchor="end"><title>{`${names[yDrug]}: ${number(dosesY[row])}${units[yDrug] ? ` ${units[yDrug]}` : ""}`}</title>{short(dosesY[row])}</text>}
        {Array.from({ length: columns }, (_, column) => {
          if (dosesX[column] == null || dosesY[row] == null) return <circle key={column} className="diamond-analysis-well padding" cx={66 + column * 36} cy={53 + row * 36} r="14" aria-hidden="true" />;
          const concentrations = names.map((_, drug) => drug === xDrug ? dosesX[column] : drug === yDrug ? dosesY[row] : slices[slice]);
          const location = locations.get(concentrations.join("|"));
          const measured = (location?.replicateCount ?? 0) > 0;
          const status = location?.selected ? measured ? "selected-data" : "selected-missing" : measured ? "measured" : "empty";
          const label = location?.selected ? measured ? "Selected for analysis" : "Selected by anchors; no response data, not analyzed" : measured ? "Measured; outside the assigned-anchor selection" : "No response data; outside the assigned-anchor selection";
          const tooltip = `${names.map((name, index) => `${name}: ${number(concentrations[index])}${units[index] ? ` ${units[index]}` : ""}`).join("\n")}\n${label}\n${location?.replicateCount ?? 0} measured replicate(s)${location?.closestToIdeal ? "\nClosest available cell to the IC50-based reference direction" : ""}`;
          return <g key={column}><circle className={`diamond-analysis-well ${status}${location?.closestToIdeal ? " ideal" : ""}`} cx={66 + column * 36} cy={53 + row * 36} r="14"><title>{tooltip}</title></circle>
            {location?.selected && measured && <text className="diamond-analysis-well-label" x={66 + column * 36} y={56 + row * 36} textAnchor="middle" pointerEvents="none">✓</text>}
            {location?.selected && !measured && <text className="diamond-analysis-well-label missing-label" x={66 + column * 36} y={56 + row * 36} textAnchor="middle" pointerEvents="none">–</text>}
          </g>;
        })}
      </g>)}
    </svg>
    <div className="diamond-analysis-plate-legend"><span><i className="selected-data" />Data used</span><span><i className="selected-missing" />Selected, no data</span><span><i className="measured" />Data outside selection</span><span><i className="ideal" />Closest to IC50 reference</span></div>
    <p className="help-text">The complete two-drug concentration grid appears in one plot. {sliced ? "Choose the drug to page by, then select its concentration to display the other two drugs. Counts above apply to the displayed concentration. " : ""}Row and column headers give final well concentrations, not physical well positions; hover over a cell for all drug amounts and measured replicates. Controls and single agents remain selected.</p>
    <details><summary>About the IC50 reference</summary><p className="help-text">{hasIdeal ? `Purple outlines show the closest available cells to equal normalized doses using the tested single-agent concentrations nearest fitted IC50: ${names.map((name, index) => `${name} ${number(plate.idealAnchors[index]!)}${units[index] ? ` ${units[index]}` : ""}`).join("; ")}. At each first active drug dose, other active drugs use their nearest positive available concentration on a log scale (lower dose breaks a tie). This reference does not change the assigned anchors or supply missing responses.` : "The IC50 reference is unavailable until each single-agent IC50 has a finite positive tested-concentration suggestion."}</p></details>
  </aside>;
}
