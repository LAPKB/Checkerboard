import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DiamondAnalysisPlate } from "./DiamondAnalysisPlate";
import type { DiamondLayoutRequest, DiamondLayoutResult } from "./Diamond";

const entry: DiamondLayoutRequest = {
  label: "A + B · Organism", units: ["µM", "µg/mL"], request: {
    import: { path: "assay.csv", worksheet: null, startRow: 1, startColumn: 1, rowLimit: 0, columnLimit: 0, organismColumn: 3 },
    mapping: { drugs: [{ column: 0, name: "A" }, { column: 1, name: "B" }], responseColumn: 2 },
    doseAnchors: [1, 2], diagonalToleranceLog2: 0.01,
    policy: { responseType: "rawOd", blankValue: 0, responseCensorThreshold: 0, bootstrapIterations: 2, randomSeed: 123, diagonalToleranceLog2: 0.01 },
    regimenDrugNames: ["A", "B"], organism: "Organism", organismColumn: 3,
  },
};
const result: DiamondLayoutResult = { check: {
  combinationLocations: 2, retainedLocations: 1, compatibleAnchors: [1, 2], compatibleLocations: 1, repeatLayout: null,
  analysisPlate: { dilutions: [[0, 1, 2], [0, 2, 4]], idealAnchors: [1, 4], locations: [
    { concentrations: [0, 0], replicateCount: 3, selected: true, closestToIdeal: false },
    { concentrations: [1, 2], replicateCount: 2, selected: true, closestToIdeal: false },
    { concentrations: [2, 4], replicateCount: 0, selected: true, closestToIdeal: false },
    { concentrations: [1, 4], replicateCount: 1, selected: false, closestToIdeal: true },
  ] },
} };

describe("assigned-anchor analysis plate", () => {
  it("distinguishes data used, missing responses, and the IC50 reference without fabricating well positions", () => {
    const html = renderToStaticMarkup(createElement(DiamondAnalysisPlate, { entry, result }));
    expect(html).toContain("2 locations with data selected");
    expect(html).toContain("1 selected intersection has no response data");
    expect(html).toContain("A: 1 µM\nB: 2 µg/mL\nSelected for analysis\n2 measured replicate(s)");
    expect(html).toContain("A: 2 µM\nB: 4 µg/mL\nSelected by anchors; no response data, not analyzed");
    expect(html).toContain('class="diamond-analysis-well measured ideal"');
    expect(html).toContain("Closest available cell to the IC50-based reference direction");
    expect(html).toContain("not physical well positions");
    expect((html.match(/<circle/g) ?? []).length).toBe(96);
  });

  it("shows every two-drug concentration in one complete plot without pagination", () => {
    const large = { check: { ...result.check!, analysisPlate: {
      dilutions: [Array.from({ length: 13 }, (_, i) => i), Array.from({ length: 9 }, (_, i) => i)],
      idealAnchors: [1, 2], locations: [
        { concentrations: [12, 8], replicateCount: 4, selected: true, closestToIdeal: false },
      ],
    } } };
    const html = renderToStaticMarkup(createElement(DiamondAnalysisPlate, { entry, result: large }));
    expect((html.match(/<svg/g) ?? []).length).toBe(1);
    expect((html.match(/<circle/g) ?? []).length).toBe(117);
    expect(html).toContain("A: 12 µM\nB: 8 µg/mL\nSelected for analysis\n4 measured replicate(s)");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("analysis plate page");
    expect(html).not.toContain("Page 1 of");
  });

  it("provides all three paging drugs while rendering the complete default concentration plane", () => {
    const threeDrugEntry = { ...entry, units: [...entry.units, "mg/L"], request: { ...entry.request, regimenDrugNames: ["A", "B", "C"] } };
    const large = { check: { ...result.check!, analysisPlate: {
      dilutions: [Array.from({ length: 13 }, (_, i) => i), Array.from({ length: 9 }, (_, i) => i), [0, 8]],
      idealAnchors: [1, 2, 4], locations: [
        { concentrations: [12, 8, 0], replicateCount: 3, selected: true, closestToIdeal: false },
        { concentrations: [12, 8, 8], replicateCount: 0, selected: true, closestToIdeal: false },
      ],
    } } };
    const html = renderToStaticMarkup(createElement(DiamondAnalysisPlate, { entry: threeDrugEntry, result: large }));
    expect((html.match(/<svg/g) ?? []).length).toBe(1);
    expect((html.match(/<circle/g) ?? []).length).toBe(117);
    const drugSelector = html.match(/<select aria-label="Analysis plate slice drug"[\s\S]*?<\/select>/)![0];
    expect(drugSelector).toContain('<option value="0">A</option>');
    expect(drugSelector).toContain('<option value="1">B</option>');
    expect(drugSelector).toContain('<option value="2" selected="">C</option>');
    const doseSelector = html.match(/<select aria-label="Analysis plate slice concentration"[\s\S]*?<\/select>/)![0];
    expect(doseSelector).toContain("0 mg/L");
    expect(doseSelector).toContain("8 mg/L");
    expect(html).toContain("Concentration 1 of 2");
    expect(html).toContain('aria-label="Previous analysis plate concentration" disabled=""');
    expect(html).toContain('aria-label="Next analysis plate concentration"');
    expect(html).toContain("A: 12 µM\nB: 8 µg/mL\nC: 0 mg/L\nSelected for analysis\n3 measured replicate(s)");
    expect(html).toContain("1 locations with data selected");
    expect(html).toContain("0 selected intersections have no response data");
    expect(html).not.toContain("analysis plate page");
  });

  it.each([false, true])("orients a taller concentration series horizontally (three drugs: %s)", (three) => {
    const names = three ? ["A", "B", "C"] : ["A", "B"];
    const orientedEntry = { ...entry, units: three ? [...entry.units, "mg/L"] : entry.units,
      request: { ...entry.request, regimenDrugNames: names } };
    const doses = [Array.from({ length: 9 }, (_, i) => i), Array.from({ length: 13 }, (_, i) => i)];
    const tall = { check: { ...result.check!, analysisPlate: {
      dilutions: three ? [...doses, [0, 8]] : doses, idealAnchors: names.map(() => 1), locations: [
        { concentrations: three ? [2, 12, 0] : [2, 12], replicateCount: 2, selected: true, closestToIdeal: true },
      ],
    } } };
    const html = renderToStaticMarkup(createElement(DiamondAnalysisPlate, { entry: orientedEntry, result: tall }));
    expect(html).toContain('<strong>B (µg/mL) →</strong><br/>A (µM) ↓');
    expect(html).toContain('cx="498" cy="125" r="14"><title>A: 2 µM\nB: 12 µg/mL');
    expect(html).toContain('class="diamond-analysis-well selected-data ideal"');
    expect(html.match(/<circle/g)).toHaveLength(117);
    const [, width, height] = html.match(/viewBox="0 0 (\d+) (\d+)"/)!;
    expect(Number(width)).toBeGreaterThan(Number(height));
  });

  it("keeps equal-length concentration series wider than they are tall", () => {
    const square = { check: { ...result.check!, analysisPlate: {
      dilutions: [Array.from({ length: 13 }, (_, i) => i), Array.from({ length: 13 }, (_, i) => i)],
      idealAnchors: [1, 2], locations: [],
    } } };
    const html = renderToStaticMarkup(createElement(DiamondAnalysisPlate, { entry, result: square }));
    expect(html.match(/<circle/g)).toHaveLength(14 * 13);
    const [, width, height] = html.match(/viewBox="0 0 (\d+) (\d+)"/)!;
    expect(Number(width)).toBeGreaterThan(Number(height));
  });

  it("shows pending and invalid layouts without a stale plate", () => {
    expect(renderToStaticMarkup(createElement(DiamondAnalysisPlate, {}))).toContain("Enter positive assigned dose anchors");
    expect(renderToStaticMarkup(createElement(DiamondAnalysisPlate, { entry, result: { error: "No control rows" } }))).toContain("No control rows");
  });
});
