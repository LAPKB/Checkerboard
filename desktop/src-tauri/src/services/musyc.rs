use checkerboard_core::drusano_greco::DrusanoDataSet;
use rand::{SeedableRng, rngs::StdRng};
use rand_distr::{Distribution, StandardNormal};
use rayon::prelude::*;
use serde::Serialize;
use std::sync::atomic::{AtomicUsize, Ordering};

pub const MODEL_SOURCE: &str = r#"# Two-drug MuSyC four-state equilibrium model
# Effects use Checkmate's normalized inhibition scale (E0 = 0; larger is more effective).
# C1 and C2 are fitted internally as fractions of each tested maximum.
U <-> A1:       (d1/C1)^h1,                                      1
U <-> A2:       (d2/C2)^h2,                                      1
A1 <-> A12:     C2^(-h2*gamma12)*(alpha12*d2)^(gamma12*h2),      1
A2 <-> A12:     C1^(-h1*gamma21)*(alpha21*d1)^(gamma21*h1),      1

predicted_effect = E0*U + E1*A1 + E2*A2 + E3*A12
beta = (E3 - max(E1, E2)) / max(E1, E2)
"#;

const PARAMETER_NAMES: [&str; 12] = [
    "e0", "e1", "e2", "e3", "c1", "c2", "h1", "h2", "alpha_12", "alpha_21", "gamma_12", "gamma_21",
];

// Optimized coordinates omit fixed E0. C, alpha, gamma and h use log coordinates.
const LOWER: [f64; 11] = [
    -0.25,
    -0.25,
    -0.25,
    -6.907755278982137,
    -6.907755278982137,
    -2.302585092994046,
    -2.302585092994046,
    -4.605170185988091,
    -4.605170185988091,
    -2.302585092994046,
    -2.302585092994046,
];
const UPPER: [f64; 11] = [
    1.25,
    1.25,
    1.25,
    1.3862943611198906,
    1.3862943611198906,
    2.302585092994046,
    2.302585092994046,
    4.605170185988091,
    4.605170185988091,
    2.302585092994046,
    2.302585092994046,
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusycParameterEstimate {
    pub name: String,
    pub value: f64,
    pub fixed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusycPredictionPoint {
    pub well_id: String,
    pub observed_effect: f64,
    pub predicted_effect: f64,
    pub observed_response: f64,
    pub predicted_response: f64,
    pub normalized_doses: Vec<f64>,
    pub censored: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusycRegressionSummary {
    pub observations: usize,
    pub slope: f64,
    pub intercept: f64,
    pub r_squared: f64,
    pub root_mean_squared_error: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusycParameterSummary {
    pub name: String,
    pub mean: f64,
    pub standard_deviation: f64,
    #[serde(rename = "percentile2_5")]
    pub percentile2_5: f64,
    pub median: f64,
    #[serde(rename = "percentile97_5")]
    pub percentile97_5: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusycDistributionSummary {
    pub mean: f64,
    pub standard_deviation: f64,
    #[serde(rename = "percentile2_5")]
    pub percentile2_5: f64,
    pub median: f64,
    #[serde(rename = "percentile97_5")]
    pub percentile97_5: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusycFitResult {
    pub data: DrusanoDataSet,
    pub model_source: String,
    pub parameters: Vec<MusycParameterEstimate>,
    pub parameter_summaries: Vec<MusycParameterSummary>,
    pub efficacy_beta: f64,
    pub efficacy_beta_summary: Option<MusycDistributionSummary>,
    pub combination_efficacy: f64,
    pub combination_efficacy_summary: Option<MusycDistributionSummary>,
    pub objective_function: f64,
    pub iterations: usize,
    pub converged: bool,
    pub predictions: Vec<MusycPredictionPoint>,
    pub regression: Option<MusycRegressionSummary>,
    pub residual_standard_deviation: f64,
    pub bootstrap_iterations: usize,
    pub bootstrap_seed: u64,
    pub bootstrap_converged_count: usize,
    pub warnings: Vec<String>,
}

pub fn fit(data: DrusanoDataSet, max_iterations: usize) -> anyhow::Result<MusycFitResult> {
    fit_once(data, max_iterations, None, |_, _| {}).map(|value| value.0)
}

pub fn fit_with_bootstrap(
    data: DrusanoDataSet,
    max_iterations: usize,
    bootstrap_iterations: usize,
    bootstrap_seed: u64,
    on_progress: impl Fn(&str, usize, f64, usize, usize) + Send + Sync,
) -> anyhow::Result<MusycFitResult> {
    anyhow::ensure!((1..=10_000).contains(&bootstrap_iterations), "MuSyC bootstrap iterations must be between 1 and 10000");
    let (mut reference, reference_coordinates) = fit_once(
        data.clone(),
        max_iterations,
        None,
        |iteration, objective| on_progress("reference", iteration, objective, 0, bootstrap_iterations),
    )?;
    let sigma = reference_residual_sd(&reference)?;
    anyhow::ensure!(sigma.is_finite() && sigma >= 0.0, "MuSyC bootstrap residual SD is not finite");
    let reference_parameters: [f64; 12] = std::array::from_fn(|index| reference.parameters[index].value);
    let mut rng = StdRng::seed_from_u64(bootstrap_seed);
    let data_sets = (0..bootstrap_iterations)
        .map(|_| parametric_bootstrap_dataset(&data, &reference_parameters, sigma, &mut rng))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let completed = AtomicUsize::new(0);
    let fits = data_sets
        .into_par_iter()
        .map(|bootstrap_data| {
            let fitted = fit_once(bootstrap_data, max_iterations, Some(reference_coordinates), |_, _| {})?.0;
            let completed_count = completed.fetch_add(1, Ordering::Relaxed) + 1;
            on_progress("bootstrap", fitted.iterations, fitted.objective_function, completed_count, bootstrap_iterations);
            Ok(fitted)
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    reference.parameter_summaries = (0..PARAMETER_NAMES.len()).map(|column| {
        let values = fits.iter().map(|fit| fit.parameters[column].value).collect::<Vec<_>>();
        let summary = distribution_summary(&values).expect("MuSyC parameter estimates are finite");
        MusycParameterSummary {
            name: PARAMETER_NAMES[column].into(),
            mean: summary.mean,
            standard_deviation: summary.standard_deviation,
            percentile2_5: summary.percentile2_5,
            median: summary.median,
            percentile97_5: summary.percentile97_5,
        }
    }).collect();
    reference.efficacy_beta_summary = distribution_summary(&fits.iter().map(|fit| fit.efficacy_beta).collect::<Vec<_>>());
    reference.combination_efficacy_summary = distribution_summary(&fits.iter().map(|fit| fit.combination_efficacy).collect::<Vec<_>>());
    reference.residual_standard_deviation = sigma;
    reference.bootstrap_iterations = bootstrap_iterations;
    reference.bootstrap_seed = bootstrap_seed;
    reference.bootstrap_converged_count = fits.iter().filter(|fit| fit.converged).count();
    Ok(reference)
}

fn fit_once(
    data: DrusanoDataSet,
    max_iterations: usize,
    initial_override: Option<[f64; 11]>,
    on_iteration: impl Fn(usize, f64),
) -> anyhow::Result<(MusycFitResult, [f64; 11])> {
    anyhow::ensure!(
        data.drug_names.len() == 2,
        "MuSyC currently requires exactly two drugs"
    );
    anyhow::ensure!(
        (100..=50_000).contains(&max_iterations),
        "MuSyC maximum iterations must be between 100 and 50000"
    );
    let monotherapy_1 = initial_monotherapy(&data, 0);
    let monotherapy_2 = initial_monotherapy(&data, 1);
    let high_corner = data
        .wells
        .iter()
        .filter(|well| {
            (well.normalized_doses[0] - 1.0).abs() < 1e-12
                && (well.normalized_doses[1] - 1.0).abs() < 1e-12
        })
        .map(|well| well.normalized_effect)
        .collect::<Vec<_>>();
    let combination_effect = if high_corner.is_empty() {
        data.wells
            .iter()
            .filter(|well| well.normalized_doses[0] > 0.0 && well.normalized_doses[1] > 0.0)
            .map(|well| well.normalized_effect)
            .fold(f64::NEG_INFINITY, f64::max)
    } else {
        high_corner.iter().sum::<f64>() / high_corner.len() as f64
    }
    .clamp(-0.2, 1.2);
    let initial = initial_override.unwrap_or([
        monotherapy_1[0],
        monotherapy_2[0],
        combination_effect,
        monotherapy_1[1].ln(),
        monotherapy_2[1].ln(),
        monotherapy_1[2].ln(),
        monotherapy_2[2].ln(),
        0.0,
        0.0,
        0.0,
        0.0,
    ]);
    let (coordinates, objective_function, iterations, converged) =
        least_squares(initial, &data, max_iterations, on_iteration);
    let parameters = decode(coordinates);
    let response_span = data.control_mean - data.blank_value;
    let predictions = data
        .wells
        .iter()
        .filter_map(|well| {
            let predicted_effect = predict_effect(
                well.normalized_doses[0],
                well.normalized_doses[1],
                &parameters,
            )?;
            Some(MusycPredictionPoint {
                well_id: well.well_id.clone(),
                observed_effect: well.normalized_effect,
                predicted_effect,
                observed_response: well.raw_response,
                predicted_response: data.blank_value + response_span * (1.0 - predicted_effect),
                normalized_doses: well.normalized_doses.clone(),
                censored: well.censored,
            })
        })
        .collect::<Vec<_>>();
    let regression = regression(&predictions);
    let strongest_single = parameters[1].max(parameters[2]);
    let efficacy_beta = if strongest_single.abs() > 1e-12 {
        (parameters[3] - strongest_single) / strongest_single
    } else {
        f64::NAN
    };
    let mut warnings = data.warnings.clone();
    if !converged {
        warnings.push(
            "MuSyC reached the iteration limit before the bounded least-squares convergence criterion.".into(),
        );
    }
    if strongest_single <= 0.0 {
        warnings.push(
            "Efficacy beta is undefined because neither fitted monotherapy efficacy is positive."
                .into(),
        );
    }
    let coordinate_names = [
        "E1", "E2", "E3", "C1", "C2", "h1", "h2", "alpha12", "alpha21", "gamma12", "gamma21",
    ];
    let boundary_parameters = coordinates
        .iter()
        .enumerate()
        .filter(|(index, value)| {
            let tolerance = (UPPER[*index] - LOWER[*index]).abs() * 1e-5;
            (**value - LOWER[*index]).abs() <= tolerance
                || (**value - UPPER[*index]).abs() <= tolerance
        })
        .map(|(index, _)| coordinate_names[index])
        .collect::<Vec<_>>();
    if !boundary_parameters.is_empty() {
        warnings.push(format!(
            "Parameter estimate(s) at a fitting bound: {}. Interaction parameters and beta may be weakly identified; do not rank regimens from point estimates alone.",
            boundary_parameters.join(", ")
        ));
    }
    let result = MusycFitResult {
        data,
        model_source: MODEL_SOURCE.into(),
        parameters: PARAMETER_NAMES
            .iter()
            .enumerate()
            .map(|(index, name)| MusycParameterEstimate {
                name: (*name).into(),
                value: parameters[index],
                fixed: index == 0,
            })
            .collect(),
        parameter_summaries: vec![],
        efficacy_beta,
        efficacy_beta_summary: None,
        combination_efficacy: parameters[3],
        combination_efficacy_summary: None,
        objective_function,
        iterations,
        converged,
        predictions,
        regression,
        residual_standard_deviation: 0.0,
        bootstrap_iterations: 0,
        bootstrap_seed: 0,
        bootstrap_converged_count: 0,
        warnings,
    };
    Ok((result, coordinates))
}

fn initial_monotherapy(data: &DrusanoDataSet, drug: usize) -> [f64; 3] {
    let points = data
        .wells
        .iter()
        .filter(|well| {
            well.normalized_doses[drug] > 0.0
                && well.normalized_doses[1 - drug] <= 1e-12
                && !well.censored
        })
        .map(|well| (well.normalized_doses[drug], well.normalized_effect))
        .collect::<Vec<_>>();
    let emax = points
        .iter()
        .map(|point| point.1)
        .fold(0.5, f64::max)
        .clamp(0.01, 1.2);
    let half = emax / 2.0;
    let c = points
        .iter()
        .min_by(|left, right| (left.1 - half).abs().total_cmp(&(right.1 - half).abs()))
        .map(|point| point.0)
        .unwrap_or(0.25)
        .clamp(0.001, 4.0);
    fit_monotherapy(&points, [emax, c.ln(), 0.0])
}

fn reference_residual_sd(result: &MusycFitResult) -> anyhow::Result<f64> {
    let residuals = result.predictions.iter()
        .filter(|point| !point.censored)
        .map(|point| point.observed_effect - point.predicted_effect)
        .collect::<Vec<_>>();
    anyhow::ensure!(
        residuals.len() > 11,
        "MuSyC bootstrap requires at least 12 uncensored drug-exposed wells to estimate residual variance; found {}",
        residuals.len(),
    );
    let degrees_of_freedom = (residuals.len() - 11) as f64;
    Ok((residuals.iter().map(|value| value * value).sum::<f64>() / degrees_of_freedom).sqrt())
}

fn parametric_bootstrap_dataset(
    source: &DrusanoDataSet,
    parameters: &[f64; 12],
    sigma: f64,
    rng: &mut StdRng,
) -> anyhow::Result<DrusanoDataSet> {
    let response_span = source.control_mean - source.blank_value;
    let mut generated = source.clone();
    generated.censored_count = 0;
    for well in &mut generated.wells {
        let prediction = predict_effect(well.normalized_doses[0], well.normalized_doses[1], parameters)
            .ok_or_else(|| anyhow::anyhow!("reference MuSyC parameters generated a non-finite prediction"))?;
        let residual: f64 = StandardNormal.sample(rng);
        let simulated_effect = prediction + sigma * residual;
        anyhow::ensure!(simulated_effect.is_finite(), "MuSyC bootstrap generated a non-finite effect");
        let simulated_response = source.blank_value + response_span * (1.0 - simulated_effect);
        well.raw_response = simulated_response;
        well.censored = source.response_censor_limit.is_some_and(|limit| simulated_response <= limit);
        if well.censored {
            generated.censored_count += 1;
            well.normalized_effect = source.normalized_effect_censor_limit
                .expect("censored MuSyC bootstrap responses require an effect boundary");
        } else {
            well.normalized_effect = simulated_effect;
        }
    }
    Ok(generated)
}

fn distribution_summary(values: &[f64]) -> Option<MusycDistributionSummary> {
    let mut values = values.iter().copied().filter(|value| value.is_finite()).collect::<Vec<_>>();
    if values.is_empty() {
        return None;
    }
    values.sort_by(f64::total_cmp);
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    let standard_deviation = if values.len() > 1 {
        (values.iter().map(|value| (value - mean).powi(2)).sum::<f64>() / (values.len() - 1) as f64).sqrt()
    } else {
        0.0
    };
    Some(MusycDistributionSummary {
        mean,
        standard_deviation,
        percentile2_5: quantile(&values, 0.025),
        median: quantile(&values, 0.5),
        percentile97_5: quantile(&values, 0.975),
    })
}

fn quantile(sorted: &[f64], probability: f64) -> f64 {
    if sorted.len() == 1 {
        return sorted[0];
    }
    let position = probability.clamp(0.0, 1.0) * (sorted.len() - 1) as f64;
    let lower = position.floor() as usize;
    let upper = position.ceil() as usize;
    sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower as f64)
}

fn fit_monotherapy(points: &[(f64, f64)], initial: [f64; 3]) -> [f64; 3] {
    let lower = [-0.25, LOWER[3], LOWER[5]];
    let upper = [1.25, UPPER[3], UPPER[5]];
    let clamp_point = |mut point: [f64; 3]| {
        for index in 0..3 {
            point[index] = point[index].clamp(lower[index], upper[index]);
        }
        point
    };
    let score = |point: [f64; 3]| {
        let emax = point[0];
        let c = point[1].exp();
        let h = point[2].exp();
        points
            .iter()
            .map(|(dose, observed)| {
                let ratio = (dose / c).powf(h);
                (observed - emax * ratio / (1.0 + ratio)).powi(2)
            })
            .sum::<f64>()
    };
    let mut simplex = vec![
        clamp_point(initial),
        clamp_point([initial[0] + 0.08, initial[1], initial[2]]),
        clamp_point([initial[0], initial[1] + 0.25, initial[2]]),
        clamp_point([initial[0], initial[1], initial[2] + 0.25]),
    ];
    let mut scores = simplex.iter().copied().map(score).collect::<Vec<_>>();
    for _ in 0..2_000 {
        let mut order = (0..4).collect::<Vec<_>>();
        order.sort_by(|left, right| scores[*left].total_cmp(&scores[*right]));
        simplex = order.iter().map(|index| simplex[*index]).collect();
        scores = order.iter().map(|index| scores[*index]).collect();
        if scores[3] - scores[0] < 1e-12 {
            break;
        }
        let mut centroid = [0.0; 3];
        for point in simplex.iter().take(3) {
            for index in 0..3 {
                centroid[index] += point[index] / 3.0;
            }
        }
        let candidate = |factor: f64| {
            clamp_point(std::array::from_fn(|index| {
                centroid[index] + factor * (centroid[index] - simplex[3][index])
            }))
        };
        let reflected = candidate(1.0);
        let reflected_score = score(reflected);
        if reflected_score < scores[0] {
            let expanded = candidate(2.0);
            let expanded_score = score(expanded);
            (simplex[3], scores[3]) = if expanded_score < reflected_score {
                (expanded, expanded_score)
            } else {
                (reflected, reflected_score)
            };
        } else if reflected_score < scores[2] {
            (simplex[3], scores[3]) = (reflected, reflected_score);
        } else {
            let contracted = candidate(-0.5);
            let contracted_score = score(contracted);
            if contracted_score < scores[3] {
                (simplex[3], scores[3]) = (contracted, contracted_score);
            } else {
                let best = simplex[0];
                for point in simplex.iter_mut().skip(1) {
                    for index in 0..3 {
                        point[index] = best[index] + 0.5 * (point[index] - best[index]);
                    }
                    *point = clamp_point(*point);
                }
                for index in 1..4 {
                    scores[index] = score(simplex[index]);
                }
            }
        }
    }
    let best = scores
        .iter()
        .enumerate()
        .min_by(|left, right| left.1.total_cmp(right.1))
        .map(|entry| entry.0)
        .unwrap_or(0);
    [
        simplex[best][0],
        simplex[best][1].exp(),
        simplex[best][2].exp(),
    ]
}

fn decode(value: [f64; 11]) -> [f64; 12] {
    [
        0.0,
        value[0],
        value[1],
        value[2],
        value[3].exp(),
        value[4].exp(),
        value[5].exp(),
        value[6].exp(),
        value[7].exp(),
        value[8].exp(),
        value[9].exp(),
        value[10].exp(),
    ]
}

pub fn predict_effect(d1: f64, d2: f64, p: &[f64; 12]) -> Option<f64> {
    if !d1.is_finite() || !d2.is_finite() || d1 < 0.0 || d2 < 0.0 {
        return None;
    }
    if d1 <= 1e-15 && d2 <= 1e-15 {
        return Some(p[0]);
    }
    if d2 <= 1e-15 {
        let ratio = (d1 / p[4]).powf(p[6]);
        return Some((p[0] + p[1] * ratio) / (1.0 + ratio));
    }
    if d1 <= 1e-15 {
        let ratio = (d2 / p[5]).powf(p[7]);
        return Some((p[0] + p[2] * ratio) / (1.0 + ratio));
    }
    // Match synergy.combination.MuSyC's default r1r=r2r=1 kinetic
    // normalization exactly. Equal transition ratios are not sufficient away
    // from detailed balance because absolute edge rates affect the stationary
    // distribution.
    let r1 = 1.0 / p[4].powf(p[6]);
    let r2 = 1.0 / p[5].powf(p[7]);
    let a = r1 * d1.powf(p[6]);
    let b = r2 * d2.powf(p[7]);
    let c = 1.0;
    let d = 1.0;
    let e = r2.powf(p[10]) * (p[8] * d2).powf(p[10] * p[7]);
    let f = 1.0;
    let g = r1.powf(p[11]) * (p[9] * d1).powf(p[11] * p[6]);
    let h = 1.0;
    let mut matrix = [
        [-(a + b), c, d, 0.0, 0.0],
        [a, -(c + e), 0.0, f, 0.0],
        [b, 0.0, -(g + d), h, 0.0],
        [1.0, 1.0, 1.0, 1.0, 1.0],
    ];
    for column in 0..4 {
        let pivot = (column..4).max_by(|left, right| {
            matrix[*left][column]
                .abs()
                .total_cmp(&matrix[*right][column].abs())
        })?;
        if matrix[pivot][column].abs() < 1e-14 {
            return None;
        }
        matrix.swap(column, pivot);
        let divisor = matrix[column][column];
        for value in column..=4 {
            matrix[column][value] /= divisor;
        }
        for row in 0..4 {
            if row == column {
                continue;
            }
            let factor = matrix[row][column];
            for value in column..=4 {
                matrix[row][value] -= factor * matrix[column][value];
            }
        }
    }
    let states = [matrix[0][4], matrix[1][4], matrix[2][4], matrix[3][4]];
    let prediction = states
        .iter()
        .zip(&p[..4])
        .map(|(state, effect)| state * effect)
        .sum::<f64>();
    prediction.is_finite().then_some(prediction)
}

fn loss(value: [f64; 11], data: &DrusanoDataSet) -> f64 {
    let residuals = residuals(value, data);
    residuals.iter().map(|value| value * value).sum::<f64>() / residuals.len().max(1) as f64
}

fn residuals(value: [f64; 11], data: &DrusanoDataSet) -> Vec<f64> {
    let parameters = decode(value);
    let boundary = data.normalized_effect_censor_limit;
    data.wells
        .iter()
        .map(|well| {
            let Some(prediction) = predict_effect(
                well.normalized_doses[0],
                well.normalized_doses[1],
                &parameters,
            ) else {
                return 1e6;
            };
            if well.censored {
                (boundary.unwrap_or(well.normalized_effect) - prediction).max(0.0)
            } else {
                well.normalized_effect - prediction
            }
        })
        .collect()
}

fn clamp(mut value: [f64; 11]) -> [f64; 11] {
    for index in 0..11 {
        value[index] = value[index].clamp(LOWER[index], UPPER[index]);
    }
    value
}

fn least_squares(
    initial: [f64; 11],
    data: &DrusanoDataSet,
    max_iterations: usize,
    on_iteration: impl Fn(usize, f64),
) -> ([f64; 11], f64, usize, bool) {
    const N: usize = 11;
    let mut point = clamp(initial);
    let mut current_residuals = residuals(point, data);
    let mut objective = loss(point, data);
    let mut damping = 1e-3;
    for iteration in 0..max_iterations {
        if iteration == 0 || (iteration + 1) % 10 == 0 {
            on_iteration(iteration + 1, objective);
        }
        let mut jacobian = vec![[0.0; N]; current_residuals.len()];
        for column in 0..N {
            let step = 1e-5 * (1.0 + point[column].abs());
            let mut upper = point;
            let mut lower = point;
            upper[column] = (upper[column] + step).min(UPPER[column]);
            lower[column] = (lower[column] - step).max(LOWER[column]);
            let denominator = upper[column] - lower[column];
            if denominator <= f64::EPSILON {
                continue;
            }
            let upper_residuals = residuals(upper, data);
            let lower_residuals = residuals(lower, data);
            for row in 0..current_residuals.len() {
                jacobian[row][column] = (upper_residuals[row] - lower_residuals[row]) / denominator;
            }
        }
        let mut normal = [[0.0; N]; N];
        let mut gradient = [0.0; N];
        for row in 0..current_residuals.len() {
            for left in 0..N {
                gradient[left] += jacobian[row][left] * current_residuals[row];
                for right in 0..N {
                    normal[left][right] += jacobian[row][left] * jacobian[row][right];
                }
            }
        }
        for index in 0..N {
            normal[index][index] += damping * normal[index][index].max(1.0);
        }
        let Some(delta) = solve_normal_system(normal, gradient.map(|value| -value)) else {
            damping *= 10.0;
            continue;
        };
        let candidate = clamp(std::array::from_fn(|index| point[index] + delta[index]));
        let candidate_objective = loss(candidate, data);
        if candidate_objective < objective {
            let improvement = objective - candidate_objective;
            point = candidate;
            objective = candidate_objective;
            current_residuals = residuals(point, data);
            damping = (damping / 3.0).max(1e-12);
            if improvement < 1e-12 || delta.iter().copied().map(f64::abs).fold(0.0, f64::max) < 1e-7
            {
                on_iteration(iteration + 1, objective);
                return (point, objective, iteration + 1, true);
            }
        } else {
            damping = (damping * 10.0).min(1e12);
        }
    }
    on_iteration(max_iterations, objective);
    (point, objective, max_iterations, false)
}

fn solve_normal_system(mut matrix: [[f64; 11]; 11], mut rhs: [f64; 11]) -> Option<[f64; 11]> {
    for column in 0..11 {
        let pivot = (column..11).max_by(|left, right| {
            matrix[*left][column]
                .abs()
                .total_cmp(&matrix[*right][column].abs())
        })?;
        if matrix[pivot][column].abs() < 1e-14 {
            return None;
        }
        matrix.swap(column, pivot);
        rhs.swap(column, pivot);
        let divisor = matrix[column][column];
        for value in column..11 {
            matrix[column][value] /= divisor;
        }
        rhs[column] /= divisor;
        for row in 0..11 {
            if row == column {
                continue;
            }
            let factor = matrix[row][column];
            for value in column..11 {
                matrix[row][value] -= factor * matrix[column][value];
            }
            rhs[row] -= factor * rhs[column];
        }
    }
    Some(rhs)
}

fn regression(points: &[MusycPredictionPoint]) -> Option<MusycRegressionSummary> {
    let points = points
        .iter()
        .filter(|point| !point.censored)
        .collect::<Vec<_>>();
    if points.len() < 2 {
        return None;
    }
    let n = points.len() as f64;
    let mean_x = points
        .iter()
        .map(|point| point.predicted_effect)
        .sum::<f64>()
        / n;
    let mean_y = points
        .iter()
        .map(|point| point.observed_effect)
        .sum::<f64>()
        / n;
    let sxx = points
        .iter()
        .map(|point| (point.predicted_effect - mean_x).powi(2))
        .sum::<f64>();
    if sxx <= f64::EPSILON {
        return None;
    }
    let slope = points
        .iter()
        .map(|point| (point.predicted_effect - mean_x) * (point.observed_effect - mean_y))
        .sum::<f64>()
        / sxx;
    let intercept = mean_y - slope * mean_x;
    let residual_sum = points
        .iter()
        .map(|point| (point.observed_effect - point.predicted_effect).powi(2))
        .sum::<f64>();
    let total_sum = points
        .iter()
        .map(|point| (point.observed_effect - mean_y).powi(2))
        .sum::<f64>();
    Some(MusycRegressionSummary {
        observations: points.len(),
        slope,
        intercept,
        r_squared: if total_sum > 0.0 {
            1.0 - residual_sum / total_sum
        } else {
            1.0
        },
        root_mean_squared_error: (residual_sum / n).sqrt(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use checkerboard_core::drusano_greco::DrusanoWell;

    #[test]
    fn boundaries_reduce_to_four_parameter_hill_curves() {
        let p = [0.0, 0.8, 0.6, 0.95, 0.25, 0.5, 1.5, 2.0, 3.0, 0.5, 1.2, 0.8];
        assert!((predict_effect(0.25, 0.0, &p).unwrap() - 0.4).abs() < 1e-12);
        assert!((predict_effect(0.0, 0.5, &p).unwrap() - 0.3).abs() < 1e-12);
    }

    #[test]
    fn predictions_match_synergy_1_0_0_generalized_rate_model() {
        // Generated with synergy.combination.MuSyC._model using r1r=r2r=1.
        let p = [
            0.0, 0.72, 0.61, 0.96, 0.18, 0.32, 1.2, 1.8, 1.7, 0.75, 1.3, 0.8,
        ];
        let cases = [
            (0.0, 0.0, 0.0),
            (0.18, 0.0, 0.36),
            (0.0, 0.32, 0.305),
            (0.07, 0.21, 0.365_000_721_732_198),
            (0.5, 0.4, 0.783_416_419_344_482_4),
            (1.0, 1.0, 0.880_658_731_132_738),
        ];
        for (d1, d2, expected) in cases {
            let actual = predict_effect(d1, d2, &p).unwrap();
            assert!(
                (actual - expected).abs() < 1e-12,
                "({d1}, {d2}): {actual} != {expected}"
            );
        }
    }

    #[test]
    fn efficacy_beta_is_positive_when_combination_state_is_more_effective() {
        let strongest_single: f64 = 0.8;
        let e3: f64 = 1.0;
        assert!(((e3 - strongest_single) / strongest_single - 0.25).abs() < 1e-12);
    }

    #[test]
    fn parametric_bootstrap_reapplies_the_absorbance_censor_boundary() {
        let source = DrusanoDataSet {
            drug_names: vec!["A".into(), "B".into()], headers: vec![], rows: vec![],
            wells: vec![DrusanoWell {
                well_id: "A1".into(), raw_response: 0.15, normalized_effect: 0.8,
                normalized_doses: vec![1.0, 1.0], censored: true,
            }],
            eligible_well_count: 1, control_count: 1, excluded_boundary_count: 0,
            excluded_effect_below_zero_count: 0, excluded_effect_above_one_count: 0,
            censored_count: 1, response_censor_limit: Some(0.2),
            normalized_effect_censor_limit: Some(0.8), blank_value: 0.0,
            control_mean: 1.0, max_concentrations: vec![1.0, 1.0], warnings: vec![],
        };
        let parameters = [0.0, 1.25, 1.25, 1.25, 0.001, 0.001, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0];
        let mut rng = StdRng::seed_from_u64(123);
        let generated = parametric_bootstrap_dataset(&source, &parameters, 0.0, &mut rng).unwrap();
        assert!(generated.wells[0].censored);
        assert_eq!(generated.wells[0].normalized_effect, 0.8);
        assert_eq!(generated.wells[0].normalized_doses, [1.0, 1.0]);
        assert_eq!(generated.censored_count, 1);
    }

    #[test]
    fn synthetic_surface_fit_recovers_predictions_and_positive_efficacy_synergy() {
        let truth = [
            0.0, 0.72, 0.61, 0.96, 0.18, 0.32, 1.2, 1.8, 1.7, 0.75, 1.0, 1.0,
        ];
        let doses = [0.0, 0.03125, 0.0625, 0.125, 0.25, 0.5, 1.0];
        let mut wells = Vec::new();
        for (row, d1) in doses.iter().enumerate() {
            for (column, d2) in doses.iter().enumerate() {
                if row == 0 && column == 0 {
                    continue;
                }
                let effect = predict_effect(*d1, *d2, &truth).unwrap();
                wells.push(DrusanoWell {
                    well_id: format!("{}-{}", row + 1, column + 1),
                    raw_response: 1.0 - effect,
                    normalized_effect: effect,
                    normalized_doses: vec![*d1, *d2],
                    censored: false,
                });
            }
        }
        let count = wells.len();
        let data = DrusanoDataSet {
                drug_names: vec!["A".into(), "B".into()],
                headers: vec![],
                rows: vec![],
                wells,
                eligible_well_count: count,
                control_count: 1,
                excluded_boundary_count: 0,
                excluded_effect_below_zero_count: 0,
                excluded_effect_above_one_count: 0,
                censored_count: 0,
                response_censor_limit: None,
                normalized_effect_censor_limit: None,
                blank_value: 0.0,
                control_mean: 1.0,
                max_concentrations: vec![1.0, 1.0],
                warnings: vec![],
            };
        let result = fit(data.clone(), 10_000).unwrap();
        assert!(result.regression.unwrap().r_squared > 0.995);
        assert!(result.efficacy_beta > 0.05);

        let bootstrapped = fit_with_bootstrap(data.clone(), 10_000, 4, 123, |_, _, _, _, _| {}).unwrap();
        let repeated = fit_with_bootstrap(data, 10_000, 4, 123, |_, _, _, _, _| {}).unwrap();
        assert_eq!(bootstrapped.bootstrap_iterations, 4);
        assert_eq!(bootstrapped.bootstrap_seed, 123);
        assert_eq!(bootstrapped.parameter_summaries.len(), 12);
        assert!(bootstrapped.efficacy_beta_summary.is_some());
        assert!(bootstrapped.combination_efficacy_summary.is_some());
        assert!(bootstrapped.residual_standard_deviation < 0.02);
        let serialized = serde_json::to_value(&bootstrapped).unwrap();
        assert!(serialized["parameterSummaries"][1]["percentile2_5"].is_number());
        assert!(serialized["efficacyBetaSummary"]["percentile97_5"].is_number());
        assert_eq!(
            bootstrapped.parameter_summaries[8].median,
            repeated.parameter_summaries[8].median,
        );
    }
}
