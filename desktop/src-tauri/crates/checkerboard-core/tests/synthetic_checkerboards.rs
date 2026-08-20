use checkerboard_core::{
    AggregateInterpretation, AnalysisPolicy, AssayInput, AssayRow, InteractionInterpretation,
    analyze,
};

const ADDITIVE_THRESHOLD: f64 = 10.0;
const CLASS_DELTA: f64 = 20.0;
const TOLERANCE: f64 = 1e-9;

fn single_agent_viability(drug_index: usize, concentration: f64) -> f64 {
    let low_dose = [80.0, 85.0, 90.0][drug_index];
    if concentration == 1.0 {
        low_dose
    } else {
        low_dose - 20.0
    }
}

/// Creates a complete 0/1/2 checkerboard in viability-percent units.
///
/// At combination locations, `bliss_delta` is subtracted from the viability
/// predicted by independent single-agent survival. Consequently the native
/// engine should recover the same delta as the Bliss interaction score.
fn synthetic_checkerboard(drug_count: usize, bliss_delta: f64) -> AssayInput {
    let location_count = 3_usize.pow(drug_count as u32);
    let rows = (0..location_count)
        .map(|mut encoded_location| {
            let concentrations = (0..drug_count)
                .map(|_| {
                    let concentration = (encoded_location % 3) as f64;
                    encoded_location /= 3;
                    concentration
                })
                .collect::<Vec<_>>();
            let positive = concentrations
                .iter()
                .enumerate()
                .filter(|(_, concentration)| **concentration > 0.0)
                .map(|(drug_index, concentration)| {
                    single_agent_viability(drug_index, *concentration)
                })
                .collect::<Vec<_>>();
            let independent_viability = if positive.is_empty() {
                100.0
            } else {
                positive.iter().product::<f64>() / 100_f64.powi(positive.len() as i32 - 1)
            };
            let response = if positive.len() >= 2 {
                independent_viability - bliss_delta
            } else {
                independent_viability
            };
            AssayRow {
                concentrations,
                od: response,
            }
        })
        .collect();

    AssayInput {
        drug_names: (0..drug_count)
            .map(|index| format!("Drug {}", (b'A' + index as u8) as char))
            .collect(),
        rows,
    }
}

fn synthetic_policy() -> AnalysisPolicy {
    AnalysisPolicy {
        bootstrap_iterations: 2,
        cell_additive_threshold: ADDITIVE_THRESHOLD,
        ..AnalysisPolicy::default()
    }
}

fn assert_surface(drug_count: usize, delta: f64, expected: AggregateInterpretation) {
    let result = analyze(
        &synthetic_checkerboard(drug_count, delta),
        synthetic_policy(),
    )
    .expect("the complete synthetic checkerboard should analyze");

    let full_combinations = result
        .processed
        .iter()
        .filter(|row| row.concentrations.iter().all(|value| *value > 0.0))
        .collect::<Vec<_>>();
    assert_eq!(full_combinations.len(), 2_usize.pow(drug_count as u32));
    assert_eq!(result.summary.combination_count, full_combinations.len());
    assert!((result.summary.mean_bliss - delta).abs() < TOLERANCE);
    assert_eq!(result.summary.interpretation, expected);

    let expected_cell_class = match expected {
        AggregateInterpretation::Antagonistic => InteractionInterpretation::Antagonistic,
        AggregateInterpretation::Additive => InteractionInterpretation::Additive,
        AggregateInterpretation::Synergistic => InteractionInterpretation::Synergistic,
    };
    for row in full_combinations {
        assert!((row.bliss_interaction - delta).abs() < TOLERANCE);
        assert_eq!(row.interpretation, expected_cell_class);
    }

    // Single-agent locations define the null surface and must not acquire an
    // interaction merely because combination responses were shifted.
    for row in result.processed.iter().filter(|row| {
        row.concentrations
            .iter()
            .filter(|value| **value > 0.0)
            .count()
            == 1
    }) {
        assert!(row.bliss_interaction.abs() < TOLERANCE);
        assert_eq!(row.interpretation, InteractionInterpretation::Additive);
    }
}

#[test]
fn synthetic_two_drug_checkerboards_recover_all_interaction_classes() {
    assert_surface(2, -CLASS_DELTA, AggregateInterpretation::Antagonistic);
    assert_surface(2, 0.0, AggregateInterpretation::Additive);
    assert_surface(2, CLASS_DELTA, AggregateInterpretation::Synergistic);
}

#[test]
fn synthetic_three_drug_checkerboards_recover_all_interaction_classes() {
    assert_surface(3, -CLASS_DELTA, AggregateInterpretation::Antagonistic);
    assert_surface(3, 0.0, AggregateInterpretation::Additive);
    assert_surface(3, CLASS_DELTA, AggregateInterpretation::Synergistic);
}

#[test]
fn synthetic_three_drug_pair_faces_retain_the_expected_relationship() {
    for delta in [-CLASS_DELTA, 0.0, CLASS_DELTA] {
        let result = analyze(&synthetic_checkerboard(3, delta), synthetic_policy()).unwrap();
        let pair_faces = result.processed.iter().filter(|row| {
            row.concentrations
                .iter()
                .filter(|value| **value > 0.0)
                .count()
                == 2
        });
        let mut count = 0;
        for row in pair_faces {
            count += 1;
            assert!((row.bliss_interaction - delta).abs() < TOLERANCE);
        }
        assert_eq!(count, 12, "three pair faces should each contain four cells");
    }
}
