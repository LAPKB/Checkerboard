import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MicWorkspace } from "./App";
import { DiamondRepeatLayouts, DiamondRetentionCell, diamondRetentionAssignments, type DiamondLayoutRequest, type DiamondLayoutResult } from "./Diamond";
import { micAssignmentKey } from "./analysis";
import type { RegimenPreview } from "./types";

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
const factors = [0.25, 0.5, 1, 2, 4, 8, 16];
const results: DiamondLayoutResult[] = [{ check: {
  combinationLocations: 7, retainedLocations: 0, compatibleAnchors: [31.25, 0.003906], compatibleLocations: 7,
  repeatLayout: { anchors: [0.0125, 0.0625],
    dilutions: [0.0125, 0.0625].map((anchor) => [0, ...factors.map((factor) => anchor * factor)]),
    combinationLocations: 7, retainedLocations: 7,
    inhibitionLevels: [[0, 20, 33.3, 50, 66.7, 80, 88.9, 94.1], [0, 15, 30, 49, 70, 85, 95, 99.5]],
    warnings: ["DETA NONOate: fitted IC50 is outside the tested single-agent range."],
    locations: [1, 2, 3].flatMap((mask) => factors.map((factor) => ({ drugIndices: [0, 1].filter((d) => mask & (1 << d)), dilutionFactor: factor, concentrations: [0.0125, 0.0625].map((anchor, d) => mask & (1 << d) ? anchor * factor : 0) }))),
  },
} }];

function renderWorkspace(overrides: Partial<ComponentProps<typeof MicWorkspace>> = {}) {
  return renderToStaticMarkup(createElement(MicWorkspace, {
    assignments: drugs.map((name, i) => ({ key: keys[i], legacyKey: keys[i], organism, name, unit: checks[0].units[i] })),
    values: { [keys[0]]: 31.25, [keys[1]]: 0.0625 }, suggestions: { [keys[0]]: 31.25, [keys[1]]: 0.0625 },
    anchorEstimates: Object.fromEntries(drugs.map((drugName, i) => [keys[i], { drugName, fittedIc50: [0.01377, 0.06387][i], suggestedAnchor: checks[0].request.doseAnchors[i], meanInhibitionAtAnchor: 50, singleAgentLevels: 7 }])),
    diamondChecks: checks, diamondResults: results, setAnchorValues: () => {}, countEstimates: {}, setValue: () => {},
    zeroTolerance: 5, setZeroTolerance: () => {}, busy: false, error: null, complete: true,
    diamond: true, drusano: false, importedDrusanoMics: false, importedMicStrata: [],
    ...overrides,
  }));
}

function cohort(id: string, cohortOrganism: string, drugNames = drugs): RegimenPreview {
  const regimenLabel = drugNames.join(" + ");
  return {
    id, label: `${regimenLabel} · ${cohortOrganism}`, regimenKey: regimenLabel, regimenLabel,
    organism: cohortOrganism, drugNames, concentrationUnits: ["uM", "ug/mL"],
    suggestedResponseType: "rawOd", rows: [], totalRows: 0,
  };
}

const cohorts = [cohort("1", organism), cohort("2", organism, [drugs[0], "AMK"]), cohort("3", "BB-MAB-1")];
const cohortAssignments = cohorts.flatMap((entry) => entry.drugNames.map((name, i) => ({
  key: micAssignmentKey(entry.organism, name), legacyKey: micAssignmentKey(entry.organism, name),
  organism: entry.organism, name, unit: entry.concentrationUnits[i],
}))).filter((assignment, index, all) => all.findIndex((other) => other.key === assignment.key) === index);
const cohortChecks = cohorts.map((entry) => ({ ...checks[0], label: entry.label, request: {
  ...checks[0].request, organism: entry.organism, regimenDrugNames: entry.drugNames,
} }));
const cohortResults = [results[0], { check: { ...results[0].check!, compatibleAnchors: [62.5, 4] } }, results[0]];

describe("Dose Anchors workspace", () => {
  it("lists every combination and organism while scoping the table, retention, and repeat layout", () => {
    const html = renderWorkspace({ assignments: cohortAssignments, diamondRegimens: cohorts,
      diamondChecks: cohortChecks, diamondResults: cohortResults });
    const selector = html.match(/<select[^>]*aria-label="Dose anchor combination and organism"[\s\S]*?<\/select>/)![0];
    expect((selector.match(/<option/g) ?? []).length).toBe(3);
    for (const entry of cohorts) expect(selector).toContain(entry.label);
    expect(html.indexOf(selector)).toBeLessThan(html.indexOf("<table"));

    const table = html.match(/<table[\s\S]*?<\/table>/)![0];
    expect((table.match(/<input/g) ?? []).length).toBe(2);
    expect(table).toContain(organism);
    expect(table).toContain(drugs[1]);
    expect(table).not.toContain("AMK");
    expect(table).not.toContain("BB-MAB-1");
    expect(table).toContain("0.003906");
    expect(table).not.toContain("62.5");
    const retentionButton = table.match(/<button[^>]*aria-label="Use Maximum Dose Retention values"[^>]*>/)![0];
    expect(retentionButton).not.toContain("disabled");
    expect(table).not.toContain("Shared drugs have different anchors");
    expect((html.match(/class="diamond-repeat-regimen"/g) ?? []).length).toBe(1);
    expect(html).toContain(`<h3>${cohorts[0].label}</h3>`);
    expect(html).not.toContain(`<h3>${cohorts[1].label}</h3>`);
    expect(html).not.toContain(`<h3>${cohorts[2].label}</h3>`);
  });

  it("retains cohort navigation and filters assignments while invalid anchors leave no layout checks", () => {
    const html = renderWorkspace({ assignments: cohortAssignments, diamondRegimens: [cohorts[2], cohorts[0], cohorts[1]],
      values: {}, diamondChecks: [], diamondResults: null, complete: false });
    const selector = html.match(/<select[^>]*aria-label="Dose anchor combination and organism"[\s\S]*?<\/select>/)![0];
    expect((selector.match(/<option/g) ?? []).length).toBe(3);
    expect(selector).toContain('value="3" selected=""');
    const table = html.match(/<table[\s\S]*?<\/table>/)![0];
    expect((table.match(/<input/g) ?? []).length).toBe(2);
    expect(table).toContain("BB-MAB-1");
    expect(table).not.toContain(organism);
    expect(table).not.toContain("AMK");
    expect(table.match(/<button[^>]*aria-label="Use Maximum Dose Retention values"[^>]*>/)![0]).toContain("disabled");
    expect(html).not.toContain("Positive dose anchors entered");
  });

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
    expect(html).toContain("0.003125");
    expect(html).toContain("0.015625");
    expect(html).toContain("7/7 planned combination levels retained");
    expect(html).toContain("Control");
    expect(html).toContain("outside the tested single-agent range");
    expect((html.match(/<input/g) ?? []).length).toBe(2);
    expect((html.match(/class="single"/g) ?? []).length).toBe(14);
    expect((html.match(/class="combination"/g) ?? []).length).toBe(7);
    expect((html.match(/class="unused"/g) ?? []).length).toBe(42);
    expect(html).toContain("DETA NONOate (uM) →");
    expect(html).toContain("CFZ (ug/mL) ↓");
    const grid = html.match(/<table class="diamond-repeat-grid">[\s\S]*?<\/table>/)![0];
    const gridBody = grid.match(/<tbody>([\s\S]*?)<\/tbody>/)![1];
    expect(gridBody.match(/<tr>/g)).toHaveLength(8);
    expect(gridBody.match(/<td /g)).toHaveLength(64);
    expect(html).toContain("8 × 8 suggested grid");
    expect(html).toContain("six lower concentrations are successive twofold dilutions");
    expect(html).not.toContain("Target IC");
    expect(html).not.toContain("Preparation worksheet");
    expect(html).not.toContain("Fixed-ratio cocktail doses");
    expect(html).toMatch(/<em[^>]*>IC50<\/em>/);
    expect(html).toMatch(/<em[^>]*>IC95<\/em>/);
    expect(html).toMatch(/<em[^>]*>IC99.5<\/em>/);
  });

  it("requires recalculation of saved non-twofold or oversized suggested layouts", () => {
    for (const doses of [[0, 1, 3, 5, 7, 9, 11, 13], [0, ...Array.from({ length: 9 }, (_, i) => 2 ** i)]]) {
      const saved = { check: { ...results[0].check!, repeatLayout: {
        ...results[0].check!.repeatLayout!, dilutions: [doses, doses],
      } } };
      const html = renderWorkspace({ diamondResults: [saved] });
      expect(html).toContain("refresh or recalculate saved layouts");
      expect(html).not.toContain('class="diamond-repeat-grid"');
    }
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
    const tables = html.match(/<table class="diamond-repeat-grid">[\s\S]*?<\/table>/g) ?? [];
    expect(tables.filter((table) => table.includes("<caption>"))).toHaveLength(1);
    expect(html).not.toContain("diamond-cocktail-doses");
    expect(html).toContain("Previous suggested layout");
    expect(html).toContain("Next suggested layout");
    expect(html).toContain(`<h3>${checks[0].label}</h3>`);
    expect(html).not.toContain(`<h3>${second.label}</h3>`);
    expect(html).toContain(`<option value=`);
    expect(html).toContain("Layout 1 of 2");
  });
});
