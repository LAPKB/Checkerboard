import { describe, expect, it } from "vitest";

import { compareRegimens } from "./analysis";
import type { AnalysisResult, ComparisonRegimen, ProcessedCombination } from "./types";

type InteractionClass = "antagonistic" | "additive" | "synergistic";

const classScore: Record<InteractionClass, number> = {
  antagonistic: -20,
  additive: 0,
  synergistic: 20,
};

function positiveDoseLocations(drugCount: number): number[][] {
  return Array.from({ length: 2 ** drugCount }, (_, encoded) =>
    Array.from({ length: drugCount }, (_, drugIndex) => 2 ** ((encoded >> drugIndex) & 1)),
  );
}

function syntheticRegimen(drugCount: 2 | 3, interaction: InteractionClass): ComparisonRegimen {
  const score = classScore[interaction];
  const processed: ProcessedCombination[] = positiveDoseLocations(drugCount).map((concentrations) => ({
    concentrations,
    meanOriginalOd: 50,
    meanCensoredOd: 50,
    censoredReplicateCount: 0,
    effect: 50,
    singleAgentEffects: Array(drugCount).fill(20),
    blissExpected: drugCount === 2 ? 36 : 48.8,
    blissInteraction: score,
    replicateCount: 1,
    interpretation: interaction,
  }));
  const analysis: AnalysisResult = {
    drugNames: Array.from({ length: drugCount }, (_, index) => `Drug ${index + 1}`),
    micValues: Array(drugCount).fill(1),
    micZeroTolerance: 5,
    control: { replicateCount: 1, meanOd: 100 },
    processed,
    summary: {
      sumBliss: score * processed.length,
      meanBliss: score,
      positiveSum: Math.max(0, score) * processed.length,
      negativeSum: Math.min(0, score) * processed.length,
      combinationCount: processed.length,
      pValue: null,
      interpretation: interaction,
    },
    warnings: [],
    policy: {
      mode: "synergyFinderPlus",
      responseType: "viability",
      baselineCorrection: "none",
      bootstrapIterations: 2,
      randomSeed: 123,
      cellAdditiveThreshold: 10,
      odCensorThreshold: 0,
      allowIncompleteGrid: true,
    },
  };
  return { id: `${drugCount}-${interaction}`, label: interaction, analysis };
}

const settings = {
  minimumEffect: 0,
  synergyThresholds: [10, 20] as [number, number],
  antagonismThreshold: 10,
};

describe.each([2, 3] as const)("synthetic %i-drug regimen ranking", (drugCount) => {
  it("ranks synergistic above additive above antagonistic by exceedance AUC", () => {
    const regimens = (["antagonistic", "synergistic", "additive"] as InteractionClass[])
      .map((interaction) => syntheticRegimen(drugCount, interaction));
    const result = compareRegimens(regimens, settings);

    expect(result.rankings.map((row) => row.regimen.label)).toEqual([
      "synergistic",
      "additive",
      "antagonistic",
    ]);
    expect(result.rankings.map((row) => row.exceedanceAuc)).toEqual([40, 20, 0]);
    expect(result.rankings.map((row) => row.averageWinProbability)).toEqual([1, 0.5, 0]);
    expect(result.rankings.map((row) => row.eligibleLocations)).toEqual([
      2 ** drugCount,
      2 ** drugCount,
      2 ** drugCount,
    ]);
  });

  it("reports the expected synergy breadth and antagonism burden", () => {
    const result = compareRegimens(
      (["synergistic", "additive", "antagonistic"] as InteractionClass[])
        .map((interaction) => syntheticRegimen(drugCount, interaction)),
      settings,
    );

    expect(result.rankings.find((row) => row.regimen.label === "synergistic")?.synergyBreadth).toEqual([1, 1]);
    expect(result.rankings.find((row) => row.regimen.label === "additive")?.synergyBreadth).toEqual([0, 0]);
    expect(result.rankings.find((row) => row.regimen.label === "antagonistic")?.antagonismBurden).toBe(1);
  });
});
