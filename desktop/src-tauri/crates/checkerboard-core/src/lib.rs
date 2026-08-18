use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

const ZERO_TOLERANCE: f64 = 1e-12;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AssayInput {
    pub drug_names: Vec<String>,
    pub rows: Vec<AssayRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AssayRow {
    pub concentrations: Vec<f64>,
    pub od: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMapping {
    pub drugs: Vec<MappedDrug>,
    pub response_column: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MappedDrug {
    pub column: usize,
    pub name: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisPolicy {
    pub cell_additive_threshold: f64,
    pub od_censor_threshold: f64,
    pub allow_incomplete_grid: bool,
}

impl Default for AnalysisPolicy {
    fn default() -> Self {
        Self {
            cell_additive_threshold: 0.05,
            od_censor_threshold: 0.05,
            allow_incomplete_grid: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisResult {
    pub drug_names: Vec<String>,
    pub control: ControlStatistics,
    pub processed: Vec<ProcessedCombination>,
    pub summary: AnalysisSummary,
    pub warnings: Vec<AnalysisWarning>,
    pub policy: AnalysisPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ControlStatistics {
    pub replicate_count: usize,
    pub mean_od: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessedCombination {
    pub concentrations: Vec<f64>,
    pub mean_original_od: f64,
    pub mean_censored_od: f64,
    pub censored_replicate_count: usize,
    pub effect: f64,
    pub single_agent_effects: Vec<f64>,
    pub bliss_expected: f64,
    pub bliss_interaction: f64,
    pub replicate_count: usize,
    pub interpretation: InteractionInterpretation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisSummary {
    pub sum_bliss: f64,
    pub mean_bliss: f64,
    pub positive_sum: f64,
    pub negative_sum: f64,
    pub combination_count: usize,
    pub interpretation: AggregateInterpretation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StratifiedSummary {
    pub stratify_drug: String,
    pub rows: Vec<StratifiedSummaryRow>,
    pub total: AnalysisSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StratifiedSummaryRow {
    pub concentration: f64,
    pub summary: AnalysisSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisWarning {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum InteractionInterpretation {
    Antagonistic,
    Additive,
    Synergistic,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AggregateInterpretation {
    Antagonistic,
    Additive,
    Synergistic,
}

#[derive(Debug, Error, Clone, PartialEq)]
pub enum AnalysisError {
    #[error("Expected 2 or 3 mapped drug columns, found {0}.")]
    InvalidDrugCount(usize),
    #[error("Drug names must be nonblank and unique.")]
    InvalidDrugNames,
    #[error("The assay contains no data rows.")]
    EmptyAssay,
    #[error("The OD censor threshold must be finite and nonnegative; found {0}.")]
    InvalidOdCensorThreshold(f64),
    #[error("Row {row} has {found} concentrations; expected {expected}.")]
    ConcentrationCount {
        row: usize,
        expected: usize,
        found: usize,
    },
    #[error("Row {row}, drug {drug} contains a non-finite concentration.")]
    NonFiniteConcentration { row: usize, drug: usize },
    #[error("Row {row}, drug {drug} contains a negative concentration.")]
    NegativeConcentration { row: usize, drug: usize },
    #[error("Row {row} contains a non-finite OD value.")]
    NonFiniteOd { row: usize },
    #[error("No all-zero untreated control rows were found.")]
    MissingControl,
    #[error("The mean untreated control OD must be finite and greater than zero; found {0}.")]
    InvalidControlMean(f64),
    #[error(
        "Missing the required single-agent observation for {drug} at concentration {concentration}."
    )]
    MissingSingleAgent { drug: String, concentration: f64 },
    #[error(
        "The selected concentrations imply {expected} combinations, but {observed} were observed."
    )]
    IncompleteGrid { expected: usize, observed: usize },
    #[error("Column mapping must contain 2 or 3 drugs and one distinct response column.")]
    InvalidColumnMapping,
    #[error("Row {row}, column {column} is missing.")]
    MissingColumn { row: usize, column: usize },
    #[error("Row {row}, column {column} is not numeric: {value:?}.")]
    NonNumericValue {
        row: usize,
        column: usize,
        value: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ConcentrationKey(Vec<u64>);

impl ConcentrationKey {
    fn new(values: &[f64]) -> Self {
        Self(values.iter().map(|value| canonical_bits(*value)).collect())
    }
}

#[derive(Debug)]
struct EffectGroup {
    concentrations: Vec<f64>,
    effect_sum: f64,
    original_od_sum: f64,
    censored_od_sum: f64,
    censored_replicate_count: usize,
    replicate_count: usize,
}

pub fn assay_from_rows(
    rows: &[Vec<String>],
    mapping: &ColumnMapping,
) -> Result<AssayInput, AnalysisError> {
    validate_mapping(mapping)?;

    let mut assay_rows = Vec::with_capacity(rows.len());
    for (row_index, row) in rows.iter().enumerate() {
        let source_row = row_index + 2;
        let mut concentrations = Vec::with_capacity(mapping.drugs.len());
        for mapped in &mapping.drugs {
            concentrations.push(parse_cell(row, source_row, mapped.column)?);
        }
        let od = parse_cell(row, source_row, mapping.response_column)?;
        assay_rows.push(AssayRow { concentrations, od });
    }

    Ok(AssayInput {
        drug_names: mapping.drugs.iter().map(|drug| drug.name.clone()).collect(),
        rows: assay_rows,
    })
}

pub fn analyze(
    input: &AssayInput,
    policy: AnalysisPolicy,
) -> Result<AnalysisResult, AnalysisError> {
    validate_input(input)?;
    if !policy.od_censor_threshold.is_finite() || policy.od_censor_threshold < 0.0 {
        return Err(AnalysisError::InvalidOdCensorThreshold(
            policy.od_censor_threshold,
        ));
    }

    let control_values: Vec<f64> = input
        .rows
        .iter()
        .filter(|row| is_control(&row.concentrations))
        .map(|row| censor_od(row.od, policy.od_censor_threshold))
        .collect();
    if control_values.is_empty() {
        return Err(AnalysisError::MissingControl);
    }

    let control_mean = control_values.iter().sum::<f64>() / control_values.len() as f64;
    if !control_mean.is_finite() || control_mean <= 0.0 {
        return Err(AnalysisError::InvalidControlMean(control_mean));
    }

    let mut groups = Vec::<EffectGroup>::new();
    let mut group_indices = HashMap::<ConcentrationKey, usize>::new();

    for row in &input.rows {
        let od_was_censored = should_censor_od(row.od, policy.od_censor_threshold);
        let censored_od = censor_od(row.od, policy.od_censor_threshold);
        let effect = if is_control(&row.concentrations) {
            0.0
        } else {
            (1.0 - censored_od / control_mean).clamp(0.0, 1.0)
        };
        let normalized: Vec<f64> = row
            .concentrations
            .iter()
            .map(|value| {
                if value.abs() < ZERO_TOLERANCE {
                    0.0
                } else {
                    *value
                }
            })
            .collect();
        let key = ConcentrationKey::new(&normalized);
        if let Some(index) = group_indices.get(&key).copied() {
            groups[index].effect_sum += effect;
            groups[index].original_od_sum += row.od;
            groups[index].censored_od_sum += censored_od;
            groups[index].censored_replicate_count += usize::from(od_was_censored);
            groups[index].replicate_count += 1;
        } else {
            group_indices.insert(key, groups.len());
            groups.push(EffectGroup {
                concentrations: normalized,
                effect_sum: effect,
                original_od_sum: row.od,
                censored_od_sum: censored_od,
                censored_replicate_count: usize::from(od_was_censored),
                replicate_count: 1,
            });
        }
    }

    let averaged_effects: HashMap<ConcentrationKey, f64> = groups
        .iter()
        .map(|group| {
            (
                ConcentrationKey::new(&group.concentrations),
                group.effect_sum / group.replicate_count as f64,
            )
        })
        .collect();

    let mut processed = Vec::with_capacity(groups.len());
    for group in &groups {
        let effect = group.effect_sum / group.replicate_count as f64;
        let mut single_agent_effects = Vec::with_capacity(input.drug_names.len());
        for (drug_index, concentration) in group.concentrations.iter().copied().enumerate() {
            let mut single = vec![0.0; input.drug_names.len()];
            single[drug_index] = concentration;
            let single_effect = averaged_effects
                .get(&ConcentrationKey::new(&single))
                .copied()
                .ok_or_else(|| AnalysisError::MissingSingleAgent {
                    drug: input.drug_names[drug_index].clone(),
                    concentration,
                })?;
            single_agent_effects.push(single_effect);
        }
        let bliss_expected = 1.0
            - single_agent_effects
                .iter()
                .fold(1.0, |product, single_effect| {
                    product * (1.0 - single_effect)
                });
        let bliss_interaction = effect - bliss_expected;
        processed.push(ProcessedCombination {
            concentrations: group.concentrations.clone(),
            mean_original_od: group.original_od_sum / group.replicate_count as f64,
            mean_censored_od: group.censored_od_sum / group.replicate_count as f64,
            censored_replicate_count: group.censored_replicate_count,
            effect,
            single_agent_effects,
            bliss_expected,
            bliss_interaction,
            replicate_count: group.replicate_count,
            interpretation: interpret_interaction(
                bliss_interaction,
                policy.cell_additive_threshold,
            ),
        });
    }

    let expected_grid_size = input
        .drug_names
        .iter()
        .enumerate()
        .map(|(drug_index, _)| {
            groups
                .iter()
                .map(|group| canonical_bits(group.concentrations[drug_index]))
                .collect::<HashSet<_>>()
                .len()
        })
        .product::<usize>();
    let mut warnings = Vec::new();
    if expected_grid_size != groups.len() {
        if !policy.allow_incomplete_grid {
            return Err(AnalysisError::IncompleteGrid {
                expected: expected_grid_size,
                observed: groups.len(),
            });
        }
        warnings.push(AnalysisWarning {
            code: "incompleteGrid".to_string(),
            message: format!(
                "The selected concentrations imply {expected_grid_size} combinations, but {} were observed.",
                groups.len()
            ),
        });
    }

    let summary = summarize(processed.iter().map(|row| row.bliss_interaction));
    Ok(AnalysisResult {
        drug_names: input.drug_names.clone(),
        control: ControlStatistics {
            replicate_count: control_values.len(),
            mean_od: control_mean,
        },
        processed,
        summary,
        warnings,
        policy,
    })
}

pub fn summarize_by(result: &AnalysisResult, drug_index: usize) -> Option<StratifiedSummary> {
    let drug_name = result.drug_names.get(drug_index)?.clone();
    let mut concentrations = Vec::<f64>::new();
    let mut grouped = Vec::<Vec<f64>>::new();
    let mut indices = HashMap::<u64, usize>::new();

    for row in &result.processed {
        let concentration = *row.concentrations.get(drug_index)?;
        let key = canonical_bits(concentration);
        let index = if let Some(index) = indices.get(&key).copied() {
            index
        } else {
            let index = grouped.len();
            indices.insert(key, index);
            concentrations.push(concentration);
            grouped.push(Vec::new());
            index
        };
        grouped[index].push(row.bliss_interaction);
    }

    Some(StratifiedSummary {
        stratify_drug: drug_name,
        rows: concentrations
            .into_iter()
            .zip(grouped)
            .map(|(concentration, values)| StratifiedSummaryRow {
                concentration,
                summary: summarize(values),
            })
            .collect(),
        total: result.summary.clone(),
    })
}

pub fn interpret_interaction(value: f64, additive_threshold: f64) -> InteractionInterpretation {
    if value < -additive_threshold {
        InteractionInterpretation::Antagonistic
    } else if value > additive_threshold {
        InteractionInterpretation::Synergistic
    } else {
        InteractionInterpretation::Additive
    }
}

fn summarize(values: impl IntoIterator<Item = f64>) -> AnalysisSummary {
    let values: Vec<f64> = values.into_iter().collect();
    let sum_bliss = values.iter().sum::<f64>();
    AnalysisSummary {
        sum_bliss,
        mean_bliss: if values.is_empty() {
            0.0
        } else {
            sum_bliss / values.len() as f64
        },
        positive_sum: values.iter().copied().filter(|value| *value > 0.0).sum(),
        negative_sum: values.iter().copied().filter(|value| *value < 0.0).sum(),
        combination_count: values.len(),
        interpretation: if sum_bliss > 1.0 {
            AggregateInterpretation::Synergistic
        } else if sum_bliss < 0.0 {
            AggregateInterpretation::Antagonistic
        } else {
            AggregateInterpretation::Additive
        },
    }
}

fn validate_input(input: &AssayInput) -> Result<(), AnalysisError> {
    if !(2..=3).contains(&input.drug_names.len()) {
        return Err(AnalysisError::InvalidDrugCount(input.drug_names.len()));
    }
    let normalized_names: Vec<String> = input
        .drug_names
        .iter()
        .map(|name| name.trim().to_lowercase())
        .collect();
    if normalized_names.iter().any(String::is_empty)
        || normalized_names.iter().collect::<HashSet<_>>().len() != normalized_names.len()
    {
        return Err(AnalysisError::InvalidDrugNames);
    }
    if input.rows.is_empty() {
        return Err(AnalysisError::EmptyAssay);
    }
    for (row_index, row) in input.rows.iter().enumerate() {
        let row_number = row_index + 2;
        if row.concentrations.len() != input.drug_names.len() {
            return Err(AnalysisError::ConcentrationCount {
                row: row_number,
                expected: input.drug_names.len(),
                found: row.concentrations.len(),
            });
        }
        for (drug_index, concentration) in row.concentrations.iter().enumerate() {
            if !concentration.is_finite() {
                return Err(AnalysisError::NonFiniteConcentration {
                    row: row_number,
                    drug: drug_index + 1,
                });
            }
            if *concentration < 0.0 {
                return Err(AnalysisError::NegativeConcentration {
                    row: row_number,
                    drug: drug_index + 1,
                });
            }
        }
        if !row.od.is_finite() {
            return Err(AnalysisError::NonFiniteOd { row: row_number });
        }
    }
    Ok(())
}

fn validate_mapping(mapping: &ColumnMapping) -> Result<(), AnalysisError> {
    if !(2..=3).contains(&mapping.drugs.len()) {
        return Err(AnalysisError::InvalidColumnMapping);
    }
    let columns: HashSet<usize> = mapping.drugs.iter().map(|drug| drug.column).collect();
    let names: HashSet<String> = mapping
        .drugs
        .iter()
        .map(|drug| drug.name.trim().to_lowercase())
        .collect();
    if columns.len() != mapping.drugs.len()
        || columns.contains(&mapping.response_column)
        || names.len() != mapping.drugs.len()
        || names.contains("")
    {
        return Err(AnalysisError::InvalidColumnMapping);
    }
    Ok(())
}

fn parse_cell(row: &[String], row_number: usize, column: usize) -> Result<f64, AnalysisError> {
    let value = row
        .get(column)
        .ok_or(AnalysisError::MissingColumn {
            row: row_number,
            column: column + 1,
        })?
        .trim();
    value
        .parse::<f64>()
        .map_err(|_| AnalysisError::NonNumericValue {
            row: row_number,
            column: column + 1,
            value: value.to_string(),
        })
}

fn is_control(concentrations: &[f64]) -> bool {
    concentrations
        .iter()
        .all(|concentration| concentration.abs() < ZERO_TOLERANCE)
}

fn canonical_bits(value: f64) -> u64 {
    if value.abs() < ZERO_TOLERANCE {
        0.0f64.to_bits()
    } else {
        value.to_bits()
    }
}

fn should_censor_od(od: f64, threshold: f64) -> bool {
    od < 0.0 || od.abs() < threshold
}

fn censor_od(od: f64, threshold: f64) -> f64 {
    if should_censor_od(od, threshold) {
        0.0
    } else {
        od
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assay_from_csv(source: &str, drug_count: usize) -> AssayInput {
        let mut reader = csv::Reader::from_reader(source.as_bytes());
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
        let mapping = ColumnMapping {
            drugs: (0..drug_count)
                .map(|index| MappedDrug {
                    column: index,
                    name: format!("Drug{}", (b'A' + index as u8) as char),
                })
                .collect(),
            response_column: drug_count,
        };
        assay_from_rows(&rows, &mapping).unwrap()
    }

    #[test]
    fn two_drug_fixture_matches_r_results() {
        let input = assay_from_csv(
            include_str!("../../../../../fixtures/valid/two_drug.csv"),
            2,
        );
        let result = analyze(&input, AnalysisPolicy::default()).unwrap();

        assert_eq!(result.control.replicate_count, 2);
        assert!((result.control.mean_od - 1.1).abs() < 1e-12);
        assert_eq!(result.processed.len(), 9);
        assert!((result.summary.sum_bliss - 0.5072727272727272).abs() < 1e-12);
        assert_eq!(
            result.summary.interpretation,
            AggregateInterpretation::Additive
        );

        let final_row = result.processed.last().unwrap();
        assert_eq!(final_row.concentrations, vec![2.0, 2.0]);
        assert!((final_row.effect - 0.8636363636363636).abs() < 1e-12);
        assert!((final_row.bliss_expected - 0.7).abs() < 1e-12);
        assert!((final_row.bliss_interaction - 0.1636363636363637).abs() < 1e-12);
    }

    #[test]
    fn three_drug_fixture_matches_r_results_and_stratifies() {
        let input = assay_from_csv(
            include_str!("../../../../../fixtures/valid/three_drug.csv"),
            3,
        );
        let result = analyze(&input, AnalysisPolicy::default()).unwrap();
        assert_eq!(result.processed.len(), 8);
        assert!((result.summary.sum_bliss - 0.4868181818181815).abs() < 1e-12);

        let stratified = summarize_by(&result, 2).unwrap();
        assert_eq!(stratified.rows.len(), 2);
        assert!((stratified.rows[0].summary.sum_bliss - 0.07045454545454533).abs() < 1e-12);
        assert!((stratified.rows[1].summary.sum_bliss - 0.4163636363636362).abs() < 1e-12);
    }

    #[test]
    fn incomplete_grid_is_a_warning() {
        let input = assay_from_csv(
            include_str!("../../../../../fixtures/valid/incomplete_grid.csv"),
            2,
        );
        let result = analyze(&input, AnalysisPolicy::default()).unwrap();
        assert_eq!(result.warnings.len(), 1);
        assert_eq!(result.warnings[0].code, "incompleteGrid");
    }

    #[test]
    fn missing_control_is_rejected() {
        let input = assay_from_csv(
            include_str!("../../../../../fixtures/invalid/missing_control.csv"),
            2,
        );
        assert_eq!(
            analyze(&input, AnalysisPolicy::default()),
            Err(AnalysisError::MissingControl)
        );
    }

    #[test]
    fn missing_single_agent_is_rejected() {
        let input = assay_from_csv(
            include_str!("../../../../../fixtures/invalid/missing_single_agent.csv"),
            2,
        );
        assert!(matches!(
            analyze(&input, AnalysisPolicy::default()),
            Err(AnalysisError::MissingSingleAgent { .. })
        ));
    }

    #[test]
    fn negative_and_near_zero_od_values_are_censored_before_analysis() {
        assert!(should_censor_od(-0.2, 0.05));
        assert_eq!(censor_od(-0.2, 0.05), 0.0);
        assert_eq!(censor_od(0.049, 0.05), 0.0);
        assert_eq!(censor_od(0.05, 0.05), 0.05);
        assert_eq!(censor_od(0.2, 0.05), 0.2);
    }

    #[test]
    fn censored_od_metadata_is_retained_with_processed_combinations() {
        let input = AssayInput {
            drug_names: vec!["DrugA".into(), "DrugB".into()],
            rows: vec![
                AssayRow {
                    concentrations: vec![0.0, 0.0],
                    od: 1.0,
                },
                AssayRow {
                    concentrations: vec![1.0, 0.0],
                    od: -0.2,
                },
                AssayRow {
                    concentrations: vec![0.0, 1.0],
                    od: 0.04,
                },
                AssayRow {
                    concentrations: vec![1.0, 1.0],
                    od: 0.2,
                },
            ],
        };
        let result = analyze(&input, AnalysisPolicy::default()).unwrap();
        let negative = &result.processed[1];
        assert_eq!(negative.mean_original_od, -0.2);
        assert_eq!(negative.mean_censored_od, 0.0);
        assert_eq!(negative.censored_replicate_count, 1);
        assert_eq!(negative.effect, 1.0);
    }
}
