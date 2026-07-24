example_bliss_data <- function(three_drugs = FALSE) {
  concentrations <- if (three_drugs) {
    expand.grid(DrugA = c(0, 1), DrugB = c(0, 1), DrugC = c(0, 1))
  } else {
    expand.grid(DrugA = c(0, 1), DrugB = c(0, 1))
  }
  effect <- 1 - apply(1 - 0.25 * (concentrations > 0), 1, prod)
  combined <- rowSums(concentrations > 0) > 1
  effect[combined] <- pmin(0.95, effect[combined] + 0.08)
  names(concentrations) <- paste0(names(concentrations), ".Concentration")
  concentrations$RelativeOD <- 1 - effect
  concentrations
}

test_that("plot methods accept custom colors for two drugs", {
  object <- bliss$new(example_bliss_data())

  heatmap <- object$heatmap(
    print = FALSE,
    low_color = "#712B75",
    mid_color = "#FAFAFA",
    high_color = "#1B998B"
  )
  bars <- object$bar(
    print = FALSE,
    low_color = "#712B75",
    mid_color = "#FAFAFA",
    high_color = "#1B998B",
    expected_color = "#2458A6"
  )

  expect_s3_class(heatmap, "ggplot")
  expect_s3_class(bars, "plotly")

  built_bars <- plotly::plotly_build(bars)
  line_colors <- vapply(
    built_bars$x$data,
    function(trace) trace$line$color %||% NA_character_,
    character(1)
  )
  expect_true("rgba(36,88,166,1.000)" %in% line_colors)
})

test_that("three-drug summary and plots use the requested stratification", {
  object <- bliss$new(example_bliss_data(three_drugs = TRUE))
  summary <- suppressMessages(object$summary(stratify = "DrugC"))

  expect_equal(tail(summary$DrugC, 1), "Total")
  expect_s3_class(
    object$heatmap(stratify = "DrugC", print = FALSE),
    "ggplot"
  )
  expect_s3_class(
    suppressMessages(object$bar(stratify = "DrugC", print = FALSE)),
    "ggplot"
  )
})

test_that("export writes a workbook containing rendered results", {
  object <- bliss$new(example_bliss_data())
  export_dir <- tempfile("checkerboard-export-")
  dir.create(export_dir)
  old_dir <- setwd(export_dir)
  on.exit(setwd(old_dir), add = TRUE)
  path <- file.path(export_dir, "results.xlsx")

  capture.output(export(object, stratify = NULL, file = path))

  expect_true(file.exists(path))
  expect_gt(file.info(path)$size, 0)
  expect_false(file.exists(file.path(export_dir, "Rplots.pdf")))
})
