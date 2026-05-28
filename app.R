app_ui <- function(request) {
  bslib::page_fillable(
    theme = bslib::bs_theme(version = 5, bootswatch = "flatly"),
    title = "Checkerboard Bliss App",
    bslib::layout_columns(
      col_widths = c(4, 8),
      bslib::card(
        full_screen = TRUE,
        bslib::card_header("Data Mapping"),
        shiny::fileInput(
          "source_file",
          "Select input file",
          accept = c(".txt", ".csv", ".xls", ".xlsx")
        ),
        shiny::radioButtons(
          "n_drugs",
          "Number of drugs",
          choices = c("2" = 2, "3" = 3),
          selected = 2,
          inline = TRUE
        ),
        shiny::uiOutput("mapping_ui"),
        shiny::uiOutput("mapping_warning"),
        shiny::uiOutput("execute_ui")
      ),
      shiny::div(
        style = "display: grid; gap: 1rem;",
        bslib::card(
          full_screen = TRUE,
          bslib::card_header("Plots"),
          bslib::navset_card_tab(
            id = "plot_tabs",
            bslib::nav_panel("Heatmap", shiny::plotOutput("heatmap_plot", height = "460px")),
            bslib::nav_panel("Bar", shiny::uiOutput("bar_plot_ui"))
          )
        ),
        bslib::card(
          full_screen = TRUE,
          bslib::card_header("Bliss Summary"),
          shiny::tableOutput("summary_table")
        )
      )
    )
  )
}

app_server <- function(input, output, session) {
  valid_name <- function(x) {
    nzchar(x) && grepl("^[A-Za-z0-9]+$", x)
  }

  read_input_data <- function(path) {
    ext <- tolower(tools::file_ext(path))

    if (ext == "csv") {
      return(readr::read_csv(path, show_col_types = FALSE, progress = FALSE))
    }

    if (ext == "txt") {
      dat <- tryCatch(
        readr::read_delim(path, delim = "\t", show_col_types = FALSE, progress = FALSE),
        error = function(e) NULL
      )

      if (is.null(dat) || ncol(dat) <= 1) {
        dat <- tryCatch(
          readr::read_delim(path, delim = ",", show_col_types = FALSE, progress = FALSE),
          error = function(e) NULL
        )
      }

      if (is.null(dat) || ncol(dat) <= 1) {
        dat <- tibble::as_tibble(utils::read.table(
          path,
          header = TRUE,
          sep = "",
          check.names = FALSE,
          stringsAsFactors = FALSE
        ))
      }

      return(dat)
    }

    if (ext %in% c("xls", "xlsx")) {
      return(readxl::read_excel(path))
    }

    stop("Unsupported file type. Use .txt, .csv, .xls, or .xlsx")
  }

  source_data <- shiny::reactive({
    shiny::req(input$source_file)
    read_input_data(input$source_file$datapath)
  })

  output$mapping_ui <- shiny::renderUI({
    shiny::req(source_data())
    n_drugs <- as.integer(input$n_drugs)
    choices <- names(source_data())

    drug_inputs <- lapply(seq_len(n_drugs), function(i) {
      bslib::layout_columns(
        col_widths = c(6, 6),
        shiny::textInput(
          inputId = paste0("drug_name_", i),
          label = paste0("Drug ", i, " name"),
          value = paste0("Drug", i)
        ),
        shiny::selectInput(
          inputId = paste0("drug_col_", i),
          label = paste0("Drug ", i, " source column"),
          choices = choices,
          selected = choices[min(i, length(choices))]
        )
      )
    })

    effect_input <- bslib::layout_columns(
      col_widths = c(6, 6),
      shiny::textInput(
        inputId = "effect_name",
        label = "Effect name",
        value = "OD"
      ),
      shiny::selectInput(
        inputId = "effect_col",
        label = "Effect source column",
        choices = choices,
        selected = choices[min(n_drugs + 1, length(choices))]
      )
    )

    do.call(shiny::tagList, c(drug_inputs, list(effect_input)))
  })

  validation_state <- shiny::reactive({
    shiny::req(source_data())
    n_drugs <- as.integer(input$n_drugs)

    drug_names <- vapply(seq_len(n_drugs), function(i) input[[paste0("drug_name_", i)]], character(1))
    drug_cols <- vapply(seq_len(n_drugs), function(i) input[[paste0("drug_col_", i)]], character(1))
    effect_name <- input$effect_name
    effect_col <- input$effect_col

    warnings <- character(0)

    all_target_names <- c(drug_names, effect_name)
    if (anyNA(all_target_names) || any(!nzchar(all_target_names))) {
      warnings <- c(warnings, "All name fields are required.")
    }

    invalid_targets <- all_target_names[!vapply(all_target_names, valid_name, logical(1))]
    if (length(invalid_targets) > 0) {
      warnings <- c(
        warnings,
        "Names must use only letters and numbers (no spaces or symbols)."
      )
    }

    if (length(unique(all_target_names)) != length(all_target_names)) {
      warnings <- c(warnings, "Drug/effect names must be unique.")
    }

    all_source_cols <- c(drug_cols, effect_col)
    if (anyNA(all_source_cols) || any(!nzchar(all_source_cols))) {
      warnings <- c(warnings, "All source-column mappings are required.")
    }

    if (length(unique(all_source_cols)) != length(all_source_cols)) {
      warnings <- c(warnings, "Each mapped source column must be unique.")
    }

    list(
      valid = length(warnings) == 0,
      warnings = unique(warnings),
      n_drugs = n_drugs,
      drug_names = drug_names,
      drug_cols = drug_cols,
      effect_name = effect_name,
      effect_col = effect_col
    )
  })

  output$mapping_warning <- shiny::renderUI({
    shiny::req(source_data())
    state <- validation_state()

    if (state$valid) {
      return(NULL)
    }

    shiny::div(
      class = "alert alert-warning",
      shiny::tags$strong("Warning:"),
      shiny::tags$ul(lapply(state$warnings, shiny::tags$li))
    )
  })

  output$execute_ui <- shiny::renderUI({
    shiny::req(source_data())
    state <- validation_state()

    if (!state$valid) {
      return(NULL)
    }

    shiny::actionButton("execute", "Execute", class = "btn-primary")
  })

  rv <- shiny::reactiveValues(
    bliss_obj = NULL,
    n_drugs = NULL
  )

  shiny::observeEvent(input$execute, {
    state <- validation_state()
    shiny::req(state$valid)

    raw <- source_data()

    mapped <- raw[, c(state$drug_cols, state$effect_col), drop = FALSE]
    names(mapped) <- c(
      paste0(state$drug_names, ".Concentration"),
      paste0("Relative", state$effect_name)
    )

    obj <- tryCatch(
      Checkerboard::bliss$new(file = mapped),
      error = function(e) e
    )

    if (inherits(obj, "error")) {
      rv$bliss_obj <- NULL
      rv$n_drugs <- NULL
      shiny::showNotification(
        paste("Execution failed:", conditionMessage(obj)),
        type = "error"
      )
      return(invisible(NULL))
    }

    rv$bliss_obj <- obj
    rv$n_drugs <- state$n_drugs
    shiny::showNotification("Bliss object created.", type = "message")
    invisible(rv$bliss_obj)
  })

  output$heatmap_plot <- shiny::renderPlot({
    shiny::req(rv$bliss_obj)
    rv$bliss_obj$heatmap(print = FALSE)
  })

  output$bar_plot_ui <- shiny::renderUI({
    shiny::req(rv$bliss_obj, rv$n_drugs)

    if (rv$n_drugs == 2) {
      plotly::plotlyOutput("bar_plotly", height = "460px")
    } else {
      shiny::plotOutput("bar_plot", height = "460px")
    }
  })

  output$bar_plotly <- plotly::renderPlotly({
    shiny::req(rv$bliss_obj, rv$n_drugs == 2)
    rv$bliss_obj$bar(print = FALSE)
  })

  output$bar_plot <- shiny::renderPlot({
    shiny::req(rv$bliss_obj, rv$n_drugs == 3)
    rv$bliss_obj$bar(print = FALSE)
  })

  output$summary_table <- shiny::renderTable({
    shiny::req(rv$bliss_obj)
    rv$bliss_obj$summary() |> dplyr::rename(Score = sum_bliss, Intepretation = interpretation)
  }, striped = TRUE, bordered = TRUE, hover = TRUE)
}

run_app <- function(...) {
  golem::with_golem_options(
    app = shiny::shinyApp(ui = app_ui, server = app_server),
    golem_opts = list(...)
  )
}

if (interactive()) {
  run_app()
}
