import { describe, expect, it } from "vitest";

import { buildMapping, compareRegimens, validateRoles } from "./analysis";
import type { AnalysisResult, ComparisonRegimen, ImportPreview } from "./types";

const preview: ImportPreview = {
  headers: ["A", "B", "Response"],
  rows: [],
  totalRows: 0,
  totalColumns: 3,
  suggestedRoles: ["drugA", "drugB", "od"],
  suggestedDrugNames: ["Ampicillin", "Meropenem", "Response"],
};

describe("column mapping", () => {
  it("requires each core role exactly once", () => {
    expect(validateRoles(["drugA", "drugA", "od"])).toHaveLength(2);
  });

  it("builds drugs in stable A/B/C order", () => {
    expect(buildMapping(preview, ["drugA", "drugB", "od"])).toEqual({
      drugs: [
        { column: 0, name: "Ampicillin" },
        { column: 1, name: "Meropenem" },
      ],
      responseColumn: 2,
    });
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
      control: { replicateCount: 1, meanOd: 1 },
      processed,
      summary: { sumBliss: 0, meanBliss: 0, positiveSum: 0, negativeSum: 0, combinationCount: processed.length, interpretation: "additive" },
      warnings: [],
      policy: { cellAdditiveThreshold: 0.05, odCensorThreshold: 0.05, allowIncompleteGrid: true },
    } satisfies AnalysisResult,
  };
}

describe("dose-stratified regimen comparison", () => {
  const settings = { minimumEffect: 0, synergyThresholds: [0.1, 0.2] as [number, number], antagonismThreshold: 0.1 };

  it("ranks using wins at corresponding relative dose locations", () => {
    const result = compareRegimens([
      regimen("A", [[1, 1, 0.2], [1, 2, 0.3], [2, 1, -0.2], [2, 2, 0.4]]),
      regimen("B", [[10, 5, 0.1], [10, 10, 0.2], [20, 5, 0.5], [20, 10, 0.3]]),
    ], settings);
    expect(result.rankings.map((row) => row.regimen.id)).toEqual(["A", "B"]);
    expect(result.rankings[0].averageWinProbability).toBe(0.75);
    expect(result.pairwise.find((cell) => cell.leftId === "A" && cell.rightId === "B")?.matchedLocations).toBe(4);
  });

  it("counts ties as half a win and excludes low-effect locations", () => {
    const result = compareRegimens([
      regimen("A", [[1, 1, 0.2, 0.8], [2, 2, 0.9, 0.1]]),
      regimen("B", [[5, 5, 0.2, 0.8], [10, 10, -0.9, 0.1]]),
    ], { ...settings, minimumEffect: 0.5 });
    expect(result.rankings[0].averageWinProbability).toBe(0.5);
    expect(result.rankings[0].eligibleLocations).toBe(1);
  });

  it("rejects mixed two- and three-drug cohorts", () => {
    expect(() => compareRegimens([regimen("A", [[1, 1, 0.2]]), regimen("B", [[1, 1, 0.2]], 3)], settings)).toThrow(/separately/);
  });
});
