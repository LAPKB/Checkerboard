import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MicWorkspace } from "./App";
import { DiamondRepeatLayouts, DiamondRetentionCell, diamondRetentionAssignments, type DiamondLayoutRequest, type DiamondLayoutResult } from "./Diamond";
import { micAssignmentKey } from "./analysis";

const organism = "BB-MAB-4";
const drugs = ["DETA NONOate", "CFZ"];
const keys = drugs.map((drug) => micAssignmentKey(organism, drug));
const checks: DiamondLayoutRequest[] = [{ label: "DETA NONOate + CFZ · BB-MAB-4", units: ["uM", "ug/mL"], request: {
  import: { path: "assay.csv", worksheet: null, startRow: 1, startColumn: 1, rowLimit: 0, columnLimit: 0, organismColumn: 3 },
  mapping: { drugs: [{ column: 0, name: drugs[0] }, { column: 1, name: drugs[1] }], responseColumn: 2 },
  regimenDrugNames: drugs, organism, organismColumn: 3,
  doseAnchors: [31.25, 0.0625], diagonalToleranceLog2: 0.5,
  policy: { responseType: "rawOd", blankValue: 0, responseCensorThreshold: 0, bootstrapIterations: 2, randomSeed: 123, diagonalToleranceLog2: 0.5 },
} }];
const results: DiamondLayoutResult[] = [{ check: {
  combinationLocations: 7, retainedLocations: 0, compatibleAnchors: [31.25, 0.003906], compatibleLocations: 7,
  repeatLayout: { anchors: [0.0125, 0.0625], dilutions: [0.2, 1].map((maximum) => [0, ...Array.from({ length: 9 }, (_, i) => maximum / 2 ** (8 - i))]), combinationLocations: 9, retainedLocations: 9,
    inhibitionLevels: [[0, 2, 5, 10, 25, 50, 65, 80, 90, 99], [0, 1, 3, 8, 20, 49, 70, 85, 95, 99.5]],
    warnings: ["DETA NONOate: fitted IC50 is outside the tested single-agent range."],
    locations: [1, 2, 3].flatMap((mask) => Array.from({ length: 9 }, (_, i) => ({ drugIndices: [0, 1].filter((d) => mask & (1 << d)), dilutionFactor: 2 ** (i - 4), concentrations: [0.2, 1].map((maximum, d) => mask & (1 << d) ? maximum / 2 ** (8 - i) : 0) }))),
  },
} }];

function renderWorkspace() {
  return renderToStaticMarkup(createElement(MicWorkspace, {
    assignments: drugs.map((name, i) => ({ key: keys[i], legacyKey: keys[i], organism, name, unit: checks[0].units[i] })),
    values: { [keys[0]]: 31.25, [keys[1]]: 0.0625 }, suggestions: { [keys[0]]: 31.25, [keys[1]]: 0.0625 },
    anchorEstimates: Object.fromEntries(drugs.map((drugName, i) => [keys[i], { drugName, fittedIc50: [0.01377, 0.06387][i], suggestedAnchor: checks[0].request.doseAnchors[i], meanInhibitionAtAnchor: 50, singleAgentLevels: 7 }])),
    diamondChecks: checks, diamondResults: results, setAnchorValues: () => {}, countEstimates: {}, setValue: () => {},
    zeroTolerance: 5, setZeroTolerance: () => {}, busy: false, error: null, complete: true,
    diamond: true, drusano: false, importedDrusanoMics: false, importedMicStrata: [],
  }));
}

describe("Dose Anchors workspace", () => {
  it("renders the requested seven columns with only the assigned anchor editable", () => {
    const html = renderWorkspace();
    const table = html.match(/<table[\s\S]*?<\/table>/)![0];
    expect([...table.matchAll(/<th>(.*?)<\/th>/g)].map((m) => m[1])).toEqual([
      "Organism", "Drug", "Units", "Fitted IC50", "Closest Anchor", "Maximum Dose Retention", "Assigned Dose Anchor",
    ]);
    const body = table.match(/<tbody>([\s\S]*?)<\/tbody>/)![1];
    const rows = [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const cells = [...row[1].matchAll(/<td>([\s\S]*?)<\/td>/g)];
      expect(cells.slice(0, 6).every((cell) => !cell[1].includes("<input"))).toBe(true);
      expect(cells[6][1]).toContain("<input");
      expect(cells[5][1]).toContain("7/7 full-combination levels");
      expect(cells[5][1]).toContain("Assigned: 0/7 retained");
    }
    expect(rows[1][1]).toContain("0.003906");
    expect((table.match(/>Use these values<\/button>/g) ?? []).length).toBe(2);
  });

  it("places an absolute-concentration repeat layout and extrapolation warning below the assignments", () => {
    const html = renderWorkspace();
    const endOfAssignments = html.indexOf("</table>");
    expect(html.indexOf("Suggested layout for a repeat experiment")).toBeGreaterThan(endOfAssignments);
    expect(html).toContain("0.00078125");
    expect(html).toContain("0.00390625");
    expect(html).toContain("9/9 planned combination levels retained");
    expect(html).toContain("Control");
    expect(html).toContain("outside the tested single-agent range");
    expect((html.match(/<input/g) ?? []).length).toBe(2);
    expect((html.match(/class="single"/g) ?? []).length).toBe(18);
    expect((html.match(/class="combination"/g) ?? []).length).toBe(9);
    expect((html.match(/class="unused"/g) ?? []).length).toBe(72);
    expect(html).toContain("DETA NONOate (uM) →");
    expect(html).toContain("CFZ (ug/mL) ↓");
    expect(html).toMatch(/<em[^>]*>IC50<\/em>/);
    expect(html).toMatch(/<em[^>]*>IC90<\/em>/);
    expect(html).toMatch(/<em[^>]*>IC99.5<\/em>/);
  });

  it("keeps conflicting regimen-specific retention anchors visible for a shared drug", () => {
    const html = renderToStaticMarkup(createElement(DiamondRetentionCell, { organism, drug: drugs[0],
      checks: [...checks, { ...checks[0], label: "A different regimen" }],
      results: [...results, { check: { ...results[0].check!, compatibleAnchors: [62.5, 0.003906] } }],
    }));
    expect(html).toContain("31.25");
    expect(html).toContain("62.5");
    expect(html).toContain("A different regimen");
  });

  it("copies exact retention anchors by organism and refuses conflicting or incomplete sets", () => {
    const assignments = drugs.map((name, i) => ({ key: keys[i], organism, name }));
    expect(diamondRetentionAssignments(assignments, checks, results)).toEqual({
      values: { [keys[0]]: 31.25, [keys[1]]: 0.003906 }, conflict: false, complete: true,
    });
    expect(diamondRetentionAssignments(assignments, checks, null).complete).toBe(false);
    const conflict = diamondRetentionAssignments(assignments, [...checks, checks[0]], [...results,
      { check: { ...results[0].check!, compatibleAnchors: [62.5, 0.003906] } },
    ]);
    expect(conflict.conflict).toBe(true);
    expect(conflict.complete).toBe(false);
    expect(conflict.values[keys[0]]).toBeUndefined();
    expect(diamondRetentionAssignments(assignments, [{ ...checks[0], request: { ...checks[0].request, organism: "Other organism" } }], results).complete).toBe(false);
  });

  it("shows one grid at a time with organism–drug navigation", () => {
    const second = { ...checks[0], label: "DETA NONOate + CFZ · BB-MAB-1", request: { ...checks[0].request, organism: "BB-MAB-1" } };
    const html = renderToStaticMarkup(createElement(DiamondRepeatLayouts, { checks: [...checks, second], results: [...results, results[0]] }));
    expect((html.match(/class="diamond-repeat-regimen"/g) ?? []).length).toBe(1);
    expect((html.match(/class="diamond-repeat-grid"/g) ?? []).length).toBe(1);
    expect(html).toContain("Previous suggested layout");
    expect(html).toContain("Next suggested layout");
    expect(html).toContain(`<h3>${checks[0].label}</h3>`);
    expect(html).not.toContain(`<h3>${second.label}</h3>`);
    expect(html).toContain(`<option value=`);
    expect(html).toContain("Layout 1 of 2");
  });
});
