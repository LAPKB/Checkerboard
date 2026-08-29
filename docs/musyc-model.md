# MuSyC implementation in Checkmate

## Scope

Checkmate implements the two-drug generalized MuSyC four-state equilibrium
model described by Meyer et al. (2019) and Wooten et al. (2021). It separates
three interaction dimensions:

- efficacy: the combination-state effect `E3`, summarized relative to the more
  effective monotherapy by `beta`;
- potency: the directional fold changes `alpha12` and `alpha21`;
- cooperativity: the directional fold changes `gamma12` and `gamma21`.

The current implementation is two-drug only.

## Response and concentration scales

All eligible responses are converted to normalized inhibition:

```text
E = 1 - (response - blank) / (mean growth control - blank)
```

Consequently, untreated control has `E0 = 0`, and increasing `E` means a more
effective treatment. `E0` is fixed rather than estimated. Drug concentrations
are divided by their respective maximum tested concentrations for fitting.
The fitted `C1` and `C2` are multiplied by those maxima for the Fit table so
they are reported in the imported concentration units.

For an absorbance censor limit `L`, wells with responses at or below `L` are
retained as one-sided observations. On the normalized-inhibition scale these
wells assert `observed E >= E_L`; a prediction at or above `E_L` therefore has
zero censoring residual.

## Four-state equilibrium

The state occupancies are `U`, `A1`, `A2`, and `A12`: untreated, affected by
drug 1, affected by drug 2, and affected by both drugs. Checkmate uses the
following forward and reverse rates:

```text
U   <-> A1:   (d1/C1)^h1,                                      1
U   <-> A2:   (d2/C2)^h2,                                      1
A1  <-> A12:  C2^(-h2*gamma12)*(alpha12*d2)^(gamma12*h2),      1
A2  <-> A12:  C1^(-h1*gamma21)*(alpha21*d1)^(gamma21*h1),      1
```

The equilibrium equations plus `U + A1 + A2 + A12 = 1` form a 4 by 4 linear
system. This uses the official Python package's default `r1r = r2r = 1`
kinetic normalization. After solving it, the predicted normalized effect is

```text
predicted E = E0*U + E1*A1 + E2*A2 + E3*A12.
```

At either zero-drug boundary, this reduces to the corresponding four-parameter
Hill curve. The fitted parameter set reported by the app is:

```text
E0 (fixed), E1, E2, E3, C1, C2, h1, h2,
alpha12, alpha21, gamma12, gamma21
```

`alpha12` is the fold change in drug 2 potency induced by drug 1;
`alpha21` is the fold change in drug 1 potency induced by drug 2. The gamma
indices follow the same direction for cooperativity. A fold change of 1 means
no interaction in that dimension.

## Efficacy synergy and ranking

The papers define beta on a response scale where a lower value is more
effective. Checkmate uses increasing normalized inhibition, so the algebraic
equivalent is

```text
beta = (E3 - max(E1, E2)) / max(E1, E2).
```

Thus `beta > 0` denotes efficacy synergy, `beta = 0` denotes no improvement in
maximal efficacy over the stronger monotherapy, and `beta < 0` denotes efficacy
antagonism. The Compare tab ranks multiple imported regimens by bootstrap
median beta or bootstrap median `E3`. Beta answers whether the combination improves efficacy relative to its
own strongest component; E3 reports the fitted absolute combination efficacy.
They should be considered together when selecting a regimen. The ranking
control defaults to beta and can be switched to E3.

## Fitting

Monotherapy observations initialize `E1`, `E2`, `C1`, `C2`, `h1`, and `h2`.
The complete surface is then fitted jointly with bounded nonlinear least
squares. Positive parameters are optimized in log coordinates. Bounds are:

```text
E1, E2, E3:       -0.25 to 1.25
C1, C2:            0.001 to 4 (fractions of tested maxima)
h1, h2:            0.1 to 10
alpha12, alpha21:  0.01 to 100
gamma12, gamma21:  0.1 to 10
```

The reported objective is the mean squared normalized-effect residual with the
one-sided censoring rule described above.

## Fixed-dose-grid parametric bootstrap

After the reference fit, Checkmate estimates one homoscedastic residual SD on
the normalized-effect scale from uncensored wells, using residual degrees of
freedom `n_uncensored - 11`. At least 12 uncensored drug-exposed wells are
therefore required. For each bootstrap iteration, it retains
the observed dose coordinates and draws

```text
E* = predicted E + residual SD * Z,    Z ~ Normal(0, 1).
```

The synthetic effect is converted to the original response scale. If an
absorbance censor limit was supplied, the censor boundary is reapplied and the
synthetic observation enters the refit with the same one-sided rule. Each
synthetic dataset is initialized from the reference solution and fitted
independently. Datasets are generated serially from the selected seed before
parallel fitting, so results do not depend on worker scheduling.

Fit reports the reference value, bootstrap mean and SD, median, and percentile
95% confidence interval for every parameter. It also reports bootstrap
summaries for beta and E3, the residual SD, and the number of converged
bootstrap fits. Compare ranks by bootstrap medians rather than potentially
unstable reference point estimates. This bootstrap is conditional on the
fitted MuSyC model and fixed experimental dose grid; it does not replace
independent biological replication.
