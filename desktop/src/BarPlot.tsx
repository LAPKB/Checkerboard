import Plot from "react-plotly.js";
import type * as Plotly from "plotly.js";

import { aggregateBliss, formatNumber, withinClinicalWindow } from "./analysis";
import type { AnalysisResult } from "./types";
import type { PlotColors } from "./preferences";

export default function BarPlot({
  analysis,
  stratifyIndex,
  colors,
  showConfidenceIntervals,
}: {
  analysis: AnalysisResult;
  stratifyIndex: number;
  colors: PlotColors;
  showConfidenceIntervals: boolean;
}) {
  if (analysis.drugNames.length === 3) {
    return <StratifiedBar analysis={analysis} stratifyIndex={stratifyIndex} colors={colors} showConfidenceIntervals={showConfidenceIntervals} />;
  }
  return <GrowthBars analysis={analysis} colors={colors} />;
}

function GrowthBars({ analysis, colors }: { analysis: AnalysisResult; colors: PlotColors }) {
  const xValues = uniqueSorted(analysis.processed.map((row) => row.concentrations[1]));
  const yValues = uniqueSorted(analysis.processed.map((row) => row.concentrations[0]));
  const maxAbs = Math.max(10, ...analysis.processed.map((row) => Math.abs(row.blissInteraction)));
  const traces: Plotly.Data[] = [];
  const wireX: Array<number | null> = [];
  const wireY: Array<number | null> = [];
  const wireZ: Array<number | null> = [];
  const hoverX: number[] = [];
  const hoverY: number[] = [];
  const hoverZ: number[] = [];
  const hoverText: string[] = [];

  for (const row of analysis.processed) {
    const x = xValues.indexOf(row.concentrations[1]);
    const y = yValues.indexOf(row.concentrations[0]);
    const growth = clamp(100 - row.effect, 0, 100);
    const expectedGrowth = clamp(100 - row.blissExpected, 0, 100);
    const x0 = x - 0.36;
    const x1 = x + 0.36;
    const y0 = y - 0.36;
    const y1 = y + 0.36;
    const barColor = interactionColor(row.blissInteraction, maxAbs, colors);
    traces.push({
      type: "mesh3d",
      x: [x0, x1, x1, x0, x0, x1, x1, x0],
      y: [y0, y0, y1, y1, y0, y0, y1, y1],
      z: [0, 0, 0, 0, growth, growth, growth, growth],
      i: [0, 0, 4, 4, 0, 0, 2, 2, 0, 0, 1, 1],
      j: [1, 2, 6, 7, 1, 5, 3, 7, 3, 7, 2, 6],
      k: [2, 3, 5, 6, 5, 4, 7, 6, 7, 4, 6, 5],
      facecolor: Array(12).fill(barColor),
      flatshading: true,
      lighting: { ambient: 0.8, diffuse: 0.5, specular: 0.2 },
      showscale: false,
      hoverinfo: "skip",
    } as unknown as Plotly.Data);
    traces.push({
      type: "scatter3d",
      mode: "lines",
      x: [x0, x1, x1, x0, x0, null, x0, x1, x1, x0, x0, null, x0, x0, null, x1, x1, null, x1, x1, null, x0, x0],
      y: [y0, y0, y1, y1, y0, null, y0, y0, y1, y1, y0, null, y0, y0, null, y0, y0, null, y1, y1, null, y1, y1],
      z: [0, 0, 0, 0, 0, null, growth, growth, growth, growth, growth, null, 0, growth, null, 0, growth, null, 0, growth, null, 0, growth],
      line: { color: "#505050", width: 2 },
      showlegend: false,
      hoverinfo: "skip",
    } as Plotly.Data);
    wireX.push(x0, x1, null, x1, x1, null, x1, x0, null, x0, x0, null);
    wireY.push(y0, y0, null, y0, y1, null, y1, y1, null, y1, y0, null);
    wireZ.push(expectedGrowth, expectedGrowth, null, expectedGrowth, expectedGrowth, null, expectedGrowth, expectedGrowth, null, expectedGrowth, expectedGrowth, null);
    hoverX.push(x);
    hoverY.push(y);
    hoverZ.push(Math.min(100, growth + 2));
    hoverText.push(
      `${analysis.drugNames[1]}: ${row.concentrations[1]}<br>` +
      `${analysis.drugNames[0]}: ${row.concentrations[0]}<br>` +
      `Growth: ${formatNumber(growth, 1)}%<br>` +
      `Expected: ${formatNumber(expectedGrowth, 1)}%<br>` +
      `Bliss: ${formatNumber(row.blissInteraction)}`,
    );
  }
  traces.push({
    type: "scatter3d",
    mode: "lines",
    x: wireX,
    y: wireY,
    z: wireZ,
    line: { color: colors.expected, width: 4 },
    name: "Expected growth",
    hoverinfo: "skip",
  } as Plotly.Data);
  traces.push({
    type: "scatter3d",
    mode: "markers",
    x: hoverX,
    y: hoverY,
    z: hoverZ,
    text: hoverText,
    hoverinfo: "text",
    marker: { size: 12, color: "rgba(0,0,0,0.01)" },
    showlegend: false,
  } as Plotly.Data);

  return (
    <div className="plot-panel">
      <Plot
        data={traces}
        layout={{
          autosize: true,
          height: 620,
          margin: { l: 20, r: 20, t: 55, b: 20 },
          title: { text: `3D growth plot: ${analysis.drugNames.join(" + ")}` },
          showlegend: true,
          legend: { orientation: "h", x: 0, y: 1.04 },
          scene: {
            xaxis: { title: { text: `${analysis.drugNames[1]}${analysis.concentrationUnits[1] ? ` (${analysis.concentrationUnits[1]})` : ""}` }, tickvals: xValues.map((_, index) => index), ticktext: xValues.map(String) },
            yaxis: { title: { text: `${analysis.drugNames[0]}${analysis.concentrationUnits[0] ? ` (${analysis.concentrationUnits[0]})` : ""}` }, tickvals: yValues.map((_, index) => index), ticktext: yValues.map(String) },
            zaxis: { title: { text: "% Growth" }, range: [0, 100] },
            camera: { eye: { x: 1.5, y: 1.5, z: 1.2 } },
          },
          paper_bgcolor: "#ffffff",
          plot_bgcolor: "#ffffff",
        }}
        config={{ responsive: true, displaylogo: false, toImageButtonOptions: { filename: "checkerboard-growth" } }}
        style={{ width: "100%", height: "620px" }}
        useResizeHandler
      />
      <InteractionLegend colors={colors} />
    </div>
  );
}

function StratifiedBar({ analysis, stratifyIndex, colors, showConfidenceIntervals }: { analysis: AnalysisResult; stratifyIndex: number; colors: PlotColors; showConfidenceIntervals: boolean }) {
  const combinations = analysis.processed.filter((row) => row.concentrations.every((value) => value > 0) && withinClinicalWindow(analysis, row));
  const values = uniqueSorted(combinations.map((row) => row.concentrations[stratifyIndex]));
  const summaries = values.map((concentration) => {
    const rows = combinations.filter((row) => row.concentrations[stratifyIndex] === concentration);
    return aggregateBliss(rows);
  });
  const labels = [...values.map(String), "Overall"];
  const xDomain: [number, number] = [0, Math.min(1, Math.max(0.24, labels.length * 0.075))];
  const overall = aggregateBliss(combinations);
  const allSummaries = [...summaries, overall];
  const allMeans = allSummaries.map((summary) => summary.mean);
  const barColors = allMeans.map((value) => value < -10 ? colors.low : value > 10 ? colors.high : colors.midpoint);
  const errors = allSummaries.map((summary) => summary.ciRight == null ? 0 : summary.ciRight - summary.mean);
  const traces: Plotly.Data[] = [{
    type: "bar",
    x: labels,
    y: allMeans,
    text: allMeans.map((value) => formatNumber(value, 2)),
    textposition: "outside",
    marker: { color: barColors, line: { color: "#666", width: 1 } },
    error_y: showConfidenceIntervals ? { type: "data", array: errors, visible: true, color: "#343a40", thickness: 1.5, width: 5 } : undefined,
    hovertemplate: "%{x}<br>Mean Bliss Interaction: %{y:.3f}<extra></extra>",
    name: "Mean Bliss Interaction",
    showlegend: false,
  } as Plotly.Data];
  for (const [name, color] of [["Antagonistic (< −10)", colors.low], ["Additive (−10 to 10)", colors.midpoint], ["Synergistic (> 10)", colors.high]] as const) {
    traces.push({ type: "scatter", mode: "markers", x: [null], y: [null], marker: { size: 12, color, line: { color: "#666", width: 1 } }, name, hoverinfo: "skip" } as Plotly.Data);
  }
  return (
    <div className="plot-panel">
      <Plot
        data={traces}
        layout={{
          autosize: true,
          height: 600,
          margin: { l: 70, r: 25, t: 70, b: 105 },
          bargap: 0.18,
          title: { text: `${analysis.drugNames.filter((_, index) => index !== stratifyIndex).join(" + ")}, stratified by ${analysis.drugNames[stratifyIndex]}` },
          xaxis: {
            type: "category",
            categoryorder: "array",
            categoryarray: labels,
            tickmode: "array",
            tickvals: labels,
            ticktext: labels,
            domain: xDomain,
            title: { text: `${analysis.drugNames[stratifyIndex]} concentration${analysis.concentrationUnits[stratifyIndex] ? ` (${analysis.concentrationUnits[stratifyIndex]})` : ""}` },
          },
          yaxis: { title: { text: "Mean Bliss Interaction (percentage points)" }, zeroline: true, zerolinecolor: "#555" },
          shapes: [
            { type: "line", xref: "paper", x0: 0, x1: xDomain[1], y0: -10, y1: -10, line: { color: colors.low, dash: "dot", width: 1 } },
            { type: "line", xref: "paper", x0: 0, x1: xDomain[1], y0: 10, y1: 10, line: { color: colors.high, dash: "dot", width: 1 } },
          ],
          paper_bgcolor: "#ffffff",
          plot_bgcolor: "#ffffff",
          showlegend: true,
          legend: { orientation: "h", x: 0, xanchor: "left", y: -0.2 },
        }}
        config={{ responsive: true, displaylogo: false, toImageButtonOptions: { filename: "checkerboard-summary" } }}
        style={{ width: "100%", height: "600px" }}
        useResizeHandler
      />
      {showConfidenceIntervals && <p className="policy-note">Error bars are approximate 95% confidence intervals propagated from the native cellwise bootstrap SEMs.</p>}
    </div>
  );
}

function InteractionLegend({ colors }: { colors: PlotColors }) {
  return (
    <div className="interaction-legend">
      <span>Antagonism</span>
      <i style={{ background: `linear-gradient(90deg, ${colors.low}, ${colors.midpoint} 45%, ${colors.midpoint} 55%, ${colors.high})` }} />
      <span>Synergy</span>
      <small>Limited evidence: −10 to 10 percentage points</small>
    </div>
  );
}

function interactionColor(value: number, maxAbs: number, colors: PlotColors) {
  if (Math.abs(value) <= 10) return colors.midpoint;
  const amount = Math.min(1, (Math.abs(value) - 10) / Math.max(0.000001, maxAbs - 10));
  return blend(colors.midpoint, value < 0 ? colors.low : colors.high, amount);
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

function uniqueSorted(values: number[]) {
  return [...new Set(values)].sort((left, right) => left - right);
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}
