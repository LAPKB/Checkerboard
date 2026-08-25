import { describe, expect, it } from "vitest";

import { aggregateBliss, buildMapping, compareRegimens, exceedanceAuc, exceedanceDomain, formatPValue, inactiveDrugPairSummary, isClinicalWindowCell, mostCommonLowerTie, stratificationIndexFor, validateRoles } from "./analysis";
import type { AnalysisResult, ComparisonRegimen, ImportPreview } from "./types";

const preview: ImportPreview = {
  headers: ["Drug A", "Drug B", "Conc A", "Conc B", "Units A", "Units B", "Response"],
  rows: [],
  totalRows: 0,
  totalColumns: 7,
  suggestedRoles: ["drugNameA", "drugNameB", "drugA", "drugB", "unitsA", "unitsB", "response"],
  suggestedDrugNames: ["DrugA", "DrugB", "Ampicillin", "Meropenem", "UnitsA", "UnitsB", "Response"],
  regimens: [],
};

describe("column mapping", () => {
  it("requires each core role exactly once", () => {
    expect(validateRoles(["drugNameA", "drugNameB", "drugA", "drugA", "unitsA", "unitsB", "response"])).toHaveLength(2);
  });

  it("builds drugs in stable A/B/C order", () => {
    expect(buildMapping(preview, preview.suggestedRoles)).toEqual({
      drugs: [
        { column: 2, name: "Ampicillin" },
        { column: 3, name: "Meropenem" },
      ],
      responseColumn: 6,
    });
  });
});

describe("p-value formatting", () => {
  it("uses scientific notation only below 0.0001", () => {
    expect(formatPValue("1e-3")).toBe("0.001");
    expect(formatPValue("0.0001")).toBe("0.0001");
    expect(formatPValue("0.000099")).toBe("9.900e-5");
  });
});

describe("pooled MIC suggestion", () => {
  it("selects the mode and resolves ties to the lower MIC", () => {
    expect(mostCommonLowerTie([4, 2, 4, 2])).toBe(2);
    expect(mostCommonLowerTie([1, 2, 2, 4])).toBe(2);
    expect(mostCommonLowerTie([])).toBeNull();
  });
});

function regimen(id: string, bliss: number[][], drugCount = 2): ComparisonRegimen {
  const processed = bliss.map(([a, b, interaction, effect = 0.8]) => ({
    concentrations: drugCount === 2 ? [a, b] : [a, b, 1],
    meanOriginalOd: 0.2,
    meanCensoredOd: 0.2,
    censoredReplicateCount: 0,
    effect,
    singleAgentEffects: Array(drugCount).fill(0.2),
    blissExpected: 0.36,
    blissInteraction: interaction,
    replicateCount: 1,
    interpretation: "synergistic" as const,
  }));
  return {
    id,
    label: id,
    analysis: {
      drugNames: Array.from({ length: drugCount }, (_, index) => `Drug ${index + 1}`),
      micValues: Array.from({ length: drugCount }, (_, index) => Math.min(...processed.map((row) => row.concentrations[index]))),
      micZeroTolerance: 5,
      clinicallyRelevantConcentrations: [],
      concentrationUnits: [],
      control: { replicateCount: 1, meanOd: 1 },
      processed,
      summary: { sumBliss: 0, meanBliss: 0, positiveSum: 0, negativeSum: 0, combinationCount: processed.length, pValue: null, interpretation: "additive" },
      warnings: [],
      policy: { mode: "synergyFinderPlus", responseType: "inhibition", baselineCorrection: "none", bootstrapIterations: 10, randomSeed: 123, cellAdditiveThreshold: 10, odCensorThreshold: 0, allowIncompleteGrid: true },
    } satisfies AnalysisResult,
  };
}

describe("dose-stratified regimen comparison", () => {
  const settings = { minimumEffect: 0, synergyThresholds: [10, 20] as [number, number], antagonismThreshold: 10 };

  it("ranks by exceedance AUC while retaining matched-location win probabilities", () => {
    const result = compareRegimens([
      regimen("A", [[1, 1, 20], [1, 2, 30], [2, 1, -20], [2, 2, 40]]),
      regimen("B", [[10, 5, 10], [10, 10, 20], [20, 5, 50], [20, 10, 30]]),
    ], settings);
    expect(result.rankings.map((row) => row.regimen.id)).toEqual(["B", "A"]);
    expect(result.rankings.map((row) => row.exceedanceAuc)).toEqual([47.5, 37.5]);
    expect(result.rankings.find((row) => row.regimen.id === "A")?.averageWinProbability).toBe(0.75);
    expect(result.pairwise.find((cell) => cell.leftId === "A" && cell.rightId === "B")?.matchedLocations).toBe(4);
  });

  it("matches concentrations by fold MIC rather than ordinal position", () => {
    const left = regimen("A", [[1, 2, 20], [2, 4, 30]]);
    left.analysis.micValues = [2, 4];
    const right = regimen("B", [[5, 10, 10], [10, 20, 40]]);
    right.analysis.micValues = [10, 20];
    const result = compareRegimens([left, right], settings);
    expect(result.pairwise.find((cell) => cell.leftId === "A" && cell.rightId === "B")?.matchedLocations).toBe(2);
    expect(result.pairwise.find((cell) => cell.leftId === "A" && cell.rightId === "B")?.winProbability).toBe(0.5);
  });

  it("counts ties as half a win and excludes low-effect locations", () => {
    const result = compareRegimens([
      regimen("A", [[1, 1, 20, 80], [2, 2, 90, 10]]),
      regimen("B", [[5, 5, 20, 80], [10, 10, -90, 10]]),
    ], { ...settings, minimumEffect: 50 });
    expect(result.rankings[0].averageWinProbability).toBe(0.5);
    expect(result.rankings[0].eligibleLocations).toBe(1);
  });

  it("rejects mixed two- and three-drug cohorts", () => {
    expect(() => compareRegimens([regimen("A", [[1, 1, 0.2]]), regimen("B", [[1, 1, 0.2]], 3)], settings)).toThrow(/separately/);
  });

  it("integrates the empirical exceedance curve over a shared domain", () => {
    const domain = exceedanceDomain([-20, 10, 20, 40]);
    expect(domain).toEqual([-20, 40]);
    expect(exceedanceAuc([-20, 20, 40], domain)).toBeCloseTo(100 / 3);
  });

  it("starts AUC only where an eligible combination can fail to exceed the threshold", () => {
    const domain = exceedanceDomain([10, 20, 30]);
    expect(domain).toEqual([10, 30]);
    expect(exceedanceAuc([10, 20, 30], domain)).toBe(10);
    expect(exceedanceAuc([10, 10], exceedanceDomain([10, 10]))).toBe(0);
  });
});

describe("three-drug summaries", () => {
  it("summarizes the active pair when the stratified drug is zero", () => {
    const value = regimen("triple", [[0, 1, 4], [0, 2, 8], [1, 1, 100]], 3).analysis;
    value.processed[0].blissSem = 1;
    value.processed[1].blissSem = 1;
    const summary = inactiveDrugPairSummary(value, 0)!;
    expect(summary.count).toBe(2);
    expect(summary.mean).toBe(6);
    expect(summary.ciLeft).toBeCloseTo(6 - 1.96 * Math.sqrt(2) / 2);
  });

  it("outlines eligible pairwise cells when the stratifying drug is zero", () => {
    const value = regimen("triple", [[1, 2, 4]], 3).analysis;
    value.processed[0].concentrations[2] = 0;
    value.clinicallyRelevantConcentrations = [null, null, 4];
    expect(isClinicalWindowCell(value, value.processed[0], 1, 0)).toBe(true);
  });

  it("does not invent an aggregate interval when cellwise SEMs are unavailable", () => {
    const value = regimen("pair", [[1, 1, 4], [2, 2, 8]]).analysis;
    expect(aggregateBliss(value.processed).ciLeft).toBeNull();
  });
});

describe("sticky stratification", () => {
  it("uses manual choices first and ordered shared drugs for remaining regimens", () => {
    const first = regimen("first", [[1, 1, 1]], 3);
    first.analysis.drugNames = ["A", "B", "C"];
    const second = regimen("second", [[1, 1, 1]], 3);
    second.analysis.drugNames = ["D", "B", "C"];
    expect(stratificationIndexFor(first, {}, ["A", "B"])).toBe(0);
    expect(stratificationIndexFor(second, {}, ["A", "B"])).toBe(1);
    expect(stratificationIndexFor(second, { second: "C" }, ["A", "B"])).toBe(2);
  });
});
