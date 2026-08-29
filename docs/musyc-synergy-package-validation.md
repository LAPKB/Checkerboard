# MuSyC validation against `djwooten/synergy`

## Dataset and oracle

The requested `tests/test_combined.csv` was not present. Validation therefore
used the matching two-drug file `tests/test2_combined.csv`, which contains seven
regimens with CFZ as drug 2. The independent oracle was the official Python
package `synergy` version 1.0.0, using `synergy.combination.MuSyC` with
`fit_gamma=True` and the same bounds as Checkmate.

Both implementations received identical no-censor data:

- blank = 0;
- each response divided by its regimen's untreated-control mean;
- concentrations divided by their respective tested maxima;
- untreated controls omitted from the fit because Checkmate fixes `E0 = 0` on
  its increasing-inhibition scale;
- drug-exposed observations outside `0 < E < 1` omitted;
- the Python response was kept as viability, while Checkmate used the
  algebraically equivalent `1 - viability` inhibition scale.

The comparison can be rerun with:

```sh
python tests/validate_musyc_against_synergy.py tests/test2_combined.csv
```

## Equation-level validation

The Checkmate state-transition solver was corrected to use the package's exact
default kinetic normalization, `r1r = r2r = 1`. A pinned Rust regression test
compares six predictions, including off-axis combination points with unequal
alpha and gamma values, against `synergy` 1.0.0 to absolute tolerance `1e-12`.

## Independent default-fit comparison

| Regimen | n | Checkmate R2 | `synergy` R2 | Checkmate beta | `synergy` beta |
|---|---:|---:|---:|---:|---:|
| AMK + CFZ | 183 | 0.856389 | 0.855690 | -0.060151 | -0.120964 |
| BDQ + CFZ | 176 | 0.805543 | 0.799907 | 0.061627 | -0.103092 |
| FOX + CFZ | 218 | 0.912590 | 0.911978 | -0.083484 | -0.092673 |
| IPM + CFZ | 169 | 0.686739 | 0.684767 | -0.123544 | -0.173504 |
| LZD + CFZ | 202 | 0.893418 | 0.887331 | -0.241247 | -0.114688 |
| OMC + CFZ | 208 | 0.421933 | 0.421897 | -0.411872 | -0.475188 |
| TZD + CFZ | 202 | 0.896124 | 0.889518 | -0.240526 | -0.134787 |

Prediction performance is closely matched: the Checkmate-to-`synergy` RMSE
ratio ranges from 0.9696 to 0.99997, and the largest absolute R2 difference is
0.00785. The point parameters are not uniquely reproduced from independent
initializations. The largest positive-parameter difference is about 10.9-fold,
and BDQ + CFZ changes the sign of beta despite similar surface error.

## Same-solution validation

To distinguish an equation discrepancy from optimizer multimodality, each
Checkmate solution was supplied to the official package as its initial point.
The package reproduced the Checkmate solution for every regimen:

- maximum absolute R2 difference: `2.33e-8`;
- maximum absolute beta difference: `2.87e-6`;
- the other six beta differences were below `4.54e-7`.

This validates the implemented equation, parameter orientation, response-scale
conversion, and objective calculation. It also demonstrates that the full
12-parameter surface has multiple near-equivalent minima for these data.

## Interpretation

The predicted surfaces are validated against the official package, but a
point-estimate beta ranking is not validated as robust for this dataset. Several
fits place E, alpha, or gamma estimates on their configured bounds. Checkmate
now displays a warning when this occurs. Bootstrap or profile-based uncertainty,
and preferably a sensitivity fit with gamma fixed to 1, should precede use of
beta for regimen ranking.
