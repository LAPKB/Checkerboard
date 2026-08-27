use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::AssayInput;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DrusanoDataSettings {
    pub blank_value: f64,
    pub response_censor_limit: Option<f64>,
    pub mic_values: Vec<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DrusanoCensorLimitSuggestion {
    pub response_censor_limit: f64,
    pub normalized_effect_limit: f64,
    pub below_or_equal_count: usize,
    pub response_count: usize,
    pub density_ratio: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DrusanoWell {
    pub subject_id: String,
    pub raw_response: f64,
    pub normalized_effect: f64,
    pub normalized_doses: Vec<f64>,
    pub censored: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DrusanoDataSet {
    pub drug_names: Vec<String>,
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub wells: Vec<DrusanoWell>,
    pub subject_count: usize,
    pub control_count: usize,
    pub excluded_boundary_count: usize,
    pub excluded_effect_below_zero_count: usize,
    pub excluded_effect_above_one_count: usize,
    pub censored_count: usize,
    pub response_censor_limit: Option<f64>,
    pub normalized_effect_censor_limit: Option<f64>,
    pub blank_value: f64,
    pub control_mean: f64,
    pub mic_values: Vec<f64>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Error, Clone, PartialEq)]
pub enum DrusanoDataError {
    #[error("The current Drusano-Greco model requires exactly two drugs; found {0}.")]
    InvalidDrugCount(usize),
    #[error("Enter one finite, positive MIC for each drug.")]
    InvalidMicValues,
    #[error("The blank response must be finite.")]
    InvalidBlank,
    #[error("The response censor limit must be finite when supplied.")]
    InvalidCensorLimit,
    #[error(
        "The response censor limit produces E_L = {effect}; require 0 <= E_L < 1 using the entered blank and mean growth control."
    )]
    InvalidCensorEffect { effect: f64 },
    #[error("No all-zero growth-control wells were found.")]
    MissingGrowthControl,
    #[error(
        "The mean growth-control response ({control}) must be greater than the blank response ({blank})."
    )]
    InvalidGrowthControl { control: f64, blank: f64 },
    #[error("Response for source row {0} must be finite.")]
    InvalidResponse(usize),
    #[error("No drug-exposed wells had a normalized effect strictly between zero and one.")]
    NoEligibleWells,
}

pub fn build_equation_dataset(
    assay: &AssayInput,
    settings: &DrusanoDataSettings,
) -> Result<DrusanoDataSet, DrusanoDataError> {
    if assay.drug_names.len() != 2 {
        return Err(DrusanoDataError::InvalidDrugCount(assay.drug_names.len()));
    }
    if settings.mic_values.len() != 2
        || settings
            .mic_values
            .iter()
            .any(|value| !value.is_finite() || *value <= 0.0)
    {
        return Err(DrusanoDataError::InvalidMicValues);
    }
    if !settings.blank_value.is_finite() {
        return Err(DrusanoDataError::InvalidBlank);
    }
    if settings
        .response_censor_limit
        .is_some_and(|value| !value.is_finite())
    {
        return Err(DrusanoDataError::InvalidCensorLimit);
    }
    for (index, row) in assay.rows.iter().enumerate() {
        if !row.od.is_finite() {
            return Err(DrusanoDataError::InvalidResponse(index + 2));
        }
    }

    let controls = assay
        .rows
        .iter()
        .filter(|row| row.concentrations.iter().all(|value| value.abs() < 1e-12))
        .collect::<Vec<_>>();
    if controls.is_empty() {
        return Err(DrusanoDataError::MissingGrowthControl);
    }
    let control_mean = controls.iter().map(|row| row.od).sum::<f64>() / controls.len() as f64;
    if !control_mean.is_finite() || control_mean <= settings.blank_value {
        return Err(DrusanoDataError::InvalidGrowthControl {
            control: control_mean,
            blank: settings.blank_value,
        });
    }

    let denominator = control_mean - settings.blank_value;
    let normalized_effect_censor_limit = settings
        .response_censor_limit
        .map(|limit| 1.0 - (limit - settings.blank_value) / denominator);
    if let Some(effect) = normalized_effect_censor_limit
        && (!effect.is_finite() || !(0.0..1.0).contains(&effect))
    {
        return Err(DrusanoDataError::InvalidCensorEffect { effect });
    }
    let mut wells = Vec::new();
    let mut excluded_effect_below_zero_count = 0;
    let mut excluded_effect_above_one_count = 0;
    let mut censored_count = 0;
    for (index, row) in assay.rows.iter().enumerate() {
        if row.concentrations.iter().all(|value| value.abs() < 1e-12) {
            continue;
        }
        let raw_effect = 1.0 - (row.od - settings.blank_value) / denominator;
        let censored = settings
            .response_censor_limit
            .is_some_and(|limit| row.od <= limit);
        let effect = if censored {
            normalized_effect_censor_limit.expect("censor limit was supplied")
        } else {
            raw_effect
        };
        if !effect.is_finite() || effect <= 0.0 {
            excluded_effect_below_zero_count += 1;
            continue;
        }
        if effect >= 1.0 {
            excluded_effect_above_one_count += 1;
            continue;
        }
        if censored {
            censored_count += 1;
        }
        wells.push(DrusanoWell {
            subject_id: (index + 1).to_string(),
            raw_response: row.od,
            normalized_effect: effect,
            normalized_doses: row
                .concentrations
                .iter()
                .zip(&settings.mic_values)
                .map(|(dose, mic)| dose / mic)
                .collect(),
            censored,
        });
    }
    if wells.is_empty() {
        return Err(DrusanoDataError::NoEligibleWells);
    }

    let headers = [
        "ID",
        "TIME",
        "OUT",
        "OUTEQ",
        "CENS",
        "D1_MIC",
        "D2_MIC",
        "EFFECT",
        "RAW_RESPONSE",
    ]
    .into_iter()
    .map(String::from)
    .collect::<Vec<_>>();
    let rows = wells
        .iter()
        .map(|well| {
            vec![
                well.subject_id.clone(),
                "0".into(),
                if well.censored {
                    settings
                        .response_censor_limit
                        .expect("censored wells require a response limit")
                        .to_string()
                } else {
                    well.raw_response.to_string()
                },
                "predicted_absorbance".into(),
                if well.censored { "1" } else { "0" }.into(),
                well.normalized_doses[0].to_string(),
                well.normalized_doses[1].to_string(),
                well.normalized_effect.to_string(),
                well.raw_response.to_string(),
            ]
        })
        .collect();
    let excluded_boundary_count =
        excluded_effect_below_zero_count + excluded_effect_above_one_count;
    let mut warnings = Vec::new();
    if let Some(limit) = settings.response_censor_limit
        && censored_count > 0
    {
        warnings.push(format!(
            "Retained {censored_count} drug-exposed well(s) with responses at or below the {limit} censor limit as CENS = 1 observations."
        ));
    }
    if excluded_boundary_count > 0 {
        warnings.push(format!(
            "Excluded {excluded_boundary_count} uncensored drug-exposed well(s): {excluded_effect_below_zero_count} had normalized effect at or below 0 and {excluded_effect_above_one_count} had normalized effect at or above 1; experimental responses were not clipped or imputed."
        ));
    }

    Ok(DrusanoDataSet {
        drug_names: assay.drug_names.clone(),
        headers,
        rows,
        subject_count: wells.len(),
        control_count: controls.len(),
        excluded_boundary_count,
        excluded_effect_below_zero_count,
        excluded_effect_above_one_count,
        censored_count,
        response_censor_limit: settings.response_censor_limit,
        normalized_effect_censor_limit,
        blank_value: settings.blank_value,
        control_mean,
        mic_values: settings.mic_values.clone(),
        wells,
        warnings,
    })
}

/// Suggest a lower response censor limit from a sharp fall in the frequency of
/// drug-exposed responses. The suggestion is descriptive, not an assay
/// validation: users must review it against instrument and plate controls.
pub fn suggest_response_censor_limit(
    assay: &AssayInput,
    blank_value: f64,
) -> Result<Option<DrusanoCensorLimitSuggestion>, DrusanoDataError> {
    if !blank_value.is_finite() {
        return Err(DrusanoDataError::InvalidBlank);
    }
    let controls = assay
        .rows
        .iter()
        .filter(|row| row.concentrations.iter().all(|value| value.abs() < 1e-12))
        .collect::<Vec<_>>();
    if controls.is_empty() {
        return Err(DrusanoDataError::MissingGrowthControl);
    }
    let control_mean = controls.iter().map(|row| row.od).sum::<f64>() / controls.len() as f64;
    if !control_mean.is_finite() || control_mean <= blank_value {
        return Err(DrusanoDataError::InvalidGrowthControl {
            control: control_mean,
            blank: blank_value,
        });
    }
    let mut responses = assay
        .rows
        .iter()
        .filter(|row| row.concentrations.iter().any(|value| value.abs() >= 1e-12))
        .map(|row| row.od)
        .filter(|value| value.is_finite())
        .collect::<Vec<_>>();
    if responses.len() < 8 {
        return Ok(None);
    }
    responses.sort_by(f64::total_cmp);
    let minimum = responses[0];
    let maximum = responses[responses.len() - 1];
    let bin_count = (responses.len() as f64).sqrt().ceil() as usize;
    let bin_count = bin_count.clamp(8, 32).min(responses.len());
    let bin_width = (maximum - minimum) / bin_count as f64;
    if !bin_width.is_finite() || bin_width <= 0.0 {
        return Ok(None);
    }
    let mut counts = vec![0_usize; bin_count];
    for response in &responses {
        let index = (((response - minimum) / bin_width).floor() as usize).min(bin_count - 1);
        counts[index] += 1;
    }
    let minimum_bin_count = 3.max(responses.len() / 50);
    let mut cumulative = 0_usize;
    let mut best: Option<(usize, f64)> = None;
    for index in 0..bin_count - 1 {
        cumulative += counts[index];
        if counts[index] < minimum_bin_count
            || cumulative * 20 < responses.len()
            || cumulative * 5 > responses.len() * 4
        {
            continue;
        }
        let ratio = (counts[index] as f64 + 0.5) / (counts[index + 1] as f64 + 0.5);
        if ratio >= 2.0 && best.is_none_or(|(_, current)| ratio > current) {
            best = Some((index, ratio));
        }
    }
    let Some((index, density_ratio)) = best else {
        return Ok(None);
    };
    let mut limit = minimum + bin_width * (index + 1) as f64;
    if limit <= blank_value {
        let Some(next_above_blank) = responses
            .iter()
            .copied()
            .find(|response| *response > blank_value)
        else {
            return Ok(None);
        };
        limit = (blank_value + next_above_blank) / 2.0;
    }
    if limit > control_mean {
        return Ok(None);
    }
    let normalized_effect_limit = 1.0 - (limit - blank_value) / (control_mean - blank_value);
    if !normalized_effect_limit.is_finite() || !(0.0..1.0).contains(&normalized_effect_limit) {
        return Ok(None);
    }
    Ok(Some(DrusanoCensorLimitSuggestion {
        response_censor_limit: limit,
        normalized_effect_limit,
        below_or_equal_count: responses.iter().filter(|value| **value <= limit).count(),
        response_count: responses.len(),
        density_ratio,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AssayRow;

    fn assay(rows: Vec<AssayRow>) -> AssayInput {
        AssayInput {
            drug_names: vec!["A".into(), "B".into()],
            rows,
        }
    }

    #[test]
    fn normalizes_effect_and_doses_while_retaining_replicates_as_subjects() {
        let data = build_equation_dataset(
            &assay(vec![
                AssayRow {
                    concentrations: vec![0.0, 0.0],
                    od: 1.1,
                },
                AssayRow {
                    concentrations: vec![1.0, 2.0],
                    od: 0.6,
                },
                AssayRow {
                    concentrations: vec![1.0, 2.0],
                    od: 0.35,
                },
            ]),
            &DrusanoDataSettings {
                blank_value: 0.1,
                response_censor_limit: None,
                mic_values: vec![2.0, 4.0],
            },
        )
        .unwrap();
        assert_eq!(data.control_count, 1);
        assert_eq!(data.subject_count, 2);
        assert_eq!(data.wells[0].normalized_doses, vec![0.5, 0.5]);
        assert!((data.wells[0].normalized_effect - 0.5).abs() < 1e-12);
        assert!((data.wells[1].normalized_effect - 0.75).abs() < 1e-12);
        assert_ne!(data.wells[0].subject_id, data.wells[1].subject_id);
        assert_eq!(data.rows[0][2], "0.6");
        assert_eq!(data.rows[0][3], "predicted_absorbance");
    }

    #[test]
    fn excludes_controls_and_reports_boundary_effects_without_clipping() {
        let data = build_equation_dataset(
            &assay(vec![
                AssayRow {
                    concentrations: vec![0.0, 0.0],
                    od: 1.0,
                },
                AssayRow {
                    concentrations: vec![1.0, 0.0],
                    od: 1.1,
                },
                AssayRow {
                    concentrations: vec![0.0, 1.0],
                    od: 0.5,
                },
            ]),
            &DrusanoDataSettings {
                blank_value: 0.0,
                response_censor_limit: None,
                mic_values: vec![1.0, 1.0],
            },
        )
        .unwrap();
        assert_eq!(data.subject_count, 1);
        assert_eq!(data.excluded_boundary_count, 1);
        assert_eq!(data.excluded_effect_below_zero_count, 1);
        assert_eq!(data.excluded_effect_above_one_count, 0);
        assert!(data.warnings[0].contains("not clipped or imputed"));
    }

    #[test]
    fn responses_at_or_below_user_limit_are_retained_as_censored_subjects() {
        let data = build_equation_dataset(
            &assay(vec![
                AssayRow {
                    concentrations: vec![0.0, 0.0],
                    od: 1.0,
                },
                AssayRow {
                    concentrations: vec![1.0, 1.0],
                    od: -0.02,
                },
            ]),
            &DrusanoDataSettings {
                blank_value: 0.1,
                response_censor_limit: Some(0.2),
                mic_values: vec![1.0, 1.0],
            },
        )
        .unwrap();
        assert_eq!(data.subject_count, 1);
        assert_eq!(data.censored_count, 1);
        assert_eq!(data.excluded_boundary_count, 0);
        assert!(data.wells[0].censored);
        assert!((data.wells[0].normalized_effect - (8.0 / 9.0)).abs() < 1e-12);
        assert_eq!(data.response_censor_limit, Some(0.2));
        assert_eq!(data.normalized_effect_censor_limit, Some(8.0 / 9.0));
        assert_eq!(data.rows[0][2], "0.2");
        assert_eq!(data.rows[0][4], "1");
    }

    #[test]
    fn test2_fixture_suggests_and_retains_all_158_lower_response_wells() {
        let mut reader = csv::Reader::from_reader(include_bytes!(
            "../../../../../tests/test2_combined.csv"
        ) as &[u8]);
        let rows = reader
            .records()
            .map(|record| {
                let record = record.unwrap();
                AssayRow {
                    concentrations: vec![record[2].parse().unwrap(), record[3].parse().unwrap()],
                    od: record[6].parse().unwrap(),
                }
            })
            .collect();
        let input = assay(rows);
        let suggestion = suggest_response_censor_limit(&input, 0.1)
            .unwrap()
            .expect("the pinned fixture has a clear lower-response pile-up");
        assert!(suggestion.response_censor_limit > 0.1);
        assert!(suggestion.response_censor_limit < 0.122_235_2);
        assert_eq!(suggestion.below_or_equal_count, 158);

        let data = build_equation_dataset(
            &input,
            &DrusanoDataSettings {
                blank_value: 0.0,
                response_censor_limit: Some(0.1),
                mic_values: vec![1.0, 1.0],
            },
        )
        .unwrap();
        assert_eq!(data.control_count, 3);
        assert_eq!(data.censored_count, 158);
        assert_eq!(data.excluded_effect_below_zero_count, 10);
        assert_eq!(data.excluded_effect_above_one_count, 0);
        assert_eq!(data.subject_count, 251);
    }

    #[test]
    fn censor_limit_requires_zero_inclusive_unit_effect_range() {
        let input = assay(vec![
            AssayRow {
                concentrations: vec![0.0, 0.0],
                od: 1.0,
            },
            AssayRow {
                concentrations: vec![1.0, 1.0],
                od: 0.5,
            },
        ]);
        let above_one = build_equation_dataset(
            &input,
            &DrusanoDataSettings {
                blank_value: 0.1,
                response_censor_limit: Some(0.1),
                mic_values: vec![1.0, 1.0],
            },
        );
        assert!(matches!(
            above_one,
            Err(DrusanoDataError::InvalidCensorEffect { effect }) if effect == 1.0
        ));

        let zero_boundary = build_equation_dataset(
            &input,
            &DrusanoDataSettings {
                blank_value: 0.1,
                response_censor_limit: Some(1.0),
                mic_values: vec![1.0, 1.0],
            },
        );
        assert!(matches!(
            zero_boundary,
            Err(DrusanoDataError::NoEligibleWells)
        ));
    }

    #[test]
    fn suggests_censor_limit_at_lower_response_frequency_break() {
        let mut rows = vec![AssayRow {
            concentrations: vec![0.0, 0.0],
            od: 1.0,
        }];
        for index in 0..40 {
            rows.push(AssayRow {
                concentrations: vec![1.0, 1.0],
                od: 0.02 + index as f64 * 0.001,
            });
        }
        for index in 0..12 {
            rows.push(AssayRow {
                concentrations: vec![1.0, 1.0],
                od: 0.3 + index as f64 * 0.04,
            });
        }
        let suggestion = suggest_response_censor_limit(&assay(rows), 0.0)
            .unwrap()
            .expect("a sharp lower-tail pile-up should produce a suggestion");
        assert!(suggestion.response_censor_limit > 0.05);
        assert!(suggestion.response_censor_limit < 0.3);
        assert_eq!(suggestion.below_or_equal_count, 40);
        assert_eq!(suggestion.response_count, 52);
        assert!((0.0..1.0).contains(&suggestion.normalized_effect_limit));
        assert!(suggestion.density_ratio >= 2.0);
    }
}
