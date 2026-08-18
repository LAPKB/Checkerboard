use std::{fs::File, path::Path};

use calamine::{Data, Reader, open_workbook_auto};
use serde::{Deserialize, Serialize};

use crate::error::AppError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    pub path: String,
    pub worksheet: Option<String>,
    pub start_row: usize,
    pub start_column: usize,
    pub row_limit: usize,
    pub column_limit: usize,
}

#[derive(Debug, Clone)]
pub struct ImportedTable {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

pub fn list_worksheets(path: &str) -> Result<Vec<String>, AppError> {
    ensure_supported_path(path)?;
    let extension = extension(path)?;
    if !matches!(extension.as_str(), "xls" | "xlsx") {
        return Ok(Vec::new());
    }
    let workbook = open_workbook_auto(path)
        .map_err(|error| AppError::new("spreadsheetReadError", error.to_string()))?;
    Ok(workbook.sheet_names().to_vec())
}

pub fn read_table(request: &ImportRequest) -> Result<ImportedTable, AppError> {
    validate_request(request)?;
    let extension = extension(&request.path)?;
    let raw_rows = match extension.as_str() {
        "csv" => read_delimited(&request.path, b',')?,
        "txt" => {
            let tabular = read_delimited(&request.path, b'\t')?;
            if tabular.iter().map(Vec::len).max().unwrap_or(0) < 2 {
                read_delimited(&request.path, b',')?
            } else {
                tabular
            }
        }
        "xls" | "xlsx" => read_spreadsheet(&request.path, request.worksheet.as_deref())?,
        _ => {
            return Err(AppError::new(
                "unsupportedFileType",
                "Select a .csv, .txt, .xls, or .xlsx file.",
            ));
        }
    };
    select_range(raw_rows, request)
}

fn read_delimited(path: &str, delimiter: u8) -> Result<Vec<Vec<String>>, AppError> {
    let file = File::open(path)?;
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(false)
        .flexible(true)
        .from_reader(file);
    reader
        .records()
        .map(|record| {
            record
                .map(|record| record.iter().map(ToString::to_string).collect())
                .map_err(|error| AppError::new("delimitedReadError", error.to_string()))
        })
        .collect()
}

fn read_spreadsheet(path: &str, worksheet: Option<&str>) -> Result<Vec<Vec<String>>, AppError> {
    let mut workbook = open_workbook_auto(path)
        .map_err(|error| AppError::new("spreadsheetReadError", error.to_string()))?;
    let sheet_name =
        match worksheet {
            Some(name) if !name.is_empty() => name.to_string(),
            _ => workbook.sheet_names().first().cloned().ok_or_else(|| {
                AppError::new("missingWorksheet", "The workbook has no worksheets.")
            })?,
        };
    let range = workbook
        .worksheet_range(&sheet_name)
        .map_err(|error| AppError::new("spreadsheetReadError", error.to_string()))?;
    Ok(range
        .rows()
        .map(|row| row.iter().map(cell_to_string).collect())
        .collect())
}

fn cell_to_string(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        Data::String(value) => value.clone(),
        Data::Float(value) => value.to_string(),
        Data::Int(value) => value.to_string(),
        Data::Bool(value) => value.to_string(),
        Data::DateTime(value) => value.to_string(),
        Data::DateTimeIso(value) => value.clone(),
        Data::DurationIso(value) => value.clone(),
        Data::Error(value) => format!("#{value:?}"),
    }
}

fn select_range(
    rows: Vec<Vec<String>>,
    request: &ImportRequest,
) -> Result<ImportedTable, AppError> {
    let header_index = request.start_row - 1;
    let header = rows.get(header_index).ok_or_else(|| {
        AppError::new(
            "startRowOutOfRange",
            "Start row is beyond the last row in the imported table.",
        )
    })?;
    let start_column = request.start_column - 1;
    if start_column >= header.len() {
        return Err(AppError::new(
            "startColumnOutOfRange",
            "Start column is beyond the last column in the imported table.",
        ));
    }
    let available_columns = header.len() - start_column;
    let selected_columns = if request.column_limit == 0 {
        available_columns
    } else {
        request.column_limit.min(available_columns)
    };
    let end_column = start_column + selected_columns;
    let headers = make_unique_headers(&header[start_column..end_column]);

    let available_data = rows.len().saturating_sub(header_index + 1);
    let selected_rows = if request.row_limit == 0 {
        available_data
    } else {
        request.row_limit.min(available_data)
    };
    let mut data = Vec::with_capacity(selected_rows);
    for raw in rows.iter().skip(header_index + 1).take(selected_rows) {
        let mut row = Vec::with_capacity(selected_columns);
        for column in start_column..end_column {
            row.push(raw.get(column).cloned().unwrap_or_default());
        }
        data.push(row);
    }
    Ok(ImportedTable {
        headers,
        rows: data,
    })
}

fn make_unique_headers(headers: &[String]) -> Vec<String> {
    let mut result = Vec::<String>::with_capacity(headers.len());
    for header in headers {
        let base = if header.trim().is_empty() {
            "Unnamed".to_string()
        } else {
            header.trim().to_string()
        };
        let mut candidate = base.clone();
        let mut suffix = 1;
        while result.iter().any(|existing| existing == &candidate) {
            suffix += 1;
            candidate = format!("{base}.{suffix}");
        }
        result.push(candidate);
    }
    result
}

fn validate_request(request: &ImportRequest) -> Result<(), AppError> {
    ensure_supported_path(&request.path)?;
    if request.start_row == 0 || request.start_column == 0 {
        return Err(AppError::new(
            "invalidRange",
            "Start row and start column must be at least one.",
        ));
    }
    Ok(())
}

fn ensure_supported_path(path: &str) -> Result<(), AppError> {
    let path = Path::new(path);
    if !path.is_file() {
        return Err(AppError::new(
            "fileNotFound",
            "The selected input file does not exist or is not a regular file.",
        ));
    }
    let extension = extension(path.to_string_lossy().as_ref())?;
    if !matches!(extension.as_str(), "csv" | "txt" | "xls" | "xlsx") {
        return Err(AppError::new(
            "unsupportedFileType",
            "Select a .csv, .txt, .xls, or .xlsx file.",
        ));
    }
    Ok(())
}

fn extension(path: &str) -> Result<String, AppError> {
    Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_lowercase)
        .ok_or_else(|| {
            AppError::new(
                "missingFileExtension",
                "The selected file has no extension.",
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_selection_uses_the_selected_row_as_header() {
        let rows = vec![
            vec!["metadata".into(), "".into(), "".into()],
            vec!["ignore".into(), "DrugA".into(), "OD".into()],
            vec!["x".into(), "0".into(), "1".into()],
            vec!["x".into(), "1".into(), "0.7".into()],
        ];
        let request = ImportRequest {
            path: "unused.csv".into(),
            worksheet: None,
            start_row: 2,
            start_column: 2,
            row_limit: 1,
            column_limit: 2,
        };
        let selected = select_range(rows, &request).unwrap();
        assert_eq!(selected.headers, vec!["DrugA", "OD"]);
        assert_eq!(selected.rows, vec![vec!["0", "1"]]);
    }
}
