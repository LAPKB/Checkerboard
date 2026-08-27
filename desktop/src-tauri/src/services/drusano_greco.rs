use std::collections::HashMap;

use checkerboard_core::drusano_greco::{DrusanoDataSet, DrusanoWell};
use pharmsol::{Analytical, Covariates, equation::metadata, simulator::V};
use pmcore::prelude::pharmsol::Censor;
use pmcore::prelude::{
    AssayErrorModel, AssayErrorModels, CycleFlow, Data, ErrorPoly, EstimationProblem,
    FitController, NpagConfig, ParameterSpace, Subject, SubjectBuilderExt, Theta, pharmsol,
};
use rand::{Rng, SeedableRng, rngs::StdRng};
use rand_distr::{Distribution, StandardNormal};
use serde::{Deserialize, Serialize};

pub const MODEL_SOURCE: &str = r#"# Numerical Drusano-Greco Equation 2 prediction model
# d1 and d2 are dimensionless dose/MIC covariates.
# E and XM0 are dimensionless; absorbance remains on the imported response scale.

u = d1 / ec50_1
v = d2 / ec50_2
w = alpha_12 * u * v
h_1 = 1 / h1
h_2 = 1 / h2
h_12 = (h_1 + h_2) / 2

solve XM0 > 0 such that:
    1 = u / XM0^h_1 + v / XM0^h_2 + w / XM0^h_12

predicted_effect = XM0 / (1 + XM0)
predicted_absorbance = blank + response_span * (1 - predicted_effect)

error_sd = sqrt(lambda^2 + (
    C0 + C1*predicted_absorbance
       + C2*predicted_absorbance^2
       + C3*predicted_absorbance^3
)^2)
"#;

const DEFAULT_PRIOR_POINTS: usize = 256;
pub const DEFAULT_MAX_CYCLES: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DrusanoAssayErrorSettings {
    pub coefficients: [f64; 4],
    pub lambda: f64,
}

impl Default for DrusanoAssayErrorSettings {
    fn default() -> Self {
        Self {
            coefficients: [0.05, 0.05, 0.0, 0.0],
            lambda: 0.0,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrusanoAssayErrorSummary {
    pub coefficients: [f64; 4],
    pub initial_lambda: f64,
    pub fitted_lambda: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrusanoSupportPoint {
    pub values: Vec<f64>,
    pub probability: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrusanoFitContinuation {
    pub support_points: Vec<DrusanoSupportPoint>,
    pub fitted_lambda: f64,
    pub completed_cycles: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrusanoParameterSummary {
    pub name: String,
    pub mean: f64,
    pub standard_deviation: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrusanoPredictionPoint {
    pub subject_id: String,
    pub observed_effect: f64,
    pub predicted_effect: f64,
    pub censored: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrusanoRegressionSummary {
    pub observations: usize,
    pub slope: f64,
    pub intercept: f64,
    pub r_squared: f64,
    pub root_mean_squared_error: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrusanoFitResult {
    pub data: DrusanoDataSet,
    pub assay_error: DrusanoAssayErrorSummary,
    pub model_source: String,
    pub parameter_names: Vec<String>,
    pub support_points: Vec<DrusanoSupportPoint>,
    pub parameter_summaries: Vec<DrusanoParameterSummary>,
    pub predictions: Vec<DrusanoPredictionPoint>,
    pub regression: Option<DrusanoRegressionSummary>,
    pub unpredicted_count: usize,
    pub converged: bool,
    /// Total cycles across the initial run and any warm continuations.
    pub cycles: usize,
    /// Cycles completed by this invocation.
    pub run_cycles: usize,
    /// Cycle cap applied to this invocation.
    pub max_cycles: usize,
    /// Total cycle count before this invocation began.
    pub continued_from_cycles: usize,
    pub objective_function: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrusanoRegimenSimulationRequest {
    pub drug_names: Vec<String>,
    pub parameter_names: Vec<String>,
    pub support_points: Vec<DrusanoSupportPoint>,
    pub mic_values: Vec<f64>,
    pub concentrations: Vec<f64>,
    #[serde(default = "default_simulation_count")]
    pub simulation_count: usize,
    #[serde(default = "default_simulation_seed")]
    pub seed: u64,
}

fn default_simulation_count() -> usize {
    1_000
}

fn default_simulation_seed() -> u64 {
    17
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrusanoRegimenSimulationSummary {
    pub mean: f64,
    pub standard_deviation: f64,
    pub minimum: f64,
    pub percentile2_5: f64,
    pub percentile25: f64,
    pub median: f64,
    pub percentile75: f64,
    pub percentile97_5: f64,
    pub maximum: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrusanoRegimenSimulationResult {
    pub drug_names: Vec<String>,
    pub concentrations: Vec<f64>,
    pub mic_values: Vec<f64>,
    pub normalized_doses: Vec<f64>,
    pub simulation_count: usize,
    pub support_point_count: usize,
    pub seed: u64,
    pub rejected_draws: usize,
    pub effects: Vec<f64>,
    pub summary: DrusanoRegimenSimulationSummary,
}

pub fn fit_npag_with_options(
    data_set: DrusanoDataSet,
    assay_error: DrusanoAssayErrorSettings,
    max_cycles: usize,
    continuation: Option<DrusanoFitContinuation>,
    on_cycle: impl FnMut(usize, f64) + Send,
) -> anyhow::Result<DrusanoFitResult> {
    fit_npag_with_config(
        data_set,
        assay_error,
        on_cycle,
        DEFAULT_PRIOR_POINTS,
        max_cycles,
        continuation,
    )
}

fn fit_npag_with_config(
    data_set: DrusanoDataSet,
    assay_error: DrusanoAssayErrorSettings,
    mut on_cycle: impl FnMut(usize, f64) + Send,
    prior_points: usize,
    max_cycles: usize,
    continuation: Option<DrusanoFitContinuation>,
) -> anyhow::Result<DrusanoFitResult> {
    anyhow::ensure!(max_cycles > 0, "maximum NPAG cycles must be at least 1");
    anyhow::ensure!(
        max_cycles <= 10_000,
        "maximum NPAG cycles cannot exceed 10000"
    );
    let equation = predicted_absorbance_equation()?;
    let response_span = data_set.control_mean - data_set.blank_value;
    let subjects = data_set
        .wells
        .iter()
        .map(|well| {
            let builder = Subject::builder(&well.subject_id);
            let observation = if well.censored {
                data_set
                    .response_censor_limit
                    .expect("censored wells require a response limit")
            } else {
                well.raw_response
            };
            let builder = if well.censored {
                builder.censored_observation(0.0, observation, "predicted_absorbance", Censor::BLOQ)
            } else {
                builder.observation(0.0, observation, "predicted_absorbance")
            };
            builder
                .covariate("d1", 0.0, well.normalized_doses[0])
                .covariate("d2", 0.0, well.normalized_doses[1])
                .covariate("blank", 0.0, data_set.blank_value)
                .covariate("response_span", 0.0, response_span)
                .build()
        })
        .collect();
    let data = Data::new(subjects);
    let parameters = ParameterSpace::bounded()
        .add("ec50_1", 0.01, 4.0)
        .add("ec50_2", 0.01, 4.0)
        .add("h1", 0.1, 10.0)
        .add("h2", 0.1, 10.0)
        .add("alpha_12", -10.0, 10.0);
    let continued_from_cycles = continuation
        .as_ref()
        .map(|value| value.completed_cycles)
        .unwrap_or(0);
    let prior = if let Some(continuation) = continuation.as_ref() {
        anyhow::ensure!(
            !continuation.support_points.is_empty(),
            "a continuation requires at least one terminal support point"
        );
        anyhow::ensure!(
            continuation.fitted_lambda.is_finite() && continuation.fitted_lambda >= 0.0,
            "continuation lambda must be finite and nonnegative"
        );
        let column_count = parameters.len();
        anyhow::ensure!(
            continuation.support_points.iter().all(|point| {
                point.values.len() == column_count
                    && point.values.iter().all(|value| value.is_finite())
            }),
            "continuation support points must contain five finite parameter values"
        );
        let matrix = faer::Mat::from_fn(
            continuation.support_points.len(),
            column_count,
            |row, column| continuation.support_points[row].values[column],
        );
        Theta::from_parts(matrix, parameters.clone())?
    } else {
        Theta::sobol(&parameters, prior_points)?
    };
    anyhow::ensure!(
        assay_error
            .coefficients
            .iter()
            .all(|value| value.is_finite()),
        "assay error polynomial coefficients must be finite"
    );
    anyhow::ensure!(
        assay_error.lambda.is_finite() && assay_error.lambda >= 0.0,
        "assay error lambda must be finite and nonnegative"
    );
    let initial_lambda = continuation
        .as_ref()
        .map(|value| value.fitted_lambda)
        .unwrap_or(assay_error.lambda);
    let error_models = AssayErrorModels::new().add(
        0,
        AssayErrorModel::additive(
            ErrorPoly::prediction_based(
                assay_error.coefficients[0],
                assay_error.coefficients[1],
                assay_error.coefficients[2],
                assay_error.coefficients[3],
            ),
            initial_lambda,
        ),
    )?;
    let result = EstimationProblem::nonparametric(equation, data, prior, error_models)?
        .fit_with_observer(
            NpagConfig::new().max_cycles(max_cycles).progress(false),
            |controller: &FitController<_>| {
                on_cycle(
                    continued_from_cycles + controller.cycle(),
                    controller.n2ll(),
                );
                CycleFlow::Continue
            },
        )?;

    let theta = result.get_theta();
    let parameter_names = theta.param_names();
    let support_points = (0..theta.matrix().nrows())
        .map(|row| DrusanoSupportPoint {
            values: (0..theta.matrix().ncols())
                .map(|column| theta.matrix()[(row, column)])
                .collect(),
            probability: result.weights()[row],
        })
        .collect::<Vec<_>>();
    let parameter_summaries = parameter_names
        .iter()
        .enumerate()
        .map(|(column, name)| {
            let mean = support_points
                .iter()
                .map(|point| point.probability * point.values[column])
                .sum::<f64>();
            let variance = support_points
                .iter()
                .map(|point| point.probability * (point.values[column] - mean).powi(2))
                .sum::<f64>();
            DrusanoParameterSummary {
                name: name.clone(),
                mean,
                standard_deviation: variance.sqrt(),
            }
        })
        .collect();
    let posterior = result.posterior()?;
    let posterior_weights = (0..posterior.matrix().nrows())
        .map(|row| {
            (0..posterior.matrix().ncols())
                .map(|column| posterior.matrix()[(row, column)])
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    let (predictions, unpredicted_count) = posterior_predictive_effects(
        &data_set.wells,
        &parameter_names,
        &support_points,
        &posterior_weights,
    );
    let regression = regression_summary(&predictions);
    let fitted_lambda = result.error_models().factor(0)?;
    let run_cycles = result.cycles();
    Ok(DrusanoFitResult {
        data: data_set,
        assay_error: DrusanoAssayErrorSummary {
            coefficients: assay_error.coefficients,
            initial_lambda,
            fitted_lambda,
        },
        model_source: MODEL_SOURCE.into(),
        parameter_names,
        support_points,
        parameter_summaries,
        predictions,
        regression,
        unpredicted_count,
        converged: result.converged(),
        cycles: continued_from_cycles + run_cycles,
        run_cycles,
        max_cycles,
        continued_from_cycles,
        objective_function: result.objf(),
    })
}

/// Native equivalent of Pmetrics `PM_sim(..., split = TRUE)` for Equation 2.
/// Each NPAG support point is a mixture-mode mean, mode selection follows its
/// fitted probability, and every mode shares the weighted population
/// covariance divided by the number of support points.
pub fn simulate_regimen(
    request: DrusanoRegimenSimulationRequest,
) -> anyhow::Result<DrusanoRegimenSimulationResult> {
    const PARAMETER_COUNT: usize = 5;
    const BOUNDS: [(f64, f64); PARAMETER_COUNT] = [
        (0.01, 4.0),
        (0.01, 4.0),
        (0.1, 10.0),
        (0.1, 10.0),
        (-10.0, 10.0),
    ];
    anyhow::ensure!(
        request.drug_names.len() == 2
            && request.mic_values.len() == 2
            && request.concentrations.len() == 2,
        "regimen simulation requires two drugs, two MICs, and two concentrations"
    );
    anyhow::ensure!(
        request.parameter_names == ["ec50_1", "ec50_2", "h1", "h2", "alpha_12"],
        "support-point parameters do not match the Equation 2 model"
    );
    anyhow::ensure!(
        (1..=100_000).contains(&request.simulation_count),
        "simulation count must be between 1 and 100000"
    );
    anyhow::ensure!(
        request
            .mic_values
            .iter()
            .all(|value| value.is_finite() && *value > 0.0),
        "MIC values must be finite and positive"
    );
    anyhow::ensure!(
        request
            .concentrations
            .iter()
            .all(|value| value.is_finite() && *value >= 0.0),
        "free concentrations must be finite and nonnegative"
    );
    anyhow::ensure!(
        !request.support_points.is_empty(),
        "regimen simulation requires fitted support points"
    );
    anyhow::ensure!(
        request.simulation_count >= 2 * request.support_points.len(),
        "split simulation requires at least twice as many simulations as support points"
    );

    let mut probabilities = Vec::with_capacity(request.support_points.len());
    for point in &request.support_points {
        anyhow::ensure!(
            point.values.len() == PARAMETER_COUNT
                && point.values.iter().all(|value| value.is_finite())
                && point.probability.is_finite()
                && point.probability >= 0.0,
            "support points and probabilities must be finite"
        );
        anyhow::ensure!(
            point
                .values
                .iter()
                .zip(BOUNDS)
                .all(|(value, (lower, upper))| *value >= lower && *value <= upper),
            "support point lies outside the fitted parameter bounds"
        );
        probabilities.push(point.probability);
    }
    let probability_sum = probabilities.iter().sum::<f64>();
    anyhow::ensure!(
        probability_sum.is_finite() && probability_sum > 0.0,
        "support-point probabilities must have a positive sum"
    );
    probabilities
        .iter_mut()
        .for_each(|probability| *probability /= probability_sum);

    let normalized_doses = request
        .concentrations
        .iter()
        .zip(&request.mic_values)
        .map(|(concentration, mic)| concentration / mic)
        .collect::<Vec<_>>();
    let means = &request.support_points;
    let mut population_mean = [0.0; PARAMETER_COUNT];
    for (point, probability) in means.iter().zip(&probabilities) {
        for (column, mean) in population_mean.iter_mut().enumerate() {
            *mean += probability * point.values[column];
        }
    }
    let mut split_covariance = [[0.0; PARAMETER_COUNT]; PARAMETER_COUNT];
    for (point, probability) in means.iter().zip(&probabilities) {
        for row in 0..PARAMETER_COUNT {
            for column in 0..PARAMETER_COUNT {
                split_covariance[row][column] += probability
                    * (point.values[row] - population_mean[row])
                    * (point.values[column] - population_mean[column]);
            }
        }
    }
    let mode_count = means.len() as f64;
    for row in &mut split_covariance {
        for value in row {
            *value /= mode_count;
        }
    }
    let cholesky = positive_semidefinite_cholesky(split_covariance)?;
    let mut rng = StdRng::seed_from_u64(request.seed);
    let mut effects = Vec::with_capacity(request.simulation_count);
    let mut rejected_draws = 0;
    while effects.len() < request.simulation_count {
        anyhow::ensure!(
            rejected_draws <= request.simulation_count * 500,
            "unable to generate 1000 valid split-distribution simulations within parameter bounds"
        );
        let mode = sample_mode(&probabilities, &mut rng);
        let z: [f64; PARAMETER_COUNT] = std::array::from_fn(|_| StandardNormal.sample(&mut rng));
        let values: [f64; PARAMETER_COUNT] = std::array::from_fn(|row| {
            means[mode].values[row]
                + (0..=row)
                    .map(|column| cholesky[row][column] * z[column])
                    .sum::<f64>()
        });
        if !values
            .iter()
            .zip(BOUNDS)
            .all(|(value, (lower, upper))| *value >= lower && *value <= upper)
        {
            rejected_draws += 1;
            continue;
        }
        if let Some(effect) = solve_effect(
            normalized_doses[0],
            normalized_doses[1],
            &request.parameter_names,
            &values,
        ) && effect.is_finite()
            && (0.0..=1.0).contains(&effect)
        {
            effects.push(effect);
        } else {
            rejected_draws += 1;
        }
    }

    let summary = summarize_effects(&effects);
    Ok(DrusanoRegimenSimulationResult {
        drug_names: request.drug_names,
        concentrations: request.concentrations,
        mic_values: request.mic_values,
        normalized_doses,
        simulation_count: effects.len(),
        support_point_count: means.len(),
        seed: request.seed,
        rejected_draws,
        effects,
        summary,
    })
}

fn sample_mode(probabilities: &[f64], rng: &mut StdRng) -> usize {
    let draw = rng.random::<f64>();
    let mut cumulative = 0.0;
    for (index, probability) in probabilities.iter().enumerate() {
        cumulative += probability;
        if draw <= cumulative {
            return index;
        }
    }
    probabilities.len() - 1
}

fn positive_semidefinite_cholesky<const N: usize>(
    covariance: [[f64; N]; N],
) -> anyhow::Result<[[f64; N]; N]> {
    for jitter in [0.0, 1e-14, 1e-12, 1e-10, 1e-8] {
        let mut lower = [[0.0; N]; N];
        let mut valid = true;
        for row in 0..N {
            for column in 0..=row {
                let mut value = covariance[row][column];
                if row == column {
                    value += jitter;
                }
                for index in 0..column {
                    value -= lower[row][index] * lower[column][index];
                }
                if row == column {
                    if value < -1e-12 || !value.is_finite() {
                        valid = false;
                        break;
                    }
                    lower[row][column] = value.max(0.0).sqrt();
                } else if lower[column][column] > 1e-14 {
                    lower[row][column] = value / lower[column][column];
                } else if value.abs() > 1e-10 {
                    valid = false;
                    break;
                }
            }
            if !valid {
                break;
            }
        }
        if valid {
            return Ok(lower);
        }
    }
    anyhow::bail!("support-point covariance could not be made positive semidefinite")
}

fn summarize_effects(effects: &[f64]) -> DrusanoRegimenSimulationSummary {
    let mut sorted = effects.to_vec();
    sorted.sort_by(f64::total_cmp);
    let mean = sorted.iter().sum::<f64>() / sorted.len() as f64;
    let standard_deviation = if sorted.len() > 1 {
        (sorted
            .iter()
            .map(|value| (value - mean).powi(2))
            .sum::<f64>()
            / (sorted.len() - 1) as f64)
            .sqrt()
    } else {
        0.0
    };
    DrusanoRegimenSimulationSummary {
        mean,
        standard_deviation,
        minimum: sorted[0],
        percentile2_5: quantile(&sorted, 0.025),
        percentile25: quantile(&sorted, 0.25),
        median: quantile(&sorted, 0.5),
        percentile75: quantile(&sorted, 0.75),
        percentile97_5: quantile(&sorted, 0.975),
        maximum: sorted[sorted.len() - 1],
    }
}

fn quantile(sorted: &[f64], probability: f64) -> f64 {
    let index = probability * (sorted.len() - 1) as f64;
    let lower = index.floor() as usize;
    let upper = index.ceil() as usize;
    sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower as f64)
}

fn predicted_absorbance_equation() -> anyhow::Result<Analytical> {
    let eq = |x: &V, _p: &V, _dt: f64, _rateiv: &V, _cov: &Covariates| x.clone();
    let seq_eq = |_parameters: &mut V, _time: f64, _covariates: &Covariates| {};
    let lag = |_parameters: &V, _time: f64, _covariates: &Covariates| HashMap::new();
    let fa = |_parameters: &V, _time: f64, _covariates: &Covariates| HashMap::new();
    let init = |_parameters: &V, _time: f64, _covariates: &Covariates, state: &mut V| {
        state[0] = 0.0;
    };
    let out = |_state: &V, parameters: &V, time: f64, covariates: &Covariates, y: &mut V| {
        let value = |name: &str| {
            covariates
                .get_covariate(name)
                .and_then(|covariate| covariate.interpolate(time).ok())
                .unwrap_or(f64::NAN)
        };
        let effect = solve_effect_values(
            value("d1"),
            value("d2"),
            [
                parameters[0],
                parameters[1],
                parameters[2],
                parameters[3],
                parameters[4],
            ],
        );
        y[0] = effect
            .map(|effect| value("blank") + value("response_span") * (1.0 - effect))
            .unwrap_or_else(|| value("blank") - 1_000.0 * value("response_span"));
    };

    Ok(Analytical::new(eq, seq_eq, lag, fa, init, out)
        .with_nstates(1)
        .with_ndrugs(0)
        .with_nout(1)
        .with_metadata(
            metadata::new("drusano_greco_predicted_absorbance")
                .parameters(["ec50_1", "ec50_2", "h1", "h2", "alpha_12"])
                .covariates([
                    metadata::Covariate::continuous("d1"),
                    metadata::Covariate::continuous("d2"),
                    metadata::Covariate::continuous("blank"),
                    metadata::Covariate::continuous("response_span"),
                ])
                .states(["carrier"])
                .outputs(["predicted_absorbance"]),
        )?)
}

fn posterior_predictive_effects(
    wells: &[DrusanoWell],
    parameter_names: &[String],
    support_points: &[DrusanoSupportPoint],
    posterior_weights: &[Vec<f64>],
) -> (Vec<DrusanoPredictionPoint>, usize) {
    let mut unpredicted_count = 0;
    let predictions = wells
        .iter()
        .zip(posterior_weights)
        .filter_map(|(well, weights)| {
            let mut weighted_effect = 0.0;
            let mut valid_weight = 0.0;
            for (point, weight) in support_points.iter().zip(weights) {
                if *weight <= 0.0 || !weight.is_finite() {
                    continue;
                }
                if let Some(effect) = solve_effect(
                    well.normalized_doses[0],
                    well.normalized_doses[1],
                    parameter_names,
                    &point.values,
                ) {
                    weighted_effect += weight * effect;
                    valid_weight += weight;
                }
            }
            if valid_weight > 0.0 {
                Some(DrusanoPredictionPoint {
                    subject_id: well.subject_id.clone(),
                    observed_effect: well.normalized_effect,
                    predicted_effect: weighted_effect / valid_weight,
                    censored: well.censored,
                })
            } else {
                unpredicted_count += 1;
                None
            }
        })
        .collect();
    (predictions, unpredicted_count)
}

fn solve_effect(d1: f64, d2: f64, parameter_names: &[String], estimates: &[f64]) -> Option<f64> {
    let parameter = |name: &str| {
        parameter_names
            .iter()
            .position(|candidate| candidate == name)
            .and_then(|index| estimates.get(index).copied())
    };
    let values = [
        parameter("ec50_1")?,
        parameter("ec50_2")?,
        parameter("h1")?,
        parameter("h2")?,
        parameter("alpha_12")?,
    ];
    if values[..4]
        .iter()
        .any(|value| !value.is_finite() || *value <= 0.0)
        || !values[4].is_finite()
    {
        return None;
    }
    solve_effect_values(d1, d2, values)
}

fn solve_effect_values(d1: f64, d2: f64, values: [f64; 5]) -> Option<f64> {
    if !d1.is_finite()
        || !d2.is_finite()
        || d1 < 0.0
        || d2 < 0.0
        || values[..4]
            .iter()
            .any(|value| !value.is_finite() || *value <= 0.0)
        || !values[4].is_finite()
    {
        return None;
    }

    let u = d1 / values[0];
    let v = d2 / values[1];
    if u <= 1e-15 && v <= 1e-15 {
        return Some(0.0);
    }
    if v <= 1e-15 {
        return Some(effect_from_log_xm(values[2] * u.ln()));
    }
    if u <= 1e-15 {
        return Some(effect_from_log_xm(values[3] * v.ln()));
    }

    let h_1 = 1.0 / values[2];
    let h_2 = 1.0 / values[3];
    let h_12 = (h_1 + h_2) / 2.0;
    let w = values[4] * u * v;
    let balance_and_derivative = |log_xm: f64| {
        let term_1 = u * (-h_1 * log_xm).exp();
        let term_2 = v * (-h_2 * log_xm).exp();
        let term_12 = w * (-h_12 * log_xm).exp();
        (
            term_1 + term_2 + term_12 - 1.0,
            -h_1 * term_1 - h_2 * term_2 - h_12 * term_12,
        )
    };
    let no_interaction_guess = (values[2] * u.ln() + values[3] * v.ln()) / 2.0;
    let mut low = -32.0;
    let mut high = 32.0;
    let mut low_value = balance_and_derivative(low).0;
    let high_value = balance_and_derivative(high).0;
    if !low_value.is_finite()
        || !high_value.is_finite()
        || low_value.signum() == high_value.signum()
    {
        return None;
    }
    let mut estimate = no_interaction_guess.clamp(low, high);
    for _ in 0..24 {
        let (value, derivative) = balance_and_derivative(estimate);
        if !value.is_finite() || !derivative.is_finite() {
            return None;
        }
        if value.abs() < 1e-10 {
            return Some(effect_from_log_xm(estimate));
        }
        if low_value.signum() == value.signum() {
            low = estimate;
            low_value = value;
        } else {
            high = estimate;
        }
        let newton = estimate - value / derivative;
        estimate = if derivative.abs() > 1e-14 && newton > low && newton < high {
            newton
        } else {
            (low + high) / 2.0
        };
    }
    Some(effect_from_log_xm(estimate))
}

fn effect_from_log_xm(log_xm: f64) -> f64 {
    if log_xm >= 0.0 {
        1.0 / (1.0 + (-log_xm).exp())
    } else {
        let xm = log_xm.exp();
        xm / (1.0 + xm)
    }
}

fn regression_summary(points: &[DrusanoPredictionPoint]) -> Option<DrusanoRegressionSummary> {
    let points = points
        .iter()
        .filter(|point| !point.censored)
        .collect::<Vec<_>>();
    if points.len() < 2 {
        return None;
    }
    let count = points.len() as f64;
    let mean_observed = points
        .iter()
        .map(|point| point.observed_effect)
        .sum::<f64>()
        / count;
    let mean_predicted = points
        .iter()
        .map(|point| point.predicted_effect)
        .sum::<f64>()
        / count;
    let predicted_ss = points
        .iter()
        .map(|point| (point.predicted_effect - mean_predicted).powi(2))
        .sum::<f64>();
    if predicted_ss <= f64::EPSILON {
        return None;
    }
    let covariance = points
        .iter()
        .map(|point| {
            (point.observed_effect - mean_observed) * (point.predicted_effect - mean_predicted)
        })
        .sum::<f64>();
    let observed_ss = points
        .iter()
        .map(|point| (point.observed_effect - mean_observed).powi(2))
        .sum::<f64>();
    let slope = covariance / predicted_ss;
    let intercept = mean_observed - slope * mean_predicted;
    let r_squared = if observed_ss <= f64::EPSILON {
        0.0
    } else {
        (covariance * covariance / (observed_ss * predicted_ss)).clamp(0.0, 1.0)
    };
    let root_mean_squared_error = (points
        .iter()
        .map(|point| (point.predicted_effect - point.observed_effect).powi(2))
        .sum::<f64>()
        / count)
        .sqrt();
    Some(DrusanoRegressionSummary {
        observations: points.len(),
        slope,
        intercept,
        r_squared,
        root_mean_squared_error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use checkerboard_core::{
        AssayInput, AssayRow,
        drusano_greco::{DrusanoDataSettings, build_equation_dataset},
    };
    use pharmsol::Equation;

    #[test]
    fn predicted_absorbance_equation_has_valid_metadata() {
        let equation = predicted_absorbance_equation().unwrap();
        let model_metadata = equation.metadata().expect("model metadata");
        assert_eq!(
            model_metadata.parameter_names(),
            ["ec50_1", "ec50_2", "h1", "h2", "alpha_12"]
        );
        assert_eq!(model_metadata.output_labels(), ["predicted_absorbance"]);
    }

    #[test]
    fn small_npag_fit_returns_probability_weighted_support_points() {
        let combinations = [
            ([0.25, 0.0], 0.2),
            ([0.5, 0.0], 1.0 / 3.0),
            ([0.0, 0.25], 0.2),
            ([0.0, 0.5], 1.0 / 3.0),
            ([0.25, 0.25], 1.0 / 3.0),
            ([0.5, 0.5], 0.5),
        ];
        let wells = combinations
            .iter()
            .enumerate()
            .map(|(index, (doses, effect))| DrusanoWell {
                subject_id: (index + 1).to_string(),
                raw_response: 1.0 - effect,
                normalized_effect: *effect,
                normalized_doses: doses.to_vec(),
                censored: index == 0,
            })
            .collect::<Vec<_>>();
        let data = DrusanoDataSet {
            drug_names: vec!["A".into(), "B".into()],
            headers: vec![],
            rows: vec![],
            subject_count: wells.len(),
            control_count: 1,
            excluded_boundary_count: 0,
            excluded_effect_below_zero_count: 0,
            excluded_effect_above_one_count: 0,
            censored_count: 1,
            response_censor_limit: Some(0.1),
            normalized_effect_censor_limit: Some(0.9),
            blank_value: 0.0,
            control_mean: 1.0,
            mic_values: vec![1.0, 1.0],
            wells,
            warnings: vec![],
        };
        let result = fit_npag_with_config(
            data,
            DrusanoAssayErrorSettings::default(),
            |_, _| {},
            32,
            2,
            None,
        )
        .unwrap();
        assert!(!result.support_points.is_empty());
        assert_eq!(result.parameter_names.len(), 5);
        let total_probability = result
            .support_points
            .iter()
            .map(|point| point.probability)
            .sum::<f64>();
        assert!((total_probability - 1.0).abs() < 1e-8);
        assert!(!result.predictions.is_empty());
        assert!(result.regression.is_some());
        assert_eq!(result.assay_error.coefficients, [0.05, 0.05, 0.0, 0.0]);
        assert_eq!(result.assay_error.initial_lambda, 0.0);
        assert!(result.assay_error.fitted_lambda.is_finite());
        assert_eq!(result.cycles, result.run_cycles);
        assert_eq!(result.max_cycles, 2);
        assert_eq!(result.continued_from_cycles, 0);
    }

    #[test]
    fn continuation_uses_terminal_grid_and_accumulates_cycles() {
        let combinations = [
            ([0.0, 0.5], 0.25),
            ([0.5, 0.0], 0.25),
            ([0.5, 0.5], 0.45),
            ([1.0, 0.5], 0.6),
        ];
        let wells = combinations
            .iter()
            .enumerate()
            .map(|(index, (doses, effect))| DrusanoWell {
                subject_id: (index + 1).to_string(),
                raw_response: 1.0 - effect,
                normalized_effect: *effect,
                normalized_doses: doses.to_vec(),
                censored: false,
            })
            .collect::<Vec<_>>();
        let data = DrusanoDataSet {
            drug_names: vec!["A".into(), "B".into()],
            headers: vec![],
            rows: vec![],
            subject_count: wells.len(),
            control_count: 1,
            excluded_boundary_count: 0,
            excluded_effect_below_zero_count: 0,
            excluded_effect_above_one_count: 0,
            censored_count: 0,
            response_censor_limit: None,
            normalized_effect_censor_limit: None,
            blank_value: 0.0,
            control_mean: 1.0,
            mic_values: vec![1.0, 1.0],
            wells,
            warnings: vec![],
        };
        let first = fit_npag_with_config(
            data.clone(),
            DrusanoAssayErrorSettings::default(),
            |_, _| {},
            32,
            1,
            None,
        )
        .unwrap();
        let first_cycles = first.cycles;
        let first_lambda = first.assay_error.fitted_lambda;
        let continued = fit_npag_with_config(
            data,
            DrusanoAssayErrorSettings::default(),
            |_, _| {},
            32,
            1,
            Some(DrusanoFitContinuation {
                support_points: first.support_points,
                fitted_lambda: first_lambda,
                completed_cycles: first_cycles,
            }),
        )
        .unwrap();

        assert_eq!(continued.continued_from_cycles, first_cycles);
        assert_eq!(continued.cycles, first_cycles + continued.run_cycles);
        assert_eq!(continued.assay_error.initial_lambda, first_lambda);
        assert!(!continued.support_points.is_empty());
    }

    #[test]
    fn implicit_prediction_recovers_known_additive_effect() {
        let names = vec![
            "ec50_1".into(),
            "ec50_2".into(),
            "h1".into(),
            "h2".into(),
            "alpha_12".into(),
        ];
        let predicted = solve_effect(0.25, 0.25, &names, &[1.0, 1.0, 1.0, 1.0, 0.0]).unwrap();
        assert!((predicted - 1.0 / 3.0).abs() < 1e-10);
    }

    #[test]
    fn regression_reports_observed_effect_on_predicted_effect() {
        let points = vec![
            DrusanoPredictionPoint {
                subject_id: "1".into(),
                predicted_effect: 0.1,
                observed_effect: 0.3,
                censored: false,
            },
            DrusanoPredictionPoint {
                subject_id: "2".into(),
                predicted_effect: 0.2,
                observed_effect: 0.5,
                censored: false,
            },
            DrusanoPredictionPoint {
                subject_id: "3".into(),
                predicted_effect: 0.3,
                observed_effect: 0.7,
                censored: false,
            },
            DrusanoPredictionPoint {
                subject_id: "censored".into(),
                predicted_effect: 0.9,
                observed_effect: 0.9,
                censored: true,
            },
        ];

        let summary = regression_summary(&points).unwrap();
        assert_eq!(summary.observations, 3);
        assert!((summary.slope - 2.0).abs() < 1e-12);
        assert!((summary.intercept - 0.1).abs() < 1e-12);
        assert!((summary.r_squared - 1.0).abs() < 1e-12);
    }

    #[test]
    fn split_regimen_simulation_is_reproducible_and_mic_scaled() {
        let request = DrusanoRegimenSimulationRequest {
            drug_names: vec!["A".into(), "B".into()],
            parameter_names: vec![
                "ec50_1".into(),
                "ec50_2".into(),
                "h1".into(),
                "h2".into(),
                "alpha_12".into(),
            ],
            support_points: vec![
                DrusanoSupportPoint {
                    values: vec![0.8, 1.0, 1.0, 1.2, 0.0],
                    probability: 0.7,
                },
                DrusanoSupportPoint {
                    values: vec![1.2, 0.7, 1.3, 0.9, 0.5],
                    probability: 0.3,
                },
            ],
            mic_values: vec![2.0, 4.0],
            concentrations: vec![1.0, 8.0],
            simulation_count: 1_000,
            seed: 17,
        };

        let first = simulate_regimen(request.clone()).unwrap();
        let second = simulate_regimen(request).unwrap();
        assert_eq!(first.normalized_doses, vec![0.5, 2.0]);
        assert_eq!(first.simulation_count, 1_000);
        assert_eq!(first.support_point_count, 2);
        assert_eq!(first.effects, second.effects);
        assert!(
            first
                .effects
                .iter()
                .all(|effect| (0.0..=1.0).contains(effect))
        );
        assert!(first.summary.minimum <= first.summary.median);
        assert!(first.summary.median <= first.summary.maximum);
    }

    #[test]
    fn likelihood_uses_predicted_absorbance_for_error_polynomial() {
        let equation = predicted_absorbance_equation().unwrap();
        let subject = Subject::builder("well")
            .observation(0.0, 0.6, "predicted_absorbance")
            .covariate("d1", 0.0, 0.25)
            .covariate("d2", 0.0, 0.25)
            .covariate("blank", 0.0, 0.1)
            .covariate("response_span", 0.0, 0.9)
            .build();
        let error_models = AssayErrorModels::new()
            .add(
                "predicted_absorbance",
                AssayErrorModel::additive_fixed(
                    ErrorPoly::prediction_based(0.0, 1.0, 0.0, 0.0),
                    0.1,
                ),
            )
            .unwrap();
        let (_, likelihood) = equation
            .simulate_subject_dense(&subject, &[1.0, 1.0, 1.0, 1.0, 0.0], Some(&error_models))
            .unwrap();

        let predicted_absorbance = 0.7_f64;
        let sigma = (predicted_absorbance.powi(2) + 0.1_f64.powi(2)).sqrt();
        let expected = (-(0.6 - predicted_absorbance).powi(2) / (2.0 * sigma.powi(2))).exp()
            / (sigma * (2.0 * std::f64::consts::PI).sqrt());
        assert!((likelihood.unwrap() - expected).abs() < 1e-12);
    }

    #[test]
    #[ignore = "manual runtime benchmark"]
    fn benchmark_test2_predicted_absorbance_fit() {
        let mut reader = csv::Reader::from_reader(include_bytes!(
            "../../../../tests/test2_combined.csv"
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
        let data = build_equation_dataset(
            &AssayInput {
                drug_names: vec!["DETA".into(), "CFZ".into()],
                rows,
            },
            &DrusanoDataSettings {
                blank_value: 0.1,
                response_censor_limit: Some(0.11),
                mic_values: vec![1000.0, 1.0],
            },
        )
        .unwrap();
        let started = std::time::Instant::now();
        let result = fit_npag_with_options(
            data,
            DrusanoAssayErrorSettings::default(),
            DEFAULT_MAX_CYCLES,
            None,
            |_, _| {},
        )
        .unwrap();
        eprintln!(
            "predicted-absorbance fit: subjects={} support={} cycles={} converged={} elapsed={:?}",
            result.data.subject_count,
            result.support_points.len(),
            result.cycles,
            result.converged,
            started.elapsed(),
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
    }
}
