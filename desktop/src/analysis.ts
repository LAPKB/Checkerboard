import type {
  ComparisonRegimen,
  ComparisonResult,
  ComparisonSettings,
  ColumnMapping,
  ColumnRole,
  ImportPreview,
} from "./types";

const comparisonTolerance = 1e-12;

const orderedDrugRoles: ColumnRole[] = ["drugA", "drugB", "drugC"];

export function validateRoles(roles: ColumnRole[]): string[] {
  const errors: string[] = [];
  for (const role of ["drugA", "drugB", "od"] as ColumnRole[]) {
    if (roles.filter((value) => value === role).length !== 1) {
      errors.push(`${roleLabel(role)} must be assigned exactly once.`);
    }
  }
  if (roles.filter((value) => value === "drugC").length > 1) {
    errors.push("Drug C can be assigned at most once.");
  }
  return errors;
}

export function buildMapping(
  preview: ImportPreview,
  roles: ColumnRole[],
): ColumnMapping | null {
  if (validateRoles(roles).length > 0) return null;
  const drugs = orderedDrugRoles.flatMap((role) => {
    const column = roles.indexOf(role);
    if (column < 0) return [];
    return [{ column, name: preview.suggestedDrugNames[column] || roleLabel(role) }];
  });
  return { drugs, responseColumn: roles.indexOf("od") };
}

export function roleLabel(role: ColumnRole): string {
  return {
    ignore: "Ignore",
    drugA: "Drug A",
    drugB: "Drug B",
    drugC: "Drug C",
    od: "OD",
  }[role];
}

export function formatNumber(value: number, digits = 3): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "—";
}

export function compareRegimens(
  regimens: ComparisonRegimen[],
  settings: ComparisonSettings,
): ComparisonResult {
  if (regimens.length < 2) throw new Error("At least two regimens are required for comparison.");
  const drugCount = regimens[0].analysis.drugNames.length;
  if (regimens.some((regimen) => regimen.analysis.drugNames.length !== drugCount)) {
    throw new Error("Two-drug and three-drug regimens must be compared separately.");
  }
  if (![2, 3].includes(drugCount)) throw new Error("Only two-drug and three-drug regimens can be compared.");

  const surfaces = new Map(regimens.map((regimen) => [regimen.id, normalizedSurface(regimen, settings.minimumEffect)]));
  const pairwise = regimens.flatMap((left) => regimens.map((right) => {
    if (left.id === right.id) {
      return { leftId: left.id, rightId: right.id, winProbability: 0.5, matchedLocations: surfaces.get(left.id)!.size };
    }
    const leftSurface = surfaces.get(left.id)!;
    const rightSurface = surfaces.get(right.id)!;
    let wins = 0;
    let matchedLocations = 0;
    for (const [coordinate, leftBliss] of leftSurface) {
      const rightBliss = rightSurface.get(coordinate);
      if (rightBliss === undefined) continue;
      matchedLocations += 1;
      const difference = leftBliss - rightBliss;
      wins += Math.abs(difference) <= comparisonTolerance ? 0.5 : Number(difference > 0);
    }
    return {
      leftId: left.id,
      rightId: right.id,
      winProbability: matchedLocations > 0 ? wins / matchedLocations : null,
      matchedLocations,
    };
  }));

  const unranked = regimens.map((regimen) => {
    const surface = surfaces.get(regimen.id)!;
    const opponentScores = pairwise
      .filter((cell) => cell.leftId === regimen.id && cell.rightId !== regimen.id && cell.winProbability !== null)
      .map((cell) => cell.winProbability!);
    const blissValues = [...surface.values()];
    return {
      regimen,
      rank: 0,
      averageWinProbability: opponentScores.length
        ? opponentScores.reduce((sum, value) => sum + value, 0) / opponentScores.length
        : null,
      eligibleLocations: surface.size,
      synergyBreadth: settings.synergyThresholds.map((threshold) => proportion(blissValues, (value) => value >= threshold)) as [number, number],
      antagonismBurden: proportion(blissValues, (value) => value <= -settings.antagonismThreshold),
    };
  }).sort((left, right) => (right.averageWinProbability ?? -1) - (left.averageWinProbability ?? -1));

  let previousScore: number | null | undefined;
  let previousRank = 0;
  const rankings = unranked.map((row, index) => {
    const tied = previousScore !== undefined
      && row.averageWinProbability !== null
      && previousScore !== null
      && Math.abs(row.averageWinProbability - previousScore) <= comparisonTolerance;
    const rank = tied ? previousRank : index + 1;
    previousScore = row.averageWinProbability;
    previousRank = rank;
    return { ...row, rank };
  });

  return { drugCount, rankings, pairwise };
}

function normalizedSurface(regimen: ComparisonRegimen, minimumEffect: number): Map<string, number> {
  const rows = regimen.analysis.processed.filter((row) => row.concentrations.every((value) => value > 0));
  const levels = regimen.analysis.drugNames.map((_, index) =>
    [...new Set(rows.map((row) => row.concentrations[index]))].sort((left, right) => left - right),
  );
  const surface = new Map<string, number>();
  for (const row of rows) {
    if (row.effect < minimumEffect) continue;
    const coordinate = row.concentrations.map((concentration, index) => {
      const levelIndex = levels[index].indexOf(concentration);
      return levels[index].length === 1 ? 1 : levelIndex / (levels[index].length - 1);
    }).map((value) => value.toFixed(12)).join("|");
    surface.set(coordinate, row.blissInteraction);
  }
  return surface;
}

function proportion(values: number[], predicate: (value: number) => boolean): number {
  return values.length ? values.filter(predicate).length / values.length : 0;
}
