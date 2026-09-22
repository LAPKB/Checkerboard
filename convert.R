#!/usr/bin/env Rscript

# Convert checkerboard workbooks in the supplied RO1 layout to the canonical
# CSV schema accepted by the Checkerboard desktop app.
#
# Usage:
#   Rscript convert.R input.xlsx [output.csv] [UnitA] [UnitB]
#
# Example:
#   Rscript convert.R plate.xlsx plate.csv mg/L mg/L

assert_openxlsx <- function() {
  if (!requireNamespace("openxlsx", quietly = TRUE)) {
    stop(
      "Package 'openxlsx' is required. Install it with install.packages('openxlsx').",
      call. = FALSE
    )
  }
}

clean_text <- function(value) {
  value <- as.character(value[[1]])
  if (length(value) == 0L || is.na(value)) {
    return(NA_character_)
  }
  value <- trimws(gsub("[[:space:]]+", " ", value))
  if (!nzchar(value)) NA_character_ else value
}

read_cell <- function(path, sheet, row, column) {
  value <- openxlsx::read.xlsx(
    path,
    sheet = sheet,
    rows = row,
    cols = column,
    colNames = FALSE,
    rowNames = FALSE,
    skipEmptyRows = FALSE,
    skipEmptyCols = FALSE
  )
  if (length(value) == 0L || ncol(value) < column) NA else value[[1, column]]
}

normalized_name <- function(value) {
  tolower(gsub("[^[:alnum:]]", "", value))
}

read_numeric_vector <- function(path, sheet, rows, columns) {
  values <- openxlsx::read.xlsx(
    path,
    sheet = sheet,
    rows = rows,
    cols = columns,
    colNames = FALSE,
    rowNames = FALSE,
    skipEmptyRows = FALSE,
    skipEmptyCols = FALSE
  )
  if (length(values) == 0L) {
    return(numeric())
  }
  selected <- matrix(NA, nrow = nrow(values), ncol = length(columns))
  available <- columns <= ncol(values)
  if (any(available)) {
    selected[, available] <- as.matrix(values[, columns[available], drop = FALSE])
  }
  suppressWarnings(as.numeric(t(selected)))
}

plate_definition <- function(plate) {
  if (identical(plate, 1L)) {
    return(list(header_row = 7L, response_rows = 8:15))
  }
  if (identical(plate, 2L)) {
    return(list(header_row = 19L, response_rows = 20:27))
  }
  stop("Plate must be 1 or 2.", call. = FALSE)
}

read_plate <- function(path, sheet, plate, drug_a, drug_b, unit_a, unit_b) {
  layout <- plate_definition(plate)

  # The workbook's horizontal concentrations occupy P:Y. Some sheets contain
  # a second zero after the assay columns; the original Pmetrics conversion
  # treats that final zero as a plate annotation rather than a concentration.
  concentrations_a <- read_numeric_vector(
    path, sheet, layout$header_row, 16:25
  )
  concentrations_a <- concentrations_a[!is.na(concentrations_a)]
  if (
    length(concentrations_a) > 1L &&
      concentrations_a[[1]] == 0 &&
      concentrations_a[[length(concentrations_a)]] == 0
  ) {
    concentrations_a <- concentrations_a[-length(concentrations_a)]
  }

  concentrations_b <- read_numeric_vector(
    path, sheet, layout$response_rows, 15L
  )
  concentrations_b <- concentrations_b[!is.na(concentrations_b)]

  if (length(concentrations_a) == 0L || length(concentrations_b) == 0L) {
    return(NULL)
  }

  response_columns <- 16L + seq_along(concentrations_a) - 1L
  raw_response <- openxlsx::read.xlsx(
    path,
    sheet = sheet,
    rows = layout$response_rows[seq_along(concentrations_b)],
    cols = response_columns,
    colNames = FALSE,
    rowNames = FALSE,
    skipEmptyRows = FALSE,
    skipEmptyCols = FALSE
  )
  if (length(raw_response) == 0L) {
    warning(
      sprintf("Skipped sheet '%s', plate %d because its response block is empty.", sheet, plate),
      call. = FALSE
    )
    return(NULL)
  }
  response_block <- matrix(
    NA,
    nrow = length(concentrations_b),
    ncol = length(concentrations_a)
  )
  available_rows <- seq_len(min(nrow(raw_response), nrow(response_block)))
  available_columns <- response_columns <= ncol(raw_response)
  if (length(available_rows) > 0L && any(available_columns)) {
    response_block[available_rows, available_columns] <- as.matrix(
      raw_response[available_rows, response_columns[available_columns], drop = FALSE]
    )
  }
  raw_response <- response_block
  if (!identical(dim(raw_response), c(length(concentrations_b), length(concentrations_a)))) {
    stop(
      sprintf(
        "Sheet '%s', plate %d has a %d x %d response block; expected %d x %d.",
        sheet,
        plate,
        nrow(raw_response),
        ncol(raw_response),
        length(concentrations_b),
        length(concentrations_a)
      ),
      call. = FALSE
    )
  }

  response_text <- trimws(as.character(raw_response))
  missing_response <- is.na(raw_response) | response_text == ""
  response <- suppressWarnings(as.numeric(raw_response))
  invalid_response <- !missing_response & is.na(response)
  if (any(invalid_response)) {
    bad <- unique(response_text[invalid_response])
    stop(
      sprintf(
        "Sheet '%s', plate %d contains non-numeric response value(s): %s",
        sheet,
        plate,
        paste(shQuote(bad), collapse = ", ")
      ),
      call. = FALSE
    )
  }

  output <- data.frame(
    DrugA = rep(drug_a, length(response)),
    DrugB = rep(drug_b, length(response)),
    ConcA = rep(concentrations_a, times = length(concentrations_b)),
    ConcB = rep(concentrations_b, each = length(concentrations_a)),
    UnitA = rep(unit_a, length(response)),
    UnitB = rep(unit_b, length(response)),
    Response = as.vector(t(matrix(response, nrow = length(concentrations_b)))),
    stringsAsFactors = FALSE,
    check.names = FALSE
  )

  omitted <- sum(missing_response)
  if (omitted > 0L) {
    warning(
      sprintf(
        "Omitted %d empty response cell(s) from sheet '%s', plate %d.",
        omitted, sheet, plate
      ),
      call. = FALSE
    )
  }
  if (omitted == length(missing_response)) {
    return(NULL)
  }
  output[!as.vector(t(matrix(missing_response, nrow = length(concentrations_b)))), , drop = FALSE]
}

convert_checkerboard_xlsx <- function(
  input,
  output = sub("\\.xlsx$", ".csv", input, ignore.case = TRUE),
  unit_a = "mg/L",
  unit_b = unit_a,
  sheets = NULL
) {
  assert_openxlsx()

  if (!file.exists(input)) {
    stop(sprintf("Input file does not exist: %s", input), call. = FALSE)
  }
  if (!grepl("\\.xlsx$", input, ignore.case = TRUE)) {
    stop("Input must be an .xlsx file.", call. = FALSE)
  }
  if (identical(output, input)) {
    stop("Output path must differ from the input path.", call. = FALSE)
  }
  if (!nzchar(trimws(unit_a)) || !nzchar(trimws(unit_b))) {
    stop("UnitA and UnitB must be non-empty strings.", call. = FALSE)
  }

  workbook_sheets <- openxlsx::getSheetNames(input)
  if (is.null(sheets)) {
    sheets <- workbook_sheets
  } else {
    unknown <- setdiff(sheets, workbook_sheets)
    if (length(unknown) > 0L) {
      stop(
        sprintf("Worksheet(s) not found: %s", paste(unknown, collapse = ", ")),
        call. = FALSE
      )
    }
  }

  converted <- list()
  converted_sheets <- character()
  skipped_sheets <- character()

  for (sheet in sheets) {
    # Q6 is the horizontal (A) drug and N9 is the vertical (B) drug. Plate 2
    # repeats those names at Q18 and N21, sometimes with spacing differences.
    drug_a <- clean_text(read_cell(input, sheet, 6L, 17L))
    drug_b <- clean_text(read_cell(input, sheet, 9L, 14L))
    if (is.na(drug_a) || is.na(drug_b)) {
      skipped_sheets <- c(skipped_sheets, sheet)
      next
    }

    plate_2_drug_a <- clean_text(read_cell(input, sheet, 18L, 17L))
    plate_2_drug_b <- clean_text(read_cell(input, sheet, 21L, 14L))
    if (
      !is.na(plate_2_drug_a) &&
        normalized_name(plate_2_drug_a) != normalized_name(drug_a)
    ) {
      warning(
        sprintf(
          "Sheet '%s' has different DrugA labels for its plates ('%s' and '%s'); using '%s'.",
          sheet, drug_a, plate_2_drug_a, drug_a
        ),
        call. = FALSE
      )
    }
    if (
      !is.na(plate_2_drug_b) &&
        normalized_name(plate_2_drug_b) != normalized_name(drug_b)
    ) {
      warning(
        sprintf(
          "Sheet '%s' has different DrugB labels for its plates ('%s' and '%s'); using '%s'.",
          sheet, drug_b, plate_2_drug_b, drug_b
        ),
        call. = FALSE
      )
    }

    sheet_data <- lapply(
      1:2,
      function(plate) {
        read_plate(
          input, sheet, as.integer(plate), drug_a, drug_b,
          trimws(unit_a), trimws(unit_b)
        )
      }
    )
    sheet_data <- Filter(Negate(is.null), sheet_data)
    if (length(sheet_data) == 0L) {
      skipped_sheets <- c(skipped_sheets, sheet)
      next
    }

    converted[[length(converted) + 1L]] <- do.call(rbind, sheet_data)
    converted_sheets <- c(converted_sheets, sheet)
  }

  if (length(converted) == 0L) {
    stop("No checkerboard assay blocks were found in the selected worksheet(s).", call. = FALSE)
  }

  result <- do.call(rbind, converted)
  rownames(result) <- NULL
  result <- result[, c("DrugA", "DrugB", "ConcA", "ConcB", "UnitA", "UnitB", "Response")]
  utils::write.csv(result, output, row.names = FALSE, na = "")

  message(sprintf("Wrote %d rows to %s", nrow(result), normalizePath(output, mustWork = FALSE)))
  message(sprintf("Converted worksheet(s): %s", paste(converted_sheets, collapse = ", ")))
  if (length(skipped_sheets) > 0L) {
    message(sprintf("Skipped worksheet(s) without assay blocks: %s", paste(skipped_sheets, collapse = ", ")))
  }

  invisible(result)
}

run_cli <- function(arguments = commandArgs(trailingOnly = TRUE)) {
  if (length(arguments) < 1L || length(arguments) > 4L) {
    stop(
      paste(
        "Usage: Rscript convert.R input.xlsx [output.csv] [UnitA] [UnitB]",
        "UnitA and UnitB default to mg/L.",
        sep = "\n"
      ),
      call. = FALSE
    )
  }

  input <- arguments[[1]]
  output <- if (length(arguments) >= 2L) arguments[[2]] else
    sub("\\.xlsx$", ".csv", input, ignore.case = TRUE)
  unit_a <- if (length(arguments) >= 3L) arguments[[3]] else "mg/L"
  unit_b <- if (length(arguments) >= 4L) arguments[[4]] else unit_a
  convert_checkerboard_xlsx(input, output, unit_a, unit_b)
}

if (sys.nframe() == 0L) {
  run_cli()
}
