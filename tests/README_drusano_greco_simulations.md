# Censored Drusano–Greco simulation fixtures

These pinned checkerboards exercise recovery of the seven-parameter, two-drug
Drusano–Greco Equation 2 model:

- `EC50_1 = 1 mg/L`
- `EC50_2 = 2 mg/L`
- `h1 = 1`
- `h2 = 2`
- `B1 = 0`
- `B2 = 0`
- `alpha_12 = -0.5`, `0`, or `0.5`

Each file contains the same 8 by 8 fixed dose grid from 0 to 8 mg/L. The
uncensored response is `1 - LatentEffect`, with a growth-control response of 1
and a blank of 0. Whenever the latent effect is strictly greater than 0.9, the
stored response is replaced by 0.1 and `CENS` is set to 1. Thus the application
sees the observation as being at or below the response detection limit while
retaining the correct direction of censoring. There are 5, 12, and 16 censored
wells in the negative, zero, and positive alpha fixtures, respectively.

The application divides both concentrations by their maximum of 8 mg/L.
Consequently, the native fit targets internal EC50 values of 0.125 and 0.25;
the displayed concentration-scale estimates must recover 1 and 2 mg/L.

The Rust regression test imports each CSV through `build_equation_dataset`,
checks the strict censoring rule, and verifies that the seven known parameters
reproduce every latent effect before running the same joint NPAG reference fit
and parametric bootstrap used by the application. Positive and zero-interaction
fixtures retain parameter-recovery checks. With negative interaction plus
upper-tail effect censoring, alpha can be weakly identified,
so that fixture pins forward-model parity and a fit-quality floor rather than
claiming unique parameter recovery. The test uses 100 bootstrap samples and
seed 123 to keep continuous integration reproducible.

The fixtures are generated deterministically by
`generate_drusano_greco_simulations.R`; R is a development convenience for
regenerating pinned data and is not used by the shipped application or by the
Rust tests.

## Bliss-calibrated Equation 2 fixtures

Three additional uncensored fixtures are generated from the same Equation 2
parameters and dose grid. Their interaction parameters are solved numerically
so the native Bliss analysis reports mean interaction scores of -12, 0.5, and
10 percentage points over locations where both concentrations are positive:

- `drusano_greco_bliss_minus12.csv`
- `drusano_greco_bliss_plus0_5.csv`
- `drusano_greco_bliss_plus10.csv`

Their concentration headers also exercise import inference: `Drug 1 (mg/L)`
and `Drug 2 mg/L` must be interpreted as concentration columns while supplying
the drug names and units. Regression tests verify the pinned Bliss means and
that the joint Drusano fit recovers the known parameters when the interaction
term is informative.
