# Checkerboard desktop developer guide

This guide explains the structure of the Checkerboard repository for a developer who already understands R packages but is new to Rust, React, npm, and Tauri.

The most important fact is that there are currently **two applications in this repository**:

1. The actively developed, self-contained Tauri desktop application is under `desktop/`.
2. The root-level R/Shiny package is the older implementation and a development reference. It is not the production runtime for the desktop application.

Unless a task explicitly concerns the R package, begin in `desktop/`.

## 1. Mental model

The desktop application has three layers:

```text
┌──────────────────────────────────────────────────────────────────┐
│ React + TypeScript frontend                                     │
│ desktop/src/                                                    │
│                                                                  │
│ Tabs, forms, tables, plots, state, and comparison presentation  │
└──────────────────────────────┬───────────────────────────────────┘
                               │ Tauri IPC: invoke("command", data)
                               │ and progress events
┌──────────────────────────────▼───────────────────────────────────┐
│ Tauri Rust application boundary                                 │
│ desktop/src-tauri/src/                                          │
│                                                                  │
│ File dialogs, import, request validation, commands, XLSX export │
└──────────────────────────────┬───────────────────────────────────┘
                               │ ordinary Rust function calls
┌──────────────────────────────▼───────────────────────────────────┐
│ Presentation-independent scientific core                        │
│ desktop/src-tauri/crates/checkerboard-core/                     │
│                                                                  │
│ Bliss calculation, baseline correction, bootstrap, statistics  │
└──────────────────────────────────────────────────────────────────┘
```

This separation is deliberate:

- React should decide what is shown and manage user interaction, but should not reimplement Bliss calculations.
- Tauri commands should be a thin, carefully validated boundary between untrusted UI/file input and Rust.
- `checkerboard-core` should be usable and testable without a window, browser, Tauri, or R installation.

An R analogy is:

| Checkerboard component | Rough R analogy |
|---|---|
| React components | Shiny UI plus reactive presentation logic |
| TypeScript interfaces | Documented S3/R6 object shapes, but checked before execution |
| Tauri commands | Shiny server endpoints or an API layer |
| `checkerboard-core` | The package's reusable functions under `R/` |
| Cargo crate | An R package |
| Cargo workspace | A repository containing related R packages |
| `Cargo.toml` | `DESCRIPTION` plus compilation/dependency configuration |
| `Cargo.lock` | A project-level `renv.lock` |
| Rust unit/integration tests | `testthat` tests |
| Vitest | `testthat` for the TypeScript layer |

## 2. What Tauri is doing

Tauri packages a web user interface inside an operating-system webview and runs a compiled Rust process behind it. The React code is therefore the visible interface, while Rust owns native and scientific operations.

This is different from simply placing a website on a server:

- The app runs locally.
- Rust can read selected files, open native dialogs, write workbooks, and quit the process.
- React cannot call arbitrary Rust functions. A Rust function must be registered as a Tauri command, and the frontend calls it through Tauri's inter-process communication layer.
- Tauri capabilities explicitly limit which native plugin operations the window may request.
- The release bundle contains compiled Rust and built frontend assets. End users do not need npm, Node.js, R, Bioconductor, or a Rust toolchain.

For example, importing a file follows this path:

```text
React button
  → native file dialog plugin
  → invoke("import_preview", request)
  → commands.rs validates and coordinates the request
  → services/importer.rs reads CSV or Excel data
  → serialized ImportPreview returns to React
  → App.tsx updates the visible mapping table
```

Analysis follows a similar path, except `commands.rs` constructs an `AssayInput` and calls `checkerboard-core` on a background task. Progress events return to React while the bootstrap runs.

## 3. What npm is

**npm** is the Node Package Manager. In this project it has three jobs:

1. Install the JavaScript/TypeScript tools and libraries listed in `desktop/package.json`.
2. Record their resolved versions in `desktop/package-lock.json`.
3. Provide named commands, called scripts, for development, tests, and builds.

It is closest to a combination of `install.packages()`, `renv`, and a small `Makefile`.

### `package.json` and `package-lock.json`

`package.json` is human-edited. It contains:

- Project identity and version.
- `dependencies`, which are libraries used by application code, such as React, Plotly, and the Tauri JavaScript APIs.
- `devDependencies`, which are development/build tools, such as TypeScript, Vite, Vitest, and the Tauri CLI.
- `scripts`, which give stable names to command sequences.

`package-lock.json` is generated by npm and pins the full dependency graph, including transitive dependencies. Commit it. Do not hand-edit it. It makes a clean installation resolve the same package versions on another machine.

The leading caret in a version such as `^19.1.0` allows compatible updates when resolving dependencies. The lock file records the exact version actually selected.

### `npm install`, `npm ci`, `npm run`, and `npx`

Run npm commands from `desktop/`:

```sh
cd desktop
npm install
```

`npm install` resolves dependencies, updates the lock file when necessary, and creates `node_modules/`. For a clean reproducible installation when the lock file must remain unchanged, use:

```sh
npm ci
```

`npm run NAME` looks up `NAME` in the `scripts` section of `package.json`. It also temporarily places `node_modules/.bin` on `PATH`, so scripts use the project-pinned tool rather than an unrelated global installation.

For example:

```sh
npm test              # script: vitest run
npm run test:rust     # script: cargo test ... --workspace
npm run test:all      # frontend tests, then Rust tests
npm run build         # all tests, TypeScript check, then Vite frontend build
npm run tauri dev     # Tauri CLI development application
npm run tauri build   # compile and package the release application
```

`npx tsc --noEmit` runs the locally installed TypeScript compiler directly. `npx` is useful for invoking a package executable that does not need its own named npm script.

### npm is not the Rust package manager

Rust uses **Cargo**, not npm:

- npm reads `package.json`; Cargo reads `Cargo.toml`.
- npm installs into `node_modules/`; Cargo downloads crates into its cache and builds into `target/`.
- npm uses `package-lock.json`; Cargo uses `Cargo.lock`.
- `npm test` runs Vitest; `cargo test` compiles and runs Rust tests.

The Tauri CLI connects the two build systems. `npm run tauri dev` starts Vite for the frontend and Cargo for the Rust host. `npm run tauri build` first builds the frontend according to `tauri.conf.json`, then compiles and bundles the native application.

## 4. Active `desktop/` files

### Frontend configuration

| File | Purpose and contents |
|---|---|
| `desktop/package.json` | npm manifest. Defines React/Plotly/Tauri dependencies, TypeScript/Vite/Vitest build tools, version `0.7.0`, and the named npm scripts. `private: true` prevents accidentally publishing this application as a public npm library. `type: module` selects modern JavaScript ES modules. |
| `desktop/package-lock.json` | npm-generated exact dependency graph. Comparable to `renv.lock`; commit it but do not manually edit it. |
| `desktop/index.html` | Minimal HTML shell loaded by Vite. It supplies `<div id="root">`; `src/main.tsx` mounts React into that element. Most visible UI is not written here. The title and favicon entries are remnants of the original scaffold; the native window title comes from `tauri.conf.json`. |
| `desktop/vite.config.ts` | Vite development/build configuration. Enables React transformation, fixes the development server at port 1420 for Tauri, configures hot-module replacement, and tells Vite not to watch Rust files. |
| `desktop/tsconfig.json` | TypeScript rules for frontend source. Enables strict checking, React JSX, browser APIs, ES2020 output assumptions, unused-variable checks, and `noEmit` because Vite performs the actual bundling. |
| `desktop/tsconfig.node.json` | Separate TypeScript settings for Node-executed configuration code, currently `vite.config.ts`. Browser UI and build configuration run in different environments, hence the separate config. |
| `desktop/.gitignore` | Excludes generated JavaScript artifacts such as `node_modules/` and `dist/`, logs, editor state, and local-only files. |
| `desktop/.vscode/extensions.json` | Recommends editor extensions useful for this project. It affects developer tooling, not the application. |
| `desktop/README.md` | Short project overview, boundaries, supported features, and common commands. The more detailed architectural explanation is in this guide. |

### React and TypeScript source: `desktop/src/`

`src` conventionally means hand-written source code. TypeScript files end in `.ts`; files containing JSX/React markup end in `.tsx`.

| File | Purpose and contents |
|---|---|
| `src/main.tsx` | Frontend entry point. Finds the HTML element named `root`, creates the React root, and renders `<App />` under React strict mode. This plays a role similar to the top-level call that launches a Shiny UI. |
| `src/App.tsx` | Main UI and application-state coordinator. It contains the Import → MIC → Analyze → Results → Compare workflow, Tauri command calls, progress listeners, regimen navigation, instructions dialog, result panels, heatmaps, comparison tables, and many small presentation components. It is intentionally responsible for state and display, not the native Bliss algorithm. |
| `src/App.css` | Global stylesheet for `App.tsx` and the main workspaces: navigation, forms, tables, dialogs, heatmaps, comparison UI, responsive constraints, and instructions-window previews. CSS class names such as `.comparison-card` are referenced by JSX through `className`. |
| `src/BarPlot.tsx` | Plotly-based visualizations. It renders two-drug growth bars and three-drug stratified interaction bars, including colors and optional confidence-interval error bars. It is lazy-loaded from `App.tsx` so Plotly's large bundle is not required for the first UI render. |
| `src/types.ts` | Shared frontend contracts: column roles, import requests/previews, analysis policies/results, processed combinations, MIC estimates, and comparison structures. These shapes must remain aligned with the Rust structures serialized through Tauri. This resembles keeping the definition and documentation of an R object consistent across all producers and consumers, except TypeScript checks it during development. |
| `src/analysis.ts` | Pure frontend helpers. It validates column-role assignments, builds mappings, formats results, aggregates displayed Bliss values, handles clinical-window display logic and stratification choices, and calculates comparison/ranking presentation data. It should not become a second implementation of the native Bliss surface calculation. |
| `src/preferences.ts` | Loads and saves user-selected plot colors with the Tauri store plugin and defines default colors. |
| `src/analysis.test.ts` | Vitest unit and regression tests for mapping helpers, formatting, clinical windows, comparison matching, exceedance AUC, sorting inputs, and related pure TypeScript logic. The `.test.ts` suffix lets Vitest discover it automatically. |
| `src/synthetic-checkerboards.test.ts` | Generated two- and three-drug frontend comparison regressions covering additive, synergistic, and antagonistic surfaces. |
| `src/vite-env.d.ts` | Type declaration reference supplied by Vite. It teaches TypeScript about Vite-specific browser types; it produces no runtime code. |
| `src/assets/logo.png` | Logo imported by React and bundled by Vite. An imported asset receives a hashed filename in the production `dist/` directory. |

### Tauri configuration: `desktop/src-tauri/`

`src-tauri` is the standard Tauri directory name. Tauri tooling expects native source and configuration here, keeping it separate from the web frontend.

| File or directory | Purpose and contents |
|---|---|
| `src-tauri/Cargo.toml` | Cargo manifest for the native application crate and root of the Cargo workspace. It defines package metadata, output library types, Tauri plugins, import/export libraries, serialization/error dependencies, and the local dependency on `checkerboard-core`. |
| `src-tauri/Cargo.lock` | Cargo-generated exact Rust dependency graph. Commit it for an application. It is the Rust counterpart of `package-lock.json` or `renv.lock`. |
| `src-tauri/build.rs` | Cargo build script. It calls `tauri_build::build()` so Tauri can generate and embed platform/configuration information while compiling. Cargo automatically recognizes the name `build.rs`. |
| `src-tauri/tauri.conf.json` | Tauri application configuration: product name, application identifier, version, window and minimum size, content-security policy, frontend development URL, frontend build command/output, bundle targets, and desktop icons. This is packaging/runtime configuration rather than scientific code. |
| `src-tauri/capabilities/default.json` | Tauri 2 permission policy for the main window. It permits the core defaults plus open/save dialogs, persistent store access, and opener functionality. Adding a plugin dependency alone is not always enough; its capability may also need to be allowed here. |
| `src-tauri/.gitignore` | Excludes Cargo's compiled `target/` tree and Tauri-generated capability schemas under `gen/`. |
| `src-tauri/icons/` | Platform-specific application icons used during packaging. `icon.icns` is for macOS, `icon.ico` for Windows, numbered square PNGs for Windows packaging, and the Android/iOS subdirectories contain mobile launcher/icon variants. They are generated variants of the same visual identity rather than separate code files. |

### Tauri Rust source: `desktop/src-tauri/src/`

Rust source files end in `.rs`. A directory forms a module hierarchy. `mod commands;` in `lib.rs` tells Rust to compile `commands.rs`; `mod services;` leads to `services/mod.rs`, which declares its child modules.

| File | Purpose and contents |
|---|---|
| `src/main.rs` | Native binary entry point. It suppresses an extra Windows console in release builds and calls `checkerboard_desktop_lib::run()`. Keeping it tiny makes the app wiring reusable across desktop/mobile build forms. |
| `src/lib.rs` | Tauri application wiring. Registers dialog/store/opener plugins and exposes the Rust functions that JavaScript may invoke: worksheet listing, preview import, MIC inference, table analysis, export, and quit. If a command is implemented but omitted from `generate_handler!`, the frontend cannot call it. |
| `src/commands.rs` | Tauri command boundary and orchestration. Defines serialized request/response structures, imports previews, discovers multiple regimens, suggests mappings and response types, validates units/responses, infers MICs, invokes the scientific core, reports bootstrap progress, exports results, and contains command-boundary tests. It translates file/UI concepts into `checkerboard-core` inputs. |
| `src/error.rs` | Serializable application error type with a stable `code` and human-readable `message`. It converts I/O and core analysis errors into values React can display instead of allowing a Rust panic to cross the boundary. |
| `src/services/mod.rs` | Declares the `importer`, `synergyfinder`, and `workbook` service modules. `mod.rs` is the conventional file representing a directory module. |
| `src/services/importer.rs` | Reads CSV, TXT, XLS, and XLSX files; lists workbook sheets; selects a requested row/column range; makes duplicate headings unique; and validates extensions/range requests. It handles file representation, not assay interpretation. |
| `src/services/workbook.rs` | Creates native XLSX exports with summary, policy, confidence interval, MIC, and processed-combination information. It also sanitizes worksheet names and tests the generated workbook. |
| `src/services/synergyfinder.rs` | Development-only reference bridge used by parity tests when the pinned R/Bioconductor environment is available. Production analysis does not call this service. |
| `src/services/synergyfinder_bridge.R` | R script embedded into the test bridge with `include_str!`. It invokes Bioconductor `synergyfinder` as an optional oracle for native-versus-R regression tests. It is not shipped as an R runtime dependency and must never become the production analysis path. |

## 5. The independent Rust scientific crate

`desktop/src-tauri/crates/checkerboard-core/` is a second Rust **crate** inside the same Cargo **workspace**.

In Cargo terminology:

- A **package** is described by one `Cargo.toml`.
- A **crate** is a compiled Rust library or binary target.
- A **workspace** coordinates related packages, shares one lock file and `target/` directory, and lets `cargo test --workspace` test all members.

The folder is named `checkerboard-core` because it contains the core domain logic, not because `core` is a special Rust keyword. The hyphenated Cargo package name is imported in Rust code as `checkerboard_core`, because Rust identifiers use underscores.

| File | Purpose and contents |
|---|---|
| `checkerboard-core/Cargo.toml` | Manifest for the scientific library. It deliberately has very few dependencies: Serde for serialization and `thiserror` for typed errors; CSV/JSON appear only as test dependencies. It does not depend on Tauri. |
| `checkerboard-core/src/lib.rs` | Public scientific API and domain types: assay rows, mappings, policies, results, warnings, interpretations, validation errors, mapping/parsing, main analysis entry points, stratified summaries, interpretations, and unit/regression tests. Types or functions marked `pub` may be used by other crates. Private helpers remain implementation details. |
| `checkerboard-core/src/synergyfinder_native.rs` | Native SynergyFinder-compatible engine. It builds Bliss surfaces, fits single-agent log-logistic baselines, applies Part/All correction, performs seeded parametric bootstrap sampling, calculates confidence intervals and p values, and implements the compatible random-number generator/statistical helpers. `pub(super)` exposes its entry point only to its parent `lib.rs`, not to arbitrary consumers. |
| `checkerboard-core/tests/synthetic_checkerboards.rs` | Cargo integration tests. Files under a crate-level `tests/` directory compile as external consumers of the public API, which verifies that the public crate interface can recover known two- and three-drug interaction classes. |

Why split out the core rather than putting everything in `commands.rs`?

- It prevents UI concerns from changing the scientific implementation.
- It can be tested without launching Tauri.
- It avoids a production dependency on R.
- A future CLI, server, or another GUI could call the same library.
- Cargo enforces the dependency direction: the Tauri crate depends on the core, while the core knows nothing about Tauri.

## 6. Important Rust conventions visible here

### `main.rs`, `lib.rs`, and `mod.rs`

Cargo recognizes conventional target names:

- `src/main.rs` defines an executable (binary crate).
- `src/lib.rs` defines a reusable library crate.
- `mod.rs` represents a module directory and declares child files.

The Tauri package has both a tiny binary and a library. Its `[lib]` configuration names the library `checkerboard_desktop_lib`; `main.rs` calls that library. `checkerboard-core` is library-only.

### Visibility

Rust items are private unless marked otherwise:

- `fn helper()` is private to its module.
- `pub fn analyze()` is publicly callable.
- `pub(super) fn analyze()` is visible only to the parent module.

This gives more explicit boundaries than ordinary R functions, although the conceptual distinction resembles exported versus unexported functions in `NAMESPACE`.

### Data and errors

- `struct` defines a named data shape, roughly like a strongly specified list or S3 record.
- `enum` defines one of a fixed set of variants, such as `BaselineCorrection::{None, Part, All}`.
- `Option<T>` means a value may be present (`Some`) or absent (`None`), rather than using `NULL` or `NA` ambiguously.
- `Result<T, E>` means success returns `Ok(T)` and failure returns `Err(E)`. The `?` operator returns an error to the caller early.
- `serde` converts Rust structures to/from the JSON-like data sent over Tauri IPC.
- `#[serde(rename_all = "camelCase")]` lets idiomatic Rust `snake_case` fields appear as idiomatic TypeScript `camelCase` fields.
- `thiserror` derives readable error messages for typed Rust errors.

### Tests

Rust supports several test locations:

- `#[cfg(test)] mod tests` inside a source file contains unit tests that may exercise private helpers.
- `checkerboard-core/tests/*.rs` contains integration tests that see only the public crate interface.
- `cargo test --workspace` tests both Cargo packages and all these test forms.

## 7. Naming and folder conventions

| Pattern | Meaning |
|---|---|
| `src/` | Hand-written source for the current package/crate. |
| `src-tauri/` | Conventional Tauri native application directory. |
| `crates/` | Repository-local Rust packages used by the parent workspace. Cargo does not require this name, but it is a common convention. |
| `tests/` in a Rust crate | Integration tests compiled separately from the library. |
| `*.test.ts` | Vitest-discovered TypeScript tests colocated with frontend code. |
| `lib.rs` | Library root. |
| `main.rs` | Executable root. |
| `mod.rs` | Module directory root/declarations. |
| `build.rs` | Cargo build-time script, recognized automatically. |
| `Cargo.toml` | Human-edited Rust manifest. “TOML” is the configuration syntax. |
| `Cargo.lock` | Generated exact Rust dependency resolution. |
| `package.json` | Human-edited npm manifest and scripts. |
| `package-lock.json` | Generated exact npm dependency resolution. |
| `PascalCase` | React component names and TypeScript interfaces, for example `AnalysisResult`. |
| `camelCase` | TypeScript variables, functions, and serialized IPC fields. |
| `snake_case` | Rust functions, variables, modules, and source filenames. |
| `SCREAMING_SNAKE_CASE` | Rust constants. |
| `kebab-case` | Package names such as `checkerboard-core`; imported by Rust as `checkerboard_core`. |

## 8. Fixtures and regression data

`fixtures/` contains pinned assay inputs used to protect scientific behavior. These are data, not application instructions.

| File | Purpose |
|---|---|
| `fixtures/README.md` | Documents the benchmark policy and each original fixture. Some descriptions cover retained legacy behavior; current product behavior is governed by the code and regression tests. |
| `fixtures/valid/two_drug.csv` | Complete replicated two-drug checkerboard regression input. |
| `fixtures/valid/three_drug.csv` | Complete three-drug checkerboard regression input. |
| `fixtures/valid/incomplete_grid.csv` | Intentionally incomplete but analyzable input, expected to warn. |
| `fixtures/valid/multiple_regimens.csv` | Multiple-regimen input used to test automatic regimen discovery and clinical-window filtering. |
| `fixtures/invalid/missing_control.csv` | Expected failure: no all-zero control. |
| `fixtures/invalid/missing_single_agent.csv` | Expected failure: a combination lacks a required single-agent coordinate. |
| `fixtures/invalid/nonnumeric.csv` | Expected failure: nonnumeric response. |
| `fixtures/reported/sample.xlsx` | Reported workbook retained as a regression case for spreadsheet import and unusual response values. |

When scientific behavior changes, add or update a pinned fixture/regression rather than relying only on manual UI testing.

## 9. Root-level R/Shiny package and supporting files

These files remain useful for historical behavior, development comparison, or the legacy app, but they are not the release desktop runtime.

| File or directory | Purpose |
|---|---|
| `DESCRIPTION` | R package metadata and R dependencies. This is the closest R equivalent to a combination of `package.json` and `Cargo.toml`. |
| `NAMESPACE` | R exports generated by roxygen2. It exports `bliss`, `export`, and `run_checkerboard_app`. |
| `Checkerboard.Rproj` | RStudio project configuration. |
| `R/bliss.R` | Legacy R Bliss implementation. |
| `R/export.R` | Legacy R export behavior. |
| `R/shiny_app.R` | Legacy Shiny application implementation. |
| `R/logic.Rmd` | Historical literate analysis/development material. |
| `R/.gitignore` | R-subdirectory ignore rules. |
| `app.R` | Legacy Shiny launch entry point. |
| `man/*.Rd` | Generated R help pages for the exported R functions. |
| `inst/www/logo.png` | Logo installed with the R package for its Shiny/static assets. It is separate from the frontend-bundled desktop logo. |
| `tests/testthat.R` | Standard `testthat` entry point for the R package. |
| `tests/testthat/test-bliss-display.R` | Legacy R display/Bliss tests. |
| `tests/testthat/test-shiny-app.R` | Legacy Shiny tests. |
| `tests/test.r` | Ad hoc or historical development test script; it is not a Vitest or Cargo test. |
| `tests/test3_combined.csv` | Uploaded multi-regimen test dataset used to reproduce import/analysis behavior. |
| `Builds/Checkerboard_0.1.tar.gz` | Previously built R source-package archive, not source code. |
| `.Rbuildignore` | Prevents desktop, development, documentation, fixtures, and editor files from entering an R package tarball. |
| `.gitignore` | Root repository ignore rules, including RStudio state. |
| `.DS_Store` | macOS Finder metadata; not application source and normally ignored. |

## 10. Documentation, development metadata, and agent guidance

| File or directory | Purpose |
|---|---|
| `AGENTS.md` | Repository-specific engineering instructions for coding agents: active product boundary, architecture, scientific invariants, editing rules, and required validation. It is developer guidance, not runtime configuration. |
| `docs/tauri-migration-plan.md` | Original migration plan from R/Shiny to Tauri. Useful historical design context. |
| `docs/tauri-migration-plan.html` | Rendered copy of the migration plan. |
| `docs/tauri-migration-plan_files/` | Generated Bootstrap/Quarto JavaScript, CSS, fonts, and accessibility assets required by the rendered HTML plan. They are documentation dependencies, not desktop application dependencies. |
| `docs/checkerboard-tauri-developer-guide.md` | This guide. |
| `dev/config_attachment.yaml` | Development/tool attachment metadata; not used by the production Tauri runtime. |
| `.vscode/settings.json` | Repository-local Visual Studio Code settings. |

## 11. Generated directories you will see locally

These directories are important during development but should not be manually edited or committed:

| Directory | Created by | Contents |
|---|---|---|
| `desktop/node_modules/` | `npm install` or `npm ci` | Installed JavaScript packages and command-line tools. Delete and reinstall if dependency installation is corrupted. |
| `desktop/dist/` | `npm run build` / Vite | Minified production HTML, CSS, JavaScript chunks, and hashed assets. Tauri embeds these files. |
| `desktop/src-tauri/target/` | Cargo | Compiled Rust libraries, executables, incremental caches, test binaries, and release bundles. This can become large. |
| `desktop/src-tauri/gen/` | Tauri tooling | Generated schemas used for capability/configuration completion. |
| `.Rproj.user/` | RStudio | Local editor/session metadata for the R project. |

The source of truth is the source/configuration plus lock files—not `dist/`, `target/`, or `node_modules/`.

## 12. Development and validation workflows

### First setup

The development machine needs Node.js/npm and Rust/Cargo. End users do not.

```sh
cd desktop
npm ci
```

The Tauri platform prerequisites must also be installed for the operating system. On macOS, Tauri uses the system webview and Apple build tools.

### Work only on frontend behavior

```sh
cd desktop
npm run dev
```

This starts the UI in a normal browser through Vite. Tauri-only calls such as native dialogs may not work outside the Tauri host, but pure layout and many presentation changes can be inspected quickly.

### Run the actual desktop application

```sh
cd desktop
npm run tauri dev
```

This starts Vite, compiles the Rust debug application, opens the Tauri window, and reloads frontend edits. Rust edits trigger recompilation.

### Test

```sh
cd desktop
npm test
npm run test:rust
npm run test:all
```

Or run Rust tests directly from their package area:

```sh
cd desktop/src-tauri
cargo test --workspace
```

The native-versus-R tests use an installed `synergyfinder` only as an optional development oracle. Missing R must not prevent normal use of the application.

### Type-check and build frontend assets

```sh
cd desktop
npx tsc --noEmit
npm run build
```

In this repository, `npm run build` deliberately runs all frontend and Rust tests before compiling the frontend. It creates `desktop/dist/`; it does **not by itself** produce a DMG or installer.

### Build the distributable application

```sh
cd desktop
npm run tauri build
```

This is the packaging command. It invokes the configured frontend build, compiles optimized Rust, and asks Tauri to create platform bundles. A successful `.app` bundle does not necessarily mean a DMG also succeeded; report packaging outputs separately.

## 13. Where a change should go

| Desired change | Primary location |
|---|---|
| Tab, form, button, dialog, table, or UI state | `desktop/src/App.tsx` and `App.css` |
| Plotly rendering | `desktop/src/BarPlot.tsx` |
| Shared frontend request/result shape | `desktop/src/types.ts`, plus matching Rust structures |
| Pure comparison/display helper | `desktop/src/analysis.ts` with a Vitest regression |
| Persistent user display preference | `desktop/src/preferences.ts` |
| CSV/Excel reading or range selection | `desktop/src-tauri/src/services/importer.rs` |
| Tauri request validation or multi-regimen orchestration | `desktop/src-tauri/src/commands.rs` |
| Workbook export | `desktop/src-tauri/src/services/workbook.rs` |
| Bliss, bootstrap, baseline correction, statistics | `desktop/src-tauri/crates/checkerboard-core/` with a pinned Rust regression |
| Window, bundle, CSP, icons, product identifier | `desktop/src-tauri/tauri.conf.json` and related icon/capability files |
| New native plugin permission | Rust/JavaScript dependencies, `src/lib.rs`, and `capabilities/default.json` as applicable |

For a change that crosses the frontend/native boundary, update both sides together. A new field normally requires:

1. A TypeScript field in `src/types.ts`.
2. A matching Serde-enabled Rust field in `commands.rs` or `checkerboard-core`.
3. State and display changes in `App.tsx`.
4. Tests on the side that owns the behavior, often both sides.

## 14. A practical reading order

For a first pass through the application, read files in this order:

1. `desktop/package.json` — learn the available commands and major frontend dependencies.
2. `desktop/src-tauri/tauri.conf.json` — see how the web and native builds are joined.
3. `desktop/src/main.tsx` — see where React starts.
4. `desktop/src/types.ts` — learn the data moving through the app.
5. The first portion of `desktop/src/App.tsx` — follow state and the import/analyze command calls.
6. `desktop/src-tauri/src/lib.rs` — see which Rust commands are exposed.
7. The public command functions near the top of `desktop/src-tauri/src/commands.rs`.
8. `desktop/src-tauri/crates/checkerboard-core/src/lib.rs` — learn the scientific API and invariants.
9. `synergyfinder_native.rs` — study the detailed numerical implementation only after understanding the public API.
10. The frontend and Rust tests — tests often provide the clearest executable examples of expected behavior.

That reading path follows one request from the screen, across the Tauri boundary, into the scientific core, and back again without beginning in the most mathematically dense file.
