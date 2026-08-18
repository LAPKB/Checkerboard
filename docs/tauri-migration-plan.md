# Checkerboard Tauri/Rust Migration Analysis and Plan

Date: 2026-08-14

## Implementation status

The first vertical slice is implemented under `desktop/`:

- Tauri 2 with a React/TypeScript frontend.
- A Tauri-independent `checkerboard-core` Rust crate.
- Shared two- and three-drug parity fixtures.
- CSV, TXT, XLS, and XLSX range import with worksheet discovery.
- Explicit column mapping and validation.
- Rust Bliss analysis with R parity tests.
- Summary metrics, stratification, heatmaps, and processed data.
- Interactive two-drug three-dimensional growth plots and three-drug summary
  bar plots.
- Persisted plot-color preferences.
- Native save dialogs and Rust-generated XLSX summary/processed-data export.
- A user-configurable OD censor threshold. Negative blank-adjusted OD values
  and values with absolute magnitude below the threshold are analyzed as zero,
  while original values are retained for display and export.
- An original/censored OD display toggle with highlighting for censored values.

Embedding plot images in exported workbooks, installer signing, and full
end-to-end desktop automation remain open phases.

## Executive recommendation

Preserve the R package at the repository root and develop the new desktop application in an isolated `desktop/` directory in the same repository. Keep migration and architecture documentation in `docs/`.

Recommended layout:

```text
Checkerboard/
├── R/                         Existing R implementation
├── tests/testthat/            Existing R tests
├── man/                       Existing R documentation
├── DESCRIPTION                Existing R package metadata
├── NAMESPACE                  Existing R exports
├── app.R                      Existing Shiny launcher
├── desktop/                   New Tauri application
│   ├── src/                   TypeScript/React frontend
│   ├── src-tauri/             Tauri shell and Rust application layer
│   └── package.json
├── fixtures/                  Optional shared parity fixtures
├── docs/
│   └── tauri-migration-plan.md
└── .Rbuildignore
```

This monorepo arrangement is preferable to creating a separate repository because it:

- Preserves the current R Shiny package as a working reference implementation.
- Keeps the scientific model, fixtures, documentation, and both implementations under one version history.
- Makes cross-language parity testing practical.
- Allows the Rust implementation to be validated against R before the Shiny package is retired or placed into maintenance mode.
- Avoids coordinating releases and behavioral changes across two repositories during migration.

The R source does not need to depend on the Tauri application. The `desktop/`, `docs/`, and optional repository-level `fixtures/` directories are excluded in `.Rbuildignore`, so they will not be included in the generated R package tarball.

## Current repository and architecture

Checkerboard is an R package containing an embedded Shiny application rather than a standalone collection of Shiny scripts.

| Component | Location | Responsibility |
|---|---|---|
| Shiny application | `R/shiny_app.R` | Import workflow, column mapping, application state, analysis UI, preferences, and export actions |
| Bliss engine | `R/bliss.R` | Normalization, replicate averaging, Bliss calculations, summaries, heatmaps, and bar plots |
| Workbook export | `R/export.R` | Excel workbook generation, styling, and embedded plot images |
| Mathematical guide | `R/logic.Rmd` | Equations and a worked Bliss example |
| Launcher | `app.R` | Loads the package from the source tree and launches Shiny |
| Tests | `tests/testthat/` | Import, naming, colors, plots, workbook export, and Shiny startup tests |

The current automated test suite passes.

### Current user workflow

1. Select a `.csv`, `.txt`, `.xls`, or `.xlsx` input file.
2. Select a worksheet for Excel inputs.
3. Set a start row, start column, and optional row and column limits. Zero means to read all remaining values.
4. Preview the selected range, limited to the first 100 rows.
5. Assign columns to Drug A, Drug B, optional Drug C, and OD. Unrelated columns are ignored.
6. Infer cleaned drug names from source column headers.
7. Convert mapped values to numeric and create a Bliss object.
8. View the summary, heatmap, bar plot, or processed-data table.
9. Select a stratifying drug for three-drug analyses.
10. Customize and persist plot colors.
11. Export results to an Excel workbook.

## Current Bliss model

For each observation, the application computes an inhibition effect relative to the mean untreated control OD:

```text
raw_effect = 1 - OD / mean_control_OD
effect = clamp(raw_effect, 0, 1)
```

Rows where every drug concentration is zero are explicitly assigned an effect of zero. Replicate effects are averaged for each unique concentration combination.

For each concentration combination, the single-agent effect for drug `k` is obtained at that drug's selected concentration while every other drug is at zero. Bliss expected effect is:

```text
expected_effect = 1 - product(1 - single_agent_effect[k])
```

The interaction score is:

```text
bliss_interaction = observed_effect - expected_effect
```

A positive interaction means greater inhibition than predicted by Bliss independence; a negative interaction means less inhibition than predicted.

### Two-drug presentation

- Summary: total sum of all Bliss interaction values.
- Heatmap: one concentration grid with a diverging scale centered at zero.
- Bar plot: interactive three-dimensional observed percent-growth bars.
- Expected growth: a wireframe over each bar.
- Bar color: derived from the Bliss interaction at that concentration pair.

### Three-drug presentation

- Summary: Bliss sums grouped by the chosen stratifying drug concentration, followed by a total row.
- Heatmap: one two-drug heatmap facet for each concentration of the stratifying drug.
- Bar plot: summary bars for each stratum plus the total.

## Current UI appearance

The Shiny interface uses Bootstrap 5 with the Flatly theme and a compact desktop-oriented layout:

- Dark blue primary navigation and card accents.
- Light gray application background.
- Pmetrics logo in the navigation bar.
- Two main pages: **Import & map** and **Analyze**.
- Fixed-width sidebars for controls.
- Horizontally scrollable mapping table with sticky assignment and column-name headers.
- Small typography and dense data tables.
- Analysis tabs for Summary, Heatmap, Bar plot, and Processed data.
- Fixed red Exit button.

The Tauri implementation should retain the information density and recognizable two-stage workflow while making loading, validation, warning, and error states more explicit.

## Behavioral issues to resolve before porting

These decisions should be recorded in tests before implementing the Rust engine.

### 1. Inconsistent interpretation thresholds

The summary classifies a total Bliss sum as:

- Antagonistic when the sum is less than zero.
- Additive when the sum is between zero and one, inclusive.
- Synergistic when the sum is greater than one.

The two-drug three-dimensional plot instead describes individual scores from `-0.05` through `0.05` as additive. The heatmap uses a continuous scale centered at zero. A single interpretation policy should be defined for per-cell scores and a separate, explicitly justified policy should be defined for aggregate results.

### 2. Grid-size-sensitive aggregate summary

The summary adds every Bliss interaction score. Its magnitude therefore changes with the number of tested concentration combinations. A fixed threshold such as `> 1` is sensitive to checkerboard size.

Recommended approach: preserve `sum_bliss` for backward compatibility, but consider also reporting the mean interaction, the number of evaluated combinations, positive and negative interaction sums, and possibly a pre-specified active-region summary.

### 3. Missing scientific input validation

The new implementation should explicitly detect and report:

- No all-zero control rows.
- A zero, missing, or non-finite mean control OD.
- Missing single-agent rows required for a tested combination.
- Missing or non-finite concentrations or OD values.
- Incomplete checkerboard grids.
- Duplicate rows and how they will be treated as replicates.
- Replicate groups containing missing effects.
- Negative concentrations, if those are invalid for the domain.

### 4. Direct R API and Shiny import differences

The R6 implementation selects source headers matching `Concentration` and `Relative`. A response column named only `OD`, although described as valid in documentation, may not be selected when the class is used directly. The Shiny workflow avoids this by mapping and renaming the response to `RelativeOD`.

The new input model should not infer scientific roles solely from header patterns. Header matching should supply defaults, while the explicit user mapping remains authoritative.

### 5. Export does not exactly reflect the active view

- User-selected colors are not passed to the current exported plots.
- The two-drug interactive plot is omitted from Excel.
- The export layer generates temporary image files and then removes matching files from the shared R temporary directory.

The new export should use the active stratification and color configuration, use uniquely owned temporary resources, and explicitly decide whether a static snapshot of the two-drug plot belongs in the workbook.

### 6. Calculation and presentation are coupled

The R `summary()` method calculates data and prints a `flextable`. Plot methods both transform analysis data and render it. The Rust implementation should return presentation-neutral domain results, leaving tables and plots to the frontend or export adapter.

## Proposed Tauri architecture

Use Tauri 2 with a TypeScript/React frontend and a Rust analysis core. The frontend should own interaction and visualization; Rust should own parsing, validation, scientific calculation, preferences, and workbook creation.

```text
TypeScript/React webview
├── Import and range selection
├── Column mapping
├── Analysis workflow state
├── Summary and processed-data tables
├── Plotly heatmaps and three-dimensional plots
└── User-facing errors and warnings
                  │
                  │ typed Tauri commands
                  ▼
Rust application layer
├── Import services
├── Mapping validation
├── Bliss analysis core
├── Summary services
├── Preferences
└── Excel export
```

Suggested Rust layout:

```text
desktop/src-tauri/src/
├── commands/
│   ├── import.rs
│   ├── analysis.rs
│   ├── export.rs
│   └── preferences.rs
├── domain/
│   ├── assay.rs
│   ├── mapping.rs
│   └── results.rs
├── services/
│   ├── importer.rs
│   ├── validation.rs
│   ├── bliss.rs
│   ├── summary.rs
│   └── workbook.rs
├── error.rs
└── lib.rs
```

Prefer a separate Rust workspace crate for the scientific core:

```text
desktop/src-tauri/crates/checkerboard-core/
```

That crate should have no dependency on Tauri. This makes its calculations independently testable and leaves open the possibility of a future command-line interface or reuse in another application.

### Recommended technology choices

| Concern | Recommendation |
|---|---|
| Desktop shell | Tauri 2 |
| Frontend | TypeScript and React |
| Application commands | Tauri commands with Serde request and response types |
| CSV/TXT input | Rust `csv` crate with explicit delimiter handling |
| XLS/XLSX input | `calamine` |
| Error types | `thiserror` plus a serializable application error payload |
| Interactive plots | Plotly.js |
| Excel output | `rust_xlsxwriter` |
| Preferences | Tauri store plugin or a small Rust-owned JSON settings service |
| Frontend tests | Vitest and Testing Library |
| Rust tests | Standard unit and integration tests |
| Desktop end-to-end tests | Add after the main workflow stabilizes |

Only the file-dialog, approved file-read/write, application preference, and window capabilities needed by the main webview should be enabled.

## Domain model

Avoid sending loosely typed data frames across the Tauri boundary. Define explicit structures such as:

```text
ImportOptions
├── path
├── worksheet
├── start_row
├── start_column
├── row_limit
└── column_limit

ImportedTable
├── source metadata
├── headers
├── inferred column types
├── dimensions
└── preview rows

ColumnMapping
├── drug columns and display names
└── response column

AnalysisResult
├── drug names
├── processed combinations
├── control statistics
├── validation warnings
└── summary metadata
```

The result for each processed concentration combination should contain:

- Drug concentrations in stable order.
- Mean original and censored OD, plus the censored replicate count.
- Observed mean effect.
- Each required single-agent effect.
- Expected Bliss effect.
- Bliss interaction.
- Replicate count.
- Optional warning flags.

## Implementation plan

### Phase 1: Freeze the behavioral specification

1. Create representative two-drug and three-drug input fixtures.
2. Include replicated controls, replicated combinations, multiple concentration levels, and non-unit control OD.
3. Add invalid fixtures for missing controls, missing single-agent rows, nonnumeric values, non-finite values, and incomplete grids.
4. Export canonical processed results from R to machine-readable CSV or JSON.
5. Decide and document per-cell and aggregate interpretation thresholds.
6. Decide whether incomplete grids are rejected or represented with missing cells.
7. Decide which additional normalized summary statistics will accompany `sum_bliss`.

Deliverable: a language-neutral scientific specification and golden parity fixture set.

### Phase 2: Scaffold the desktop application

1. Create `desktop/` with a Tauri 2 and TypeScript/React application.
2. Establish frontend and Rust test runners.
3. Configure the minimum Tauri capabilities.
4. Reuse the existing logo and establish visual design tokens matching the Shiny application.
5. Create the Import & map and Analyze application shells.

Deliverable: an installable desktop shell with the intended navigation and layout.

### Phase 3: Implement Rust import and mapping

1. Add native file selection.
2. Parse CSV, tab-delimited text, comma-fallback text, XLS, and XLSX.
3. Return worksheet names for spreadsheet files.
4. Match the current start row, start column, row limit, and column limit semantics.
5. Return a 100-row preview without forcing the frontend to hold the entire source table.
6. Port default role and drug-name inference.
7. Validate unique role assignments and numeric conversion.

Deliverable: complete Import & map behavior without invoking R.

### Phase 4: Port the Bliss engine

1. Implement typed assay input and result structures.
2. Validate controls and required single-agent observations.
3. Normalize OD against the mean all-zero control.
4. Clip effect values and force controls to zero.
5. Average replicates and retain replicate counts.
6. Resolve single-agent effects.
7. Calculate expected effect and interaction for two or three drugs.
8. Compare Rust results against every R golden fixture using a documented floating-point tolerance.

Deliverable: an independently tested Rust scientific core with R parity.

### Phase 5: Build the analysis interface

1. Render the summary using presentation-neutral Rust results.
2. Add stratification controls for three-drug assays.
3. Add a symmetric, zero-centered interaction heatmap.
4. Add faceted heatmaps for three-drug analysis.
5. Add a virtualized processed-data table with filtering and consistent numeric formatting.
6. Add explicit empty, loading, validation, warning, and failure states.

Deliverable: summary, heatmap, and processed-data parity.

### Phase 6: Recreate the bar plots

1. Reproduce the two-drug observed percent-growth bars with Plotly.js.
2. Add expected-growth wireframes.
3. Preserve concentration labels, camera behavior, hover details, and control behavior.
4. Implement the three-drug stratified summary bar plot.
5. Centralize the color scale and interpretation bands so every view uses the same policy.

Deliverable: interactive visualization parity.

### Phase 7: Implement preferences and export

1. Persist plot color preferences in the application data directory.
2. Use a native save-file dialog.
3. Generate styled summary and processed-data worksheets in Rust.
4. Render plots to images in the frontend and pass owned image data to the Rust exporter.
5. Embed the active heatmap and summary plot in the workbook.
6. If approved, include a static two-drug three-dimensional plot snapshot.
7. Ensure export uses the visible stratification and plot colors.

Deliverable: deterministic Excel output reflecting the active analysis.

### Phase 8: Harden, package, and compare

1. Add unit tests for import, naming, validation, calculations, summaries, and workbook generation.
2. Add frontend component tests for mapping and analysis states.
3. Add end-to-end import, analyze, and export tests.
4. Test macOS and Windows behavior; add Linux if it is a supported target.
5. Test large datasets and add progress reporting or documented limits where necessary.
6. Configure icons, version metadata, signing, and installers.
7. Run R and Rust against the shared fixture corpus before declaring feature parity.

Deliverable: distributable builds backed by cross-language parity evidence.

## Recommended delivery sequence

The first vertical slice should deliberately be narrow:

1. Two-drug CSV import.
2. Column mapping and validation.
3. Rust Bliss calculation.
4. Summary and processed-data table.
5. Heatmap.
6. Excel import and three-drug analysis.
7. Interactive bar plots.
8. Workbook export and packaging.

This proves the scientific core early and leaves the most presentation-specific work until numerical parity is established.

## Preservation policy for the R package

During migration:

- Treat the R implementation as the behavioral reference, not as a dependency of the desktop application.
- Continue running the current R tests in CI.
- Add regression fixtures to R first when clarifying scientific behavior.
- Do not reorganize the existing R package merely to accommodate Tauri.
- Keep desktop dependencies entirely below `desktop/`.
- Exclude `desktop/`, `docs/`, and repository-level parity fixtures from `R CMD build` through `.Rbuildignore`.
- Do not retire the Shiny application until the Rust implementation passes the agreed parity suite and workbook export checks.

After parity, the R package can remain supported as a scripting and reproducibility interface even if the Tauri application becomes the primary interactive product.

## Immediate next decisions

Before scaffolding the desktop application, decide:

1. The authoritative additive, synergistic, and antagonistic thresholds for individual combinations.
2. The intended interpretation of aggregate Bliss sums.
3. Whether incomplete grids are errors or allowed with missing results.
4. Whether non-finite and missing replicate values invalidate a group or are omitted with a warning.
5. Whether the Excel export should include raw imported data in addition to processed results.
6. Whether a static image of the two-drug three-dimensional plot should be embedded in Excel.
7. Initial operating-system targets and signing requirements.

These choices affect the scientific contract and should be settled before implementation details make them expensive to change.
