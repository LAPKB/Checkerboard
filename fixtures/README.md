# Checkerboard parity fixtures

These fixtures define the compatibility boundary between the preserved R
package and the new Rust analysis core.

## Provisional behavior policy

- The Bliss calculation must match the current R implementation within an
  absolute tolerance of `1e-12`.
- Individual interactions in `[-0.05, 0.05]` are described as additive-like,
  matching the current two-drug bar-plot legend.
- The desktop analysis policy has a user-configurable OD censor threshold,
  defaulting to `0.05`. Negative blank-adjusted OD values and OD values
  satisfying `abs(OD) < threshold` are analyzed as exactly zero. Original OD
  values are retained for display and export.
- The legacy aggregate interpretation is preserved: a Bliss sum below zero is
  antagonistic, a sum above one is synergistic, and other sums are additive.
- Incomplete concentration grids are accepted with a warning when every
  analyzed row still has its required single-agent observations.
- Missing controls, non-positive censored control means, missing single-agent
  observations, non-finite values, and negative concentrations are errors in
  the Rust application. Negative OD values are valid inputs and are censored.
- Duplicate concentration combinations are replicates and are averaged after
  normalization, matching the R implementation.

The policies above are intentionally centralized in the Rust analysis policy
so they can be revised without changing import or presentation code.

## Contents

- `valid/two_drug.csv`: complete 3 by 3 checkerboard with replicated controls
  and a replicated combination.
- `valid/three_drug.csv`: complete 2 by 2 by 2 checkerboard.
- `invalid/missing_control.csv`: has no all-zero control.
- `invalid/missing_single_agent.csv`: contains a combination without the
  corresponding Drug B single-agent observation.
- `invalid/nonnumeric.csv`: contains a nonnumeric OD value.
- `valid/incomplete_grid.csv`: intentionally incomplete but analyzable; it
  should produce a warning rather than an error.
- `reported/sample.xlsx`: user-reported workbook containing negative and
  near-zero OD values; it guards the import and censoring behavior.
