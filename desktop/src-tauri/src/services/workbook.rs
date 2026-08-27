use std::path::Path;

use checkerboard_core::{
    AggregateInterpretation, AnalysisResult, InteractionInterpretation, summarize_by,
};
use rust_xlsxwriter::{Color, Format, FormatAlign, Workbook, XlsxError};

use crate::error::AppError;

pub fn export_results(
    path: &str,
    analysis: &AnalysisResult,
    stratify_index: Option<usize>,
) -> Result<(), AppError> {
    if analysis.mic_values.len() != analysis.drug_names.len()
        || analysis
            .mic_values
            .iter()
            .any(|value| !value.is_finite() || *value <= 0.0)
    {
        return Err(AppError::new(
            "invalidMicValues",
            "The analysis must contain one positive MIC for each drug before export.",
        ));
    }
    if Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("xlsx"))
    {
        return Err(AppError::new(
            "invalidExportExtension",
            "The export file must use the .xlsx extension.",
        ));
    }

    let mut workbook = Workbook::new();
    let worksheet = workbook.add_worksheet();
    worksheet
        .set_name(safe_sheet_name(&analysis.drug_names.join("+")))
        .map_err(xlsx_error)?;

    let title_format = Format::new()
        .set_bold()
        .set_font_size(16)
        .set_font_color(Color::White)
        .set_background_color(Color::RGB(0x235789));
    let header_format = Format::new()
        .set_bold()
        .set_font_color(Color::White)
        .set_background_color(Color::RGB(0x235789))
        .set_align(FormatAlign::Center);
    let number_format = Format::new().set_num_format("0.000");

    worksheet
        .write_string_with_format(
            0,
            0,
            "SynergyFinder+ Compatible Bliss Analysis",
            &title_format,
        )
        .map_err(xlsx_error)?;
    worksheet
        .write_string(
            1,
            0,
            format!("Combination: {}", analysis.drug_names.join(" + ")),
        )
        .map_err(xlsx_error)?;
    worksheet
        .write_string(
            2,
            0,
            format!(
                "Native Rust analysis benchmarked against synergyfinder 3.20.0; response type: {:?}; baseline correction: {:?}; bootstrap iterations: {}; seed: {}",
                analysis.policy.response_type,
                analysis.policy.baseline_correction,
                analysis.policy.bootstrap_iterations,
                analysis.policy.random_seed
            ),
        )
        .map_err(xlsx_error)?;
    worksheet
        .write_string(
            3,
            0,
            format!(
                "MIC-relative coordinates (inference tolerance ±{} viability percentage points): {}",
                analysis.mic_zero_tolerance,
                analysis
                    .drug_names
                    .iter()
                    .zip(&analysis.mic_values)
                    .enumerate()
                    .map(|(index, (drug, mic))| {
                        let unit = analysis.concentration_units.get(index).filter(|unit| !unit.is_empty()).map(|unit| format!(" {unit}")).unwrap_or_default();
                        format!("{drug} MIC={mic}{unit}")
                    })
                    .collect::<Vec<_>>()
                    .join("; ")
            ),
        )
        .map_err(xlsx_error)?;
    worksheet
        .write_string(
            4,
            0,
            format!(
                "Clinically relevant concentrations (analysis window 1/4× to 4×): {}",
                analysis
                    .drug_names
                    .iter()
                    .enumerate()
                    .map(|(index, drug)| {
                        match analysis
                            .clinically_relevant_concentrations
                            .get(index)
                            .copied()
                            .flatten()
                        {
                            Some(value) => {
                                let unit = analysis
                                    .concentration_units
                                    .get(index)
                                    .filter(|unit| !unit.is_empty())
                                    .map(|unit| format!(" {unit}"))
                                    .unwrap_or_default();
                                format!("{drug}={value}{unit}")
                            }
                            None => format!("{drug}=unrestricted"),
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("; ")
            ),
        )
        .map_err(xlsx_error)?;

    let mut row = 5;
    if analysis.drug_names.len() == 3 {
        let index = stratify_index.unwrap_or(2);
        let stratified = summarize_by(analysis, index).ok_or_else(|| {
            AppError::new(
                "invalidStratification",
                "The selected stratifying drug is invalid.",
            )
        })?;
        for (column, heading) in [
            stratified.stratify_drug.as_str(),
            "Mean Bliss Interaction",
            "Interpretation",
        ]
        .iter()
        .enumerate()
        {
            worksheet
                .write_string_with_format(row, column as u16, *heading, &header_format)
                .map_err(xlsx_error)?;
        }
        row += 1;
        for summary_row in &stratified.rows {
            worksheet
                .write_number(row, 0, summary_row.concentration)
                .map_err(xlsx_error)?;
            worksheet
                .write_number_with_format(row, 1, summary_row.summary.mean_bliss, &number_format)
                .map_err(xlsx_error)?;
            write_aggregate_interpretation(worksheet, row, 2, summary_row.summary.interpretation)?;
            row += 1;
        }
        worksheet
            .write_string(row, 0, "Total")
            .map_err(xlsx_error)?;
        worksheet
            .write_number_with_format(row, 1, analysis.summary.mean_bliss, &number_format)
            .map_err(xlsx_error)?;
        write_aggregate_interpretation(worksheet, row, 2, analysis.summary.interpretation)?;
        row += 3;
    } else {
        for (column, heading) in [
            "Mean Bliss Interaction",
            "P Value",
            "Combination Locations",
            "Interpretation",
        ]
        .iter()
        .enumerate()
        {
            worksheet
                .write_string_with_format(row, column as u16, *heading, &header_format)
                .map_err(xlsx_error)?;
        }
        row += 1;
        worksheet
            .write_number_with_format(row, 0, analysis.summary.mean_bliss, &number_format)
            .map_err(xlsx_error)?;
        worksheet
            .write_string(row, 1, analysis.summary.p_value.as_deref().unwrap_or(""))
            .map_err(xlsx_error)?;
        worksheet
            .write_number(row, 2, analysis.summary.combination_count as f64)
            .map_err(xlsx_error)?;
        write_aggregate_interpretation(worksheet, row, 3, analysis.summary.interpretation)?;
        row += 3;
    }

    let mut headers = analysis
        .drug_names
        .iter()
        .enumerate()
        .map(|(index, drug)| {
            analysis
                .concentration_units
                .get(index)
                .filter(|unit| !unit.is_empty())
                .map_or_else(|| drug.clone(), |unit| format!("{drug} ({unit})"))
        })
        .collect::<Vec<_>>();
    headers.extend(
        analysis
            .drug_names
            .iter()
            .map(|drug| format!("{drug} log2(Dose/MIC)")),
    );
    headers.extend([
        "Mean Original Response".into(),
        "Mean Inhibition (%)".into(),
        "Adjusted Replicates".into(),
    ]);
    headers.push("Observed Inhibition (%)".into());
    headers.extend(
        analysis
            .drug_names
            .iter()
            .map(|drug| format!("Effect {drug}")),
    );
    headers.extend([
        "Bliss Expected".into(),
        "Mean Bliss Interaction (percentage points)".into(),
        "Bliss Bootstrap SEM".into(),
        "Bliss 95% CI Left".into(),
        "Bliss 95% CI Right".into(),
        "Interpretation".into(),
        "Replicates".into(),
    ]);
    for (column, heading) in headers.iter().enumerate() {
        worksheet
            .write_string_with_format(row, column as u16, heading, &header_format)
            .map_err(xlsx_error)?;
    }
    row += 1;

    for combination in &analysis.processed {
        let mut column = 0u16;
        for value in &combination.concentrations {
            worksheet
                .write_number(row, column, *value)
                .map_err(xlsx_error)?;
            column += 1;
        }
        for (value, mic) in combination.concentrations.iter().zip(&analysis.mic_values) {
            if *value > 0.0 {
                worksheet
                    .write_number_with_format(row, column, (value / mic).log2(), &number_format)
                    .map_err(xlsx_error)?;
            } else {
                worksheet
                    .write_string(row, column, "NA")
                    .map_err(xlsx_error)?;
            }
            column += 1;
        }
        worksheet
            .write_number_with_format(row, column, combination.mean_original_od, &number_format)
            .map_err(xlsx_error)?;
        column += 1;
        worksheet
            .write_number_with_format(row, column, combination.mean_censored_od, &number_format)
            .map_err(xlsx_error)?;
        column += 1;
        worksheet
            .write_number(row, column, combination.censored_replicate_count as f64)
            .map_err(xlsx_error)?;
        column += 1;
        worksheet
            .write_number_with_format(row, column, combination.effect, &number_format)
            .map_err(xlsx_error)?;
        column += 1;
        for value in &combination.single_agent_effects {
            worksheet
                .write_number_with_format(row, column, *value, &number_format)
                .map_err(xlsx_error)?;
            column += 1;
        }
        worksheet
            .write_number_with_format(row, column, combination.bliss_expected, &number_format)
            .map_err(xlsx_error)?;
        column += 1;
        worksheet
            .write_number_with_format(row, column, combination.bliss_interaction, &number_format)
            .map_err(xlsx_error)?;
        column += 1;
        for statistic in [
            combination.bliss_sem,
            combination.bliss_ci_left,
            combination.bliss_ci_right,
        ] {
            if let Some(value) = statistic {
                worksheet
                    .write_number_with_format(row, column, value, &number_format)
                    .map_err(xlsx_error)?;
            }
            column += 1;
        }
        worksheet
            .write_string(row, column, interaction_label(combination.interpretation))
            .map_err(xlsx_error)?;
        column += 1;
        worksheet
            .write_number(row, column, combination.replicate_count as f64)
            .map_err(xlsx_error)?;
        row += 1;
    }

    for column in 0..headers.len() as u16 {
        worksheet
            .set_column_width(
                column,
                if column < (analysis.drug_names.len() * 2) as u16 {
                    14
                } else {
                    18
                },
            )
            .map_err(xlsx_error)?;
    }
    worksheet.set_freeze_panes(1, 0).map_err(xlsx_error)?;
    workbook.save(path).map_err(xlsx_error)
}

fn write_aggregate_interpretation(
    worksheet: &mut rust_xlsxwriter::Worksheet,
    row: u32,
    column: u16,
    interpretation: AggregateInterpretation,
) -> Result<(), AppError> {
    let (label, background, foreground) = match interpretation {
        AggregateInterpretation::Antagonistic => ("Antagonistic", 0x00A83B, Color::White),
        AggregateInterpretation::Additive => ("Additive", 0xFFFFFF, Color::Black),
        AggregateInterpretation::Synergistic => ("Synergistic", 0xFF2B20, Color::White),
    };
    let format = Format::new()
        .set_background_color(Color::RGB(background))
        .set_font_color(foreground)
        .set_align(FormatAlign::Center);
    worksheet
        .write_string_with_format(row, column, label, &format)
        .map(|_| ())
        .map_err(xlsx_error)
}

fn interaction_label(interpretation: InteractionInterpretation) -> &'static str {
    match interpretation {
        InteractionInterpretation::Antagonistic => "Antagonistic",
        InteractionInterpretation::Additive => "Additive",
        InteractionInterpretation::Synergistic => "Synergistic",
    }
}

fn safe_sheet_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|character| match character {
            ':' | '\\' | '/' | '?' | '*' | '[' | ']' => '_',
            other => other,
        })
        .take(31)
        .collect();
    if cleaned.is_empty() {
        "Checkmate".into()
    } else {
        cleaned
    }
}

fn xlsx_error(error: XlsxError) -> AppError {
    AppError::new("workbookExportError", error.to_string())
}

#[cfg(test)]
mod tests {
    use checkerboard_core::{
        AnalysisPolicy, ColumnMapping, MappedDrug, ResponseType, analyze, assay_from_rows,
    };

    use super::*;

    #[test]
    fn workbook_contains_the_analyzed_fixture() {
        let source = include_str!("../../../../fixtures/valid/two_drug.csv");
        let mut reader = csv::Reader::from_reader(source.as_bytes());
        let rows = reader
            .records()
            .map(|record| {
                record
                    .unwrap()
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        let assay = assay_from_rows(
            &rows,
            &ColumnMapping {
                drugs: vec![
                    MappedDrug {
                        column: 0,
                        name: "DrugA".into(),
                    },
                    MappedDrug {
                        column: 1,
                        name: "DrugB".into(),
                    },
                ],
                response_column: 2,
            },
        )
        .unwrap();
        let mut analysis = analyze(
            &assay,
            AnalysisPolicy {
                response_type: ResponseType::RawOd,
                ..AnalysisPolicy::default()
            },
        )
        .unwrap();
        analysis.mic_values = vec![1.0, 1.0];
        analysis.mic_zero_tolerance = 5.0;
        let path = std::env::temp_dir().join(format!(
            "checkerboard-workbook-test-{}.xlsx",
            std::process::id()
        ));
        export_results(path.to_string_lossy().as_ref(), &analysis, None).unwrap();
        assert!(std::fs::metadata(&path).unwrap().len() > 1_000);
        std::fs::remove_file(path).unwrap();
    }
}
