test_that("range-aware CSV import honors row, column, and row count", {
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
    n_rows = 2
  )

  expect_named(result, c("DrugA", "DrugB", "OD"))
  expect_equal(nrow(result), 2)
  expect_equal(result$DrugA, c(0, 1))
})

test_that("raw preview preserves cell positions before range selection", {
  path <- tempfile(fileext = ".csv")
  writeLines(
    c(
      "assay metadata,,,",
      "unused,DrugA,DrugB,OD",
      "x,0,0,1"
    ),
    path
  )

  preview <- Checkerboard:::checkerboard_preview_data(
    path,
    filename = "input.csv"
  )

  expect_named(preview, paste("Column", 1:4))
  expect_equal(preview[[1]][1], "assay metadata")
  expect_equal(preview[[2]][2], "DrugA")
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
