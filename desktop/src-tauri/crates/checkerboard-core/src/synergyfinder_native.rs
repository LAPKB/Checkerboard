//! Native implementation of the SynergyFinder 3.20 Bliss workflow.
//!
//! The bootstrap follows SynergyFinder's `.Bootstrapping` and `CalculateSynergy`
//! functions: normally distributed pseudo-replicates are drawn independently at
//! every dose location, the complete Bliss surface is recalculated, and the
//! resulting surfaces are summarized across iterations.  `Rng` reproduces R's
//! default Mersenne-Twister initialization and inversion normal generator so a
//! seed has the same meaning in the native and reference implementations.

use std::collections::{HashMap, HashSet};

use super::*;

#[derive(Debug, Clone)]
struct Group {
    concentrations: Vec<f64>,
    original: Vec<f64>,
    responses: Vec<f64>,
}

#[derive(Debug, Clone)]
struct SurfaceCell {
    expected: f64,
    synergy: f64,
}

pub(super) fn analyze(
    input: &AssayInput,
    policy: AnalysisPolicy,
    mut progress: impl FnMut(usize, usize),
) -> Result<AnalysisResult, AnalysisError> {
    if policy.bootstrap_iterations < 2 {
        return Err(AnalysisError::InvalidBootstrapIterations(
            policy.bootstrap_iterations,
        ));
    }
    if policy.random_seed > i32::MAX as u64 {
        return Err(AnalysisError::InvalidRandomSeed(policy.random_seed));
    }
    let control_rows = input
        .rows
        .iter()
        .filter(|row| is_control(&row.concentrations))
        .map(|row| row.od)
        .collect::<Vec<_>>();
    if control_rows.is_empty() {
        return Err(AnalysisError::MissingControl);
    }
    let control_mean = mean(&control_rows);
    if policy.response_type == ResponseType::Viability && (0.5..=2.0).contains(&control_mean) {
        return Err(AnalysisError::ViabilityScaleMismatch);
    }
    if policy.response_type == ResponseType::RawOd
        && (!control_mean.is_finite() || control_mean <= 0.0)
    {
        return Err(AnalysisError::InvalidControlMean(control_mean));
    }

    let mut grouped = HashMap::<ConcentrationKey, Group>::new();
    for row in &input.rows {
        let concentrations = row
            .concentrations
            .iter()
            .map(|value| {
                if value.abs() < ZERO_TOLERANCE {
                    0.0
                } else {
                    *value
                }
            })
            .collect::<Vec<_>>();
        let original = match policy.response_type {
            ResponseType::Viability | ResponseType::Inhibition => row.od,
            ResponseType::ViabilityFraction => 100.0 * row.od,
            ResponseType::InhibitionFraction => 100.0 * row.od,
            ResponseType::RawOd => 100.0 * row.od / control_mean,
        };
        let response = match policy.response_type {
            ResponseType::Viability | ResponseType::ViabilityFraction | ResponseType::RawOd => {
                100.0 - original
            }
            ResponseType::Inhibition | ResponseType::InhibitionFraction => original,
        };
        let key = ConcentrationKey::new(&concentrations);
        let group = grouped.entry(key).or_insert_with(|| Group {
            concentrations,
            original: Vec::new(),
            responses: Vec::new(),
        });
        group.original.push(original);
        group.responses.push(response);
    }
    let mut groups = grouped.into_values().collect::<Vec<_>>();
    groups.sort_by(|left, right| compare_coordinates(&left.concentrations, &right.concentrations));

    let expected_grid_size = (0..input.drug_names.len())
        .map(|index| {
            groups
                .iter()
                .map(|group| canonical_bits(group.concentrations[index]))
                .collect::<HashSet<_>>()
                .len()
        })
        .product::<usize>();
    if expected_grid_size != groups.len() && !policy.allow_incomplete_grid {
        return Err(AnalysisError::IncompleteGrid {
            expected: expected_grid_size,
            observed: groups.len(),
        });
    }

    let replicate = groups.iter().any(|group| group.responses.len() > 1);
    let iterations = policy.bootstrap_iterations.max(2);
    let mut surfaces = Vec::new();
    if replicate {
        progress(0, iterations);
        let mut rng = Rng::new(policy.random_seed as u32);
        surfaces.reserve(iterations);
        for iteration in 0..iterations {
            let sampled = groups
                .iter()
                .map(|group| bootstrap_mean(&group.responses, replicate, &mut rng))
                .collect::<Vec<_>>();
            surfaces.push(bliss_surface(
                &groups,
                &sampled,
                policy.baseline_correction,
                &input.drug_names,
            )?);
            progress(iteration + 1, iterations);
        }
    } else {
        progress(0, 1);
        let observed = groups
            .iter()
            .map(|group| mean(&group.responses))
            .collect::<Vec<_>>();
        surfaces.push(bliss_surface(
            &groups,
            &observed,
            policy.baseline_correction,
            &input.drug_names,
        )?);
        progress(1, 1);
    }

    let combination_indices = groups
        .iter()
        .enumerate()
        .filter(|(_, group)| group.concentrations.iter().all(|value| *value > 0.0))
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let matrix_means = surfaces
        .iter()
        .map(|surface| {
            mean(
                &combination_indices
                    .iter()
                    .map(|index| surface[*index].synergy)
                    .collect::<Vec<_>>(),
            )
        })
        .collect::<Vec<_>>();

    let mut processed = Vec::with_capacity(groups.len());
    for (index, group) in groups.iter().enumerate() {
        let effect = mean(&group.responses);
        let single_agent_effects = single_agent_values(
            &groups,
            &groups
                .iter()
                .map(|g| mean(&g.responses))
                .collect::<Vec<_>>(),
            &group.concentrations,
            &input.drug_names,
        )?;
        let expected_values = surfaces
            .iter()
            .map(|surface| surface[index].expected)
            .collect::<Vec<_>>();
        let synergy_values = surfaces
            .iter()
            .map(|surface| surface[index].synergy)
            .collect::<Vec<_>>();
        let bliss_expected = mean(&expected_values);
        let bliss_interaction = mean(&synergy_values);
        let (bliss_sem, bliss_ci_left, bliss_ci_right) = if replicate {
            let sd = sample_sd(&synergy_values);
            (
                Some(sd / (iterations as f64).sqrt()),
                Some(quantile_type7(&synergy_values, 0.025)),
                Some(quantile_type7(&synergy_values, 0.975)),
            )
        } else {
            (None, None, None)
        };
        processed.push(ProcessedCombination {
            concentrations: group.concentrations.clone(),
            mean_original_od: mean(&group.original),
            mean_censored_od: effect,
            censored_replicate_count: 0,
            effect,
            single_agent_effects,
            bliss_expected,
            bliss_interaction,
            replicate_count: group.responses.len(),
            interpretation: interpret_interaction(
                bliss_interaction,
                policy.cell_additive_threshold,
            ),
            bliss_sem,
            bliss_ci_left,
            bliss_ci_right,
        });
    }

    let combination_scores = combination_indices
        .iter()
        .map(|index| processed[*index].bliss_interaction)
        .collect::<Vec<_>>();
    let mut summary = summarize(combination_scores.iter().copied());
    summary.interpretation = interpret_aggregate_mean(summary.mean_bliss);
    summary.p_value = if replicate {
        approximate_normal_p_value(&matrix_means)
    } else {
        one_sample_t_p_value(&combination_scores)
    };

    let mut warnings = Vec::new();
    if expected_grid_size != groups.len() {
        warnings.push(AnalysisWarning {
            code: "incompleteGrid".into(),
            message: format!(
                "The selected concentrations imply {expected_grid_size} combinations, but {} were observed. Native SynergyFinder-compatible analysis requires the single-agent coordinates used by observed combinations.",
                groups.len()
            ),
        });
    }

    Ok(AnalysisResult {
        drug_names: input.drug_names.clone(),
        mic_values: Vec::new(),
        mic_zero_tolerance: 0.0,
        clinically_relevant_concentrations: Vec::new(),
        concentration_units: Vec::new(),
        control: ControlStatistics {
            replicate_count: control_rows.len(),
            mean_od: control_mean,
        },
        processed,
        summary,
        warnings,
        policy,
    })
}

fn bliss_surface(
    groups: &[Group],
    responses: &[f64],
    correction: BaselineCorrection,
    drug_names: &[String],
) -> Result<Vec<SurfaceCell>, AnalysisError> {
    let corrected = correct_baseline(groups, responses, correction);
    groups
        .iter()
        .enumerate()
        .map(|(index, group)| {
            let singles =
                single_agent_values(groups, &corrected, &group.concentrations, drug_names)?;
            let expected = if group
                .concentrations
                .iter()
                .filter(|value| **value > 0.0)
                .count()
                <= 1
            {
                corrected[index]
            } else {
                100.0
                    * (1.0
                        - singles
                            .iter()
                            .fold(1.0, |product, value| product * (1.0 - value / 100.0)))
            };
            Ok(SurfaceCell {
                expected,
                synergy: corrected[index] - expected,
            })
        })
        .collect()
}

fn single_agent_values(
    groups: &[Group],
    responses: &[f64],
    concentrations: &[f64],
    drug_names: &[String],
) -> Result<Vec<f64>, AnalysisError> {
    concentrations
        .iter()
        .enumerate()
        .map(|(drug_index, concentration)| {
            let mut coordinate = vec![0.0; concentrations.len()];
            coordinate[drug_index] = *concentration;
            groups
                .iter()
                .position(|group| {
                    ConcentrationKey::new(&group.concentrations)
                        == ConcentrationKey::new(&coordinate)
                })
                .map(|index| responses[index])
                .ok_or_else(|| AnalysisError::MissingSingleAgent {
                    drug: drug_names[drug_index].clone(),
                    concentration: *concentration,
                })
        })
        .collect()
}

fn correct_baseline(
    groups: &[Group],
    responses: &[f64],
    correction: BaselineCorrection,
) -> Vec<f64> {
    if correction == BaselineCorrection::None {
        return responses.to_vec();
    }
    let drug_count = groups.first().map_or(0, |group| group.concentrations.len());
    let mut fitted_minimum = f64::INFINITY;
    for drug_index in 0..drug_count {
        let mut series = groups
            .iter()
            .enumerate()
            .filter(|(_, group)| {
                group
                    .concentrations
                    .iter()
                    .enumerate()
                    .all(|(index, value)| index == drug_index || value.abs() < ZERO_TOLERANCE)
            })
            .map(|(index, group)| (group.concentrations[drug_index], responses[index]))
            .collect::<Vec<_>>();
        series.sort_by(|left, right| left.0.total_cmp(&right.0));
        fitted_minimum = fitted_minimum.min(log_logistic_fitted_minimum(&series));
    }
    if !fitted_minimum.is_finite() {
        return responses.to_vec();
    }
    responses
        .iter()
        .map(|response| {
            if correction == BaselineCorrection::Part && *response >= 0.0 {
                *response
            } else {
                response - ((100.0 - response) / 100.0 * fitted_minimum)
            }
        })
        .collect()
}

// Four-parameter log-logistic fit. SynergyFinder uses drc::LL.4 and only the
// minimum fitted value is required for baseline correction. Multiple starts and
// Nelder-Mead make this deterministic and robust for typical dilution series.
fn log_logistic_fitted_minimum(series: &[(f64, f64)]) -> f64 {
    if series.is_empty() {
        return f64::INFINITY;
    }
    if series.len() == 1 {
        return series[0].1;
    }
    let minimum = series
        .iter()
        .map(|point| point.1)
        .fold(f64::INFINITY, f64::min);
    let maximum = series
        .iter()
        .map(|point| point.1)
        .fold(f64::NEG_INFINITY, f64::max);
    let positives = series
        .iter()
        .filter(|point| point.0 > 0.0)
        .map(|point| point.0)
        .collect::<Vec<_>>();
    let midpoint = positives
        .get(positives.len() / 2)
        .copied()
        .unwrap_or(1.0)
        .max(1e-12);
    let mut best = [1.0, minimum, maximum, midpoint.ln()];
    let mut best_error = logistic_error(best, series);
    for slope in [-2.0, -1.0, 1.0, 2.0] {
        let candidate = nelder_mead([slope, minimum, maximum, midpoint.ln()], series);
        let error = logistic_error(candidate, series);
        if error < best_error {
            best = candidate;
            best_error = error;
        }
    }
    series
        .iter()
        .map(|point| logistic_value(best, point.0))
        .fold(f64::INFINITY, f64::min)
}

fn logistic_value(parameters: [f64; 4], dose: f64) -> f64 {
    let [slope, lower, upper, log_ed50] = parameters;
    let exponent = if dose <= 0.0 {
        if slope >= 0.0 {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        }
    } else {
        (slope * (dose.ln() - log_ed50)).clamp(-700.0, 700.0)
    };
    lower + (upper - lower) / (1.0 + exponent.exp())
}

fn logistic_error(parameters: [f64; 4], series: &[(f64, f64)]) -> f64 {
    if parameters.iter().any(|value| !value.is_finite()) {
        return f64::INFINITY;
    }
    series
        .iter()
        .map(|(dose, response)| (logistic_value(parameters, *dose) - response).powi(2))
        .sum()
}

fn nelder_mead(start: [f64; 4], series: &[(f64, f64)]) -> [f64; 4] {
    let scale = (start[2] - start[1]).abs().max(1.0);
    let steps = [0.5, scale * 0.1, scale * 0.1, 0.5];
    let mut simplex = vec![start];
    for axis in 0..4 {
        let mut point = start;
        point[axis] += steps[axis];
        simplex.push(point);
    }
    for _ in 0..500 {
        simplex.sort_by(|left, right| {
            logistic_error(*left, series).total_cmp(&logistic_error(*right, series))
        });
        let spread = logistic_error(simplex[4], series) - logistic_error(simplex[0], series);
        if spread.abs() < 1e-12 {
            break;
        }
        let mut centroid = [0.0; 4];
        for point in simplex.iter().take(4) {
            for axis in 0..4 {
                centroid[axis] += point[axis] / 4.0;
            }
        }
        let reflect = affine(centroid, simplex[4], -1.0);
        let reflected_error = logistic_error(reflect, series);
        let best_error = logistic_error(simplex[0], series);
        let fourth_error = logistic_error(simplex[3], series);
        if reflected_error < best_error {
            let expand = affine(centroid, simplex[4], -2.0);
            simplex[4] = if logistic_error(expand, series) < reflected_error {
                expand
            } else {
                reflect
            };
        } else if reflected_error < fourth_error {
            simplex[4] = reflect;
        } else {
            let contract = affine(centroid, simplex[4], 0.5);
            if logistic_error(contract, series) < logistic_error(simplex[4], series) {
                simplex[4] = contract;
            } else {
                let best = simplex[0];
                for point in simplex.iter_mut().skip(1) {
                    for axis in 0..4 {
                        point[axis] = best[axis] + 0.5 * (point[axis] - best[axis]);
                    }
                }
            }
        }
    }
    simplex.sort_by(|left, right| {
        logistic_error(*left, series).total_cmp(&logistic_error(*right, series))
    });
    simplex[0]
}

fn affine(centroid: [f64; 4], worst: [f64; 4], factor: f64) -> [f64; 4] {
    std::array::from_fn(|axis| centroid[axis] + factor * (worst[axis] - centroid[axis]))
}

fn bootstrap_mean(values: &[f64], replicate_block: bool, rng: &mut Rng) -> f64 {
    let effective = if replicate_block && values.len() == 1 {
        2
    } else {
        values.len()
    };
    let location = mean(values);
    let sd = if values.len() <= 1 {
        0.0
    } else {
        sample_sd(values)
    };
    // R's rnorm short-circuits at sd == 0 and does not advance the RNG.
    if sd == 0.0 {
        return location;
    }
    (0..effective)
        .map(|_| location + sd * rng.standard_normal())
        .sum::<f64>()
        / effective as f64
}

fn mean(values: &[f64]) -> f64 {
    if values.is_empty() {
        f64::NAN
    } else {
        values.iter().sum::<f64>() / values.len() as f64
    }
}

fn sample_sd(values: &[f64]) -> f64 {
    if values.len() < 2 {
        return 0.0;
    }
    let average = mean(values);
    (values
        .iter()
        .map(|value| (value - average).powi(2))
        .sum::<f64>()
        / (values.len() - 1) as f64)
        .sqrt()
}

fn quantile_type7(values: &[f64], probability: f64) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    if sorted.len() == 1 {
        return sorted[0];
    }
    let index = (sorted.len() - 1) as f64 * probability;
    let lower = index.floor() as usize;
    let fraction = index - lower as f64;
    sorted[lower] + fraction * (sorted[(lower + 1).min(sorted.len() - 1)] - sorted[lower])
}

fn approximate_normal_p_value(values: &[f64]) -> Option<String> {
    if values.len() < 2 {
        return None;
    }
    let sd = sample_sd(values);
    let z = mean(values).abs() / sd;
    let p = (-0.717 * z - 0.416 * z * z).exp();
    Some(format_p_value(p))
}

fn one_sample_t_p_value(values: &[f64]) -> Option<String> {
    if values.len() < 2 {
        return None;
    }
    let sd = sample_sd(values);
    let t = mean(values).abs() / (sd / (values.len() as f64).sqrt());
    let degrees = (values.len() - 1) as f64;
    let x = degrees / (degrees + t * t);
    Some(format_p_value(regularized_beta(x, degrees / 2.0, 0.5)))
}

fn format_p_value(value: f64) -> String {
    if !value.is_finite() || value <= 0.0 {
        return "< 2e-324".into();
    }
    let raw = format!("{value:.2e}");
    let Some((mantissa, exponent)) = raw.split_once('e') else {
        return raw;
    };
    let exponent_value = exponent.parse::<i32>().unwrap_or(0);
    format!(
        "{mantissa}e{}{:#02}",
        if exponent_value < 0 { '-' } else { '+' },
        exponent_value.abs()
    )
    .replace("0x", "")
}

fn regularized_beta(x: f64, a: f64, b: f64) -> f64 {
    if x <= 0.0 {
        return 0.0;
    }
    if x >= 1.0 {
        return 1.0;
    }
    let front = (ln_gamma(a + b) - ln_gamma(a) - ln_gamma(b) + a * x.ln() + b * (-x).ln_1p()).exp();
    if x < (a + 1.0) / (a + b + 2.0) {
        front * beta_fraction(x, a, b) / a
    } else {
        1.0 - front * beta_fraction(1.0 - x, b, a) / b
    }
}

fn beta_fraction(x: f64, a: f64, b: f64) -> f64 {
    let mut c = 1.0;
    let mut d = 1.0 - (a + b) * x / (a + 1.0);
    if d.abs() < 1e-30 {
        d = 1e-30;
    }
    d = 1.0 / d;
    let mut h = d;
    for m in 1..=200 {
        let m = m as f64;
        let m2 = 2.0 * m;
        let aa = m * (b - m) * x / ((a + m2 - 1.0) * (a + m2));
        d = 1.0 + aa * d;
        if d.abs() < 1e-30 {
            d = 1e-30;
        }
        c = 1.0 + aa / c;
        if c.abs() < 1e-30 {
            c = 1e-30;
        }
        d = 1.0 / d;
        h *= d * c;
        let aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1.0));
        d = 1.0 + aa * d;
        if d.abs() < 1e-30 {
            d = 1e-30;
        }
        c = 1.0 + aa / c;
        if c.abs() < 1e-30 {
            c = 1e-30;
        }
        d = 1.0 / d;
        let delta = d * c;
        h *= delta;
        if (delta - 1.0).abs() < 3e-14 {
            break;
        }
    }
    h
}

fn ln_gamma(value: f64) -> f64 {
    const COEFFICIENTS: [f64; 9] = [
        0.9999999999998099,
        676.5203681218851,
        -1259.1392167224028,
        771.3234287776531,
        -176.6150291621406,
        12.507343278686905,
        -0.13857109526572012,
        9.984369578019572e-6,
        1.5056327351493116e-7,
    ];
    if value < 0.5 {
        return std::f64::consts::PI.ln()
            - (std::f64::consts::PI * value).sin().ln()
            - ln_gamma(1.0 - value);
    }
    let z = value - 1.0;
    let mut x = COEFFICIENTS[0];
    for (index, coefficient) in COEFFICIENTS.iter().enumerate().skip(1) {
        x += coefficient / (z + index as f64);
    }
    let t = z + 7.5;
    0.5 * (2.0 * std::f64::consts::PI).ln() + (z + 0.5) * t.ln() - t + x.ln()
}

fn compare_coordinates(left: &[f64], right: &[f64]) -> std::cmp::Ordering {
    left.iter()
        .zip(right)
        .find_map(|(a, b)| {
            let order = a.total_cmp(b);
            (order != std::cmp::Ordering::Equal).then_some(order)
        })
        .unwrap_or(std::cmp::Ordering::Equal)
}

struct Rng {
    state: [u32; 624],
    index: usize,
}

impl Rng {
    fn new(mut seed: u32) -> Self {
        for _ in 0..50 {
            seed = seed.wrapping_mul(69069).wrapping_add(1);
        }
        // R initializes 625 words, then overwrites the first with the MT index.
        seed = seed.wrapping_mul(69069).wrapping_add(1);
        let mut state = [0; 624];
        for word in &mut state {
            seed = seed.wrapping_mul(69069).wrapping_add(1);
            *word = seed;
        }
        Self { state, index: 624 }
    }

    fn uniform(&mut self) -> f64 {
        if self.index >= 624 {
            self.twist();
        }
        let mut value = self.state[self.index];
        self.index += 1;
        value ^= value >> 11;
        value ^= (value << 7) & 0x9d2c5680;
        value ^= (value << 15) & 0xefc60000;
        value ^= value >> 18;
        let result = value as f64 * 2.3283064365386963e-10;
        if result <= 0.0 {
            0.5 * 2.328306437080797e-10
        } else if result >= 1.0 {
            1.0 - 0.5 * 2.328306437080797e-10
        } else {
            result
        }
    }

    fn standard_normal(&mut self) -> f64 {
        const BIG: f64 = 134_217_728.0;
        let first = self.uniform();
        let probability = ((BIG * first) as u32 as f64 + self.uniform()) / BIG;
        qnorm(probability)
    }

    fn twist(&mut self) {
        for index in 0..624 {
            let value =
                (self.state[index] & 0x80000000) | (self.state[(index + 1) % 624] & 0x7fffffff);
            self.state[index] = self.state[(index + 397) % 624]
                ^ (value >> 1)
                ^ if value & 1 == 1 { 0x9908b0df } else { 0 };
        }
        self.index = 0;
    }
}

// AS 241, matching R's default inversion normal generator for ordinary tails.
fn qnorm(probability: f64) -> f64 {
    let q = probability - 0.5;
    if q.abs() <= 0.425 {
        let r = 0.180625 - q * q;
        return q
            * (((((((r * 2509.0809287301227 + 33430.57558358813) * r + 67265.7709270087) * r
                + 45921.95393154987)
                * r
                + 13731.69376550946)
                * r
                + 1971.5909503065514)
                * r
                + 133.14166789178438)
                * r
                + 3.3871328727963665)
            / (((((((r * 5226.495278852855 + 28729.085735721943) * r + 39307.89580009271) * r
                + 21213.794301586596)
                * r
                + 5394.196021424751)
                * r
                + 687.1870074920579)
                * r
                + 42.31333070160091)
                * r
                + 1.0);
    }
    let tail = if q > 0.0 {
        1.0 - probability
    } else {
        probability
    };
    let mut r = (-tail.ln()).sqrt();
    let value = if r <= 5.0 {
        r -= 1.6;
        (((((((r * 7.745450142783414e-4 + 0.022723844989269185) * r + 0.2417807251774506) * r
            + 1.2704582524523684)
            * r
            + 3.6478483247632045)
            * r
            + 5.769497221460691)
            * r
            + 4.630337846156546)
            * r
            + 1.4234371107496836)
            / (((((((r * 1.0507500716444169e-9 + 5.475938084995344e-4) * r
                + 0.015198666563616457)
                * r
                + 0.14810397642748008)
                * r
                + 0.6897673349851)
                * r
                + 1.6763848301838038)
                * r
                + 2.053191626637759)
                * r
                + 1.0)
    } else {
        r -= 5.0;
        (((((((r * 2.0103343992922881e-7 + 2.7115555687434876e-5) * r + 0.0012426609473880784)
            * r
            + 0.026532189526576123)
            * r
            + 0.2965605718285049)
            * r
            + 1.7848265399172913)
            * r
            + 5.463784911164115)
            * r
            + 6.657904643501103)
            / (((((((r * 2.0442631033899397e-15 + 1.4215117583164459e-7) * r
                + 1.8463183175100548e-5)
                * r
                + 7.868691311456132e-4)
                * r
                + 0.014875361290850615)
                * r
                + 0.1369298809227358)
                * r
                + 0.5998322065558879)
                * r
                + 1.0)
    };
    if q < 0.0 { -value } else { value }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn r_rng_matches_known_seed_123_uniforms() {
        let mut rng = Rng::new(123);
        assert!((rng.uniform() - 0.28757752012461424).abs() < 1e-15);
        assert!((rng.uniform() - 0.7883051354438066).abs() < 1e-15);
    }

    #[test]
    fn r_rng_matches_known_seed_123_normals() {
        let mut rng = Rng::new(123);
        let expected = [-0.5604756465522126, -0.23017748948327998, 1.558708314149124];
        for value in expected {
            assert!((rng.standard_normal() - value).abs() < 1e-14);
        }
    }

    #[test]
    fn type_seven_quantile_interpolates_like_r() {
        assert!((quantile_type7(&[1.0, 2.0, 3.0, 4.0], 0.25) - 1.75).abs() < 1e-12);
    }
}
