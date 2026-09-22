//! Native DiaMOND (diagonal measurement of n-way drug interactions) analysis.
//!
//! Concentrations are expressed in units of the user-supplied dose anchors.  A
//! combination row belongs to the DiaMOND diagonal when every active drug has
//! the same normalized concentration.  The curve dose is the sum of those
//! normalized concentrations, matching the total-dose convention in Cokol et
//! al. (2017).  At inhibition level `p`, the Loewe expectation is
//! `n / sum(1 / IC_i(p))`, and FIC is observed / expected.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::{
    AnalysisError, AssayInput, ConcentrationKey, ResponseType, is_control, validate_input,
};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiamondPolicy {
    pub response_type: ResponseType,
    #[serde(default)]
    pub blank_value: f64,
    #[serde(default)]
    pub response_censor_threshold: f64,
    #[serde(default = "default_bootstrap_iterations")]
    pub bootstrap_iterations: usize,
    #[serde(default = "default_seed")]
    pub random_seed: u64,
    #[serde(default = "default_diagonal_tolerance")]
    pub diagonal_tolerance_log2: f64,
}

fn default_bootstrap_iterations() -> usize {
    500
}
fn default_seed() -> u64 {
    123
}
fn default_diagonal_tolerance() -> f64 {
    0.5
}
impl Default for DiamondPolicy {
    fn default() -> Self {
        Self {
            response_type: ResponseType::Viability,
            blank_value: 0.0,
            response_censor_threshold: 0.0,
            bootstrap_iterations: default_bootstrap_iterations(),
            random_seed: default_seed(),
            diagonal_tolerance_log2: default_diagonal_tolerance(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiamondResult {
    pub drug_names: Vec<String>,
    pub dose_anchors: Vec<f64>,
    #[serde(default)]
    pub concentration_units: Vec<String>,
    pub control_mean: f64,
    pub control_replicates: usize,
    pub curves: Vec<DiamondCurve>,
    pub assay_locations: Vec<DiamondAssayLocation>,
    pub total_scores: Vec<DiamondScore>,
    pub pairwise_summaries: Vec<DiamondPairwiseSummary>,
    pub emergent_scores: Vec<DiamondScore>,
    #[serde(default)]
    pub isobole_diagnostics: Vec<DiamondIsoboleDiagnostic>,
    pub excluded_off_diagonal_locations: usize,
    pub warnings: Vec<String>,
    pub policy: DiamondPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiamondIsoboleDiagnostic {
    pub drug_indices: Vec<usize>,
    pub drug_names: Vec<String>,
    pub inhibition_level: f64,
    pub single_drug_ics: Vec<f64>,
    pub contour_segments: Vec<DiamondIsoboleSegment>,
    pub ray_direction: Vec<f64>,
    pub ray_intersection: Option<Vec<f64>>,
    pub surface_fic: Option<f64>,
    pub primary_fic: f64,
    pub absolute_log2_difference: Option<f64>,
    pub agrees_with_primary: Option<bool>,
    pub ray_intersection_count: usize,
    pub grid_shape: Vec<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiamondIsoboleSegment {
    pub start: Vec<f64>,
    pub end: Vec<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiamondAssayLocation {
    pub concentrations: Vec<f64>,
    pub mean_inhibition: f64,
    pub replicate_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiamondCurve {
    pub drug_indices: Vec<usize>,
    pub drug_names: Vec<String>,
    pub points: Vec<DiamondPoint>,
    pub fit: DiamondHillFit,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiamondPoint {
    pub concentrations: Vec<f64>,
    pub normalized_total_dose: f64,
    pub mean_inhibition: f64,
    pub replicate_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiamondHillFit {
    pub maximum_inhibition: f64,
    pub ec50: f64,
    pub hill_slope: f64,
    pub r_squared: f64,
    pub ic50: Option<f64>,
    pub ic90: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiamondScore {
    pub inhibition_level: f64,
    pub observed_dose: f64,
    pub expected_dose: f64,
    pub fic: f64,
    pub log2_fic: f64,
    pub ci_lower: Option<f64>,
    pub ci_upper: Option<f64>,
    pub interpretation: DiamondInterpretation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiamondPairwiseSummary {
    pub drug_indices: Vec<usize>,
    pub drug_names: Vec<String>,
    pub scores: Vec<DiamondScore>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DiamondInterpretation {
    Synergistic,
    Additive,
    Antagonistic,
}

#[derive(Debug, Error, Clone, PartialEq)]
pub enum DiamondError {
    #[error(transparent)]
    Input(#[from] AnalysisError),
    #[error("Enter one finite, positive DiaMOND dose anchor for each drug.")]
    InvalidDoseAnchors,
    #[error("DiaMOND bootstrap iterations must be at least 2; found {0}.")]
    InvalidBootstrapIterations(usize),
    #[error(
        "The DiaMOND policy contains an invalid blank, censor threshold, or diagonal tolerance."
    )]
    InvalidPolicy,
    #[error("No untreated control rows were found.")]
    MissingControl,
    #[error("The adjusted untreated control must be finite and positive; found {0}.")]
    InvalidControl(f64),
    #[error(
        "No usable dose response was found for {0}. Include at least three positive dose levels on each single-agent and equipotent combination diagonal."
    )]
    MissingCurve(String),
    #[error(
        "Row {row} has response {raw}; under the selected response type, blank, and untreated control this does not produce a finite inhibition value. Check the response-column mapping, blank, and all-zero untreated controls."
    )]
    NonFiniteInhibition {
        row: usize,
        raw: f64,
        inhibition: f64,
    },
}

#[derive(Debug, Clone)]
struct Location {
    concentrations: Vec<f64>,
    inhibitions: Vec<f64>,
}

#[derive(Debug, Clone)]
struct CurveData {
    indices: Vec<usize>,
    locations: Vec<Location>,
}

pub fn analyze(
    input: &AssayInput,
    dose_anchors: &[f64],
    mut policy: DiamondPolicy,
    mut progress: impl FnMut(usize, usize),
) -> Result<DiamondResult, DiamondError> {
    validate_input(input)?;
    if dose_anchors.len() != input.drug_names.len()
        || dose_anchors
            .iter()
            .any(|value| !value.is_finite() || *value <= 0.0)
    {
        return Err(DiamondError::InvalidDoseAnchors);
    }
    if policy.bootstrap_iterations < 2 {
        return Err(DiamondError::InvalidBootstrapIterations(
            policy.bootstrap_iterations,
        ));
    }
    if !policy.blank_value.is_finite()
        || !policy.response_censor_threshold.is_finite()
        || policy.response_censor_threshold < 0.0
        || !policy.diagonal_tolerance_log2.is_finite()
        || policy.diagonal_tolerance_log2 < 0.0
    {
        return Err(DiamondError::InvalidPolicy);
    }

    let controls = input
        .rows
        .iter()
        .filter(|row| is_control(&row.concentrations))
        .collect::<Vec<_>>();
    if controls.is_empty() {
        return Err(DiamondError::MissingControl);
    }
    let control_mean = controls.iter().map(|row| row.od).sum::<f64>() / controls.len() as f64;
    let adjusted_control = control_mean - policy.blank_value;
    let imported_response_type = policy.response_type;
    if matches!(
        policy.response_type,
        ResponseType::Viability | ResponseType::ViabilityFraction
    ) {
        if (0.5..=2.0).contains(&control_mean) {
            policy.response_type = ResponseType::ViabilityFraction;
        } else if (50.0..=150.0).contains(&control_mean) {
            policy.response_type = ResponseType::Viability;
        }
    }
    if policy.response_type == ResponseType::RawOd
        && (!adjusted_control.is_finite() || adjusted_control <= 0.0)
    {
        return Err(DiamondError::InvalidControl(adjusted_control));
    }

    let mut grouped = HashMap::<ConcentrationKey, Location>::new();
    for (row_index, row) in input.rows.iter().enumerate() {
        if is_control(&row.concentrations) {
            continue;
        }
        let concentrations = row
            .concentrations
            .iter()
            .map(|value| if value.abs() < 1e-12 { 0.0 } else { *value })
            .collect::<Vec<_>>();
        let raw = if policy.response_type == ResponseType::RawOd
            && row.od <= policy.response_censor_threshold
        {
            policy.response_censor_threshold
        } else {
            row.od
        };
        let inhibition = match policy.response_type {
            ResponseType::Viability => 100.0 - raw,
            ResponseType::ViabilityFraction => 100.0 * (1.0 - raw),
            ResponseType::Inhibition => raw,
            ResponseType::InhibitionFraction => 100.0 * raw,
            ResponseType::RawOd => 100.0 * (1.0 - (raw - policy.blank_value) / adjusted_control),
        };
        if !inhibition.is_finite() {
            return Err(DiamondError::NonFiniteInhibition {
                row: row_index + 2,
                raw: row.od,
                inhibition,
            });
        }
        grouped
            .entry(ConcentrationKey::new(&concentrations))
            .or_insert_with(|| Location {
                concentrations,
                inhibitions: Vec::new(),
            })
            .inhibitions
            .push(inhibition);
    }

    let mut assay_locations = grouped
        .values()
        .map(|location| DiamondAssayLocation {
            concentrations: location.concentrations.clone(),
            mean_inhibition: mean(&location.inhibitions),
            replicate_count: location.inhibitions.len(),
        })
        .collect::<Vec<_>>();
    assay_locations.push(DiamondAssayLocation {
        concentrations: vec![0.0; input.drug_names.len()],
        mean_inhibition: 0.0,
        replicate_count: controls.len(),
    });
    assay_locations.sort_by(|left, right| {
        left.concentrations
            .iter()
            .zip(&right.concentrations)
            .find_map(|(left, right)| {
                let order = left.total_cmp(right);
                (order != std::cmp::Ordering::Equal).then_some(order)
            })
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut by_subset = HashMap::<Vec<usize>, Vec<Location>>::new();
    let mut excluded = 0usize;
    for location in grouped.into_values() {
        let indices = location
            .concentrations
            .iter()
            .enumerate()
            .filter_map(|(i, c)| (*c > 0.0).then_some(i))
            .collect::<Vec<_>>();
        if indices.is_empty() {
            continue;
        }
        if indices.len() > 1 {
            let normalized = indices
                .iter()
                .map(|i| location.concentrations[*i] / dose_anchors[*i])
                .collect::<Vec<_>>();
            let low = normalized.iter().copied().fold(f64::INFINITY, f64::min);
            let high = normalized.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            if (high / low).log2() > policy.diagonal_tolerance_log2 {
                excluded += 1;
                continue;
            }
        }
        by_subset.entry(indices).or_default().push(location);
    }

    let mut subsets = (0..input.drug_names.len())
        .map(|i| vec![i])
        .collect::<Vec<_>>();
    if input.drug_names.len() == 3 {
        subsets.extend([vec![0, 1], vec![0, 2], vec![1, 2]]);
    }
    subsets.push((0..input.drug_names.len()).collect());
    subsets.sort();
    subsets.dedup();

    let mut curve_data = Vec::new();
    let mut curves = Vec::new();
    for indices in subsets {
        let label = indices
            .iter()
            .map(|i| input.drug_names[*i].as_str())
            .collect::<Vec<_>>()
            .join(" + ");
        let mut locations = by_subset.remove(&indices).unwrap_or_default();
        locations.sort_by(|a, b| {
            total_dose(a, &indices, dose_anchors).total_cmp(&total_dose(b, &indices, dose_anchors))
        });
        if locations.len() < 3 {
            if indices.len() == 2 && input.drug_names.len() == 3 {
                continue;
            }
            return Err(DiamondError::MissingCurve(label));
        }
        let series = locations
            .iter()
            .map(|location| {
                (
                    total_dose(location, &indices, dose_anchors),
                    mean(&location.inhibitions),
                )
            })
            .collect::<Vec<_>>();
        let fit = fit_hill(&series);
        curves.push(DiamondCurve {
            drug_indices: indices.clone(),
            drug_names: indices
                .iter()
                .map(|i| input.drug_names[*i].clone())
                .collect(),
            points: locations
                .iter()
                .map(|location| DiamondPoint {
                    concentrations: location.concentrations.clone(),
                    normalized_total_dose: total_dose(location, &indices, dose_anchors),
                    mean_inhibition: mean(&location.inhibitions),
                    replicate_count: location.inhibitions.len(),
                })
                .collect(),
            fit,
        });
        curve_data.push(CurveData { indices, locations });
    }

    let central_fits = curves
        .iter()
        .map(|curve| curve.fit.clone())
        .collect::<Vec<_>>();
    let score_sets = calculate_scores(&curve_data, &central_fits, input.drug_names.len())?;
    let has_replicates = curve_data
        .iter()
        .flat_map(|curve| &curve.locations)
        .any(|location| location.inhibitions.len() > 1);
    let mut bootstrap = vec![Vec::<f64>::new(); score_sets.len()];
    let mut emergent_bootstrap = [Vec::<f64>::new(), Vec::<f64>::new()];
    if has_replicates {
        let mut rng = SplitMix64::new(policy.random_seed);
        progress(0, policy.bootstrap_iterations);
        for iteration in 0..policy.bootstrap_iterations {
            let fits = curve_data
                .iter()
                .map(|curve| {
                    let series = curve
                        .locations
                        .iter()
                        .map(|location| {
                            let values = (0..location.inhibitions.len())
                                .map(|_| {
                                    location.inhibitions[rng.index(location.inhibitions.len())]
                                })
                                .collect::<Vec<_>>();
                            (
                                total_dose(location, &curve.indices, dose_anchors),
                                mean(&values),
                            )
                        })
                        .collect::<Vec<_>>();
                    fit_hill(&series)
                })
                .collect::<Vec<_>>();
            if let Ok(scores) = calculate_scores(&curve_data, &fits, input.drug_names.len()) {
                if scores.len() == bootstrap.len() {
                    for (values, score) in bootstrap.iter_mut().zip(scores) {
                        values.push(score.fic);
                    }
                }
            }
            if input.drug_names.len() == 3 {
                for (index, level) in [50.0, 90.0].into_iter().enumerate() {
                    if let Some(score) = emergent_score(&curve_data, &fits, level) {
                        emergent_bootstrap[index].push(score.fic);
                    }
                }
            }
            progress(iteration + 1, policy.bootstrap_iterations);
        }
    } else {
        progress(0, 1);
        progress(1, 1);
    }

    let mut scores = score_sets;
    for (score, values) in scores.iter_mut().zip(&bootstrap) {
        if values.len() >= 2 {
            score.ci_lower = Some(quantile(values, 0.025));
            score.ci_upper = Some(quantile(values, 0.975));
        }
        score.interpretation = interpret_score(score.fic, score.ci_lower, score.ci_upper);
    }
    let full_len = input.drug_names.len();
    let mut cursor = 0usize;
    let mut pairwise_summaries = Vec::new();
    let mut total_scores = Vec::new();
    let mut emergent_scores = Vec::new();
    for curve in &curve_data {
        if curve.indices.len() < 2 {
            continue;
        }
        let available = [50.0, 90.0]
            .iter()
            .filter(|level| {
                score_for_curve(&central_fits, &curve_data, &curve.indices, **level, false)
                    .is_some()
            })
            .count();
        let curve_scores = scores[cursor..cursor + available].to_vec();
        cursor += available;
        if curve.indices.len() == full_len {
            total_scores = curve_scores;
        } else {
            pairwise_summaries.push(DiamondPairwiseSummary {
                drug_indices: curve.indices.clone(),
                drug_names: curve
                    .indices
                    .iter()
                    .map(|i| input.drug_names[*i].clone())
                    .collect(),
                scores: curve_scores,
            });
        }
    }
    if full_len == 3 && pairwise_summaries.len() == 3 {
        for level in [50.0, 90.0] {
            if let Some(mut score) = emergent_score(&curve_data, &central_fits, level) {
                let values = &emergent_bootstrap[usize::from(level == 90.0)];
                if values.len() >= 2 {
                    score.ci_lower = Some(quantile(values, 0.025));
                    score.ci_upper = Some(quantile(values, 0.975));
                }
                score.interpretation = interpret_score(score.fic, score.ci_lower, score.ci_upper);
                emergent_scores.push(score);
            }
        }
    }
    let isobole_diagnostics = build_isobole_diagnostics(
        &assay_locations,
        &curves,
        dose_anchors,
        &total_scores,
        &pairwise_summaries,
    );
    let mut warnings = Vec::new();
    if policy.response_type != imported_response_type {
        let detected_scale = match policy.response_type {
            ResponseType::ViabilityFraction => "fractional viability (0–1)",
            ResponseType::Viability => "percentage viability (0–100)",
            _ => unreachable!("only viability scales are detected from untreated controls"),
        };
        warnings.push(format!(
            "Detected {detected_scale} from the all-zero drug controls (mean response {control_mean:.4}); the imported response scale was adjusted automatically."
        ));
    }
    if excluded > 0 {
        warnings.push(format!("Excluded {excluded} off-diagonal combination dose location(s) from the primary fitted-diagonal curves. When they form a complete checkerboard, they are used only for the full-isobole diagnostic."));
    }
    if !has_replicates {
        warnings.push("No replicated diagonal dose locations were available; confidence intervals were not calculated.".into());
    }
    if total_scores
        .iter()
        .all(|score| score.inhibition_level != 90.0)
    {
        warnings.push("FIC90 could not be calculated because at least one fitted curve did not reach 90% inhibition.".into());
    }
    for diagnostic in &isobole_diagnostics {
        if diagnostic.surface_fic.is_none() {
            warnings.push(format!(
                "The complete-checkerboard IC{} contour for {} does not cross the equipotent ray inside the observed grid, so a surface-derived FIC comparison is unavailable. The contour was not extrapolated.",
                diagnostic.inhibition_level,
                diagnostic.drug_names.join(" + "),
            ));
        } else if diagnostic.agrees_with_primary == Some(false) {
            warnings.push(format!(
                "The full-checkerboard IC{} isobole for {} intersects the equipotent ray at FIC {:.3}, versus primary diagonal FIC {:.3} (|log2 ratio| {:.3} > 0.5). This suggests drug-ratio dependence or a poor diagonal/surface fit; the primary DiaMOND result was not replaced.",
                diagnostic.inhibition_level,
                diagnostic.drug_names.join(" + "),
                diagnostic.surface_fic.unwrap_or(f64::NAN),
                diagnostic.primary_fic,
                diagnostic.absolute_log2_difference.unwrap_or(f64::NAN),
            ));
        }
        if diagnostic.ray_intersection_count > 1 {
            warnings.push(format!(
                "The full-checkerboard IC{} isobole for {} crosses the equipotent ray {} times. The lowest-dose crossing is shown; multiple crossings suggest a nonmonotonic or irregular response surface.",
                diagnostic.inhibition_level,
                diagnostic.drug_names.join(" + "),
                diagnostic.ray_intersection_count,
            ));
        }
    }

    Ok(DiamondResult {
        drug_names: input.drug_names.clone(),
        dose_anchors: dose_anchors.to_vec(),
        concentration_units: Vec::new(),
        control_mean,
        control_replicates: controls.len(),
        curves,
        assay_locations,
        total_scores,
        pairwise_summaries,
        emergent_scores,
        isobole_diagnostics,
        excluded_off_diagonal_locations: excluded,
        warnings,
        policy,
    })
}

fn calculate_scores(
    curves: &[CurveData],
    fits: &[DiamondHillFit],
    drug_count: usize,
) -> Result<Vec<DiamondScore>, DiamondError> {
    let mut result = Vec::new();
    for curve in curves.iter().filter(|curve| curve.indices.len() >= 2) {
        for level in [50.0, 90.0] {
            if let Some((observed, expected, fic)) =
                score_for_curve(fits, curves, &curve.indices, level, false)
            {
                result.push(make_score(level, observed, expected, fic));
            }
        }
    }
    if !curves.iter().any(|curve| curve.indices.len() == drug_count) {
        return Err(DiamondError::MissingCurve("full combination".into()));
    }
    Ok(result)
}

fn score_for_curve(
    fits: &[DiamondHillFit],
    curves: &[CurveData],
    indices: &[usize],
    level: f64,
    pair_expectation: bool,
) -> Option<(f64, f64, f64)> {
    let observed_index = curves.iter().position(|curve| curve.indices == indices)?;
    let observed = ic_at(&fits[observed_index], level)?;
    let expected_components = if pair_expectation {
        curves
            .iter()
            .enumerate()
            .filter(|(_, curve)| {
                curve.indices.len() + 1 == indices.len()
                    && curve.indices.iter().all(|i| indices.contains(i))
            })
            .map(|(i, _)| ic_at(&fits[i], level))
            .collect::<Option<Vec<_>>>()?
    } else {
        indices
            .iter()
            .map(|drug| {
                let i = curves
                    .iter()
                    .position(|curve| curve.indices.as_slice() == [*drug])?;
                ic_at(&fits[i], level)
            })
            .collect::<Option<Vec<_>>>()?
    };
    if expected_components.len() != indices.len() {
        return None;
    }
    let expected = indices.len() as f64
        / expected_components
            .iter()
            .map(|dose| 1.0 / dose)
            .sum::<f64>();
    Some((observed, expected, observed / expected))
}

fn emergent_score(
    curves: &[CurveData],
    fits: &[DiamondHillFit],
    level: f64,
) -> Option<DiamondScore> {
    let indices = [0, 1, 2];
    let (observed, expected, fic) = score_for_curve(fits, curves, &indices, level, true)?;
    Some(make_score(level, observed, expected, fic))
}

const ISOBOLE_AGREEMENT_LOG2_TOLERANCE: f64 = 0.5;

fn build_isobole_diagnostics(
    assay_locations: &[DiamondAssayLocation],
    curves: &[DiamondCurve],
    dose_anchors: &[f64],
    total_scores: &[DiamondScore],
    pairwise_summaries: &[DiamondPairwiseSummary],
) -> Vec<DiamondIsoboleDiagnostic> {
    let mut score_sets = Vec::<(Vec<usize>, &[DiamondScore])>::new();
    if dose_anchors.len() == 2 {
        score_sets.push((vec![0, 1], total_scores));
    } else {
        score_sets.extend(
            pairwise_summaries
                .iter()
                .map(|summary| (summary.drug_indices.clone(), summary.scores.as_slice())),
        );
    }
    score_sets
        .into_iter()
        .flat_map(|(indices, scores)| {
            scores.iter().filter_map(move |score| {
                build_isobole_diagnostic(assay_locations, curves, dose_anchors, &indices, score)
            })
        })
        .collect()
}

fn build_isobole_diagnostic(
    assay_locations: &[DiamondAssayLocation],
    curves: &[DiamondCurve],
    dose_anchors: &[f64],
    indices: &[usize],
    primary: &DiamondScore,
) -> Option<DiamondIsoboleDiagnostic> {
    if indices.len() != 2 {
        return None;
    }
    let single_drug_relative_ics = indices
        .iter()
        .map(|drug| {
            curves
                .iter()
                .find(|curve| curve.drug_indices.as_slice() == [*drug])
                .and_then(|curve| ic_at(&curve.fit, primary.inhibition_level))
        })
        .collect::<Option<Vec<_>>>()?;
    let single_drug_ics = single_drug_relative_ics
        .iter()
        .zip(indices)
        .map(|(relative_ic, drug)| relative_ic * dose_anchors[*drug])
        .collect::<Vec<_>>();
    let face_locations = assay_locations
        .iter()
        .filter(|location| {
            location.concentrations.len() == dose_anchors.len()
                && location
                    .concentrations
                    .iter()
                    .enumerate()
                    .all(|(index, concentration)| {
                        indices.contains(&index) || concentration.abs() < 1e-12
                    })
        })
        .collect::<Vec<_>>();
    let mut x_levels = face_locations
        .iter()
        .map(|location| location.concentrations[indices[0]])
        .collect::<Vec<_>>();
    let mut y_levels = face_locations
        .iter()
        .map(|location| location.concentrations[indices[1]])
        .collect::<Vec<_>>();
    sort_dedup_finite(&mut x_levels);
    sort_dedup_finite(&mut y_levels);
    if x_levels.len() < 2
        || y_levels.len() < 2
        || face_locations.len() != x_levels.len() * y_levels.len()
    {
        return None;
    }
    let values = face_locations
        .iter()
        .map(|location| {
            (
                (
                    location.concentrations[indices[0]].to_bits(),
                    location.concentrations[indices[1]].to_bits(),
                ),
                location.mean_inhibition,
            )
        })
        .collect::<HashMap<_, _>>();
    let grid = y_levels
        .iter()
        .map(|y| {
            x_levels
                .iter()
                .map(|x| values.get(&(x.to_bits(), y.to_bits())).copied())
                .collect::<Option<Vec<_>>>()
        })
        .collect::<Option<Vec<_>>>()?;
    let relative_x = x_levels
        .iter()
        .map(|value| value / single_drug_ics[0])
        .collect::<Vec<_>>();
    let relative_y = y_levels
        .iter()
        .map(|value| value / single_drug_ics[1])
        .collect::<Vec<_>>();
    let contour_segments =
        marching_squares(&relative_x, &relative_y, &grid, primary.inhibition_level);
    let ray_direction = vec![
        dose_anchors[indices[0]] / single_drug_ics[0],
        dose_anchors[indices[1]] / single_drug_ics[1],
    ];
    let mut intersections = contour_segments
        .iter()
        .filter_map(|segment| ray_segment_intersection(&ray_direction, segment))
        .collect::<Vec<_>>();
    intersections.sort_by(|left, right| (left[0] + left[1]).total_cmp(&(right[0] + right[1])));
    intersections
        .dedup_by(|left, right| ((left[0] + left[1]) - (right[0] + right[1])).abs() < 1e-9);
    let ray_intersection = intersections.first().cloned();
    let surface_fic = ray_intersection.as_ref().map(|point| point[0] + point[1]);
    let absolute_log2_difference = surface_fic
        .filter(|fic| *fic > 0.0 && primary.fic > 0.0)
        .map(|fic| (fic / primary.fic).log2().abs());
    let agrees_with_primary =
        absolute_log2_difference.map(|difference| difference <= ISOBOLE_AGREEMENT_LOG2_TOLERANCE);
    let drug_names = indices
        .iter()
        .filter_map(|index| {
            curves
                .iter()
                .find(|curve| curve.drug_indices.as_slice() == [*index])
                .and_then(|curve| curve.drug_names.first().cloned())
        })
        .collect::<Vec<_>>();

    Some(DiamondIsoboleDiagnostic {
        drug_indices: indices.to_vec(),
        drug_names,
        inhibition_level: primary.inhibition_level,
        single_drug_ics,
        contour_segments,
        ray_direction,
        ray_intersection,
        surface_fic,
        primary_fic: primary.fic,
        absolute_log2_difference,
        agrees_with_primary,
        ray_intersection_count: intersections.len(),
        grid_shape: vec![x_levels.len(), y_levels.len()],
    })
}

fn sort_dedup_finite(values: &mut Vec<f64>) {
    values.retain(|value| value.is_finite());
    values.sort_by(f64::total_cmp);
    values.dedup_by(|left, right| left.to_bits() == right.to_bits());
}

fn marching_squares(
    x: &[f64],
    y: &[f64],
    values: &[Vec<f64>],
    level: f64,
) -> Vec<DiamondIsoboleSegment> {
    let mut segments = Vec::new();
    for row in 0..y.len() - 1 {
        for column in 0..x.len() - 1 {
            let points = [
                [x[column], y[row]],
                [x[column + 1], y[row]],
                [x[column + 1], y[row + 1]],
                [x[column], y[row + 1]],
            ];
            let z = [
                values[row][column],
                values[row][column + 1],
                values[row + 1][column + 1],
                values[row + 1][column],
            ];
            if z.iter().any(|value| !value.is_finite()) {
                continue;
            }
            let case = z.iter().enumerate().fold(0_u8, |bits, (index, value)| {
                bits | (u8::from(*value >= level) << index)
            });
            let edge = |edge_index: usize| {
                let (start, end) = [(0, 1), (1, 2), (2, 3), (3, 0)][edge_index];
                interpolate_contour_edge(points[start], points[end], z[start], z[end], level)
            };
            let mut connect = |first: usize, second: usize| {
                segments.push(DiamondIsoboleSegment {
                    start: edge(first).to_vec(),
                    end: edge(second).to_vec(),
                });
            };
            match case {
                1 | 14 => connect(3, 0),
                2 | 13 => connect(0, 1),
                3 | 12 => connect(3, 1),
                4 | 11 => connect(1, 2),
                6 | 9 => connect(0, 2),
                7 | 8 => connect(3, 2),
                5 => {
                    if z.iter().sum::<f64>() / 4.0 >= level {
                        connect(0, 1);
                        connect(2, 3);
                    } else {
                        connect(3, 0);
                        connect(1, 2);
                    }
                }
                10 => {
                    if z.iter().sum::<f64>() / 4.0 >= level {
                        connect(3, 0);
                        connect(1, 2);
                    } else {
                        connect(0, 1);
                        connect(2, 3);
                    }
                }
                _ => {}
            }
        }
    }
    segments
}

fn interpolate_contour_edge(
    start: [f64; 2],
    end: [f64; 2],
    start_value: f64,
    end_value: f64,
    level: f64,
) -> [f64; 2] {
    let fraction = if (end_value - start_value).abs() < 1e-15 {
        0.5
    } else {
        ((level - start_value) / (end_value - start_value)).clamp(0.0, 1.0)
    };
    [
        start[0] + fraction * (end[0] - start[0]),
        start[1] + fraction * (end[1] - start[1]),
    ]
}

fn ray_segment_intersection(
    direction: &[f64],
    segment: &DiamondIsoboleSegment,
) -> Option<Vec<f64>> {
    if direction.len() != 2 || segment.start.len() != 2 || segment.end.len() != 2 {
        return None;
    }
    let segment_direction = [
        segment.end[0] - segment.start[0],
        segment.end[1] - segment.start[1],
    ];
    let denominator = cross([direction[0], direction[1]], segment_direction);
    if denominator.abs() < 1e-12 {
        return None;
    }
    let start = [segment.start[0], segment.start[1]];
    let ray_scale = cross(start, segment_direction) / denominator;
    let segment_scale = cross(start, [direction[0], direction[1]]) / denominator;
    if ray_scale < -1e-12 || !(-1e-12..=1.0 + 1e-12).contains(&segment_scale) {
        return None;
    }
    Some(vec![ray_scale * direction[0], ray_scale * direction[1]])
}

fn cross(left: [f64; 2], right: [f64; 2]) -> f64 {
    left[0] * right[1] - left[1] * right[0]
}

fn make_score(level: f64, observed: f64, expected: f64, fic: f64) -> DiamondScore {
    let interpretation = interpret_score(fic, None, None);
    DiamondScore {
        inhibition_level: level,
        observed_dose: observed,
        expected_dose: expected,
        fic,
        log2_fic: fic.log2(),
        ci_lower: None,
        ci_upper: None,
        interpretation,
    }
}

fn interpret_score(
    fic: f64,
    ci_lower: Option<f64>,
    ci_upper: Option<f64>,
) -> DiamondInterpretation {
    match (ci_lower, ci_upper) {
        (Some(lower), Some(upper)) if lower <= 1.0 && upper >= 1.0 => {
            DiamondInterpretation::Additive
        }
        (_, Some(upper)) if upper < 1.0 => DiamondInterpretation::Synergistic,
        (Some(lower), _) if lower > 1.0 => DiamondInterpretation::Antagonistic,
        _ if fic < 1.0 => DiamondInterpretation::Synergistic,
        _ if fic > 1.0 => DiamondInterpretation::Antagonistic,
        _ => DiamondInterpretation::Additive,
    }
}

fn total_dose(location: &Location, indices: &[usize], dose_anchors: &[f64]) -> f64 {
    indices
        .iter()
        .map(|i| location.concentrations[*i] / dose_anchors[*i])
        .sum()
}

fn fit_hill(series: &[(f64, f64)]) -> DiamondHillFit {
    let max_y = series
        .iter()
        .map(|p| p.1)
        .fold(0.0, f64::max)
        .clamp(0.1, 99.9);
    let median_x = series[series.len() / 2].0.max(1e-12);
    let mut best = [
        logit(max_y / 100.0),
        median_x.ln(),
        logit((1.0 - 0.05) / 9.95),
    ];
    let mut best_error = hill_error(best, series);
    for emax in [max_y, (max_y + 5.0).min(99.9), 95.0, 99.0] {
        for slope in [0.5, 1.0, 2.0, 4.0] {
            let start = [
                logit(emax / 100.0),
                median_x.ln(),
                logit((slope - 0.05) / 9.95),
            ];
            let candidate = nelder_mead(start, series);
            let error = hill_error(candidate, series);
            if error < best_error {
                best = candidate;
                best_error = error;
            }
        }
    }
    let (maximum_inhibition, ec50, hill_slope) = decode(best);
    let observed = series.iter().map(|p| p.1).collect::<Vec<_>>();
    let mean_y = mean(&observed);
    let total = observed.iter().map(|y| (y - mean_y).powi(2)).sum::<f64>();
    let r_squared = if total <= 1e-15 {
        1.0
    } else {
        1.0 - best_error / total
    };
    let fit = DiamondHillFit {
        maximum_inhibition,
        ec50,
        hill_slope,
        r_squared,
        ic50: None,
        ic90: None,
    };
    DiamondHillFit {
        ic50: ic_at(&fit, 50.0),
        ic90: ic_at(&fit, 90.0),
        ..fit
    }
}

fn decode(p: [f64; 3]) -> (f64, f64, f64) {
    (
        100.0 * sigmoid(p[0]),
        p[1].exp(),
        0.05 + 9.95 * sigmoid(p[2]),
    )
}
fn hill_value(p: [f64; 3], dose: f64) -> f64 {
    let (emax, ec50, slope) = decode(p);
    if dose <= 0.0 {
        0.0
    } else {
        emax / (1.0 + (ec50 / dose).powf(slope))
    }
}
fn hill_error(p: [f64; 3], series: &[(f64, f64)]) -> f64 {
    if p.iter().any(|v| !v.is_finite()) {
        return f64::INFINITY;
    }
    series
        .iter()
        .map(|(x, y)| (hill_value(p, *x) - y).powi(2))
        .sum()
}
fn nelder_mead(start: [f64; 3], series: &[(f64, f64)]) -> [f64; 3] {
    let mut simplex = vec![
        start,
        [start[0] + 0.5, start[1], start[2]],
        [start[0], start[1] + 0.5, start[2]],
        [start[0], start[1], start[2] + 0.5],
    ];
    for _ in 0..700 {
        simplex.sort_by(|a, b| hill_error(*a, series).total_cmp(&hill_error(*b, series)));
        if (hill_error(simplex[3], series) - hill_error(simplex[0], series)).abs() < 1e-12 {
            break;
        }
        let centroid: [f64; 3] =
            std::array::from_fn(|axis| simplex.iter().take(3).map(|p| p[axis]).sum::<f64>() / 3.0);
        let affine = |factor: f64| {
            std::array::from_fn(|axis| {
                centroid[axis] + factor * (simplex[3][axis] - centroid[axis])
            })
        };
        let reflected = affine(-1.0);
        if hill_error(reflected, series) < hill_error(simplex[0], series) {
            let expanded = affine(-2.0);
            simplex[3] = if hill_error(expanded, series) < hill_error(reflected, series) {
                expanded
            } else {
                reflected
            };
        } else if hill_error(reflected, series) < hill_error(simplex[2], series) {
            simplex[3] = reflected;
        } else {
            let contracted = affine(0.5);
            if hill_error(contracted, series) < hill_error(simplex[3], series) {
                simplex[3] = contracted;
            } else {
                let best = simplex[0];
                for point in simplex.iter_mut().skip(1) {
                    for axis in 0..3 {
                        point[axis] = best[axis] + 0.5 * (point[axis] - best[axis]);
                    }
                }
            }
        }
    }
    simplex.sort_by(|a, b| hill_error(*a, series).total_cmp(&hill_error(*b, series)));
    simplex[0]
}
fn ic_at(fit: &DiamondHillFit, level: f64) -> Option<f64> {
    if fit.maximum_inhibition <= level || level <= 0.0 {
        return None;
    }
    let value = fit.ec50 / (fit.maximum_inhibition / level - 1.0).powf(1.0 / fit.hill_slope);
    value.is_finite().then_some(value)
}
fn mean(values: &[f64]) -> f64 {
    values.iter().sum::<f64>() / values.len() as f64
}
fn sigmoid(value: f64) -> f64 {
    1.0 / (1.0 + (-value.clamp(-40.0, 40.0)).exp())
}
fn logit(value: f64) -> f64 {
    let v = value.clamp(1e-6, 1.0 - 1e-6);
    (v / (1.0 - v)).ln()
}
fn quantile(values: &[f64], probability: f64) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let index = probability * (sorted.len() - 1) as f64;
    let lower = index.floor() as usize;
    let upper = index.ceil() as usize;
    sorted[lower] + (index - lower as f64) * (sorted[upper] - sorted[lower])
}

struct SplitMix64 {
    state: u64,
}
impl SplitMix64 {
    fn new(seed: u64) -> Self {
        Self { state: seed }
    }
    fn next(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^ (z >> 31)
    }
    fn index(&mut self, length: usize) -> usize {
        (self.next() % length as u64) as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AssayRow;

    fn hill(dose: f64, ec50: f64) -> f64 {
        100.0 / (1.0 + ec50 / dose)
    }

    #[test]
    fn two_drug_fic_recovers_known_synergy() {
        let mut rows = vec![AssayRow {
            concentrations: vec![0.0, 0.0],
            od: 100.0,
        }];
        for dose in [0.25, 0.5, 1.0, 2.0, 4.0] {
            rows.push(AssayRow {
                concentrations: vec![dose, 0.0],
                od: 100.0 - hill(dose, 1.0),
            });
            rows.push(AssayRow {
                concentrations: vec![0.0, dose],
                od: 100.0 - hill(dose, 1.0),
            });
            let each = dose / 2.0;
            rows.push(AssayRow {
                concentrations: vec![each, each],
                od: 100.0 - hill(dose, 0.5),
            });
        }
        let result = analyze(
            &AssayInput {
                drug_names: vec!["A".into(), "B".into()],
                rows,
            },
            &[1.0, 1.0],
            DiamondPolicy {
                response_type: ResponseType::Viability,
                ..Default::default()
            },
            |_, _| {},
        )
        .unwrap();
        let score = result
            .total_scores
            .iter()
            .find(|score| score.inhibition_level == 50.0)
            .unwrap();
        assert!((score.fic - 0.5).abs() < 0.02, "{}", score.fic);
        assert_eq!(score.interpretation, DiamondInterpretation::Synergistic);
    }

    #[test]
    fn complete_checkerboard_adds_isobole_diagnostics_without_replacing_primary_fic() {
        let normalized_doses = [0.0, 0.25, 0.5, 1.0, 2.0, 4.0, 8.0];
        let rows = normalized_doses
            .iter()
            .flat_map(|a| {
                normalized_doses.iter().map(move |b| {
                    let inhibition = if *a + *b <= 0.0 {
                        0.0
                    } else {
                        hill(*a + *b, 1.0)
                    };
                    AssayRow {
                        concentrations: vec![*a * 2.0, *b * 4.0],
                        od: 100.0 - inhibition,
                    }
                })
            })
            .collect::<Vec<_>>();
        let result = analyze(
            &AssayInput {
                drug_names: vec!["A".into(), "B".into()],
                rows: rows.clone(),
            },
            &[2.0, 4.0],
            DiamondPolicy {
                response_type: ResponseType::Viability,
                ..Default::default()
            },
            |_, _| {},
        )
        .unwrap();
        let primary = result
            .total_scores
            .iter()
            .find(|score| score.inhibition_level == 50.0)
            .unwrap();
        let diagnostic = result
            .isobole_diagnostics
            .iter()
            .find(|diagnostic| diagnostic.inhibition_level == 50.0)
            .unwrap();
        assert!((primary.fic - 1.0).abs() < 0.02);
        assert!(
            (diagnostic.surface_fic.unwrap() - 1.0).abs() < 1e-6,
            "surface FIC was {:?}",
            diagnostic.surface_fic
        );
        assert_eq!(diagnostic.primary_fic, primary.fic);
        assert_eq!(diagnostic.agrees_with_primary, Some(true));
        assert_eq!(diagnostic.grid_shape, [7, 7]);
        assert!(!diagnostic.contour_segments.is_empty());

        let incomplete = rows
            .into_iter()
            .filter(|row| row.concentrations != [0.5, 2.0])
            .collect::<Vec<_>>();
        let result = analyze(
            &AssayInput {
                drug_names: vec!["A".into(), "B".into()],
                rows: incomplete,
            },
            &[2.0, 4.0],
            DiamondPolicy {
                response_type: ResponseType::Viability,
                ..Default::default()
            },
            |_, _| {},
        )
        .unwrap();
        assert!(result.isobole_diagnostics.is_empty());
    }

    #[test]
    fn all_zero_controls_detect_fractional_normalized_viability() {
        let mut rows = vec![AssayRow {
            concentrations: vec![0.0, 0.0],
            od: 1.0,
        }];
        for dose in [0.25, 0.5, 1.0, 2.0, 4.0] {
            rows.push(AssayRow {
                concentrations: vec![dose, 0.0],
                od: 1.0 - hill(dose, 1.0) / 100.0,
            });
            rows.push(AssayRow {
                concentrations: vec![0.0, dose],
                od: 1.0 - hill(dose, 1.0) / 100.0,
            });
            rows.push(AssayRow {
                concentrations: vec![dose / 2.0; 2],
                od: 1.0 - hill(dose, 0.5) / 100.0,
            });
        }

        let result = analyze(
            &AssayInput {
                drug_names: vec!["A".into(), "B".into()],
                rows,
            },
            &[1.0, 1.0],
            DiamondPolicy {
                // Deliberately supply the percentage variant: DiaMOND should
                // recognize the fractional scale from the untreated control.
                response_type: ResponseType::Viability,
                ..Default::default()
            },
            |_, _| {},
        )
        .unwrap();

        assert_eq!(result.policy.response_type, ResponseType::ViabilityFraction);
        assert!(
            result
                .warnings
                .iter()
                .any(|warning| warning.contains("fractional viability"))
        );
        let fic50 = result
            .total_scores
            .iter()
            .find(|score| score.inhibition_level == 50.0)
            .unwrap();
        assert!((fic50.fic - 0.5).abs() < 0.02, "{}", fic50.fic);
    }

    #[test]
    fn fractional_viability_retains_growth_above_the_control() {
        let mut rows = vec![AssayRow {
            concentrations: vec![0.0, 0.0],
            od: 1.0,
        }];
        for dose in [0.25, 0.5, 1.0, 2.0, 4.0] {
            rows.push(AssayRow {
                concentrations: vec![dose, 0.0],
                od: if dose == 0.25 {
                    1.442381274
                } else {
                    1.0 - hill(dose, 1.0) / 100.0
                },
            });
            rows.push(AssayRow {
                concentrations: vec![0.0, dose],
                od: 1.0 - hill(dose, 1.0) / 100.0,
            });
            rows.push(AssayRow {
                concentrations: vec![dose / 2.0; 2],
                od: 1.0 - hill(dose, 0.5) / 100.0,
            });
        }

        let result = analyze(
            &AssayInput {
                drug_names: vec!["A".into(), "B".into()],
                rows,
            },
            &[1.0, 1.0],
            DiamondPolicy {
                response_type: ResponseType::ViabilityFraction,
                ..Default::default()
            },
            |_, _| {},
        )
        .unwrap();

        let above_control = result
            .curves
            .iter()
            .find(|curve| curve.drug_names == ["A"])
            .unwrap()
            .points
            .iter()
            .find(|point| point.normalized_total_dose == 0.25)
            .unwrap();
        assert!((above_control.mean_inhibition + 44.2381274).abs() < 1e-9);
    }

    #[test]
    fn confidence_interval_controls_interaction_interpretation() {
        assert_eq!(
            interpret_score(0.7, Some(0.6), Some(1.05)),
            DiamondInterpretation::Additive
        );
        assert_eq!(
            interpret_score(0.9, Some(0.7), Some(0.99)),
            DiamondInterpretation::Synergistic
        );
        assert_eq!(
            interpret_score(1.1, Some(1.01), Some(1.3)),
            DiamondInterpretation::Antagonistic
        );
        assert_eq!(
            interpret_score(1.0, None, None),
            DiamondInterpretation::Additive
        );
    }

    #[test]
    fn three_drug_result_retains_pairwise_and_emergent_scores() {
        let mut rows = vec![AssayRow {
            concentrations: vec![0.0; 3],
            od: 100.0,
        }];
        for dose in [0.25, 0.5, 1.0, 2.0, 4.0] {
            for i in 0..3 {
                let mut c = vec![0.0; 3];
                c[i] = dose;
                rows.push(AssayRow {
                    concentrations: c,
                    od: 100.0 - hill(dose, 1.0),
                });
            }
            for pair in [[0, 1], [0, 2], [1, 2]] {
                let mut c = vec![0.0; 3];
                c[pair[0]] = dose / 2.0;
                c[pair[1]] = dose / 2.0;
                rows.push(AssayRow {
                    concentrations: c,
                    od: 100.0 - hill(dose, 1.0),
                });
            }
            rows.push(AssayRow {
                concentrations: vec![dose / 3.0; 3],
                od: 100.0 - hill(dose, 0.5),
            });
        }
        let result = analyze(
            &AssayInput {
                drug_names: vec!["A".into(), "B".into(), "C".into()],
                rows,
            },
            &[1.0; 3],
            DiamondPolicy {
                response_type: ResponseType::Viability,
                ..Default::default()
            },
            |_, _| {},
        )
        .unwrap();
        assert_eq!(result.pairwise_summaries.len(), 3);
        assert!((result.total_scores[0].fic - 0.5).abs() < 0.02);
        assert!((result.emergent_scores[0].fic - 0.5).abs() < 0.02);
    }

    #[test]
    fn bootstrap_is_reproducible() {
        let mut rows = vec![AssayRow {
            concentrations: vec![0.0, 0.0],
            od: 100.0,
        }];
        for dose in [0.25, 0.5, 1.0, 2.0] {
            for offset in [-1.0, 1.0] {
                rows.push(AssayRow {
                    concentrations: vec![dose, 0.0],
                    od: 100.0 - hill(dose, 1.0) + offset,
                });
                rows.push(AssayRow {
                    concentrations: vec![0.0, dose],
                    od: 100.0 - hill(dose, 1.0) - offset,
                });
                rows.push(AssayRow {
                    concentrations: vec![dose / 2.0; 2],
                    od: 100.0 - hill(dose, 0.8) + offset,
                });
            }
        }
        let input = AssayInput {
            drug_names: vec!["A".into(), "B".into()],
            rows,
        };
        let policy = DiamondPolicy {
            response_type: ResponseType::Viability,
            bootstrap_iterations: 20,
            ..Default::default()
        };
        assert_eq!(
            analyze(&input, &[1.0; 2], policy, |_, _| {}).unwrap(),
            analyze(&input, &[1.0; 2], policy, |_, _| {}).unwrap()
        );
    }
}
