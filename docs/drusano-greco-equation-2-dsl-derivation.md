# Drusano–Greco Equation 2 model derivation

## Purpose and scope

This note records how the two-drug Drusano–Greco equation in
`DrusanoModelFortran.docx` is used by Checkmate. It also preserves the
derivation of the former `neg_equation_rhs` DSL output so the reason for that
code remains clear in project history.

The fitted parameters are

\[
EC_{50,1},\quad EC_{50,2},\quad h_1,\quad h_2,\quad \alpha_{12}.
\]

Drug concentrations are divided by their user-entered MICs. Effect remains a
dimensionless fraction, but the likelihood for absorbance data is calculated
on the original absorbance scale.

## 1. Starting equation

After normalizing effect as \(E^*=E/E_{con}\), Equation (1b) is

\[
1 =
\frac{D_1}
{EC_{50,1}\left(\frac{E^*}{1-E^*}\right)^{1/h_1}}
+
\frac{D_2}
{EC_{50,2}\left(\frac{E^*}{1-E^*}\right)^{1/h_2}}
+
\frac{\alpha_{12}D_1D_2}
{EC_{50,1}EC_{50,2}
\left(\frac{E^*}{1-E^*}\right)^{
\frac{1}{2}(1/h_1+1/h_2)}}.
\]

Checkmate normalizes an uncensored response \(Y\) as

\[
E^* = 1 - \frac{Y-B}{G-B},
\]

where \(B\) is the assay blank and \(G\) is the mean all-zero-drug growth
control response. Set \(B>0\) only when the imported responses have not already
been blank-adjusted. If blank subtraction was performed before import, set
\(B=0\) to avoid subtracting the blank twice.

## 2. Substitutions and MIC scaling

Define

\[
\begin{aligned}
d_1 &= D_1/MIC_1, & d_2 &= D_2/MIC_2,\\
XM0 &= \frac{E^*}{1-E^*},\\
U &= \frac{d_1}{EC_{50,1}}, & V &= \frac{d_2}{EC_{50,2}},\\
W &= \alpha_{12}UV,\\
H_1 &= \frac{1}{h_1}, & H_2 &= \frac{1}{h_2},\\
H_{12} &= \frac{H_1+H_2}{2}.
\end{aligned}
\]

Equation (2) is therefore

\[
1 = \frac{U}{XM0^{H_1}}
  + \frac{V}{XM0^{H_2}}
  + \frac{W}{XM0^{H_{12}}}.
\]

Both \(d_i\) and the fitted \(EC_{50,i}\) are expressed in multiples of MIC,
so \(U\) and \(V\) remain dimensionless. The MIC scaling does not alter the
dimensionless effect transformation.

## 3. Derivation of the former DSL output

Let the right-hand side of Equation (2) be

\[
S(E^*,d_1,d_2;\theta)=
\frac{U}{XM0^{H_1}}+
\frac{V}{XM0^{H_2}}+
\frac{W}{XM0^{H_{12}}}.
\]

The former DSL used

```text
out(neg_equation_rhs) = -(
    u / pow(xm0, h_1)
  + v / pow(xm0, h_2)
  + w / pow(xm0, h_12)
)
```

and paired every well with `OUT = -1`. Thus the fitted equality was

\[
-1=-S,
\]

which is algebraically identical to \(1=S\). Its residual was

\[
-1-(-S)=S-1,
\]

and its squared residual was

\[
(S-1)^2=(1-S)^2.
\]

Using \(T_1=U/XM0^{H_1}\), \(T_2=V/XM0^{H_2}\), and
\(T_3=W/XM0^{H_{12}}\), this is the source document's `BestM0` objective
\((1-T_1-T_2-T_3)^2\).

That implicit residual representation is no longer used for likelihood
calculation. Its fixed observation caused the assay-error polynomial to be
constant across wells and placed the error model on an artificial equation
scale rather than the measured response scale.

## 4. Current predicted-absorbance model

For every well and candidate parameter vector \(\theta\), Checkmate now:

1. Retains the dimensionless MIC-scaled doses \(d_1\) and \(d_2\).
2. Numerically solves Equation (2) for \(XM0>0\).
3. Recovers the dimensionless predicted effect:

   \[
   \widehat E_i(\theta)=\frac{XM0_i(\theta)}{1+XM0_i(\theta)}.
   \]

4. Converts predicted effect back to the imported response scale:

   \[
   \widehat Y_i(\theta)=B+(G-B)\left[1-\widehat E_i(\theta)\right].
   \]

For absorbance input, \(\widehat Y_i\) is predicted absorbance. The measured
absorbance is the observation used by the likelihood. Observed normalized
effect is retained for reporting and observed-versus-predicted effect plots; it
is no longer supplied as a model covariate.

The numerical implementation uses a safeguarded Newton solve in \(\log(XM0)\)
rather than invoking a nested Nelder–Mead optimization. Single-agent locations
have direct solutions and bypass the root search.

## 5. Prediction-based assay error

The user-entered polynomial is evaluated on the model prediction:

\[
\alpha_i(\theta)=
C_0+C_1\widehat Y_i(\theta)
+C_2\widehat Y_i(\theta)^2
+C_3\widehat Y_i(\theta)^3.
\]

The total standard deviation and inverse-variance weight are

\[
\sigma_i(\theta)=
\sqrt{\lambda^2+\alpha_i(\theta)^2},
\qquad
w_i(\theta)=\frac{1}{\lambda^2+\alpha_i(\theta)^2}.
\]

Consequently, for absorbance data, \(C_0\), \(\lambda\), and every term
produced by the polynomial have absorbance units. The higher-order coefficients
have the corresponding inverse powers of absorbance needed to produce a
standard deviation in absorbance units.

The defaults are \((C_0,C_1,C_2,C_3)=(0.05,0.05,0,0)\) and initial
\(\lambda=0\). Polynomial coefficients remain fixed during a fit. A zero lambda
is valid and leaves that variance component off; a positive starting value may
be optimized by NPAG. Fit output records both the initial and fitted values.

Checkmate vendors a narrowly extended `pharmsol` dependency so an assay error
polynomial can explicitly select prediction-based evaluation. The legacy
observation-based constructor remains unchanged for other uses.

## 6. Absorbance censoring

For a user-selected lower absorbance limit \(L\), wells with \(Y_i\le L\) are
retained as `CENS = 1`/`BLOQ` observations. Their likelihood contribution is

\[
P(Y_i\le L\mid\theta)=
\Phi\!\left(
\frac{L-\widehat Y_i(\theta)}{\sigma_i(\theta)}
\right).
\]

Thus the censor limit, observation, prediction, polynomial, and lambda are all
on the same absorbance scale. No sign reversal of Equation (2) is required.

The corresponding effect boundary is

\[
E_L=1-\frac{L-B}{G-B},
\]

and must satisfy \(0\le E_L<1\). The control response can legitimately have
\(E=0\), although all-zero-drug controls define normalization and are not NPAG
subjects. Drug-exposed observations at the singular effect boundaries remain
explicit exclusions rather than being clipped or imputed.

The automatic \(L\) suggestion is exploratory. It detects a sharp lower-tail
frequency change among finite drug-exposed responses and must be reviewed
against assay validation and instrument limits.

## 7. Runtime policy

The old configuration started with 2,028 support points and allowed 1,000
cycles. That was inappropriate for an interactive checkerboard fit. The current
configuration uses a deterministic 256-point Sobol prior and a user-editable
cycle cap that defaults to 100. Fixed data and settings still produce a
reproducible initial grid and fit path.

If a run reaches its cycle cap without convergence, the UI can warm-continue
that fit for another user-selected number of cycles. The continuation uses the
terminal support-point grid and fitted lambda as the next run's initial state;
PMcore recalculates the support probabilities when the new NPAG run begins.
Cycle counts shown in the result are cumulative, while the latest run's count
and cap are retained separately to determine whether another continuation is
available. This is a warm continuation of the fitted numerical state, not a
serialization of PMcore's internal controller bookkeeping.

## 8. Constant-concentration regimen simulation

For user-entered constant free concentrations \(C_1\) and \(C_2\), the simulator
first uses the fitted MICs to calculate

\[
d_1=\frac{C_1}{\mathrm{MIC}_1},\qquad
d_2=\frac{C_2}{\mathrm{MIC}_2}.
\]

The native simulation follows the Pmetrics `PM_sim(..., split = TRUE)` mixture
policy without introducing an R runtime dependency. Each NPAG support point is
the mean of one multivariate-normal mode, and its fitted support probability is
the probability of selecting that mode. If \(K\) support points have weighted
population covariance \(\Sigma\), every mode uses covariance \(\Sigma/K\).
Parameter draws outside the fitted bounds are rejected and redrawn. Equation 2
is solved at \((d_1,d_2)\) for 1,000 valid draws using a fixed seed of 17. The
Regimen tab reports the mean, sample standard deviation, quantiles, range, and a
kernel density estimate of the resulting dimensionless effects.

## Implementation anchors

- Predicted-absorbance equation, numerical effect solve, likelihood subjects,
  error model, and NPAG runtime policy:
  [`desktop/src-tauri/src/services/drusano_greco.rs`](../desktop/src-tauri/src/services/drusano_greco.rs)
- Response normalization, MIC scaling, censor boundary, and exported model
  rows:
  [`desktop/src-tauri/crates/checkerboard-core/src/drusano_greco.rs`](../desktop/src-tauri/crates/checkerboard-core/src/drusano_greco.rs)
- Prediction-based error-polynomial extension:
  [`vendor/pharmsol/src/data/error_model.rs`](../vendor/pharmsol/src/data/error_model.rs)
