# Checkerboard desktop

This directory contains the Tauri 2 migration of the Checkerboard Bliss Shiny
application. The R package remains at the repository root and is the reference
implementation during migration.

## Current vertical slice

- CSV, TXT, XLS, and XLSX range import in Rust.
- Worksheet discovery for Excel files.
- Column-role suggestions and explicit mapping.
- Tauri-independent two- and three-drug Bliss analysis.
- Validation for controls, numeric input, concentrations, OD, and required
  single-agent observations.
- Replicate averaging and incomplete-grid warnings.
- User-configurable censoring of blank-adjusted OD values before analysis:
  negative values and values whose absolute magnitude is below the threshold
  are analyzed as zero, while their original values remain available.
- Original/censored OD display toggle with visual highlighting of censored
  values.
- Summary metrics, stratified three-drug summaries, heatmaps, and processed
  result tables.
- Lazy-loaded Plotly three-dimensional growth bars with expected-growth
  wireframes for two-drug assays.
- Plotly stratified summary bars for three-drug assays.
- Plot color persistence in the Tauri application store.
- Native save dialog and Rust-generated XLSX summary/processed-data export.
- In-memory comparison cohorts for two- or three-drug regimens, with relative-dose
  coordinate matching, pairwise probabilities of superiority, average-win ranking,
  synergy breadth, antagonism burden, and an observed-effect filter.
- Shared R/Rust parity fixtures under `../fixtures/`.

Embedding static plot images in exported workbooks, installer signing, and
desktop end-to-end automation remain later migration phases.

## Commands

```sh
npm install
npm test
npm run build
npm run tauri dev
```

Rust tests are run from `src-tauri/`:

```sh
cargo test --workspace
```

## Boundaries

The `checkerboard-core` crate contains presentation-independent scientific
logic and does not depend on Tauri. Tauri commands re-read the selected source
range for analysis so the frontend only receives the 100-row preview rather
than retaining the entire input table.
