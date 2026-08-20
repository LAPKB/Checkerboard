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
    Ok(ImportPreview {
        headers: table.headers,
        rows: table.rows.into_iter().take(100).collect(),
        total_rows,
        total_columns,
        suggested_roles,
        suggested_drug_names,
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
    let assay = assay_from_rows(&table.rows, &request.mapping)?;
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
    if let Some(block_column) = table
        .headers
        .iter()
        .position(|header| matches!(normalize_header(header).as_str(), "pairindex" | "blockid"))
    {
        let blocks = table
            .rows
            .iter()
            .filter_map(|row| row.get(block_column))
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .collect::<std::collections::HashSet<_>>();
        if blocks.len() > 1 {
            return Err(AppError::new(
                "multipleBlocksUnsupported",
                "This version analyzes one SynergyFinder block at a time. Select a range containing one PairIndex/block_id; blocks are never merged as replicates.",
            ));
        }
    }
    let assay = assay_from_rows(&table.rows, &request.mapping)?;
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
    let mut result = analyze_with_progress(&assay, policy, |completed, total| {
        if let Some(channel) = &on_progress {
            let _ = channel.send(AnalysisProgress {
                completed_iterations: completed,
                total_iterations: total,
            });
        }
    })?;
    result.mic_values = request.mic_values;
    result.mic_zero_tolerance = request.mic_zero_tolerance;
    Ok(result)
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
    if normalized.contains("conca")
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
        let preview = import_preview(import.clone()).unwrap();
        assert_eq!(preview.total_rows, 11);
        assert_eq!(preview.suggested_roles, vec!["drugA", "drugB", "response"]);

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
        let preview = import_preview(import.clone()).unwrap();
        assert_eq!(preview.total_rows, 264);
        assert_eq!(
            preview.suggested_roles,
            vec!["ignore", "drugA", "drugB", "response"]
        );

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
}
