use std::{
    collections::HashMap,
    sync::atomic::{AtomicUsize, Ordering},
};

use anyhow::Context;
use checkerboard_core::drusano_greco::{DrusanoDataSet, DrusanoWell};
use pharmsol::{Analytical, Covariates, equation::metadata, simulator::V};
use pmcore::prelude::pharmsol::Censor;
use pmcore::prelude::{
    AssayErrorModel, AssayErrorModels, CycleFlow, Data, ErrorPoly, EstimationProblem,
    FitController, NpagConfig, ParameterSpace, Subject, SubjectBuilderExt, Theta, pharmsol,
};
use rand::{Rng, SeedableRng, rngs::StdRng};
use rand_distr::{Distribution, StandardNormal};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

pub const MODEL_SOURCE: &str = r#"# Numerical Drusano-Greco Equation 2 prediction model
# d1 and d2 are dimensionless concentration/maximum-tested-concentration covariates.
# E and XM0 are dimensionless; absorbance remains on the imported response scale.
u = d1 / ec50_1
v = d2 / ec50_2
w = alpha_12 * u * v
z_1 = tanh(log(u))
z_2 = tanh(log(v))
h1_d = h1 * exp(b1 * z_1)
h2_d = h2 * exp(b2 * z_2)
h_1 = 1 / h1_d
h_2 = 1 / h2_d
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
            coefficients: [0.02, 0.0, 0.1, 0.0],
            lambda: 0.01,
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
    #[serde(rename = "percentile2_5")]
    pub percentile2_5: f64,
    pub median: f64,
    #[serde(rename = "percentile97_5")]
    pub percentile97_5: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrusanoPredictionPoint {
    pub well_id: String,
    pub observed_effect: f64,
    pub predicted_effect: f64,
    pub observed_response: f64,
    pub predicted_response: f64,
    pub response_residual: Option<f64>,
    pub normalized_doses: Vec<f64>,
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
    pub reference_support_point: DrusanoSupportPoint,
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
    pub bootstrap_iterations: usize,
    pub bootstrap_seed: u64,
    pub bootstrap_converged_count: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrusanoRegimenSimulationRequest {
    pub drug_names: Vec<String>,
    pub parameter_names: Vec<String>,
    pub support_points: Vec<DrusanoSupportPoint>,
    pub max_concentrations: Vec<f64>,
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
    #[serde(rename = "percentile2_5")]
    pub percentile2_5: f64,
    pub percentile25: f64,
    pub median: f64,
    pub percentile75: f64,
    #[serde(rename = "percentile97_5")]
    pub percentile97_5: f64,
    pub maximum: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrusanoRegimenSimulationResult {
    pub drug_names: Vec<String>,
    pub concentrations: Vec<f64>,
    pub max_concentrations: Vec<f64>,
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
    bootstrap_iterations: usize,
    bootstrap_seed: u64,
    on_progress: impl Fn(&str, usize, f64, usize, usize) + Send + Sync,
) -> anyhow::Result<DrusanoFitResult> {
    anyhow::ensure!(
        (1..=10_000).contains(&bootstrap_iterations),
        "bootstrap iterations must be between 1 and 10000"
    );
    let mut reference = fit_npag_with_config(
        data_set.clone(),
        assay_error.clone(),
        |cycle, objective| on_progress("reference", cycle, objective, 0, bootstrap_iterations),
        DEFAULT_PRIOR_POINTS,
        max_cycles,
        continuation,
    )?;
    let reference_point = reference.reference_support_point.clone();
    let bootstrap_error = DrusanoAssayErrorSettings {
        coefficients: reference.assay_error.coefficients,
        lambda: reference.assay_error.fitted_lambda,
    };
    let mut rng = StdRng::seed_from_u64(bootstrap_seed);
    // Generate every synthetic data set serially so a fixed seed remains
    // reproducible regardless of Rayon thread count or completion order.
    let bootstrap_data_sets = (0..bootstrap_iterations)
        .map(|_| {
            parametric_bootstrap_dataset(
                &data_set,
                &reference.parameter_names,
                &reference_point.values,
                &bootstrap_error,
                &mut rng,
            )
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let completed = AtomicUsize::new(0);
    let bootstrap_fits = bootstrap_data_sets
        .into_par_iter()
        .map(|bootstrap_data| {
            let bootstrap_fit = fit_npag_with_config(
                bootstrap_data,
                bootstrap_error.clone(),
                |_, _| {},
                1,
                max_cycles,
                Some(DrusanoFitContinuation {
                    support_points: vec![reference_point.clone()],
                    fitted_lambda: bootstrap_error.lambda,
                    completed_cycles: 0,
                }),
            )?;
            let completed_count = completed.fetch_add(1, Ordering::Relaxed) + 1;
            on_progress(
                "bootstrap",
                bootstrap_fit.run_cycles,
                bootstrap_fit.objective_function,
                completed_count,
                bootstrap_iterations,
            );
            Ok(bootstrap_fit)
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let bootstrap_converged_count = bootstrap_fits.iter().filter(|fit| fit.converged).count();
    let bootstrap_points = bootstrap_fits
        .into_iter()
        .map(|fit| {
            let mut point = fit.reference_support_point;
            point.probability = 1.0 / bootstrap_iterations as f64;
            point
        })
        .collect::<Vec<_>>();

    reference.parameter_summaries =
        parameter_summaries_from_empirical_points(&reference.parameter_names, &bootstrap_points);
    reference.support_points = bootstrap_points;
    reference.bootstrap_iterations = bootstrap_iterations;
    reference.bootstrap_seed = bootstrap_seed;
    reference.bootstrap_converged_count = bootstrap_converged_count;
    Ok(reference)
}

fn parametric_bootstrap_dataset(
    data_set: &DrusanoDataSet,
    parameter_names: &[String],
    reference_values: &[f64],
    assay_error: &DrusanoAssayErrorSettings,
    rng: &mut StdRng,
) -> anyhow::Result<DrusanoDataSet> {
    let response_span = data_set.control_mean - data_set.blank_value;
    let mut generated = data_set.clone();
    generated.censored_count = 0;
    for well in &mut generated.wells {
        let effect = solve_effect(
            well.normalized_doses[0],
            well.normalized_doses[1],
            parameter_names,
            reference_values,
        )
        .context("reference support point has no finite Equation 2 root")?;
        let prediction = data_set.blank_value + response_span * (1.0 - effect);
        let alpha = assay_error.coefficients[0]
            + assay_error.coefficients[1] * prediction
            + assay_error.coefficients[2] * prediction.powi(2)
            + assay_error.coefficients[3] * prediction.powi(3);
        let sigma = (assay_error.lambda.powi(2) + alpha.powi(2)).sqrt();
        anyhow::ensure!(
            sigma.is_finite() && sigma > 0.0,
            "parametric bootstrap requires positive finite assay-error SD"
        );
        let residual: f64 = StandardNormal.sample(rng);
        let simulated_response = prediction + sigma * residual;
        anyhow::ensure!(
            simulated_response.is_finite(),
            "parametric bootstrap generated a non-finite response"
        );
        well.raw_response = simulated_response;
        well.censored = data_set
            .response_censor_limit
            .is_some_and(|limit| simulated_response <= limit);
        if well.censored {
            generated.censored_count += 1;
            well.normalized_effect = data_set
                .normalized_effect_censor_limit
                .expect("censored bootstrap responses require an effect boundary");
        } else {
            well.normalized_effect =
                1.0 - (simulated_response - data_set.blank_value) / response_span;
        }
    }
    Ok(generated)
}

fn parameter_summaries_from_empirical_points(
    parameter_names: &[String],
    points: &[DrusanoSupportPoint],
) -> Vec<DrusanoParameterSummary> {
    parameter_names
        .iter()
        .enumerate()
        .map(|(column, name)| {
            let mut values = points
                .iter()
                .map(|point| point.values[column])
                .collect::<Vec<_>>();
            values.sort_by(f64::total_cmp);
            let mean = values.iter().sum::<f64>() / values.len() as f64;
            let standard_deviation = if values.len() > 1 {
                (values
                    .iter()
                    .map(|value| (value - mean).powi(2))
                    .sum::<f64>()
                    / (values.len() - 1) as f64)
                    .sqrt()
            } else {
                0.0
            };
            DrusanoParameterSummary {
                name: name.clone(),
                mean,
                standard_deviation,
                percentile2_5: quantile(&values, 0.025),
                median: quantile(&values, 0.5),
                percentile97_5: quantile(&values, 0.975),
            }
        })
        .collect()
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
    let mut builder = Subject::builder("checkerboard");
    for (index, well) in data_set.wells.iter().enumerate() {
        let time = index as f64;
        let observation = if well.censored {
            data_set
                .response_censor_limit
                .expect("censored wells require a response limit")
        } else {
            well.raw_response
        };
        builder = if well.censored {
            builder.censored_observation(time, observation, "predicted_absorbance", Censor::BLOQ)
        } else {
            builder.observation(time, observation, "predicted_absorbance")
        };
        builder = builder
            .covariate("d1", time, well.normalized_doses[0])
            .covariate("d2", time, well.normalized_doses[1])
            .covariate("blank", time, data_set.blank_value)
            .covariate("response_span", time, response_span);
    }
    let data = Data::new(vec![builder.build()]);
    let parameters = ParameterSpace::bounded()
        .add("ec50_1", 0.001, 4.0)
        .add("ec50_2", 0.001, 4.0)
        .add("h1", 0.1, 10.0)
        .add("h2", 0.1, 10.0)
        .add("b1", -2.0, 2.0)
        .add("b2", -2.0, 2.0)
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
            "continuation support points must contain seven finite parameter values"
        );
        let matrix = faer::Mat::from_fn(
            continuation.support_points.len(),
            column_count,
            |row, column| continuation.support_points[row].values[column],
        );
        Theta::from_parts(matrix, parameters.clone())?
    } else {
        // Start on the complete constant-Hill surface in its native five
        // dimensions so it exactly preserves the former model's Sobol
        // coverage, including alpha. NPAG's adaptive grid can then move B1 and
        // B2 away from zero within their fitted bounds.
        let constant_hill_parameters = ParameterSpace::bounded()
            .add("ec50_1", 0.001, 4.0)
            .add("ec50_2", 0.001, 4.0)
            .add("h1", 0.1, 10.0)
            .add("h2", 0.1, 10.0)
            .add("alpha_12", -10.0, 10.0);
        let constant_hill = Theta::sobol(&constant_hill_parameters, prior_points)?;
        let matrix =
            faer::Mat::from_fn(
                constant_hill.matrix().nrows(),
                7,
                |row, column| match column {
                    0..=3 => constant_hill.matrix()[(row, column)],
                    4 | 5 => 0.0,
                    6 => constant_hill.matrix()[(row, 4)],
                    _ => unreachable!(),
                },
            );
        Theta::from_parts(matrix, parameters.clone())?
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
            NpagConfig::new()
                .min_eps(1e-3)
                .max_cycles(max_cycles)
                .progress(false),
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
            let mut values = support_points
                .iter()
                .map(|point| point.values[column])
                .collect::<Vec<_>>();
            values.sort_by(f64::total_cmp);
            DrusanoParameterSummary {
                name: name.clone(),
                mean,
                standard_deviation: variance.sqrt(),
                percentile2_5: quantile(&values, 0.025),
                median: quantile(&values, 0.5),
                percentile97_5: quantile(&values, 0.975),
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
        data_set.blank_value,
        response_span,
    );
    let regression = regression_summary(&predictions);
    let fitted_lambda = result.error_models().factor(0)?;
    let run_cycles = result.cycles();
    let highest_probability_point = support_points
        .iter()
        .max_by(|left, right| left.probability.total_cmp(&right.probability));
    let reference_support_point = support_points
        .iter()
        .filter(|point| {
            data_set.wells.iter().all(|well| {
                solve_effect(
                    well.normalized_doses[0],
                    well.normalized_doses[1],
                    &parameter_names,
                    &point.values,
                )
                .is_some()
            })
        })
        .max_by(|left, right| left.probability.total_cmp(&right.probability))
        .cloned()
        .with_context(|| {
            format!(
                "NPAG returned no support point with finite roots across the fitted dose grid; highest-probability point was {:?}",
                highest_probability_point.map(|point| &point.values)
            )
        })?;
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
        reference_support_point,
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
        bootstrap_iterations: 0,
        bootstrap_seed: 0,
        bootstrap_converged_count: 0,
    })
}

/// Simulate Equation 2 directly from the empirical, unclustered bootstrap
/// parameter distribution. Bootstrap vectors are sampled with replacement
/// according to their stored probabilities; no additional parameter variance
/// is added around them.
pub fn simulate_regimen(
    request: DrusanoRegimenSimulationRequest,
) -> anyhow::Result<DrusanoRegimenSimulationResult> {
    const PARAMETER_COUNT: usize = 7;
    const BOUNDS: [(f64, f64); PARAMETER_COUNT] = [
        (0.001, 4.0),
        (0.001, 4.0),
        (0.1, 10.0),
        (0.1, 10.0),
        (-2.0, 2.0),
        (-2.0, 2.0),
        (-10.0, 10.0),
    ];
    anyhow::ensure!(
        request.drug_names.len() == 2
            && request.max_concentrations.len() == 2
            && request.concentrations.len() == 2,
        "regimen simulation requires two drugs, two tested maxima, and two concentrations"
    );
    anyhow::ensure!(
        request.parameter_names == ["ec50_1", "ec50_2", "h1", "h2", "b1", "b2", "alpha_12"],
        "support-point parameters do not match the Equation 2 model"
    );
    anyhow::ensure!(
        (1..=100_000).contains(&request.simulation_count),
        "simulation count must be between 1 and 100000"
    );
    anyhow::ensure!(
        request
            .max_concentrations
            .iter()
            .all(|value| value.is_finite() && *value > 0.0),
        "maximum tested concentrations must be finite and positive"
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
        .zip(&request.max_concentrations)
        .map(|(concentration, maximum)| concentration / maximum)
        .collect::<Vec<_>>();
    let mut rng = StdRng::seed_from_u64(request.seed);
    let mut effects = Vec::with_capacity(request.simulation_count);
    let mut rejected_draws = 0;
    while effects.len() < request.simulation_count {
        anyhow::ensure!(
            rejected_draws <= request.simulation_count * 500,
            "unable to generate the requested number of valid bootstrap effect simulations"
        );
        let mode = sample_mode(&probabilities, &mut rng);
        if let Some(effect) = solve_effect(
            normalized_doses[0],
            normalized_doses[1],
            &request.parameter_names,
            &request.support_points[mode].values,
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
        max_concentrations: request.max_concentrations,
        normalized_doses,
        simulation_count: effects.len(),
        support_point_count: request.support_points.len(),
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
                parameters[5],
                parameters[6],
            ],
        );
        y[0] = effect
            .map(|effect| value("blank") + value("response_span") * (1.0 - effect))
            // A missing root is an invalid parameter vector. Use an extremely
            // high absorbance so it receives negligible likelihood for both
            // exact and lower-absorbance-censored observations. Keep it close
            // enough that a prediction-polynomial SD cannot grow faster than
            // the residual and neutralize the penalty. A low sentinel would
            // incorrectly reward invalid vectors at BLOQ wells.
            .unwrap_or_else(|| value("blank") + 3.0 * value("response_span"));
    };

    Ok(Analytical::new(eq, seq_eq, lag, fa, init, out)
        .with_nstates(1)
        .with_ndrugs(0)
        .with_nout(1)
        .with_metadata(
            metadata::new("drusano_greco_predicted_absorbance")
                .parameters(["ec50_1", "ec50_2", "h1", "h2", "b1", "b2", "alpha_12"])
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
    blank_value: f64,
    response_span: f64,
) -> (Vec<DrusanoPredictionPoint>, usize) {
    let mut unpredicted_count = 0;
    let predictions = wells
        .iter()
        .enumerate()
        .filter_map(|(index, well)| {
            let weights = if posterior_weights.len() == 1 {
                &posterior_weights[0]
            } else {
                posterior_weights.get(index)?
            };
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
                let predicted_effect = weighted_effect / valid_weight;
                let predicted_response = blank_value + response_span * (1.0 - predicted_effect);
                Some(DrusanoPredictionPoint {
                    well_id: well.well_id.clone(),
                    observed_effect: well.normalized_effect,
                    predicted_effect,
                    observed_response: well.raw_response,
                    predicted_response,
                    response_residual: (!well.censored)
                        .then_some(well.raw_response - predicted_response),
                    normalized_doses: well.normalized_doses.clone(),
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
        parameter("b1")?,
        parameter("b2")?,
        parameter("alpha_12")?,
    ];
    if values[..4]
        .iter()
        .any(|value| !value.is_finite() || *value <= 0.0)
        || values[4..].iter().any(|value| !value.is_finite())
    {
        return None;
    }
    solve_effect_values(d1, d2, values)
}

fn solve_effect_values(d1: f64, d2: f64, values: [f64; 7]) -> Option<f64> {
    if !d1.is_finite()
        || !d2.is_finite()
        || d1 < 0.0
        || d2 < 0.0
        || values[..4]
            .iter()
            .any(|value| !value.is_finite() || *value <= 0.0)
        || values[4..].iter().any(|value| !value.is_finite())
    {
        return None;
    }

    let u = d1 / values[0];
    let v = d2 / values[1];
    if u <= 1e-15 && v <= 1e-15 {
        return Some(0.0);
    }
    if v <= 1e-15 {
        let log_u = u.ln();
        let h1_d = values[2] * (values[4] * log_u.tanh()).exp();
        return Some(effect_from_log_xm(h1_d * log_u));
    }
    if u <= 1e-15 {
        let log_v = v.ln();
        let h2_d = values[3] * (values[5] * log_v.tanh()).exp();
        return Some(effect_from_log_xm(h2_d * log_v));
    }

    let log_u = u.ln();
    let log_v = v.ln();
    let h1_d = values[2] * (values[4] * log_u.tanh()).exp();
    let h2_d = values[3] * (values[5] * log_v.tanh()).exp();
    let h_1 = 1.0 / h1_d;
    let h_2 = 1.0 / h2_d;
    let h_12 = (h_1 + h_2) / 2.0;
    let w = values[6] * u * v;
    let balance_and_derivative = |log_xm: f64| {
        let term_1 = u * (-h_1 * log_xm).exp();
        let term_2 = v * (-h_2 * log_xm).exp();
        let term_12 = w * (-h_12 * log_xm).exp();
        (
            term_1 + term_2 + term_12 - 1.0,
            -h_1 * term_1 - h_2 * term_2 - h_12 * term_12,
        )
    };
    let no_interaction_guess = (h1_d * log_u + h2_d * log_v) / 2.0;
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
        AnalysisPolicy, AssayInput, AssayRow, ResponseType, analyze,
        drusano_greco::DrusanoDataSettings,
    };
    use pharmsol::Equation;

    const CENSORED_SIMULATIONS: [(&str, f64, usize); 3] = [
        (
            include_str!("../../../../tests/drusano_greco_alpha_negative.csv"),
            -0.5,
            5,
        ),
        (
            include_str!("../../../../tests/drusano_greco_alpha_zero.csv"),
            0.0,
            12,
        ),
        (
            include_str!("../../../../tests/drusano_greco_alpha_positive.csv"),
            0.5,
            16,
        ),
    ];

    const BLISS_CALIBRATED_SIMULATIONS: [(&str, f64); 3] = [
        (
            include_str!("../../../../tests/drusano_greco_bliss_minus12.csv"),
            -12.0,
        ),
        (
            include_str!("../../../../tests/drusano_greco_bliss_plus0_5.csv"),
            0.5,
        ),
        (
            include_str!("../../../../tests/drusano_greco_bliss_plus10.csv"),
            10.0,
        ),
    ];

    fn censored_simulation_dataset(csv_text: &str) -> DrusanoDataSet {
        let mut reader = csv::Reader::from_reader(csv_text.as_bytes());
        let rows = reader
            .records()
            .map(|record| {
                let record = record.expect("valid simulated CSV record");
                let response: f64 = record[6].parse().expect("simulated response");
                let latent_effect: f64 = record[7].parse().expect("latent effect");
                let censored: usize = record[8].parse().expect("censor indicator");
                assert_eq!(censored == 1, latent_effect > 0.9);
                let expected_response = if censored == 1 {
                    0.1
                } else {
                    1.0 - latent_effect
                };
                assert!((response - expected_response).abs() < 1e-12);
                AssayRow {
                    concentrations: vec![
                        record[2].parse().expect("drug 1 concentration"),
                        record[3].parse().expect("drug 2 concentration"),
                    ],
                    od: response,
                }
            })
            .collect();
        checkerboard_core::drusano_greco::build_equation_dataset(
            &AssayInput {
                drug_names: vec!["Drug 1".into(), "Drug 2".into()],
                rows,
            },
            &DrusanoDataSettings {
                blank_value: 0.0,
                response_censor_limit: Some(0.1),
            },
        )
        .expect("simulated checkerboard should build")
    }

    fn deta_cfz_dataset() -> DrusanoDataSet {
        let mut reader =
            csv::Reader::from_reader(include_bytes!("../../../../tests/DETA_CFZ.csv") as &[u8]);
        let rows = reader
            .records()
            .map(|record| {
                let record = record.expect("valid DETA/CFZ fixture row");
                AssayRow {
                    concentrations: vec![record[2].parse().unwrap(), record[3].parse().unwrap()],
                    od: record[6].parse().unwrap(),
                }
            })
            .collect();
        checkerboard_core::drusano_greco::build_equation_dataset(
            &AssayInput {
                drug_names: vec!["DETA".into(), "CFZ".into()],
                rows,
            },
            &DrusanoDataSettings {
                blank_value: 0.0,
                response_censor_limit: Some(0.1),
            },
        )
        .expect("DETA/CFZ checkerboard should build")
    }

    fn bliss_calibrated_assay(csv_text: &str) -> (AssayInput, f64) {
        let mut reader = csv::Reader::from_reader(csv_text.as_bytes());
        let mut true_alpha = None;
        let rows = reader
            .records()
            .map(|record| {
                let record = record.expect("valid Bliss-calibrated CSV record");
                true_alpha = Some(record[9].parse().expect("true alpha"));
                AssayRow {
                    concentrations: vec![
                        record[0].parse().expect("drug 1 concentration"),
                        record[1].parse().expect("drug 2 concentration"),
                    ],
                    od: record[2].parse().expect("simulated response"),
                }
            })
            .collect();
        (
            AssayInput {
                drug_names: vec!["Drug 1".into(), "Drug 2".into()],
                rows,
            },
            true_alpha.expect("fixture should contain alpha metadata"),
        )
    }

    #[test]
    fn percentile_json_fields_preserve_decimal_underscores() {
        let parameter = serde_json::to_value(DrusanoParameterSummary {
            name: "h1".into(),
            mean: 1.0,
            standard_deviation: 0.1,
            percentile2_5: 0.8,
            median: 1.0,
            percentile97_5: 1.2,
        })
        .unwrap();
        assert_eq!(parameter["percentile2_5"], 0.8);
        assert_eq!(parameter["percentile97_5"], 1.2);
        assert!(parameter.get("percentile25").is_none());
        assert!(parameter.get("percentile975").is_none());

        let regimen = serde_json::to_value(DrusanoRegimenSimulationSummary {
            mean: 0.5,
            standard_deviation: 0.1,
            minimum: 0.1,
            percentile2_5: 0.2,
            percentile25: 0.3,
            median: 0.5,
            percentile75: 0.7,
            percentile97_5: 0.8,
            maximum: 0.9,
        })
        .unwrap();
        assert_eq!(regimen["percentile2_5"], 0.2);
        assert_eq!(regimen["percentile97_5"], 0.8);
    }

    #[test]
    fn predicted_absorbance_equation_has_valid_metadata() {
        let equation = predicted_absorbance_equation().unwrap();
        let model_metadata = equation.metadata().expect("model metadata");
        assert_eq!(
            model_metadata.parameter_names(),
            ["ec50_1", "ec50_2", "h1", "h2", "b1", "b2", "alpha_12"]
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
                well_id: (index + 1).to_string(),
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
            eligible_well_count: wells.len(),
            control_count: 1,
            excluded_boundary_count: 0,
            excluded_effect_below_zero_count: 0,
            excluded_effect_above_one_count: 0,
            censored_count: 1,
            response_censor_limit: Some(0.1),
            normalized_effect_censor_limit: Some(0.9),
            blank_value: 0.0,
            control_mean: 1.0,
            max_concentrations: vec![1.0, 1.0],
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
        assert_eq!(result.parameter_names.len(), 7);
        let total_probability = result
            .support_points
            .iter()
            .map(|point| point.probability)
            .sum::<f64>();
        assert!((total_probability - 1.0).abs() < 1e-8);
        assert!(!result.predictions.is_empty());
        assert!(result.regression.is_some());
        assert_eq!(result.assay_error.coefficients, [0.02, 0.0, 0.1, 0.0]);
        assert_eq!(result.assay_error.initial_lambda, 0.01);
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
                well_id: (index + 1).to_string(),
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
            eligible_well_count: wells.len(),
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
    fn joint_reference_fit_produces_unclustered_parametric_bootstrap_vectors() {
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
                well_id: (index + 1).to_string(),
                raw_response: 1.0 - effect,
                normalized_effect: *effect,
                normalized_doses: doses.to_vec(),
                censored: false,
            })
            .collect::<Vec<_>>();
        let original_doses = wells
            .iter()
            .map(|well| well.normalized_doses.clone())
            .collect::<Vec<_>>();
        let data = DrusanoDataSet {
            drug_names: vec!["A".into(), "B".into()],
            headers: vec![],
            rows: vec![],
            eligible_well_count: wells.len(),
            control_count: 1,
            excluded_boundary_count: 0,
            excluded_effect_below_zero_count: 0,
            excluded_effect_above_one_count: 0,
            censored_count: 0,
            response_censor_limit: Some(0.1),
            normalized_effect_censor_limit: Some(0.9),
            blank_value: 0.0,
            control_mean: 1.0,
            max_concentrations: vec![1.0, 1.0],
            wells,
            warnings: vec![],
        };
        let progress = std::sync::Mutex::new(Vec::new());
        let result = fit_npag_with_options(
            data.clone(),
            DrusanoAssayErrorSettings::default(),
            2,
            None,
            3,
            123,
            |phase, _, _, completed, total| {
                progress
                    .lock()
                    .unwrap()
                    .push((phase.to_string(), completed, total));
            },
        )
        .unwrap();
        let progress = progress.into_inner().unwrap();

        assert_eq!(result.bootstrap_iterations, 3);
        assert_eq!(result.bootstrap_seed, 123);
        assert_eq!(result.support_points.len(), 3);
        assert!(
            result
                .support_points
                .iter()
                .all(|point| (point.probability - 1.0 / 3.0).abs() < 1e-12)
        );
        assert_eq!(
            result
                .data
                .wells
                .iter()
                .map(|well| well.normalized_doses.clone())
                .collect::<Vec<_>>(),
            original_doses
        );
        assert!(progress.iter().any(|entry| entry.0 == "reference"));
        assert!(
            progress
                .iter()
                .any(|entry| entry == &("bootstrap".into(), 3, 3))
        );
        assert!(
            result
                .parameter_summaries
                .iter()
                .all(|summary| summary.percentile2_5 <= summary.percentile97_5)
        );
        let repeated = fit_npag_with_options(
            data,
            DrusanoAssayErrorSettings::default(),
            2,
            None,
            3,
            123,
            |_, _, _, _, _| {},
        )
        .unwrap();
        assert_eq!(result.support_points.len(), repeated.support_points.len());
        for (first, second) in result.support_points.iter().zip(repeated.support_points) {
            assert_eq!(first.values, second.values);
            assert_eq!(first.probability, second.probability);
        }
    }

    #[test]
    fn implicit_prediction_recovers_known_additive_effect() {
        let names = vec![
            "ec50_1".into(),
            "ec50_2".into(),
            "h1".into(),
            "h2".into(),
            "b1".into(),
            "b2".into(),
            "alpha_12".into(),
        ];
        let predicted =
            solve_effect(0.25, 0.25, &names, &[1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0]).unwrap();
        assert!((predicted - 1.0 / 3.0).abs() < 1e-10);
    }

    #[test]
    fn constant_interaction_model_retains_the_original_combination_exponent() {
        let constant = solve_effect_values(0.5, 0.75, [1.0, 1.0, 1.0, 2.0, 0.0, 0.0, 0.5]).unwrap();
        assert!((constant - 0.628_005_207_486_265_9).abs() < 1e-12);
    }

    #[test]
    fn b_terms_change_off_ec50_monotherapy_but_preserve_ec50() {
        let constant = solve_effect_values(0.25, 0.0, [1.0, 1.0, 1.0, 2.0, 0.0, 0.0, 0.0]).unwrap();
        let shaped = solve_effect_values(0.25, 0.0, [1.0, 1.0, 1.0, 2.0, 1.0, 0.0, 0.0]).unwrap();
        let at_ec50 = solve_effect_values(1.0, 0.0, [1.0, 1.0, 1.0, 2.0, 1.0, 0.0, 0.0]).unwrap();
        assert!((constant - shaped).abs() > 1e-3);
        assert!((at_ec50 - 0.5).abs() < 1e-12);
    }

    #[test]
    fn deta_cfz_fit_and_bootstrap_have_finite_roots_with_variable_hill_slopes() {
        let fit = fit_npag_with_options(
            deta_cfz_dataset(),
            DrusanoAssayErrorSettings::default(),
            100,
            None,
            1,
            123,
            |_, _, _, _, _| {},
        )
        .expect("DETA/CFZ fit should retain a finite reference root");

        assert_eq!(fit.bootstrap_iterations, 1);
        assert_eq!(fit.support_points.len(), 1);
        assert!(
            fit.reference_support_point
                .values
                .iter()
                .all(|value| value.is_finite())
        );
        assert_eq!(fit.unpredicted_count, 0);
    }

    #[test]
    fn censored_simulation_fixtures_recover_reference_and_bootstrap_parameters() {
        for (csv_text, alpha_12, expected_censored) in CENSORED_SIMULATIONS {
            let mut fixture_reader = csv::Reader::from_reader(csv_text.as_bytes());
            for record in fixture_reader.records() {
                let record = record.expect("simulation fixture row");
                let d1 = record[2].parse::<f64>().unwrap() / 8.0;
                let d2 = record[3].parse::<f64>().unwrap() / 8.0;
                let latent_effect = record[7].parse::<f64>().unwrap();
                let predicted =
                    solve_effect_values(d1, d2, [0.125, 0.25, 1.0, 2.0, 0.0, 0.0, alpha_12])
                        .unwrap();
                assert!(
                    (predicted - latent_effect).abs() < 1e-10,
                    "alpha {alpha_12}, doses ({d1}, {d2}): predicted {predicted}, fixture {latent_effect}"
                );
            }
            let data = censored_simulation_dataset(csv_text);
            assert_eq!(data.control_count, 1);
            assert_eq!(data.max_concentrations, [8.0, 8.0]);
            assert_eq!(data.censored_count, expected_censored);
            assert_eq!(data.normalized_effect_censor_limit, Some(0.9));

            let fit = fit_npag_with_options(
                data,
                DrusanoAssayErrorSettings {
                    coefficients: [0.01, 0.0, 0.0, 0.0],
                    lambda: 0.0,
                },
                DEFAULT_MAX_CYCLES,
                None,
                100,
                123,
                |_, _, _, _, _| {},
            )
            .expect("reference fit should succeed");
            let truth = [0.125, 0.25, 1.0, 2.0, 0.0, 0.0, alpha_12];
            let recovery_tolerances = [0.01, 0.02, 0.1, 0.15, 0.2, 0.2, 0.25];
            let interval_tolerances = [0.01, 0.01, 0.03, 0.08, 0.1, 0.1, 0.2];
            assert_eq!(fit.bootstrap_iterations, 100);
            assert!(
                fit.bootstrap_converged_count >= if alpha_12 == 0.0 { 80 } else { 85 },
                "alpha {alpha_12}: only {} bootstrap fits converged",
                fit.bootstrap_converged_count
            );
            assert!(
                fit.regression.as_ref().unwrap().r_squared
                    > if alpha_12 < 0.0 { 0.9 } else { 0.99 },
                "alpha {alpha_12}: R2 was {}; reference {:?}",
                fit.regression.as_ref().unwrap().r_squared,
                fit.reference_support_point.values
            );
            // With censoring and a negative interaction term, the alpha
            // intercept and slope can be weakly identified. The exact forward-model check
            // above remains pinned; do not claim parameter recovery here.
            if alpha_12 < 0.0 {
                continue;
            }
            for (index, expected) in truth.into_iter().enumerate() {
                let reference = fit.reference_support_point.values[index];
                let summary = &fit.parameter_summaries[index];
                assert!(
                    (reference - expected).abs() <= recovery_tolerances[index],
                    "{} reference estimate {reference} did not recover {expected}",
                    fit.parameter_names[index]
                );
                assert!(
                    (summary.median - expected).abs() <= recovery_tolerances[index],
                    "{} bootstrap median {} did not recover {expected}",
                    fit.parameter_names[index],
                    summary.median
                );
                assert!(
                    expected >= summary.percentile2_5 - interval_tolerances[index]
                        && expected <= summary.percentile97_5 + interval_tolerances[index],
                    "{} bootstrap interval [{}, {}] missed {expected}",
                    fit.parameter_names[index],
                    summary.percentile2_5,
                    summary.percentile97_5
                );
            }

            // EC50 is fitted as a fraction of the maximum concentration. Verify
            // that the app's summary-scale conversion recovers 1 and 2 mg/L.
            assert!((fit.reference_support_point.values[0] * 8.0 - 1.0).abs() <= 0.24);
            assert!((fit.reference_support_point.values[1] * 8.0 - 2.0).abs() <= 0.24);
        }
    }

    #[test]
    fn bliss_calibrated_equation_fixtures_validate_bliss_and_drusano_recovery() {
        for (csv_text, target_bliss) in BLISS_CALIBRATED_SIMULATIONS {
            let (assay, true_alpha) = bliss_calibrated_assay(csv_text);
            let bliss = analyze(
                &assay,
                AnalysisPolicy {
                    response_type: ResponseType::ViabilityFraction,
                    bootstrap_iterations: 2,
                    ..AnalysisPolicy::default()
                },
            )
            .expect("Bliss analysis should succeed");
            assert_eq!(bliss.summary.combination_count, 49);
            assert!((bliss.summary.mean_bliss - target_bliss).abs() < 1e-9);

            let data = checkerboard_core::drusano_greco::build_equation_dataset(
                &assay,
                &DrusanoDataSettings {
                    blank_value: 0.0,
                    response_censor_limit: None,
                },
            )
            .expect("Equation 2 fixture should build");
            let fit = fit_npag_with_config(
                data,
                DrusanoAssayErrorSettings {
                    coefficients: [0.01, 0.0, 0.0, 0.0],
                    lambda: 0.0,
                },
                |_, _| {},
                DEFAULT_PRIOR_POINTS,
                300,
                None,
            )
            .expect("Equation 2 fit should succeed");
            assert!(fit.converged);
            assert!(
                fit.regression.as_ref().unwrap().r_squared > 0.9,
                "Bliss {target_bliss}: R2 was {}; reference {:?}",
                fit.regression.as_ref().unwrap().r_squared,
                fit.reference_support_point.values
            );
            let truth = [0.125, 0.25, 1.0, 2.0, 0.0, 0.0, true_alpha];
            let tolerances = [
                0.03,
                0.03,
                0.15,
                0.2,
                0.25,
                0.25,
                (true_alpha.abs() * 0.26).max(0.1),
            ];
            for (index, expected) in truth.into_iter().enumerate() {
                let estimate = fit.reference_support_point.values[index];
                assert!(
                    (estimate - expected).abs() <= tolerances[index],
                    "Bliss {target_bliss}: {} estimate {estimate} did not recover {expected}; reference {:?}",
                    fit.parameter_names[index],
                    fit.reference_support_point.values
                );
            }
        }
    }

    #[test]
    fn regression_reports_observed_effect_on_predicted_effect() {
        let points = vec![
            DrusanoPredictionPoint {
                well_id: "1".into(),
                predicted_effect: 0.1,
                observed_effect: 0.3,
                observed_response: 0.7,
                predicted_response: 0.9,
                response_residual: Some(-0.2),
                normalized_doses: vec![0.1, 0.1],
                censored: false,
            },
            DrusanoPredictionPoint {
                well_id: "2".into(),
                predicted_effect: 0.2,
                observed_effect: 0.5,
                observed_response: 0.5,
                predicted_response: 0.8,
                response_residual: Some(-0.3),
                normalized_doses: vec![0.2, 0.2],
                censored: false,
            },
            DrusanoPredictionPoint {
                well_id: "3".into(),
                predicted_effect: 0.3,
                observed_effect: 0.7,
                observed_response: 0.3,
                predicted_response: 0.7,
                response_residual: Some(-0.4),
                normalized_doses: vec![0.3, 0.3],
                censored: false,
            },
            DrusanoPredictionPoint {
                well_id: "censored".into(),
                predicted_effect: 0.9,
                observed_effect: 0.9,
                observed_response: 0.1,
                predicted_response: 0.1,
                response_residual: None,
                normalized_doses: vec![1.0, 1.0],
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
    fn empirical_bootstrap_regimen_simulation_is_reproducible_and_maximum_scaled() {
        let request = DrusanoRegimenSimulationRequest {
            drug_names: vec!["A".into(), "B".into()],
            parameter_names: vec![
                "ec50_1".into(),
                "ec50_2".into(),
                "h1".into(),
                "h2".into(),
                "b1".into(),
                "b2".into(),
                "alpha_12".into(),
            ],
            support_points: vec![
                DrusanoSupportPoint {
                    values: vec![0.8, 1.0, 1.0, 1.2, 0.0, 0.0, 0.0],
                    probability: 0.7,
                },
                DrusanoSupportPoint {
                    values: vec![1.2, 0.7, 1.3, 0.9, 0.2, -0.2, 0.5],
                    probability: 0.3,
                },
            ],
            max_concentrations: vec![2.0, 4.0],
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
            .simulate_subject_dense(
                &subject,
                &[1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0],
                Some(&error_models),
            )
            .unwrap();

        let predicted_absorbance = 0.7_f64;
        let sigma = (predicted_absorbance.powi(2) + 0.1_f64.powi(2)).sqrt();
        let expected = (-(0.6 - predicted_absorbance).powi(2) / (2.0 * sigma.powi(2))).exp()
            / (sigma * (2.0 * std::f64::consts::PI).sqrt());
        assert!((likelihood.unwrap() - expected).abs() < 1e-12);
    }
}
