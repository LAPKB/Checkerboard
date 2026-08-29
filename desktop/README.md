# Checkmate desktop

This directory contains the Tauri 2 Checkmate application. Its Bliss
analysis profile is a native Rust implementation benchmarked against
Bioconductor `synergyfinder` 3.20.0 rather than the historical Shiny
implementation.

For a detailed, R-developer-oriented explanation of the Rust, Tauri, React,
npm, Cargo, and repository structure, see
[`../docs/checkerboard-tauri-developer-guide.md`](../docs/checkerboard-tauri-developer-guide.md).

The release application is self-contained. It calculates Bliss surfaces,
replicate bootstraps, baseline corrections, confidence intervals, and p-values
in compiled Rust; users do not need R, Bioconductor, or a Rust toolchain.
The R package remains an optional development oracle for parity tests.

## Current vertical slice

- CSV, TXT, XLS, and XLSX range import in Rust.
- Worksheet discovery for Excel files.
- Column-role suggestions and explicit mapping.
- Algorithm-level selection among Bliss, Drusano–Greco, and MuSyC workflows.
- A compact Drusano–Greco navigation path of Import → Fit → Simulate → Compare; MIC and
  separate Results tabs remain specific to the Bliss workflow.
- Explicit absorbance, fluorescence, or CFU input policy.
- Drusano–Greco blank/growth-control response normalization, maximum-tested-concentration-normalized doses,
  and a user-editable absorbance censor limit with a lower-tail frequency-break suggestion.
- Separate PMcore NPAG fits for each two-drug regimen, with all eligible wells
  combined into one checkerboard subject and displayed reference estimates plus
  fixed-grid parametric-bootstrap distributions for EC50₁, EC50₂, h₁, h₂, and α₁₂.
- User-editable NPAG cycle limits (100 by default) and warm continuation from a
  nonconverged run's terminal support grid and fitted lambda.
- Constant free-concentration regimen simulation with tested-maximum scaling and 1,000
  reproducible draws from the unclustered empirical bootstrap distribution.
- Two-drug MuSyC fitting with fixed-dose-grid parametric bootstrap confidence
  intervals, live reference/bootstrap progress, and Compare-tab ranking by
  bootstrap median beta or absolute combination efficacy E3.
- Versioned `.ckm` project snapshots using maximum DEFLATE compression. Save and
  Load restore imported state, settings, fits, bootstrap summaries, and
  simulations without rerunning the analyses or requiring the source file.
- Absorbance responses at or below the selected censor limit retained with
  Pmetrics/PMcore `CENS = 1` likelihoods; user-editable prediction-based,
  absorbance-scale assay-error polynomial coefficients and initial lambda; plus
  observed-versus-predicted effect plots
  and regression statistics.
- Tauri-independent two- and three-drug Bliss analysis.
- Validation for controls, numeric input, concentrations, OD, and required
  single-agent observations.
- Replicate averaging and incomplete-grid warnings.
- Explicit viability (%), fractional viability (0–1), inhibition (%), and raw-OD response modes.
- SynergyFinder+ `non`, `part`, and `all` baseline correction modes.
- Seeded replicate bootstrap settings, contextual help, and optional cellwise confidence intervals.
- Iteration-level progress reporting from the native bootstrap engine.
- Combination-only mean Bliss summaries in percentage points.
- Summary metrics, stratified three-drug summaries, inactive-drug pair summaries,
  non-overlapping heatmap facets, and processed result tables.
- Lazy-loaded Plotly three-dimensional growth bars with expected-growth
  wireframes for two-drug assays.
- Plotly stratified summary bars for three-drug assays, with interaction-class
  colors and optional approximate confidence-interval error bars.
- Plot color persistence in the Tauri application store.
- Native save dialog and Rust-generated XLSX summary/processed-data export.
- Editable MIC values inferred from single-agent wells using a configurable zero-response tolerance.
- In-memory comparison cohorts for two- or three-drug regimens, with
  `log2(dose/MIC)` coordinate matching, pairwise probabilities of superiority, average-win summaries,
  synergy breadth, antagonism burden, an observed-effect filter, and primary
  ranking by area under the shared-domain synergy exceedance curve.
- Comparison entries retain their import, mapping, MIC, and analysis settings;
  the pencil action restores an entry for editing and recalculation replaces it in place.
- Pinned R-package development parity tests for two- and three-drug bootstrap
  surfaces, baseline correction, confidence intervals, and unreplicated p-values.
- Fast generated two- and three-drug checkerboard regressions for additive,
  synergistic, and antagonistic surfaces, including comparison ranking checks;
  the complete frontend and Rust test suites run automatically before every build.

### MIC inference and comparison

After column mapping, the app groups single-agent wells (one positive drug
concentration and all other drug concentrations equal to zero). It converts the
selected response type to viability percentage, averages replicates at each
dose, and proposes the lowest concentration whose mean is within the editable
zero-response tolerance (default ±5 percentage points). Users must review or
replace every proposed MIC before analysis. Comparisons match cells at equal
`log2(concentration / MIC)` coordinates; zero-concentration control and
single-agent cells are excluded.

The Drusano–Greco model fits the algebraic right-hand side of Equation 2 directly;
it does not use the bacterial growth ODE or `get_e2()`. Subsequent regimen
simulation/results stages, embedding static plot images in exported workbooks,
installer signing, and desktop end-to-end automation remain later migration phases.

## Commands

```sh
npm install
npm test
npm run test:all
npm run build
npm run tauri dev
```

Rust tests are run from `src-tauri/`:

```sh
cargo test --workspace
```

When R and `synergyfinder` 3.20.0 are installed, the test suite also runs the
development-only native-versus-R parity checks. Missing R is never an
application runtime error.

## Boundaries

The `checkerboard-core` crate contains presentation-independent scientific
logic and does not depend on Tauri. Tauri commands re-read the selected source
range for analysis so the frontend only receives the 100-row preview rather
than retaining the entire input table.
