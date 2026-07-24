test_that("range-aware CSV import honors row and column limits", {
  path <- tempfile(fileext = ".csv")
  writeLines(
    c(
      "assay metadata,,,",
      "unused,DrugA,DrugB,OD",
      "x,0,0,1",
      "x,1,0,.8",
      "x,0,1,.7"
    ),
    path
  )

  result <- Checkerboard:::checkerboard_read_data(
    path,
    filename = "input.csv",
    start_row = 2,
    start_col = 2,
    n_rows = 2,
    n_cols = 2
  )

  expect_named(result, c("DrugA", "DrugB"))
  expect_equal(nrow(result), 2)
  expect_equal(result$DrugA, c(0, 1))
})

test_that("zero row and column limits read every remaining value", {
  path <- tempfile(fileext = ".csv")
  writeLines(
    c(
      "unused,DrugA,DrugB,OD",
      "x,0,0,1",
      "x,1,0,.8"
    ),
    path
  )

  result <- Checkerboard:::checkerboard_read_data(
    path,
    filename = "input.csv",
    start_col = 2,
    n_rows = 0,
    n_cols = 0
  )

  expect_named(result, c("DrugA", "DrugB", "OD"))
  expect_equal(nrow(result), 2)
})

test_that("numeric mapping values display with three decimal places", {
  display <- Checkerboard:::checkerboard_display_value

  expect_equal(display(1.23456), "1.235")
  expect_equal(display(0.00123456), "0.001")
  expect_equal(display(NA_real_), "NA")
  expect_equal(display("label"), "label")
})

test_that("plot color defaults round-trip through JSON", {
  config_dir <- tempfile("checkerboard-config-")
  path <- file.path(config_dir, "plot-colors.json")
  colors <- c(
    antagonism = "#A00000",
    midpoint = "ivory",
    synergy = "#008040",
    expected_growth = "navy"
  )

  expect_false(dir.exists(config_dir))
  expect_no_warning(
    result <- Checkerboard:::checkerboard_write_color_defaults(colors, path)
  )
  expect_identical(result, path)
  expect_true(file.exists(path))
  expect_equal(
    Checkerboard:::checkerboard_read_color_defaults(path),
    colors
  )

  parsed <- jsonlite::fromJSON(path)
  expect_equal(unname(unlist(parsed)), unname(colors))
})

test_that("missing or invalid color preferences fall back safely", {
  missing <- tempfile(fileext = ".json")
  expect_equal(
    Checkerboard:::checkerboard_read_color_defaults(missing),
    Checkerboard:::checkerboard_builtin_colors()
  )

  writeLines("{not valid json", missing)
  expect_equal(
    Checkerboard:::checkerboard_read_color_defaults(missing),
    Checkerboard:::checkerboard_builtin_colors()
  )
})

test_that("default mappings recognize common column names", {
  expect_equal(Checkerboard:::checkerboard_default_role("DrugA.Concentration", 1), "DrugA")
  expect_equal(Checkerboard:::checkerboard_default_role("Relative OD", 4), "OD")
  expect_equal(Checkerboard:::checkerboard_default_role("Notes", 7), "Ignore")
})

test_that("drug names are inferred from concentration headers", {
  infer <- Checkerboard:::checkerboard_drug_name

  expect_equal(infer("Ciprofloxacin Concentration", "DrugA"), "Ciprofloxacin")
  expect_equal(infer("Meropenem Conc", "DrugB"), "Meropenem")
  expect_equal(infer("Drug C.Concentration", "DrugC"), "DrugC")
  expect_equal(infer("Concentration", "DrugA"), "DrugA")
})

test_that("the app can be constructed", {
  skip_if_not_installed("shiny")
  skip_if_not_installed("bslib")
  skip_if_not_installed("DT")
  skip_if_not_installed("readxl")

  expect_s3_class(run_checkerboard_app(), "shiny.appobj")
})

test_that("the app server completes its startup flush", {
  skip_if_not_installed("shiny")

  expect_no_error(
    shiny::testServer(Checkerboard:::checkerboard_app_server, {
      session$flushReact()
    })
  )
})
