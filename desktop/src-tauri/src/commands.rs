use checkerboard_core::{
    AnalysisPolicy, AnalysisResult, ColumnMapping, ResponseType, analyze_with_progress,
    assay_from_rows,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::{
    error::AppError,
    services::importer::{self, ImportRequest},
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
    pub concentration_units: Vec<String>,
    #[serde(default)]
    pub clinically_relevant_concentrations: Vec<Option<f64>>,
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
    pub zero_tolerance: f64,
    #[serde(default)]
    pub regimen_drug_names: Vec<String>,
}

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

#[tauri::command]
pub fn list_worksheets(path: String) -> Result<Vec<String>, AppError> {
    importer::list_worksheets(&path)
}

#[tauri::command]
pub fn import_preview(request: ImportRequest) -> Result<ImportPreview, AppError> {
    let table = importer::read_table(&request)?;
    validate_input_headers(&table.headers)?;
    let total_rows = table.rows.len();
    let total_columns = table.headers.len();
    let suggested_roles = suggest_roles(&table.headers);
    let mut suggested_drug_names: Vec<String> = table
        .headers
        .iter()
        .enumerate()
        .map(|(index, header)| {
            infer_drug_name(header, &format!("Drug{}", (b'A' + index as u8) as char))
        })
        .collect();
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
    let regimens = describe_regimens(&table, &drug_columns, response_column);
    if regimens.is_empty() {
        return Err(AppError::new(
            "noRegimens",
            "No rows contain nonblank Drug A and Drug B names.",
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
    let rows = select_regimen_rows(&table, &request.regimen_drug_names)?;
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
                        let control = control_mean.filter(|value| value.is_finite() && *value > 0.0)
                            .ok_or_else(|| AppError::new("invalidControl", "Raw-OD MIC inference requires a positive untreated-control mean."))?;
                        100.0 * row.od / control
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
pub async fn analyze_table(
    request: AnalyzeTableRequest,
    on_progress: Channel<AnalysisProgress>,
) -> Result<AnalysisResult, AppError> {
    tauri::async_runtime::spawn_blocking(move || analyze_table_inner(request, Some(on_progress)))
        .await
        .map_err(|error| AppError::new("analysisWorkerError", error.to_string()))?
}

fn analyze_table_inner(
    request: AnalyzeTableRequest,
    on_progress: Option<Channel<AnalysisProgress>>,
) -> Result<AnalysisResult, AppError> {
    let table = importer::read_table(&request.import)?;
    let rows = select_regimen_rows(&table, &request.regimen_drug_names)?;
    validate_regimen_units(&table.headers, &rows, &request.concentration_units)?;
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
    let clinically_relevant = if request.clinically_relevant_concentrations.is_empty() {
        vec![None; assay.drug_names.len()]
    } else {
        request.clinically_relevant_concentrations
    };
    if clinically_relevant.len() != assay.drug_names.len()
        || clinically_relevant
            .iter()
            .flatten()
            .any(|value| !value.is_finite() || *value <= 0.0)
    {
        return Err(AppError::new(
            "invalidClinicallyRelevantConcentrations",
            "Clinically relevant concentrations must be blank or finite and positive, with one field per drug.",
        ));
    }
    let full_assay = assay.clone();
    let has_clinical_window = clinically_relevant.iter().any(Option::is_some);
    if has_clinical_window {
        assay.rows.retain(|row| {
            row.concentrations
                .iter()
                .zip(&clinically_relevant)
                .all(|(dose, target)| {
                    *dose <= 0.0
                        || target.is_none_or(|value| *dose >= value / 4.0 && *dose <= value * 4.0)
                })
        });
        if !assay
            .rows
            .iter()
            .any(|row| row.concentrations.iter().all(|value| *value > 0.0))
        {
            return Err(AppError::new(
                "noClinicallyRelevantCombinations",
                "No combination wells fall within two two-fold dilutions below or above the clinically relevant concentrations.",
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
            code: "clinicallyRelevantWindow".into(),
            message: "Overall statistics are restricted to wells within two two-fold dilutions below or above each specified clinically relevant concentration; the full observed surface remains available for context.".into(),
        });
    }
    result.mic_values = request.mic_values;
    result.mic_zero_tolerance = request.mic_zero_tolerance;
    result.clinically_relevant_concentrations = clinically_relevant;
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
) -> Result<Vec<Vec<String>>, AppError> {
    if regimen_drug_names.is_empty() {
        return Ok(table.rows.clone());
    }
    let name_columns = regimen_name_columns(&table.headers)?;
    let selected = table
        .rows
        .iter()
        .filter(|row| {
            row_drug_names(row, &name_columns).is_some_and(|names| names == regimen_drug_names)
        })
        .cloned()
        .collect::<Vec<_>>();
    if selected.is_empty() {
        Err(AppError::new(
            "missingRegimen",
            format!(
                "No rows were found for regimen {}.",
                regimen_drug_names.join(" + ")
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
) -> Vec<RegimenPreview> {
    let Ok(name_columns) = regimen_name_columns(&table.headers) else {
        return Vec::new();
    };
    let unit_columns = [0, 1, 2].map(|index| find_units_column(&table.headers, index));
    let mut combinations = Vec::<Vec<String>>::new();
    for row in &table.rows {
        if let Some(names) = row_drug_names(row, &name_columns)
            && !combinations.contains(&names)
        {
            combinations.push(names);
        }
    }
    combinations
        .into_iter()
        .enumerate()
        .map(|(index, drug_names)| {
            let rows = table
                .rows
                .iter()
                .filter(|row| {
                    row_drug_names(row, &name_columns).is_some_and(|names| names == drug_names)
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
                        })
                        .unwrap_or("")
                        .to_string()
                })
                .collect::<Vec<_>>();
            let active_drug_columns = &drug_columns[..drug_names.len().min(drug_columns.len())];
            let suggested_response_type =
                infer_response_type(&rows, active_drug_columns, response_column);
            let id = (index + 1).to_string();
            let label = format!("{} — {}", id, drug_names.join(" + "));
            let total_rows = rows.len();
            RegimenPreview {
                id,
                label,
                drug_names,
                concentration_units,
                suggested_response_type,
                rows: rows.into_iter().take(100).cloned().collect(),
                total_rows,
            }
        })
        .collect()
}

fn regimen_name_columns(headers: &[String]) -> Result<Vec<Option<usize>>, AppError> {
    let drug_a = find_named_column(headers, "druga")
        .ok_or_else(|| AppError::new("missingDrugNameColumn", "A Drug A column is required."))?;
    let drug_b = find_named_column(headers, "drugb")
        .ok_or_else(|| AppError::new("missingDrugNameColumn", "A Drug B column is required."))?;
    Ok(vec![
        Some(drug_a),
        Some(drug_b),
        find_named_column(headers, "drugc"),
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

fn find_named_column(headers: &[String], normalized: &str) -> Option<usize> {
    headers
        .iter()
        .position(|header| normalize_header(header) == normalized)
}

fn find_units_column(headers: &[String], index: usize) -> Option<usize> {
    let suffix = (b'a' + index as u8) as char;
    find_named_column(headers, &format!("units{suffix}"))
        .or_else(|| find_named_column(headers, &format!("unit{suffix}")))
}

fn validate_input_headers(headers: &[String]) -> Result<(), AppError> {
    let missing = ["druga", "drugb", "conca", "concb", "response"]
        .into_iter()
        .filter(|name| find_named_column(headers, name).is_none())
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(AppError::new(
            "missingRequiredColumns",
            "The import must contain Drug A, Drug B, Conc A, Conc B, Units A, Units B, and Response columns.",
        ));
    }
    if find_units_column(headers, 0).is_none() || find_units_column(headers, 1).is_none() {
        return Err(AppError::new(
            "missingRequiredColumns",
            "The import must contain Units A and Units B columns (singular Unit A/Unit B are also accepted).",
        ));
    }
    let optional_c = [
        find_named_column(headers, "drugc").is_some(),
        find_named_column(headers, "concc").is_some(),
        find_units_column(headers, 2).is_some(),
    ];
    if optional_c.iter().any(|present| *present) && !optional_c.iter().all(|present| *present) {
        return Err(AppError::new(
            "incompleteDrugCColumns",
            "Drug C, Conc C, and Units C must either all be present or all be omitted.",
        ));
    }
    Ok(())
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
    // Fractional assay data can contain a small number of values outside 0–1
    // after background correction. Use absolute magnitudes, and do not let a
    // few noisy wells force an otherwise fractional regimen onto a percent
    // scale.
    let fractional = is_fractional_response_scale(&values);
    let control_mean = mean_or(&controls, 0.0);
    let treated_mean = mean_or(&treated, control_mean);
    match (control_mean >= treated_mean, fractional) {
        (true, true) => ResponseType::ViabilityFraction,
        (true, false) => ResponseType::Viability,
        (false, true) => ResponseType::InhibitionFraction,
        (false, false) => ResponseType::Inhibition,
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
    expected: &[String],
) -> Result<(), AppError> {
    if expected.is_empty() || expected.iter().all(|unit| unit.trim().is_empty()) {
        return Ok(());
    }
    for (index, expected_unit) in expected.iter().enumerate() {
        let column = find_units_column(headers, index).ok_or_else(|| {
            AppError::new(
                "missingUnits",
                format!("Missing Units {} column.", (b'A' + index as u8) as char),
            )
        })?;
        if expected_unit.trim().is_empty()
            || rows.iter().any(|row| {
                row.get(column)
                    .is_none_or(|value| value.trim() != expected_unit.trim())
            })
        {
            return Err(AppError::new(
                "inconsistentUnits",
                format!(
                    "Regimen concentration units for drug {} must be nonblank and consistent.",
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
    if normalized == "druga" {
        "drugNameA".into()
    } else if normalized == "drugb" {
        "drugNameB".into()
    } else if normalized == "drugc" {
        "drugNameC".into()
    } else if matches!(normalized.as_str(), "unita" | "unitsa") {
        "unitsA".into()
    } else if matches!(normalized.as_str(), "unitb" | "unitsb") {
        "unitsB".into()
    } else if matches!(normalized.as_str(), "unitc" | "unitsc") {
        "unitsC".into()
    } else if normalized == "conca"
        || normalized == "conc1"
        || normalized.contains("drugaconcentration")
    {
        "drugA".into()
    } else if normalized.contains("concb")
        || normalized == "conc2"
        || normalized.contains("drugbconcentration")
    {
        "drugB".into()
    } else if normalized.contains("concc")
        || normalized == "conc3"
        || normalized.contains("drugcconcentration")
    {
        "drugC".into()
    } else if normalized.contains("relative")
        || normalized.contains("od")
        || normalized.contains("response")
        || normalized.contains("effect")
    {
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
            && (normalized.contains("concentration") || normalized.contains("conc"))
        {
            if let Some(drug_index) = used_drugs.iter().position(|used| !used) {
                roles[index] = format!("drug{}", (b'A' + drug_index as u8) as char);
                used_drugs[drug_index] = true;
            }
        }
    }

    if used_drugs.iter().filter(|used| **used).count() < 2 {
        for role in &mut roles {
            if role == "ignore" {
                if let Some(drug_index) = used_drugs.iter().position(|used| !used) {
                    *role = format!("drug{}", (b'A' + drug_index as u8) as char);
                    used_drugs[drug_index] = true;
                }
            }
            if used_drugs.iter().filter(|used| **used).count() >= 2 {
                break;
            }
        }
    }
    roles
}

fn infer_drug_name(header: &str, fallback: &str) -> String {
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
        assert_eq!(default_role("Drug1", 1), "ignore");
        assert_eq!(default_role("Conc1", 3), "drugA");
        assert_eq!(default_role("Conc2", 4), "drugB");
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
                concentration_units: vec![String::new(), String::new()],
                clinically_relevant_concentrations: Vec::new(),
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
                concentration_units: vec![String::new(), String::new()],
                clinically_relevant_concentrations: Vec::new(),
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
            zero_tolerance: 70.0,
            regimen_drug_names: Vec::new(),
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
    fn multiple_regimens_are_described_separately_and_clinical_windows_filter_doses() {
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
                concentration_units: vec!["mg/L".into(), "mg/L".into()],
                clinically_relevant_concentrations: vec![Some(1.0), Some(1.0)],
            },
            None,
        )
        .unwrap();
        assert_eq!(result.summary.combination_count, 1);
        assert_eq!(result.processed.len(), 7);
        assert_eq!(
            result.clinically_relevant_concentrations,
            vec![Some(1.0), Some(1.0)]
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

        let mut noisy_fractional_rows = vec![
            vec!["0".into(), "0".into(), "1".into()],
            vec!["1".into(), "1".into(), "1.4".into()],
        ];
        noisy_fractional_rows.extend((0..38).map(|_| vec!["1".into(), "1".into(), "0.25".into()]));
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
                concentration_units: first.concentration_units.clone(),
                clinically_relevant_concentrations: vec![None, None, Some(4.0)],
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
}
