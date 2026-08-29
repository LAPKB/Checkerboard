#!/usr/bin/env python3
"""Independent MuSyC fit comparison against djwooten/synergy 1.0.0.

Usage (from repository root):
    python tests/validate_musyc_against_synergy.py tests/test2_combined.csv

The script deliberately applies the same no-censor preprocessing used by the
Checkmate validation example: blank=0, response/control normalization, maximum
concentration scaling, and exclusion of drug-exposed effects outside (0, 1).
"""

from __future__ import annotations

import csv
import io
import math
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
from synergy.combination import MuSyC


ROOT = Path(__file__).resolve().parents[1]
PARAMETERS = ("e0", "e1", "e2", "e3", "c1", "c2", "h1", "h2", "alpha12", "alpha21", "gamma12", "gamma21")


def checkmate_results(path: Path) -> dict[str, dict[str, str]]:
    completed = subprocess.run(
        ["cargo", "run", "--quiet", "--example", "musyc_fit_csv", "--", str(path)],
        cwd=ROOT / "desktop" / "src-tauri",
        check=True,
        text=True,
        capture_output=True,
    )
    return {row["regimen"]: row for row in csv.DictReader(io.StringIO(completed.stdout))}


def grouped_rows(path: Path):
    groups = defaultdict(list)
    with path.open(encoding="utf-8-sig", newline="") as stream:
        for row in csv.DictReader(stream):
            groups[(row["DrugA"], row["DrugB"])].append(
                (float(row["ConcA"]), float(row["ConcB"]), float(row["Response"]))
            )
    return groups


def oracle_fit(rows, p0=None):
    controls = [response for d1, d2, response in rows if d1 == 0 and d2 == 0]
    control = sum(controls) / len(controls)
    maximum_1 = max(d1 for d1, _, _ in rows)
    maximum_2 = max(d2 for _, d2, _ in rows)
    eligible = []
    for d1, d2, response in rows:
        if d1 == 0 and d2 == 0:
            continue
        effect = 1 - response / control
        if 0 < effect < 1:
            eligible.append((d1 / maximum_1, d2 / maximum_2, 1 - effect))
    values = np.asarray(eligible)
    d1, d2, viability = values.T
    model = MuSyC(
        fit_gamma=True,
        E_bounds=(-0.25, 1.25),
        E0_bounds=(0.999999, 1.000001),
        C_bounds=(0.001, 4),
        h_bounds=(0.1, 10),
        alpha_bounds=(0.01, 100),
        gamma_bounds=(0.1, 10),
    )
    model.fit(d1, d2, viability, p0=p0, maxfev=200_000)
    predicted_effect = 1 - model.E(d1, d2)
    observed_effect = 1 - viability
    residual = observed_effect - predicted_effect
    total = np.sum((observed_effect - np.mean(observed_effect)) ** 2)
    result = {
        "e0": 1 - model.E0,
        "e1": 1 - model.E1,
        "e2": 1 - model.E2,
        "e3": 1 - model.E3,
        "c1": model.C1,
        "c2": model.C2,
        "h1": model.h1,
        "h2": model.h2,
        "alpha12": model.alpha12,
        "alpha21": model.alpha21,
        "gamma12": model.gamma12,
        "gamma21": model.gamma21,
        "beta": model.beta,
        "r2": 1 - np.sum(residual**2) / total,
        "rmse": math.sqrt(np.mean(residual**2)),
        "n": len(eligible),
        "converged": model.is_converged,
    }
    return result


def main() -> None:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "tests" / "test2_combined.csv").resolve()
    native = checkmate_results(path)
    print("regimen,n,checkmate_r2,synergy_default_r2,prediction_rmse_ratio,checkmate_beta,synergy_default_beta,max_log10_fold_difference,synergy_warm_r2_delta,synergy_warm_beta_delta")
    for drugs, rows in grouped_rows(path).items():
        regimen = "+".join(drugs)
        checkmate = native[regimen]
        oracle = oracle_fit(rows)
        p0 = [1 - float(checkmate[name]) for name in ("e0", "e1", "e2", "e3")]
        p0 += [float(checkmate[name]) for name in ("h1", "h2", "c1", "c2", "alpha12", "alpha21", "gamma12", "gamma21")]
        warm = oracle_fit(rows, p0=p0)
        fold_differences = []
        for parameter in ("c1", "c2", "h1", "h2", "alpha12", "alpha21", "gamma12", "gamma21"):
            left = float(checkmate[parameter])
            right = float(oracle[parameter])
            fold_differences.append(abs(math.log10(left / right)))
        print(
            f"{regimen},{oracle['n']},{float(checkmate['r2']):.8g},{oracle['r2']:.8g},"
            f"{float(checkmate['rmse']) / oracle['rmse']:.8g},{float(checkmate['beta']):.8g},"
            f"{oracle['beta']:.8g},{max(fold_differences):.8g},"
            f"{warm['r2'] - float(checkmate['r2']):.8g},{warm['beta'] - float(checkmate['beta']):.8g}"
        )


if __name__ == "__main__":
    main()
