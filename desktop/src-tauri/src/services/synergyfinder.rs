use std::io::Write;
use std::process::{Command, Stdio};

use checkerboard_core::{AnalysisPolicy, AnalysisResult, AssayInput};
use serde_json::json;

use crate::error::AppError;

const BRIDGE_SCRIPT: &str = include_str!("synergyfinder_bridge.R");

/// Development-only oracle backed by the installed SynergyFinder R package.
/// This module is excluded from release builds.
pub fn analyze_reference(
    input: &AssayInput,
    policy: AnalysisPolicy,
) -> Result<AnalysisResult, AppError> {
    let payload = serde_json::to_vec(&json!({
        "drugNames": input.drug_names,
        "rows": input.rows,
        "policy": policy,
    }))
    .map_err(|error| AppError::new("synergyFinderInputError", error.to_string()))?;

    let mut child = Command::new("Rscript")
        .args(["--vanilla", "-e", BRIDGE_SCRIPT])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            AppError::new(
                "rscriptUnavailable",
                format!("Could not start Rscript. Install R and synergyfinder 3.20.0, then retry: {error}"),
            )
        })?;
    child
        .stdin
        .take()
        .ok_or_else(|| AppError::new("synergyFinderBridgeError", "Rscript stdin was unavailable."))?
        .write_all(&payload)?;
    let output = child.wait_with_output()?;
    if !output.status.success() {
        return Err(AppError::new(
            "synergyFinderAnalysisError",
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    serde_json::from_slice(&output.stdout).map_err(|error| {
        AppError::new(
            "synergyFinderOutputError",
            format!(
                "Could not read the SynergyFinder result: {error}. R output: {}",
                String::from_utf8_lossy(&output.stdout).trim()
            ),
        )
    })
}

#[cfg(test)]
mod tests {
    use checkerboard_core::{
        AssayInput, BaselineCorrection, ColumnMapping, MappedDrug, ResponseType, assay_from_rows,
    };

    use super::*;

    #[test]
    fn installed_package_matches_the_pinned_replicate_fixture() {
        if Command::new("Rscript").arg("--version").output().is_err() {
            return;
        }
        let assay = fixture(include_str!("../../../../fixtures/valid/two_drug.csv"), 2);
        let policy = AnalysisPolicy {
            response_type: ResponseType::RawOd,
            ..AnalysisPolicy::default()
        };
        assert_parity(&assay, policy, 1e-10);
    }

    #[test]
    fn installed_package_matches_three_drug_bootstrap() {
        if Command::new("Rscript").arg("--version").output().is_err() {
            return;
        }
        let assay = fixture(include_str!("../../../../fixtures/valid/three_drug.csv"), 3);
        let policy = AnalysisPolicy {
            response_type: ResponseType::RawOd,
            bootstrap_iterations: 100,
            ..AnalysisPolicy::default()
        };
        assert_parity(&assay, policy, 1e-10);
    }

    #[test]
    fn installed_package_benchmarks_native_baseline_corrections() {
        if Command::new("Rscript").arg("--version").output().is_err() {
            return;
        }
        let assay = fixture(include_str!("../../../../fixtures/valid/two_drug.csv"), 2);
        for baseline_correction in [BaselineCorrection::Part, BaselineCorrection::All] {
            let policy = AnalysisPolicy {
                response_type: ResponseType::RawOd,
                baseline_correction,
                bootstrap_iterations: 20,
                ..AnalysisPolicy::default()
            };
            assert_parity(&assay, policy, 1e-4);
        }
    }

    #[test]
    fn installed_package_matches_unreplicated_t_test() {
        if Command::new("Rscript").arg("--version").output().is_err() {
            return;
        }
        let assay = fixture(
            "A,B,viability\n0,0,100\n0,1,80\n0,2,60\n1,0,70\n1,1,40\n1,2,25\n2,0,50\n2,1,20\n2,2,10\n",
            2,
        );
        let policy = AnalysisPolicy {
            response_type: ResponseType::Viability,
            ..AnalysisPolicy::default()
        };
        assert_parity(&assay, policy, 1e-10);
    }

    fn fixture(csv: &str, drug_count: usize) -> AssayInput {
        let mut reader = csv::Reader::from_reader(csv.as_bytes());
        let rows = reader
            .records()
            .map(|record| {
                record
                    .unwrap()
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        assay_from_rows(
            &rows,
            &ColumnMapping {
                drugs: (0..drug_count)
                    .map(|column| MappedDrug {
                        column,
                        name: format!("Drug {}", column + 1),
                    })
                    .collect(),
                response_column: drug_count,
            },
        )
        .unwrap()
    }

    fn assert_parity(assay: &AssayInput, policy: AnalysisPolicy, tolerance: f64) {
        let reference = analyze_reference(&assay, policy).unwrap();
        let native = checkerboard_core::analyze(&assay, policy).unwrap();
        assert!(
            (reference.summary.mean_bliss - native.summary.mean_bliss).abs() < tolerance,
            "reference {}, native {}",
            reference.summary.mean_bliss,
            native.summary.mean_bliss,
        );
        assert_eq!(
            reference.summary.combination_count,
            native.summary.combination_count
        );
        assert_eq!(reference.summary.p_value, native.summary.p_value);
        for expected in reference.processed {
            let actual = native
                .processed
                .iter()
                .find(|row| row.concentrations == expected.concentrations)
                .unwrap();
            assert!((expected.bliss_interaction - actual.bliss_interaction).abs() < tolerance);
            assert!((expected.bliss_expected - actual.bliss_expected).abs() < tolerance);
            for (label, expected_value, actual_value) in [
                ("SEM", expected.bliss_sem, actual.bliss_sem),
                ("CI left", expected.bliss_ci_left, actual.bliss_ci_left),
                ("CI right", expected.bliss_ci_right, actual.bliss_ci_right),
            ] {
                match (expected_value, actual_value) {
                    (Some(reference_value), Some(native_value)) => assert!(
                        (reference_value - native_value).abs() < tolerance,
                        "{label} differs at {:?}: reference {reference_value}, native {native_value}",
                        expected.concentrations,
                    ),
                    (None, None) => {}
                    values => panic!("{label} availability differs: {values:?}"),
                }
            }
        }
    }
}
