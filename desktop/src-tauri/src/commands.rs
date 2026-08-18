use checkerboard_core::{AnalysisPolicy, AnalysisResult, ColumnMapping, analyze, assay_from_rows};
use serde::{Deserialize, Serialize};

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
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResultsRequest {
    pub path: String,
    pub analysis: AnalysisResult,
    pub stratify_index: Option<usize>,
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
    let suggested_drug_names = table
        .headers
        .iter()
        .enumerate()
        .map(|(index, header)| {
            infer_drug_name(header, &format!("Drug{}", (b'A' + index as u8) as char))
        })
        .collect();
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
pub fn analyze_table(request: AnalyzeTableRequest) -> Result<AnalysisResult, AppError> {
    let table = importer::read_table(&request.import)?;
    let assay = assay_from_rows(&table.rows, &request.mapping)?;
    analyze(&assay, request.policy.unwrap_or_default()).map_err(Into::into)
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
    let normalized: String = header
        .to_lowercase()
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect();
    if normalized.contains("druga") || normalized.contains("drug1") {
        "drugA".into()
    } else if normalized.contains("drugb") || normalized.contains("drug2") {
        "drugB".into()
    } else if normalized.contains("drugc") || normalized.contains("drug3") {
        "drugC".into()
    } else if normalized.contains("relative")
        || normalized.contains("od")
        || normalized.contains("response")
        || normalized.contains("effect")
    {
        "od".into()
    } else {
        "ignore".into()
    }
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

    #[test]
    fn common_headers_get_expected_roles() {
        assert_eq!(default_role("DrugA.Concentration", 0), "drugA");
        assert_eq!(default_role("Relative OD", 3), "od");
        assert_eq!(default_role("Notes", 6), "ignore");
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
            vec!["ignore", "drugA", "drugB", "od"]
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
        assert_eq!(preview.suggested_roles, vec!["drugA", "drugB", "od"]);

        let result = analyze_table(AnalyzeTableRequest {
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
            policy: None,
        })
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
            vec!["ignore", "drugA", "drugB", "od"]
        );

        let result = analyze_table(AnalyzeTableRequest {
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
            policy: None,
        })
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
}
