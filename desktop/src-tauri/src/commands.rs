use checkerboard_core::{
    AnalysisPolicy, AnalysisResult, ColumnMapping, ConcentrationRange, ResponseType, analyze_with_progress,
    assay_from_rows,
    diamond::{DiamondPolicy, DiamondResult},
    drusano_greco::{
        DrusanoCensorLimitSuggestion, DrusanoDataSet, DrusanoDataSettings, build_equation_dataset,
        suggest_response_censor_limit,
    },
};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::{
    error::AppError,
    services::{
        drusano_greco::{
            self, DrusanoAssayErrorSettings, DrusanoFitContinuation, DrusanoFitResult,
            DrusanoRegimenSimulationRequest, DrusanoRegimenSimulationResult,
        },
        importer::{self, ImportRequest},
        musyc::{self, MusycFitResult},
        snapshot,
    },
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub total_rows: usize,
    pub total_columns: usize,
    pub suggested_roles: Vec<String>,
    pub suggested_drug_names: Vec<String>,
    pub regimens: Vec<RegimenPreview>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegimenPreview {
    pub id: String,
    pub label: String,
    pub regimen_key: String,
    pub regimen_label: String,
    pub organism: Option<String>,
    pub drug_names: Vec<String>,
    pub concentration_units: Vec<String>,
    pub suggested_response_type: ResponseType,
    pub rows: Vec<Vec<String>>,
    pub total_rows: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeTableRequest {
    pub import: ImportRequest,
    pub mapping: ColumnMapping,
    pub policy: Option<AnalysisPolicy>,
    #[serde(default)]
    pub mic_values: Vec<f64>,
    #[serde(default = "default_mic_zero_tolerance")]
    pub mic_zero_tolerance: f64,
    #[serde(default)]
    pub regimen_drug_names: Vec<String>,
    #[serde(default)]
    pub organism: Option<String>,
    #[serde(default)]
    pub organism_column: Option<usize>,
    #[serde(default)]
    pub concentration_units: Vec<String>,
    #[serde(default)]
    pub clinically_relevant_concentrations: Vec<Option<f64>>,
    #[serde(default)]
    pub concentration_ranges: Vec<ConcentrationRange>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeDiamondRequest {
    pub import: ImportRequest,
    pub mapping: ColumnMapping,
    pub policy: DiamondPolicy,
    pub dose_anchors: Vec<f64>,
    #[serde(default)]
    pub regimen_drug_names: Vec<String>,
    #[serde(default)]
    pub organism: Option<String>,
    #[serde(default)]
    pub organism_column: Option<usize>,
    #[serde(default)]
    pub concentration_units: Vec<String>,
}

fn default_mic_zero_tolerance() -> f64 {
    5.0
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InferMicsRequest {
    pub import: ImportRequest,
    pub mapping: ColumnMapping,
    pub response_type: ResponseType,
    #[serde(default)]
    pub blank_value: f64,
    pub zero_tolerance: f64,
    #[serde(default)]
    pub regimen_drug_names: Vec<String>,
    #[serde(default)]
    pub organism: Option<String>,
    #[serde(default)]
    pub organism_column: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareDrusanoDataRequest {
    pub import: ImportRequest,
    pub mapping: ColumnMapping,
    pub settings: DrusanoDataSettings,
    #[serde(default)]
    pub assay_error: DrusanoAssayErrorSettings,
    #[serde(default)]
    pub regimen_drug_names: Vec<String>,
    #[serde(default)]
    pub organism: Option<String>,
    #[serde(default)]
    pub organism_column: Option<usize>,
    #[serde(default = "default_drusano_max_cycles")]
    pub max_cycles: usize,
    #[serde(default)]
    pub continuation: Option<DrusanoFitContinuation>,
    #[serde(default = "default_drusano_bootstrap_iterations")]
    pub bootstrap_iterations: usize,
    #[serde(default = "default_drusano_bootstrap_seed")]
    pub bootstrap_seed: u64,
}

fn default_drusano_max_cycles() -> usize {
    drusano_greco::DEFAULT_MAX_CYCLES
}

fn default_drusano_bootstrap_iterations() -> usize {
    500
}

fn default_drusano_bootstrap_seed() -> u64 {
    123
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestDrusanoCensorLimitRequest {
    pub import: ImportRequest,
    pub mapping: ColumnMapping,
    pub blank_value: f64,
    #[serde(default)]
    pub count_data: bool,
    #[serde(default)]
    pub regimen_drug_names: Vec<String>,
    #[serde(default)]
    pub organism: Option<String>,
    #[serde(default)]
    pub organism_column: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FitMusycRequest {
    pub import: ImportRequest,
    pub mapping: ColumnMapping,
    pub settings: DrusanoDataSettings,
    #[serde(default)]
    pub regimen_drug_names: Vec<String>,
    #[serde(default)]
    pub organism: Option<String>,
    #[serde(default)]
    pub organism_column: Option<usize>,
    #[serde(default = "default_musyc_max_iterations")]
    pub max_iterations: usize,
    #[serde(default = "default_musyc_bootstrap_iterations")]
    pub bootstrap_iterations: usize,
    #[serde(default = "default_musyc_bootstrap_seed")]
    pub bootstrap_seed: u64,
}

fn default_musyc_max_iterations() -> usize {
    5_000
}

fn default_musyc_bootstrap_iterations() -> usize { 500 }
fn default_musyc_bootstrap_seed() -> u64 { 123 }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicEstimate {
    pub drug_name: String,
    pub mic: Option<f64>,
    pub mean_response_at_mic: Option<f64>,
    pub single_agent_levels: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResultsRequest {
    pub path: String,
    pub analysis: AnalysisResult,
    pub stratify_index: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisProgress {
    completed_iterations: usize,
    total_iterations: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrusanoFitProgress {
    pub phase: String,
    pub cycle: usize,
    pub objective_function: f64,
    pub completed_bootstraps: usize,
    pub total_bootstraps: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusycFitProgress {
    pub phase: String,
    pub iteration: usize,
    pub objective_function: f64,
    pub completed_bootstraps: usize,
    pub total_bootstraps: usize,
}

#[tauri::command]
pub fn list_worksheets(path: String) -> Result<Vec<String>, AppError> {
    importer::list_worksheets(&path)
}

#[tauri::command]
pub fn import_preview(request: ImportRequest) -> Result<ImportPreview, AppError> {
    let table = importer::read_table(&request)?;
    let total_rows = table.rows.len();
    let total_columns = table.headers.len();
    let mut suggested_roles = suggest_roles(&table.headers);
    if let Some(column) = request.organism_column.filter(|column| *column < suggested_roles.len()) {
        for role in &mut suggested_roles {
            if role == "organism" {
                *role = "ignore".into();
            }
        }
        suggested_roles[column] = "organism".into();
    }
    let mut suggested_drug_names = table
        .headers
        .iter()
        .enumerate()
        .map(|(index, header)| {
            parse_concentration_header(header)
                .map(|parsed| parsed.drug_name)
                .unwrap_or_else(|| {
                    infer_drug_name(header, &format!("Drug{}", (b'A' + index as u8) as char))
                })
        })
        .collect::<Vec<_>>();
    for (index, header) in table.headers.iter().enumerate() {
        let normalized = normalize_header(header);
        let suffix = normalized.strip_prefix("conc");
        if let Some(suffix) =
            suffix.filter(|value| value.chars().all(|character| character.is_ascii_digit()))
        {
            if let Some(drug_column) = table
                .headers
                .iter()
                .position(|candidate| normalize_header(candidate) == format!("drug{suffix}"))
            {
                if let Some(name) = table
                    .rows
                    .iter()
                    .filter_map(|row| row.get(drug_column))
                    .find(|value| !value.trim().is_empty())
                {
                    suggested_drug_names[index] = name.trim().to_string();
                }
            }
        }
    }
    let drug_columns = ["drugA", "drugB", "drugC"]
        .iter()
        .filter_map(|role| {
            suggested_roles
                .iter()
                .position(|candidate| candidate == role)
        })
        .collect::<Vec<_>>();
    let response_column = suggested_roles.iter().position(|role| role == "response");
    let organism_column = suggested_roles.iter().position(|role| role == "organism");
    let mut regimens = describe_regimens(
        &table,
        &drug_columns,
        response_column,
        organism_column,
    );
    if regimens.is_empty() {
        regimens.push(generic_regimen_preview(
            &table,
            &drug_columns,
            response_column,
            None,
            None,
        ));
    }
    Ok(ImportPreview {
        headers: table.headers,
        rows: table.rows.into_iter().take(100).collect(),
        total_rows,
        total_columns,
        suggested_roles,
        suggested_drug_names,
        regimens,
    })
}

#[tauri::command]
pub fn infer_mics(request: InferMicsRequest) -> Result<Vec<MicEstimate>, AppError> {
    if !request.zero_tolerance.is_finite() || request.zero_tolerance < 0.0 {
        return Err(AppError::new(
            "invalidMicTolerance",
            "MIC zero tolerance must be finite and nonnegative.",
        ));
    }
    let table = importer::read_table(&request.import)?;
    let rows = select_regimen_rows(
        &table,
        &request.regimen_drug_names,
        request.organism.as_deref(),
        request.organism_column,
    )?;
    let assay = assay_from_rows(&rows, &request.mapping)?;
    let control_values = assay
        .rows
        .iter()
        .filter(|row| row.concentrations.iter().all(|value| value.abs() < 1e-12))
        .map(|row| row.od)
        .collect::<Vec<_>>();
    let control_mean = if control_values.is_empty() {
        None
    } else {
        Some(control_values.iter().sum::<f64>() / control_values.len() as f64)
    };

    assay
        .drug_names
        .iter()
        .enumerate()
        .map(|(drug_index, drug_name)| {
            let mut groups = std::collections::HashMap::<u64, (f64, f64, usize)>::new();
            for row in &assay.rows {
                let concentration = row.concentrations[drug_index];
                let is_single_agent = concentration > 0.0
                    && row
                        .concentrations
                        .iter()
                        .enumerate()
                        .all(|(index, value)| index == drug_index || value.abs() < 1e-12);
                if !is_single_agent {
                    continue;
                }
                let viability = match request.response_type {
                    ResponseType::Viability => row.od,
                    ResponseType::ViabilityFraction => 100.0 * row.od,
                    ResponseType::Inhibition => 100.0 - row.od,
                    ResponseType::InhibitionFraction => 100.0 * (1.0 - row.od),
                    ResponseType::RawOd => {
                        let control = control_mean.map(|value| value - request.blank_value)
                            .filter(|value| value.is_finite() && *value > 0.0)
                            .ok_or_else(|| AppError::new("invalidControl", "Raw-OD MIC inference requires a positive untreated-control mean."))?;
                        100.0 * (row.od - request.blank_value) / control
                    }
                };
                let entry = groups.entry(concentration.to_bits()).or_insert((concentration, 0.0, 0));
                entry.1 += viability;
                entry.2 += 1;
            }
            let mut levels = groups
                .into_values()
                .map(|(concentration, sum, count)| (concentration, sum / count as f64))
                .collect::<Vec<_>>();
            levels.sort_by(|left, right| left.0.total_cmp(&right.0));
            let selected = levels
                .iter()
                .find(|(_, mean)| mean.abs() <= request.zero_tolerance)
                .copied();
            Ok(MicEstimate {
                drug_name: drug_name.clone(),
                mic: selected.map(|value| value.0),
                mean_response_at_mic: selected.map(|value| value.1),
                single_agent_levels: levels.len(),
            })
        })
        .collect()
}

#[tauri::command]
pub fn prepare_drusano_data(
    request: PrepareDrusanoDataRequest,
) -> Result<DrusanoDataSet, AppError> {
    prepare_drusano_data_inner(request)
}

#[tauri::command]
pub fn suggest_drusano_censor_limit(
    request: SuggestDrusanoCensorLimitRequest,
) -> Result<Option<DrusanoCensorLimitSuggestion>, AppError> {
    let table = importer::read_table(&request.import)?;
    let rows = select_regimen_rows(
        &table,
        &request.regimen_drug_names,
        request.organism.as_deref(),
        request.organism_column,
    )?;
    let assay = assay_from_rows(&rows, &request.mapping)?;
    Ok(if request.count_data {
        checkerboard_core::drusano_greco::suggest_count_censor_limit(&assay)?
    } else {
        suggest_response_censor_limit(&assay, request.blank_value)?
    })
}

fn prepare_drusano_data_inner(
    request: PrepareDrusanoDataRequest,
) -> Result<DrusanoDataSet, AppError> {
    let table = importer::read_table(&request.import)?;
    let rows = select_regimen_rows(
        &table,
        &request.regimen_drug_names,
        request.organism.as_deref(),
        request.organism_column,
    )?;
    let assay = assay_from_rows(&rows, &request.mapping)?;
    Ok(build_equation_dataset(&assay, &request.settings)?)
}

#[tauri::command]
pub async fn fit_drusano_greco(
    request: PrepareDrusanoDataRequest,
    on_progress: Channel<DrusanoFitProgress>,
) -> Result<DrusanoFitResult, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let assay_error = request.assay_error.clone();
        let max_cycles = request.max_cycles;
        let continuation = request.continuation.clone();
        let bootstrap_iterations = request.bootstrap_iterations;
        let bootstrap_seed = request.bootstrap_seed;
        let data = prepare_drusano_data_inner(request)?;
        drusano_greco::fit_npag_with_options(
            data,
            assay_error,
            max_cycles,
            continuation,
            bootstrap_iterations,
            bootstrap_seed,
            |phase, cycle, objective_function, completed_bootstraps, total_bootstraps| {
                let _ = on_progress.send(DrusanoFitProgress {
                    phase: phase.into(),
                    cycle,
                    objective_function,
                    completed_bootstraps,
                    total_bootstraps,
                });
            },
        )
        .map_err(|error| AppError::new("drusanoFitError", error.to_string()))
    })
    .await
    .map_err(|error| AppError::new("drusanoWorkerError", error.to_string()))?
}

#[tauri::command]
pub async fn simulate_drusano_regimen(
    request: DrusanoRegimenSimulationRequest,
) -> Result<DrusanoRegimenSimulationResult, AppError> {
    tauri::async_runtime::spawn_blocking(move || drusano_greco::simulate_regimen(request))
        .await
        .map_err(|error| AppError::new("drusanoSimulationWorkerError", error.to_string()))?
        .map_err(|error| AppError::new("drusanoSimulationError", error.to_string()))
}

#[tauri::command]
pub async fn fit_musyc(
    request: FitMusycRequest,
    on_progress: Channel<MusycFitProgress>,
) -> Result<MusycFitResult, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let table = importer::read_table(&request.import)?;
        let rows = select_regimen_rows(
            &table,
            &request.regimen_drug_names,
            request.organism.as_deref(),
            request.organism_column,
        )?;
        let assay = assay_from_rows(&rows, &request.mapping)?;
        let data = build_equation_dataset(&assay, &request.settings)?;
        musyc::fit_with_bootstrap(
            data,
            request.max_iterations,
            request.bootstrap_iterations,
            request.bootstrap_seed,
            |phase, iteration, objective_function, completed_bootstraps, total_bootstraps| {
                let _ = on_progress.send(MusycFitProgress {
                    phase: phase.into(), iteration, objective_function,
                    completed_bootstraps, total_bootstraps,
                });
            },
        )
            .map_err(|error| AppError::new("musycFitError", error.to_string()))
    })
    .await
    .map_err(|error| AppError::new("musycWorkerError", error.to_string()))?
}

#[tauri::command]
pub async fn save_project_snapshot(path: String, snapshot_json: String) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || snapshot::save(&path, &snapshot_json))
        .await
        .map_err(|error| AppError::new("projectSaveWorkerError", error.to_string()))?
        .map_err(|error| AppError::new("projectSaveError", error.to_string()))
}

#[tauri::command]
pub async fn load_project_snapshot(path: String) -> Result<String, AppError> {
    tauri::async_runtime::spawn_blocking(move || snapshot::load(&path))
        .await
        .map_err(|error| AppError::new("projectLoadWorkerError", error.to_string()))?
        .map_err(|error| AppError::new("projectLoadError", error.to_string()))
}

#[tauri::command]
pub async fn analyze_table(
    request: AnalyzeTableRequest,
    on_progress: Channel<AnalysisProgress>,
) -> Result<AnalysisResult, AppError> {
    tauri::async_runtime::spawn_blocking(move || analyze_table_inner(request, Some(on_progress)))
        .await
        .map_err(|error| AppError::new("analysisWorkerError", error.to_string()))?
}

#[tauri::command]
pub async fn analyze_diamond(
    request: AnalyzeDiamondRequest,
    on_progress: Channel<AnalysisProgress>,
) -> Result<DiamondResult, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let table = importer::read_table(&request.import)?;
        let rows = select_regimen_rows(
            &table,
            &request.regimen_drug_names,
            request.organism.as_deref(),
            request.organism_column,
        )?;
        validate_regimen_units(
            &table.headers,
            &rows,
            &request.mapping,
            &request.concentration_units,
        )?;
        let assay = assay_from_rows(&rows, &request.mapping)?;
        let mut result = checkerboard_core::diamond::analyze(
            &assay,
            &request.dose_anchors,
            request.policy,
            |completed, total| {
                let _ = on_progress.send(AnalysisProgress {
                    completed_iterations: completed,
                    total_iterations: total,
                });
            },
        )?;
        result.concentration_units = if request.concentration_units.len() == assay.drug_names.len() {
            request.concentration_units
        } else {
            vec![String::new(); assay.drug_names.len()]
        };
        Ok(result)
    })
    .await
    .map_err(|error| AppError::new("diamondWorkerError", error.to_string()))?
}

fn analyze_table_inner(
    request: AnalyzeTableRequest,
    on_progress: Option<Channel<AnalysisProgress>>,
) -> Result<AnalysisResult, AppError> {
    let table = importer::read_table(&request.import)?;
    let rows = select_regimen_rows(
        &table,
        &request.regimen_drug_names,
        request.organism.as_deref(),
        request.organism_column,
    )?;
    validate_regimen_units(
        &table.headers,
        &rows,
        &request.mapping,
        &request.concentration_units,
    )?;
    let mut assay = assay_from_rows(&rows, &request.mapping)?;
    if request.mic_values.len() != assay.drug_names.len()
        || request
            .mic_values
            .iter()
            .any(|value| !value.is_finite() || *value <= 0.0)
    {
        return Err(AppError::new(
            "invalidMicValues",
            "Enter one finite, positive MIC value for each mapped drug.",
        ));
    }
    if !request.mic_zero_tolerance.is_finite() || request.mic_zero_tolerance < 0.0 {
        return Err(AppError::new(
            "invalidMicTolerance",
            "MIC zero tolerance must be finite and nonnegative.",
        ));
    }
    let policy = request.policy.unwrap_or_default();
    validate_response_values(&assay, policy.response_type)?;
    let legacy_clinically_relevant = request.clinically_relevant_concentrations;
    let concentration_ranges = if !request.concentration_ranges.is_empty() {
        request.concentration_ranges
    } else if !legacy_clinically_relevant.is_empty() {
        legacy_clinically_relevant
            .iter()
            .map(|target| ConcentrationRange {
                minimum: target.map(|value| value / 4.0),
                maximum: target.map(|value| value * 4.0),
            })
            .collect()
    } else {
        vec![ConcentrationRange::default(); assay.drug_names.len()]
    };
    if concentration_ranges.len() != assay.drug_names.len()
        || concentration_ranges
            .iter()
            .any(|range| {
                range.minimum.is_some_and(|value| !value.is_finite() || value < 0.0)
                    || range.maximum.is_some_and(|value| !value.is_finite() || value <= 0.0)
                    || matches!((range.minimum, range.maximum), (Some(minimum), Some(maximum)) if minimum > maximum)
            })
    {
        return Err(AppError::new(
            "invalidConcentrationRanges",
            "Concentration ranges must have finite, nonnegative lower bounds and positive upper bounds, with the minimum no greater than the maximum.",
        ));
    }
    let full_assay = assay.clone();
    let has_clinical_window = concentration_ranges
        .iter()
        .any(|range| range.minimum.is_some() || range.maximum.is_some());
    if has_clinical_window {
        assay.rows.retain(|row| {
            row.concentrations
                .iter()
                .zip(&concentration_ranges)
                .all(|(dose, range)| {
                    *dose <= 0.0
                        || (range.minimum.is_none_or(|minimum| *dose >= minimum)
                            && range.maximum.is_none_or(|maximum| *dose <= maximum))
                })
        });
        if !assay
            .rows
            .iter()
            .any(|row| row.concentrations.iter().all(|value| *value > 0.0))
        {
            return Err(AppError::new(
                "noCombinationsInConcentrationRange",
                "No combination wells fall within the specified concentration ranges.",
            ));
        }
    }
    let mut restricted_total = 0;
    let mut result = analyze_with_progress(&assay, policy, |completed, total| {
        restricted_total = total;
        if let Some(channel) = &on_progress {
            let _ = channel.send(AnalysisProgress {
                completed_iterations: completed,
                total_iterations: if has_clinical_window {
                    total * 2
                } else {
                    total
                },
            });
        }
    })?;
    if has_clinical_window {
        let full_result = analyze_with_progress(&full_assay, policy, |completed, total| {
            if let Some(channel) = &on_progress {
                let _ = channel.send(AnalysisProgress {
                    completed_iterations: restricted_total + completed,
                    total_iterations: restricted_total + total,
                });
            }
        })?;
        let restricted_rows = result.processed.clone();
        result.processed = full_result
            .processed
            .into_iter()
            .map(|full_row| {
                restricted_rows
                    .iter()
                    .find(|restricted| restricted.concentrations == full_row.concentrations)
                    .cloned()
                    .unwrap_or(full_row)
            })
            .collect();
        result.warnings.push(checkerboard_core::AnalysisWarning {
            code: "concentrationRange".into(),
            message: "Overall statistics are restricted to wells within the specified concentration range for each drug; the full observed surface remains available for context.".into(),
        });
    }
    result.mic_values = request.mic_values;
    result.mic_zero_tolerance = request.mic_zero_tolerance;
    result.clinically_relevant_concentrations = Vec::new();
    result.concentration_ranges = concentration_ranges;
    result.concentration_units = if request.concentration_units.len() == assay.drug_names.len() {
        request.concentration_units
    } else {
        vec![String::new(); assay.drug_names.len()]
    };
    Ok(result)
}

fn select_regimen_rows(
    table: &importer::ImportedTable,
    regimen_drug_names: &[String],
    organism: Option<&str>,
    organism_column: Option<usize>,
) -> Result<Vec<Vec<String>>, AppError> {
    if regimen_drug_names.is_empty() && organism.is_none() {
        return Ok(table.rows.clone());
    }
    let name_columns = regimen_name_columns(&table.headers).ok();
    if !regimen_drug_names.is_empty() && name_columns.is_none() && organism.is_none() {
        // A file without confidently inferred drug-name columns is presented as
        // one regimen. Column mapping still determines concentrations and the
        // response; no rows should be rejected merely because headers differ.
        return Ok(table.rows.clone());
    }
    if organism.is_some() && organism_column.is_none() {
        return Err(AppError::new(
            "missingOrganismColumn",
            "An organism was selected, but no Organism column is mapped.",
        ));
    }
    let selected = table
        .rows
        .iter()
        .filter(|row| {
            let regimen_matches = regimen_drug_names.is_empty()
                || name_columns.as_ref().is_none_or(|columns| {
                    row_drug_names(row, columns)
                        .is_some_and(|names| names == regimen_drug_names)
                });
            let organism_matches = organism.is_none_or(|selected_organism| {
                organism_column
                    .and_then(|column| row.get(column))
                    .is_some_and(|value| value.trim() == selected_organism)
            });
            regimen_matches && organism_matches
        })
        .cloned()
        .collect::<Vec<_>>();
    if selected.is_empty() {
        Err(AppError::new(
            "missingRegimen",
            format!(
                "No rows were found for {}{}.",
                if regimen_drug_names.is_empty() {
                    "the selected regimen".into()
                } else {
                    format!("regimen {}", regimen_drug_names.join(" + "))
                },
                organism.map_or_else(String::new, |value| format!(" and organism {value}"))
            ),
        ))
    } else {
        Ok(selected)
    }
}

fn describe_regimens(
    table: &importer::ImportedTable,
    drug_columns: &[usize],
    response_column: Option<usize>,
    organism_column: Option<usize>,
) -> Vec<RegimenPreview> {
    let Ok(name_columns) = regimen_name_columns(&table.headers) else {
        let mut organisms = table
            .rows
            .iter()
            .filter_map(|row| row_organism(row, organism_column))
            .collect::<Vec<_>>();
        organisms.sort();
        organisms.dedup();
        if organisms.is_empty() {
            return vec![generic_regimen_preview(
                table,
                drug_columns,
                response_column,
                organism_column,
                None,
            )];
        }
        return organisms
            .into_iter()
            .enumerate()
            .map(|(index, organism)| {
                generic_regimen_preview(
                    table,
                    drug_columns,
                    response_column,
                    organism_column,
                    Some((index + 1, organism)),
                )
            })
            .collect();
    };
    let unit_columns = [0, 1, 2].map(|index| find_units_column(&table.headers, index));
    let mut combinations = Vec::<(Vec<String>, Option<String>)>::new();
    for row in &table.rows {
        if let Some(names) = row_drug_names(row, &name_columns)
            && !combinations.contains(&(names.clone(), row_organism(row, organism_column)))
        {
            combinations.push((names, row_organism(row, organism_column)));
        }
    }
    combinations
        .into_iter()
        .enumerate()
        .map(|(index, (drug_names, organism))| {
            let rows = table
                .rows
                .iter()
                .filter(|row| {
                    row_drug_names(row, &name_columns).is_some_and(|names| names == drug_names)
                        && row_organism(row, organism_column) == organism
                })
                .collect::<Vec<_>>();
            let concentration_units = (0..drug_names.len())
                .map(|drug_index| {
                    unit_columns[drug_index]
                        .and_then(|column| {
                            rows.iter()
                                .filter_map(|row| row.get(column))
                                .map(|value| value.trim())
                                .find(|value| !value.is_empty())
                                .map(str::to_string)
                        })
                        .or_else(|| {
                            drug_columns
                                .get(drug_index)
                                .and_then(|column| {
                                    parse_concentration_header(&table.headers[*column])
                                })
                                .map(|parsed| parsed.unit)
                        })
                        .unwrap_or_default()
                })
                .collect::<Vec<_>>();
            let active_drug_columns = &drug_columns[..drug_names.len().min(drug_columns.len())];
            let suggested_response_type =
                infer_response_type(&rows, active_drug_columns, response_column);
            let id = (index + 1).to_string();
            let regimen_label = drug_names.join(" + ");
            let label = organism.as_ref().map_or_else(
                || format!("{id} — {regimen_label}"),
                |value| format!("{id} — {value} — {regimen_label}"),
            );
            let total_rows = rows.len();
            RegimenPreview {
                id,
                label,
                regimen_key: drug_names.join("\u{1f}"),
                regimen_label,
                organism,
                drug_names,
                concentration_units,
                suggested_response_type,
                rows: rows.into_iter().take(100).cloned().collect(),
                total_rows,
            }
        })
        .collect()
}

fn generic_regimen_preview(
    table: &importer::ImportedTable,
    drug_columns: &[usize],
    response_column: Option<usize>,
    organism_column: Option<usize>,
    organism_entry: Option<(usize, String)>,
) -> RegimenPreview {
    let drug_count = drug_columns.len().clamp(2, 3);
    let drug_names = (0..drug_count)
        .map(|index| {
            drug_columns
                .get(index)
                .map(|column| {
                    infer_drug_name(&table.headers[*column], &format!("Drug {}", index + 1))
                })
                .unwrap_or_else(|| format!("Drug {}", index + 1))
        })
        .collect::<Vec<_>>();
    let concentration_units = (0..drug_count)
        .map(|index| {
            drug_columns
                .get(index)
                .and_then(|column| parse_concentration_header(&table.headers[*column]))
                .map(|parsed| parsed.unit)
                .unwrap_or_default()
        })
        .collect();
    let organism = organism_entry.as_ref().map(|(_, value)| value.clone());
    let row_refs = table
        .rows
        .iter()
        .filter(|row| row_organism(row, organism_column) == organism)
        .collect::<Vec<_>>();
    let id = organism_entry.as_ref().map_or(1, |(index, _)| *index).to_string();
    let regimen_label = drug_names.join(" + ");
    RegimenPreview {
        id: id.clone(),
        label: organism.as_ref().map_or_else(
            || format!("{id} — {regimen_label}"),
            |value| format!("{id} — {value} — {regimen_label}"),
        ),
        regimen_key: drug_names.join("\u{1f}"),
        regimen_label,
        organism: organism.clone(),
        concentration_units,
        suggested_response_type: infer_response_type(&row_refs, drug_columns, response_column),
        drug_names,
        rows: row_refs.iter().take(100).map(|row| (*row).clone()).collect(),
        total_rows: row_refs.len(),
    }
}

fn row_organism(row: &[String], column: Option<usize>) -> Option<String> {
    column
        .and_then(|index| row.get(index))
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn regimen_name_columns(headers: &[String]) -> Result<Vec<Option<usize>>, AppError> {
    let roles = suggest_roles(headers);
    let drug_a = roles
        .iter()
        .position(|role| role == "drugNameA")
        .ok_or_else(|| AppError::new("missingDrugNameColumn", "A Drug A column is required."))?;
    let drug_b = roles
        .iter()
        .position(|role| role == "drugNameB")
        .ok_or_else(|| AppError::new("missingDrugNameColumn", "A Drug B column is required."))?;
    Ok(vec![
        Some(drug_a),
        Some(drug_b),
        roles.iter().position(|role| role == "drugNameC"),
    ])
}

fn row_drug_names(row: &[String], columns: &[Option<usize>]) -> Option<Vec<String>> {
    let first = row.get(columns[0]?)?.trim();
    let second = row.get(columns[1]?)?.trim();
    if first.is_empty() || second.is_empty() {
        return None;
    }
    let mut names = vec![first.to_string(), second.to_string()];
    if let Some(column) = columns.get(2).copied().flatten()
        && let Some(value) = row
            .get(column)
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
    {
        names.push(value.to_string());
    }
    Some(names)
}

fn find_units_column(headers: &[String], index: usize) -> Option<usize> {
    let role = format!("units{}", (b'A' + index as u8) as char);
    suggest_roles(headers)
        .iter()
        .position(|candidate| candidate == &role)
}

fn infer_response_type(
    rows: &[&Vec<String>],
    concentration_columns: &[usize],
    response_column: Option<usize>,
) -> ResponseType {
    let Some(response_column) = response_column else {
        return ResponseType::Viability;
    };
    let values = rows
        .iter()
        .filter_map(|row| row.get(response_column)?.trim().parse::<f64>().ok())
        .collect::<Vec<_>>();
    let controls = rows
        .iter()
        .filter(|row| {
            concentration_columns.iter().all(|column| {
                row.get(*column)
                    .and_then(|value| value.trim().parse::<f64>().ok())
                    .is_some_and(|value| value.abs() < 1e-12)
            })
        })
        .filter_map(|row| row.get(response_column)?.trim().parse::<f64>().ok())
        .collect::<Vec<_>>();
    let treated = rows
        .iter()
        .filter(|row| {
            concentration_columns.iter().any(|column| {
                row.get(*column)
                    .and_then(|value| value.trim().parse::<f64>().ok())
                    .is_some_and(|value| value > 0.0)
            })
        })
        .filter_map(|row| row.get(response_column)?.trim().parse::<f64>().ok())
        .collect::<Vec<_>>();
    let control_mean = mean_or(&controls, 0.0);
    let treated_mean = mean_or(&treated, control_mean);
    // For normalized viability, the all-zero drug arms identify the scale:
    // controls centered near 1 are fractional and controls centered near 100
    // are percentages. Fall back to the whole response distribution when the
    // controls are absent/ambiguous or when inhibition increases with dose.
    let fractional = if control_mean >= treated_mean {
        normalized_viability_scale_from_controls(&controls)
            .unwrap_or_else(|| is_fractional_response_scale(&values))
    } else {
        is_fractional_response_scale(&values)
    };
    match (control_mean >= treated_mean, fractional) {
        (true, true) => ResponseType::ViabilityFraction,
        (true, false) => ResponseType::Viability,
        (false, true) => ResponseType::InhibitionFraction,
        (false, false) => ResponseType::Inhibition,
    }
}

fn normalized_viability_scale_from_controls(controls: &[f64]) -> Option<bool> {
    let mean = mean_or(controls, f64::NAN);
    if (0.5..=2.0).contains(&mean) {
        Some(true)
    } else if (50.0..=150.0).contains(&mean) {
        Some(false)
    } else {
        None
    }
}

fn mean_or(values: &[f64], fallback: f64) -> f64 {
    if values.is_empty() {
        fallback
    } else {
        values.iter().sum::<f64>() / values.len() as f64
    }
}

fn is_fractional_response_scale(values: &[f64]) -> bool {
    let out_of_fraction_range = values.iter().filter(|value| value.abs() > 1.0).count();
    !values.is_empty() && out_of_fraction_range as f64 / values.len() as f64 <= 0.05
}

fn validate_regimen_units(
    headers: &[String],
    rows: &[Vec<String>],
    mapping: &ColumnMapping,
    expected: &[String],
) -> Result<(), AppError> {
    if expected.is_empty() || expected.iter().all(|unit| unit.trim().is_empty()) {
        return Ok(());
    }
    for (index, expected_unit) in expected.iter().enumerate() {
        let expected_unit = expected_unit.trim();
        let explicit_units_match = find_units_column(headers, index).map(|column| {
            rows.iter().all(|row| {
                row.get(column)
                    .is_some_and(|value| value.trim() == expected_unit)
            })
        });
        let embedded_unit = mapping
            .drugs
            .get(index)
            .and_then(|drug| headers.get(drug.column))
            .and_then(|header| parse_concentration_header(header))
            .map(|parsed| parsed.unit);
        let embedded_units_match = embedded_unit
            .as_deref()
            .is_some_and(|unit| unit.trim() == expected_unit);

        if expected_unit.is_empty()
            || explicit_units_match.map_or(!embedded_units_match, |units_match| !units_match)
        {
            let code = if explicit_units_match.is_none() && embedded_unit.is_none() {
                "missingUnits"
            } else {
                "inconsistentUnits"
            };
            return Err(AppError::new(
                code,
                format!(
                    "Regimen concentration units for drug {} must be nonblank and consistent, either in a Units {} column or the mapped concentration header.",
                    (b'A' + index as u8) as char,
                    (b'A' + index as u8) as char
                ),
            ));
        }
    }
    Ok(())
}

fn validate_response_values(
    assay: &checkerboard_core::AssayInput,
    response_type: ResponseType,
) -> Result<(), AppError> {
    if assay.rows.iter().any(|row| !row.od.is_finite()) {
        return Err(AppError::new(
            "responseOutOfRange",
            "Response values must be finite.",
        ));
    }
    if matches!(
        response_type,
        ResponseType::ViabilityFraction | ResponseType::InhibitionFraction
    ) && !is_fractional_response_scale(&assay.rows.iter().map(|row| row.od).collect::<Vec<_>>())
    {
        return Err(AppError::new(
            "responseOutOfRange",
            "Fractional response data may contain assay noise outside the absolute 0–1 range, but at least 95% of values must remain within that range.",
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn export_results(request: ExportResultsRequest) -> Result<(), AppError> {
    crate::services::workbook::export_results(
        &request.path,
        &request.analysis,
        request.stratify_index,
    )
}

#[tauri::command]
pub fn quit_application(app: tauri::AppHandle) {
    app.exit(0);
}

fn default_role(header: &str, _index: usize) -> String {
    let normalized = normalize_header(header);
    if matches!(normalized.as_str(), "organism" | "organismname") {
        "organism".into()
    } else if matches!(normalized.as_str(), "druga" | "drug1" | "drugname1") {
        "drugNameA".into()
    } else if matches!(normalized.as_str(), "drugb" | "drug2" | "drugname2") {
        "drugNameB".into()
    } else if matches!(normalized.as_str(), "drugc" | "drug3" | "drugname3") {
        "drugNameC".into()
    } else if matches!(
        normalized.as_str(),
        "unita" | "unitsa" | "unitdrug1" | "unitsdrug1" | "drug1unit" | "drug1units"
    ) {
        "unitsA".into()
    } else if matches!(
        normalized.as_str(),
        "unitb" | "unitsb" | "unitdrug2" | "unitsdrug2" | "drug2unit" | "drug2units"
    ) {
        "unitsB".into()
    } else if matches!(
        normalized.as_str(),
        "unitc" | "unitsc" | "unitdrug3" | "unitsdrug3" | "drug3unit" | "drug3units"
    ) {
        "unitsC".into()
    } else if normalized == "conca"
        || normalized == "conc1"
        || normalized == "concdrug1"
        || normalized == "drug1conc"
        || normalized.contains("drugaconcentration")
    {
        "drugA".into()
    } else if normalized.contains("concb")
        || normalized == "conc2"
        || normalized == "concdrug2"
        || normalized == "drug2conc"
        || normalized.contains("drugbconcentration")
    {
        "drugB".into()
    } else if normalized.contains("concc")
        || normalized == "conc3"
        || normalized == "concdrug3"
        || normalized == "drug3conc"
        || normalized.contains("drugcconcentration")
    {
        "drugC".into()
    } else if matches!(
        normalized.as_str(),
        "response"
            | "od"
            | "od600"
            | "relativeod"
            | "relativeod600"
            | "absorbance"
            | "viability"
            | "inhibition"
            | "effect"
    ) {
        "response".into()
    } else {
        "ignore".into()
    }
}

fn normalize_header(header: &str) -> String {
    header
        .to_lowercase()
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect()
}

fn suggest_roles(headers: &[String]) -> Vec<String> {
    let mut roles = headers
        .iter()
        .enumerate()
        .map(|(index, header)| default_role(header, index))
        .collect::<Vec<_>>();
    let mut used_drugs =
        ["drugA", "drugB", "drugC"].map(|role| roles.iter().any(|assigned| assigned == role));

    for (index, header) in headers.iter().enumerate() {
        let normalized = header.to_lowercase();
        if roles[index] == "ignore"
            && (normalized.contains("concentration")
                || normalized.contains("conc")
                || parse_concentration_header(header).is_some())
        {
            if let Some(drug_index) = used_drugs.iter().position(|used| !used) {
                roles[index] = format!("drug{}", (b'A' + drug_index as u8) as char);
                used_drugs[drug_index] = true;
            }
        }
    }

    roles
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedConcentrationHeader {
    drug_name: String,
    unit: String,
}

fn parse_concentration_header(header: &str) -> Option<ParsedConcentrationHeader> {
    let trimmed = header.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Some(without_close) = trimmed.strip_suffix(')')
        && let Some(open_index) = without_close.rfind('(')
    {
        let drug_name = clean_concentration_drug_name(&without_close[..open_index]);
        let unit = without_close[open_index + 1..].trim();
        if !drug_name.is_empty() && is_concentration_unit(unit) {
            return Some(ParsedConcentrationHeader {
                drug_name,
                unit: unit.to_string(),
            });
        }
    }

    for (split_index, character) in trimmed.char_indices() {
        if !character.is_whitespace() {
            continue;
        }
        let drug_name = clean_concentration_drug_name(&trimmed[..split_index]);
        let unit = trimmed[split_index..].trim();
        if !drug_name.is_empty() && is_concentration_unit(unit) {
            return Some(ParsedConcentrationHeader {
                drug_name,
                unit: unit.to_string(),
            });
        }
    }
    None
}

fn clean_concentration_drug_name(value: &str) -> String {
    let mut cleaned = value.trim().trim_end_matches(['-', '_', ':']).trim();
    let lowercase = cleaned.to_lowercase();
    for suffix in ["concentration", "conc"] {
        if lowercase.ends_with(suffix) {
            let prefix_length = cleaned.len() - suffix.len();
            if prefix_length == 0
                || cleaned[..prefix_length]
                    .chars()
                    .last()
                    .is_some_and(|character| {
                        character.is_whitespace() || matches!(character, '-' | '_' | ':')
                    })
            {
                cleaned = cleaned[..prefix_length]
                    .trim()
                    .trim_end_matches(['-', '_', ':'])
                    .trim();
                break;
            }
        }
    }
    cleaned.to_string()
}

fn is_concentration_unit(unit: &str) -> bool {
    let normalized = unit
        .chars()
        .filter(|character| !character.is_whitespace())
        .flat_map(char::to_lowercase)
        .map(|character| match character {
            'µ' | 'μ' => 'u',
            other => other,
        })
        .collect::<String>();
    let standalone = [
        "g", "mg", "mcg", "ug", "ng", "ml", "l", "ul", "m", "mm", "um", "nm",
    ];
    if standalone.contains(&normalized.as_str()) {
        return true;
    }
    let Some((numerator, denominator)) = normalized.split_once('/') else {
        return false;
    };
    !denominator.contains('/')
        && ["g", "mg", "mcg", "ug", "ng"].contains(&numerator)
        && ["ml", "l", "ul"].contains(&denominator)
}

fn infer_drug_name(header: &str, fallback: &str) -> String {
    if let Some(parsed) = parse_concentration_header(header) {
        return parsed.drug_name;
    }
    let mut cleaned = header.to_string();
    for pattern in [
        "Concentration",
        "concentration",
        "CONCENTRATION",
        "Conc",
        "conc",
        "CONC",
    ] {
        cleaned = cleaned.replace(pattern, "");
    }
    let cleaned: String = cleaned
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '_')
        .collect();
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn legacy_policy() -> AnalysisPolicy {
        AnalysisPolicy {
            mode: checkerboard_core::AnalysisMode::LegacyOd,
            response_type: checkerboard_core::ResponseType::RawOd,
            cell_additive_threshold: 0.05,
            ..AnalysisPolicy::default()
        }
    }

    #[test]
    fn common_headers_get_expected_roles() {
        assert_eq!(default_role("Drug A", 0), "drugNameA");
        assert_eq!(default_role("Unit A", 0), "unitsA");
        assert_eq!(default_role("DrugA.Concentration", 0), "drugA");
        assert_eq!(default_role("Relative OD", 3), "response");
        assert_eq!(default_role("Notes", 6), "ignore");
        assert_eq!(default_role("Conc1", 3), "drugA");
        assert_eq!(default_role("Conc2", 4), "drugB");
        assert_eq!(default_role("Drug1", 0), "drugNameA");
        assert_eq!(default_role("ConcDrug1", 2), "drugA");
        assert_eq!(default_role("UnitDrug2", 5), "unitsB");
        assert_eq!(default_role("LatentEffect", 7), "ignore");
    }

    #[test]
    fn sample_headers_ignore_strain_and_map_concentrations() {
        let headers = vec![
            "Strain Name".into(),
            "DETA Concentration".into(),
            "CFZ Concentration".into(),
            "Relative OD600".into(),
        ];
        assert_eq!(
            suggest_roles(&headers),
            vec!["ignore", "drugA", "drugB", "response"]
        );
    }

    #[test]
    fn organism_column_partitions_identical_regimens_and_filters_rows() {
        let table = importer::ImportedTable {
            headers: vec![
                "Organism".into(),
                "Drug A".into(),
                "Drug B".into(),
                "Conc A".into(),
                "Conc B".into(),
                "Response".into(),
            ],
            rows: vec![
                vec!["Org 1".into(), "A".into(), "B".into(), "0".into(), "0".into(), "1".into()],
                vec!["Org 1".into(), "A".into(), "B".into(), "1".into(), "1".into(), "0.5".into()],
                vec!["Org 2".into(), "A".into(), "B".into(), "0".into(), "0".into(), "1".into()],
                vec!["Org 2".into(), "A".into(), "B".into(), "1".into(), "1".into(), "0.25".into()],
            ],
        };

        assert_eq!(
            suggest_roles(&table.headers),
            ["organism", "drugNameA", "drugNameB", "drugA", "drugB", "response"]
        );
        let regimens = describe_regimens(&table, &[3, 4], Some(5), Some(0));
        assert_eq!(regimens.len(), 2);
        assert_eq!(regimens[0].regimen_key, regimens[1].regimen_key);
        assert_eq!(regimens[0].organism.as_deref(), Some("Org 1"));
        assert_eq!(regimens[1].organism.as_deref(), Some("Org 2"));

        let selected = select_regimen_rows(
            &table,
            &["A".into(), "B".into()],
            Some("Org 2"),
            Some(0),
        )
        .unwrap();
        assert_eq!(selected.len(), 2);
        assert!(selected.iter().all(|row| row[0] == "Org 2"));
    }

    #[test]
    fn concentration_headers_supply_drug_names_units_and_roles() {
        let table = importer::ImportedTable {
            headers: vec![
                "Amikacin (mg/L)".into(),
                "Clofazimine µM".into(),
                "Response".into(),
                "Plate note".into(),
            ],
            rows: vec![vec!["1".into(), "2".into(), "0.5".into(), "keep".into()]],
        };
        let roles = suggest_roles(&table.headers);
        assert_eq!(roles, ["drugA", "drugB", "response", "ignore"]);
        let regimens = describe_regimens(&table, &[0, 1], Some(2), None);
        assert_eq!(regimens.len(), 1);
        assert_eq!(regimens[0].drug_names, ["Amikacin", "Clofazimine"]);
        assert_eq!(regimens[0].concentration_units, ["mg/L", "µM"]);
        assert_eq!(
            parse_concentration_header("Amikacin concentration mg / L"),
            Some(ParsedConcentrationHeader {
                drug_name: "Amikacin".into(),
                unit: "mg / L".into(),
            })
        );
        assert_eq!(
            parse_concentration_header("Amikacin concentration (mg/L)"),
            Some(ParsedConcentrationHeader {
                drug_name: "Amikacin".into(),
                unit: "mg/L".into(),
            })
        );
    }

    #[test]
    fn embedded_concentration_units_satisfy_regimen_validation() {
        let headers = vec![
            "File Name".into(),
            "Species".into(),
            "Full Strain".into(),
            "Cefidericol Conc (mg/L)".into(),
            "Amikacin Conc (mg/L)".into(),
            "Relative OD".into(),
        ];
        let rows = vec![vec![
            "096".into(),
            "E. cloacea complex".into(),
            "E. cloacea complex 16537-1a".into(),
            "64".into(),
            "0".into(),
            "0.0154".into(),
        ]];
        let mapping = ColumnMapping {
            drugs: vec![
                checkerboard_core::MappedDrug {
                    column: 3,
                    name: "Cefidericol".into(),
                },
                checkerboard_core::MappedDrug {
                    column: 4,
                    name: "Amikacin".into(),
                },
            ],
            response_column: 5,
        };

        validate_regimen_units(&headers, &rows, &mapping, &["mg/L".into(), "mg/L".into()])
            .expect("units embedded in mapped concentration headers should be accepted");
    }

    #[test]
    fn embedded_concentration_unit_mismatch_is_reported() {
        let headers = vec![
            "Cefidericol Conc (mg/L)".into(),
            "Amikacin Conc (mg/L)".into(),
            "Relative OD".into(),
        ];
        let rows = vec![vec!["1".into(), "1".into(), "0.5".into()]];
        let mapping = ColumnMapping {
            drugs: vec![
                checkerboard_core::MappedDrug {
                    column: 0,
                    name: "Cefidericol".into(),
                },
                checkerboard_core::MappedDrug {
                    column: 1,
                    name: "Amikacin".into(),
                },
            ],
            response_column: 2,
        };

        let error =
            validate_regimen_units(&headers, &rows, &mapping, &["mg/L".into(), "µM".into()])
                .expect_err("a conflicting embedded concentration unit should be rejected");
        assert_eq!(error.code, "inconsistentUnits");
    }

    #[test]
    fn documented_concentration_unit_combinations_are_recognized_case_insensitively() {
        for numerator in ["g", "mg", "mcg", "µg", "ng"] {
            for denominator in ["mL", "L", "µL"] {
                assert!(is_concentration_unit(&format!("{numerator}/{denominator}")));
            }
        }
        for unit in [
            "g", "mg", "mcg", "µg", "ng", "mL", "L", "µL", "M", "mM", "µM", "nM", "MG/ML",
            "MCG/UL", "μg/μL",
        ] {
            assert!(
                is_concentration_unit(unit),
                "unit {unit} was not recognized"
            );
        }
        for unit in ["kg/L", "mg/dL", "percent", "hours"] {
            assert!(!is_concentration_unit(unit), "unit {unit} was accepted");
        }
    }

    #[test]
    fn uncertain_headers_remain_ignored_and_still_receive_a_preview() {
        let table = importer::ImportedTable {
            headers: vec!["Sample".into(), "Measurement X".into(), "Comment".into()],
            rows: vec![vec!["one".into(), "0.5".into(), "review".into()]],
        };
        let roles = suggest_roles(&table.headers);
        assert_eq!(roles, ["ignore", "ignore", "ignore"]);
        let regimens = describe_regimens(&table, &[], None, None);
        assert_eq!(regimens.len(), 1);
        assert_eq!(regimens[0].drug_names, ["Drug 1", "Drug 2"]);
        assert_eq!(regimens[0].rows, table.rows);
    }

    #[test]
    fn censored_drusano_simulations_open_and_map_through_command_boundary() {
        let fixtures = [
            ("drusano_greco_alpha_negative.csv", 5),
            ("drusano_greco_alpha_zero.csv", 12),
            ("drusano_greco_alpha_positive.csv", 16),
        ];
        for (filename, censored_count) in fixtures {
            let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../..")
                .join("tests")
                .join(filename)
                .canonicalize()
                .unwrap();
            let import = ImportRequest {
                path: fixture.to_string_lossy().into_owned(),
                worksheet: None,
                start_row: 1,
                start_column: 1,
                row_limit: 0,
                column_limit: 0,
                organism_column: None,
            };
            let preview = import_preview(import.clone()).expect("fixture should open");
            assert_eq!(
                &preview.suggested_roles[..7],
                [
                    "drugNameA",
                    "drugNameB",
                    "drugA",
                    "drugB",
                    "unitsA",
                    "unitsB",
                    "response",
                ]
            );
            assert!(
                preview.suggested_roles[7..]
                    .iter()
                    .all(|role| role == "ignore")
            );
            assert_eq!(preview.regimens.len(), 1);
            assert_eq!(preview.regimens[0].drug_names, ["Drug 1", "Drug 2"]);
            assert_eq!(preview.regimens[0].concentration_units, ["mg/L", "mg/L"]);

            let data = prepare_drusano_data_inner(PrepareDrusanoDataRequest {
                import,
                mapping: ColumnMapping {
                    drugs: vec![
                        checkerboard_core::MappedDrug {
                            column: 2,
                            name: "Drug 1".into(),
                        },
                        checkerboard_core::MappedDrug {
                            column: 3,
                            name: "Drug 2".into(),
                        },
                    ],
                    response_column: 6,
                },
                settings: DrusanoDataSettings {
                    blank_value: 0.0,
                    response_censor_limit: Some(0.1),
                },
                assay_error: DrusanoAssayErrorSettings::default(),
                regimen_drug_names: preview.regimens[0].drug_names.clone(),
                organism: None,
                organism_column: None,
                max_cycles: default_drusano_max_cycles(),
                continuation: None,
                bootstrap_iterations: 1,
                bootstrap_seed: 123,
            })
            .expect("mapped fixture should prepare for fitting");
            assert_eq!(data.censored_count, censored_count);
            assert_eq!(data.max_concentrations, [8.0, 8.0]);
        }
    }

    #[test]
    fn bliss_calibrated_drusano_simulations_open_with_encoded_headers() {
        for filename in [
            "drusano_greco_bliss_minus12.csv",
            "drusano_greco_bliss_plus0_5.csv",
            "drusano_greco_bliss_plus10.csv",
        ] {
            let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../..")
                .join("tests")
                .join(filename)
                .canonicalize()
                .unwrap();
            let preview = import_preview(ImportRequest {
                path: fixture.to_string_lossy().into_owned(),
                worksheet: None,
                start_row: 1,
                start_column: 1,
                row_limit: 0,
                column_limit: 0,
                organism_column: None,
            })
            .expect("Bliss-calibrated fixture should open");
            assert_eq!(
                &preview.suggested_roles[..3],
                ["drugA", "drugB", "response"]
            );
            assert!(
                preview.suggested_roles[3..]
                    .iter()
                    .all(|role| role == "ignore")
            );
            assert_eq!(preview.regimens.len(), 1);
            assert_eq!(preview.regimens[0].drug_names, ["Drug 1", "Drug 2"]);
            assert_eq!(preview.regimens[0].concentration_units, ["mg/L", "mg/L"]);
            assert_eq!(preview.regimens[0].total_rows, 64);
        }
    }

    #[test]
    fn concentration_suffix_is_removed_from_drug_names() {
        assert_eq!(
            infer_drug_name("Ciprofloxacin Concentration", "DrugA"),
            "Ciprofloxacin"
        );
        assert_eq!(infer_drug_name("Concentration", "DrugA"), "DrugA");
    }

    #[test]
    fn csv_fixture_imports_and_analyzes_through_the_command_boundary() {
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("fixtures/valid/two_drug.csv")
            .canonicalize()
            .unwrap();
        let import = ImportRequest {
            path: fixture.to_string_lossy().into_owned(),
            worksheet: None,
            start_row: 1,
            start_column: 1,
            row_limit: 0,
            column_limit: 0,
            organism_column: None,
        };
        let result = analyze_table_inner(
            AnalyzeTableRequest {
                import,
                mapping: ColumnMapping {
                    drugs: vec![
                        checkerboard_core::MappedDrug {
                            column: 0,
                            name: "DrugA".into(),
                        },
                        checkerboard_core::MappedDrug {
                            column: 1,
                            name: "DrugB".into(),
                        },
                    ],
                    response_column: 2,
                },
                policy: Some(legacy_policy()),
                mic_values: vec![1.0, 1.0],
                mic_zero_tolerance: 5.0,
                regimen_drug_names: Vec::new(),
                organism: None,
                organism_column: None,
                concentration_units: vec![String::new(), String::new()],
                clinically_relevant_concentrations: Vec::new(),
                concentration_ranges: Vec::new(),
            },
            None,
        )
        .unwrap();
        assert!((result.summary.sum_bliss - 0.5072727272727272).abs() < 1e-12);
    }

    #[test]
    fn reported_xlsx_censors_negative_od_instead_of_rejecting_it() {
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("fixtures/reported/sample.xlsx")
            .canonicalize()
            .unwrap();
        let import = ImportRequest {
            path: fixture.to_string_lossy().into_owned(),
            worksheet: Some("Sheet1".into()),
            start_row: 1,
            start_column: 1,
            row_limit: 0,
            column_limit: 0,
            organism_column: None,
        };
        let result = analyze_table_inner(
            AnalyzeTableRequest {
                import,
                mapping: ColumnMapping {
                    drugs: vec![
                        checkerboard_core::MappedDrug {
                            column: 1,
                            name: "DETA".into(),
                        },
                        checkerboard_core::MappedDrug {
                            column: 2,
                            name: "CFZ".into(),
                        },
                    ],
                    response_column: 3,
                },
                policy: Some(legacy_policy()),
                mic_values: vec![1.0, 1.0],
                mic_zero_tolerance: 5.0,
                regimen_drug_names: Vec::new(),
                organism: None,
                organism_column: None,
                concentration_units: vec![String::new(), String::new()],
                clinically_relevant_concentrations: Vec::new(),
                concentration_ranges: Vec::new(),
            },
            None,
        )
        .unwrap();

        assert_eq!(result.processed.len(), 88);
        assert_eq!(
            result
                .processed
                .iter()
                .map(|row| row.censored_replicate_count)
                .sum::<usize>(),
            148
        );
        assert!(result.processed.iter().any(|row| {
            row.mean_original_od < 0.0
                && row.mean_censored_od == 0.0
                && row.censored_replicate_count > 0
        }));
    }

    #[test]
    fn mic_inference_uses_single_agent_wells_and_fractional_viability() {
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("fixtures/valid/two_drug.csv")
            .canonicalize()
            .unwrap();
        let estimates = infer_mics(InferMicsRequest {
            import: ImportRequest {
                path: fixture.to_string_lossy().into_owned(),
                worksheet: None,
                start_row: 1,
                start_column: 1,
                row_limit: 0,
                column_limit: 0,
                organism_column: None,
            },
            mapping: ColumnMapping {
                drugs: vec![
                    checkerboard_core::MappedDrug {
                        column: 0,
                        name: "A".into(),
                    },
                    checkerboard_core::MappedDrug {
                        column: 1,
                        name: "B".into(),
                    },
                ],
                response_column: 2,
            },
            response_type: ResponseType::ViabilityFraction,
            blank_value: 0.0,
            zero_tolerance: 70.0,
            regimen_drug_names: Vec::new(),
            organism: None,
            organism_column: None,
        })
        .unwrap();
        assert_eq!(
            estimates.iter().map(|value| value.mic).collect::<Vec<_>>(),
            vec![Some(2.0), Some(2.0)]
        );
        assert_eq!(
            estimates
                .iter()
                .map(|value| value.single_agent_levels)
                .collect::<Vec<_>>(),
            vec![2, 2]
        );
    }

    #[test]
    fn multiple_regimens_are_described_separately_and_exact_concentration_ranges_filter_doses() {
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("fixtures/valid/multiple_regimens.csv")
            .canonicalize()
            .unwrap();
        let import = ImportRequest {
            path: fixture.to_string_lossy().into_owned(),
            worksheet: None,
            start_row: 1,
            start_column: 1,
            row_limit: 0,
            column_limit: 0,
            organism_column: None,
        };
        let preview = import_preview(import.clone()).unwrap();
        assert_eq!(
            preview.suggested_roles,
            vec![
                "drugNameA",
                "drugNameB",
                "drugA",
                "drugB",
                "unitsA",
                "unitsB",
                "response"
            ]
        );
        assert_eq!(preview.regimens.len(), 2);
        assert_eq!(preview.regimens[0].id, "1");
        assert_eq!(
            preview.regimens[0].drug_names,
            vec!["Ampicillin", "Meropenem"]
        );
        assert_eq!(
            preview.regimens[0].concentration_units,
            vec!["mg/L", "mg/L"]
        );
        assert_eq!(
            preview.regimens[0].suggested_response_type,
            ResponseType::Inhibition
        );
        assert_eq!(preview.regimens[1].label, "2 — Ciprofloxacin + Rifampin");
        assert_eq!(
            preview.regimens[1].suggested_response_type,
            ResponseType::ViabilityFraction
        );

        let result = analyze_table_inner(
            AnalyzeTableRequest {
                import,
                mapping: ColumnMapping {
                    drugs: vec![
                        checkerboard_core::MappedDrug {
                            column: 2,
                            name: "Ampicillin".into(),
                        },
                        checkerboard_core::MappedDrug {
                            column: 3,
                            name: "Meropenem".into(),
                        },
                    ],
                    response_column: 6,
                },
                policy: Some(AnalysisPolicy {
                    response_type: ResponseType::Inhibition,
                    ..AnalysisPolicy::default()
                }),
                mic_values: vec![1.0, 1.0],
                mic_zero_tolerance: 5.0,
                regimen_drug_names: vec!["Ampicillin".into(), "Meropenem".into()],
                organism: None,
                organism_column: None,
                concentration_units: vec!["mg/L".into(), "mg/L".into()],
                clinically_relevant_concentrations: Vec::new(),
                concentration_ranges: vec![
                    ConcentrationRange { minimum: Some(0.75), maximum: Some(1.25) },
                    ConcentrationRange { minimum: Some(0.75), maximum: Some(1.25) },
                ],
            },
            None,
        )
        .unwrap();
        assert_eq!(result.summary.combination_count, 1);
        assert_eq!(result.processed.len(), 7);
        assert_eq!(
            result.concentration_ranges,
            vec![
                ConcentrationRange { minimum: Some(0.75), maximum: Some(1.25) },
                ConcentrationRange { minimum: Some(0.75), maximum: Some(1.25) },
            ]
        );
        assert_eq!(result.concentration_units, vec!["mg/L", "mg/L"]);
    }

    #[test]
    fn response_type_inference_distinguishes_scale_and_direction() {
        fn inferred(control: &str, treated: &str) -> ResponseType {
            let rows = [
                vec!["0".into(), "0".into(), control.into()],
                vec!["1".into(), "1".into(), treated.into()],
            ];
            infer_response_type(&rows.iter().collect::<Vec<_>>(), &[0, 1], Some(2))
        }
        assert_eq!(inferred("100", "25"), ResponseType::Viability);
        assert_eq!(inferred("1", "-0.25"), ResponseType::ViabilityFraction);
        assert_eq!(inferred("0", "75"), ResponseType::Inhibition);
        assert_eq!(inferred("-0.02", "0.75"), ResponseType::InhibitionFraction);

        let mut noisy_fractional_rows = vec![vec!["0".into(), "0".into(), "1".into()]];
        noisy_fractional_rows
            .extend((0..4).map(|_| vec!["1".into(), "1".into(), "1.4".into()]));
        noisy_fractional_rows
            .extend((0..36).map(|_| vec!["1".into(), "1".into(), "0.25".into()]));
        assert_eq!(
            infer_response_type(
                &noisy_fractional_rows.iter().collect::<Vec<_>>(),
                &[0, 1],
                Some(2),
            ),
            ResponseType::ViabilityFraction
        );
    }

    #[test]
    fn test2_combined_fractional_viability_runs_every_diamond_regimen() {
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("tests/test2_combined.csv")
            .canonicalize()
            .unwrap();
        let import = ImportRequest {
            path: fixture.to_string_lossy().into_owned(),
            worksheet: None,
            start_row: 1,
            start_column: 1,
            row_limit: 0,
            column_limit: 0,
            organism_column: None,
        };
        let table = importer::read_table(&import).unwrap();
        let preview = import_preview(import).unwrap();
        assert_eq!(preview.regimens.len(), 7);

        for regimen in preview.regimens {
            let rows = select_regimen_rows(&table, &regimen.drug_names, None, None).unwrap();
            let assay = assay_from_rows(
                &rows,
                &ColumnMapping {
                    drugs: vec![
                        checkerboard_core::MappedDrug {
                            column: 3,
                            name: regimen.drug_names[0].clone(),
                        },
                        checkerboard_core::MappedDrug {
                            column: 2,
                            name: regimen.drug_names[1].clone(),
                        },
                    ],
                    response_column: 6,
                },
            )
            .unwrap();
            let anchors = (0..2)
                .map(|index| {
                    assay
                        .rows
                        .iter()
                        .map(|row| row.concentrations[index])
                        .fold(0.0_f64, f64::max)
                })
                .collect::<Vec<_>>();
            let result = checkerboard_core::diamond::analyze(
                &assay,
                &anchors,
                DiamondPolicy {
                    response_type: ResponseType::ViabilityFraction,
                    bootstrap_iterations: 2,
                    ..DiamondPolicy::default()
                },
                |_, _| {},
            )
            .unwrap_or_else(|error| panic!("{}: {error}", regimen.regimen_label));
            assert!(
                !result.total_scores.is_empty(),
                "{} did not produce a total FIC",
                regimen.regimen_label
            );
        }
    }

    #[test]
    fn uploaded_three_drug_file_maps_all_columns_and_discovers_seven_regimens() {
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("tests/test3_combined.csv")
            .canonicalize()
            .unwrap();
        let import = ImportRequest {
            path: fixture.to_string_lossy().into_owned(),
            worksheet: None,
            start_row: 1,
            start_column: 1,
            row_limit: 0,
            column_limit: 0,
            organism_column: None,
        };
        let preview = import_preview(import.clone()).unwrap();
        assert_eq!(preview.total_rows, 11_088);
        assert_eq!(preview.regimens.len(), 7);
        assert_eq!(
            preview.suggested_roles,
            vec![
                "drugNameA",
                "drugNameB",
                "drugNameC",
                "drugA",
                "drugB",
                "drugC",
                "unitsA",
                "unitsB",
                "unitsC",
                "response",
            ]
        );
        assert!(
            preview
                .regimens
                .iter()
                .all(|regimen| regimen.drug_names.len() == 3)
        );
        assert!(
            preview.regimens.iter().all(|regimen| {
                regimen.suggested_response_type == ResponseType::ViabilityFraction
            })
        );

        let first = &preview.regimens[0];
        let result = analyze_table_inner(
            AnalyzeTableRequest {
                import,
                mapping: ColumnMapping {
                    drugs: vec![
                        checkerboard_core::MappedDrug {
                            column: 3,
                            name: first.drug_names[0].clone(),
                        },
                        checkerboard_core::MappedDrug {
                            column: 4,
                            name: first.drug_names[1].clone(),
                        },
                        checkerboard_core::MappedDrug {
                            column: 5,
                            name: first.drug_names[2].clone(),
                        },
                    ],
                    response_column: 9,
                },
                policy: Some(AnalysisPolicy {
                    response_type: ResponseType::ViabilityFraction,
                    baseline_correction: checkerboard_core::BaselineCorrection::All,
                    bootstrap_iterations: 2,
                    ..AnalysisPolicy::default()
                }),
                mic_values: vec![1.0, 1.0, 1.0],
                mic_zero_tolerance: 5.0,
                regimen_drug_names: first.drug_names.clone(),
                organism: None,
                organism_column: None,
                concentration_units: first.concentration_units.clone(),
                clinically_relevant_concentrations: Vec::new(),
                concentration_ranges: vec![
                    ConcentrationRange::default(),
                    ConcentrationRange::default(),
                    ConcentrationRange { minimum: Some(1.0), maximum: Some(16.0) },
                ],
            },
            None,
        )
        .unwrap();
        assert_eq!(result.policy.response_type, ResponseType::ViabilityFraction);
        assert!(!result.processed.is_empty());
        assert!(
            result
                .processed
                .iter()
                .any(|row| row.concentrations[2] > 16.0)
        );
        let restricted_scores = result
            .processed
            .iter()
            .filter(|row| {
                row.concentrations.iter().all(|value| *value > 0.0)
                    && (1.0..=16.0).contains(&row.concentrations[2])
            })
            .map(|row| row.bliss_interaction)
            .collect::<Vec<_>>();
        let restricted_mean =
            restricted_scores.iter().sum::<f64>() / restricted_scores.len() as f64;
        assert!((restricted_mean - result.summary.mean_bliss).abs() < 1e-9);
    }

    #[test]
    fn test3_combined_produces_pairwise_and_emergent_diamond_scores() {
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("tests/test3_combined.csv")
            .canonicalize()
            .unwrap();
        let import = ImportRequest {
            path: fixture.to_string_lossy().into_owned(),
            worksheet: None,
            start_row: 1,
            start_column: 1,
            row_limit: 0,
            column_limit: 0,
            organism_column: None,
        };
        let table = importer::read_table(&import).unwrap();
        let preview = import_preview(import).unwrap();
        let regimen = &preview.regimens[0];
        let rows = select_regimen_rows(&table, &regimen.drug_names, None, None).unwrap();
        let assay = assay_from_rows(
            &rows,
            &ColumnMapping {
                drugs: (0..3)
                    .map(|index| checkerboard_core::MappedDrug {
                        column: 3 + index,
                        name: regimen.drug_names[index].clone(),
                    })
                    .collect(),
                response_column: 9,
            },
        )
        .unwrap();
        let anchors = (0..3)
            .map(|index| {
                assay
                    .rows
                    .iter()
                    .map(|row| row.concentrations[index])
                    .fold(0.0_f64, f64::max)
            })
            .collect::<Vec<_>>();
        let result = checkerboard_core::diamond::analyze(
            &assay,
            &anchors,
            DiamondPolicy {
                response_type: ResponseType::ViabilityFraction,
                bootstrap_iterations: 2,
                ..DiamondPolicy::default()
            },
            |_, _| {},
        )
        .unwrap();

        assert_eq!(result.pairwise_summaries.len(), 3);
        assert!(
            result
                .emergent_scores
                .iter()
                .any(|score| score.inhibition_level == 50.0)
        );
        assert!(!result.assay_locations.is_empty());
    }
}
