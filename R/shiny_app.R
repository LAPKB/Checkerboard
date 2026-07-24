#' Run the Checkerboard Shiny app
#'
#' Launch an interactive interface for importing checkerboard assay data,
#' assigning columns to `DrugA`, `DrugB`, optional `DrugC`, and `OD`, and
#' running the methods provided by the [bliss] R6 class.
#'
#' @param ... Arguments passed to [shiny::shinyApp()].
#' @return A Shiny application object, invisibly.
#' @export
run_checkerboard_app <- function(...) {
  required <- c("shiny", "bslib", "DT", "readxl")
  missing <- required[!vapply(required, requireNamespace, logical(1), quietly = TRUE)]
  if (length(missing)) {
    stop(
      "The Checkerboard app requires: ",
      paste(missing, collapse = ", "),
      ". Install the missing package(s) and try again.",
      call. = FALSE
    )
  }

  shiny::shinyApp(
    ui = checkerboard_app_ui,
    server = checkerboard_app_server,
    ...
  )
}

checkerboard_read_data <- function(path, filename, sheet = NULL, start_row = 1L,
                                   start_col = 1L, n_rows = Inf) {
  extension <- tolower(tools::file_ext(filename))
  start_row <- max(1L, as.integer(start_row))
  start_col <- max(1L, as.integer(start_col))
  n_max <- if (is.finite(n_rows) && n_rows > 0) as.integer(n_rows) else Inf

  data <- switch(
    extension,
    csv = readr::read_csv(
      path,
      skip = start_row - 1L,
      n_max = n_max,
      show_col_types = FALSE,
      progress = FALSE,
      name_repair = "minimal"
    ),
    txt = {
      first_try <- tryCatch(
        readr::read_delim(
          path,
          delim = "\t",
          skip = start_row - 1L,
          n_max = n_max,
          show_col_types = FALSE,
          progress = FALSE,
          name_repair = "minimal"
        ),
        error = function(e) NULL
      )
      if (is.null(first_try) || ncol(first_try) < 2L) {
        first_try <- readr::read_delim(
          path,
          delim = ",",
          skip = start_row - 1L,
          n_max = n_max,
          show_col_types = FALSE,
          progress = FALSE,
          name_repair = "minimal"
        )
      }
      first_try
    },
    xls = readxl::read_excel(
      path,
      sheet = sheet %||% 1,
      skip = start_row - 1L,
      n_max = n_max,
      .name_repair = "minimal"
    ),
    xlsx = readxl::read_excel(
      path,
      sheet = sheet %||% 1,
      skip = start_row - 1L,
      n_max = n_max,
      .name_repair = "minimal"
    ),
    stop("Unsupported file type. Select a .csv, .txt, .xls, or .xlsx file.")
  )

  if (start_col > ncol(data)) {
    stop("Start column is beyond the last column in the imported table.")
  }

  data <- data[, seq.int(start_col, ncol(data)), drop = FALSE]
  names(data) <- make.unique(ifelse(nzchar(names(data)), names(data), "Unnamed"))
  tibble::as_tibble(data, .name_repair = "minimal")
}

checkerboard_preview_data <- function(path, filename, sheet = NULL, n_max = 500L) {
  extension <- tolower(tools::file_ext(filename))
  data <- switch(
    extension,
    csv = readr::read_csv(
      path,
      col_names = FALSE,
      n_max = n_max,
      show_col_types = FALSE,
      progress = FALSE,
      name_repair = "minimal"
    ),
    txt = {
      first_try <- tryCatch(
        readr::read_delim(
          path,
          delim = "\t",
          col_names = FALSE,
          n_max = n_max,
          show_col_types = FALSE,
          progress = FALSE,
          name_repair = "minimal"
        ),
        error = function(e) NULL
      )
      if (is.null(first_try) || ncol(first_try) < 2L) {
        first_try <- readr::read_delim(
          path,
          delim = ",",
          col_names = FALSE,
          n_max = n_max,
          show_col_types = FALSE,
          progress = FALSE,
          name_repair = "minimal"
        )
      }
      first_try
    },
    xls = readxl::read_excel(
      path,
      sheet = sheet %||% 1,
      col_names = FALSE,
      n_max = n_max,
      .name_repair = "minimal"
    ),
    xlsx = readxl::read_excel(
      path,
      sheet = sheet %||% 1,
      col_names = FALSE,
      n_max = n_max,
      .name_repair = "minimal"
    ),
    stop("Unsupported file type. Select a .csv, .txt, .xls, or .xlsx file.")
  )
  names(data) <- paste0("Column ", seq_len(ncol(data)))
  tibble::as_tibble(data, .name_repair = "minimal")
}

`%||%` <- function(x, y) if (is.null(x) || length(x) == 0L) y else x

checkerboard_default_role <- function(name, position) {
  normalized <- gsub("[^a-z0-9]", "", tolower(name))
  if (grepl("druga|drug1", normalized)) return("DrugA")
  if (grepl("drugb|drug2", normalized)) return("DrugB")
  if (grepl("drugc|drug3", normalized)) return("DrugC")
  if (grepl("relative|od|response|effect", normalized)) return("OD")
  fallback <- c("DrugA", "DrugB", "OD")
  if (position <= length(fallback)) fallback[[position]] else "Ignore"
}

checkerboard_drug_name <- function(name, fallback) {
  cleaned <- gsub("concentration|conc", "", name, ignore.case = TRUE)
  cleaned <- gsub("[[:space:]]+", "", cleaned)
  cleaned <- gsub("[^[:alnum:]_]+", "", cleaned)
  cleaned <- gsub("^_+|_+$", "", cleaned)
  if (nzchar(cleaned)) cleaned else fallback
}

checkerboard_color_input <- function(id, label, value) {
  shiny::textInput(id, label, value = value, width = "100%")
}

checkerboard_app_ui <- bslib::page_navbar(
  title = shiny::tagList(
    shiny::span(class = "app-mark", "CB"),
    "Checkerboard Bliss"
  ),
  theme = bslib::bs_theme(
    version = 5,
    bootswatch = "flatly",
    primary = "#235789",
    bg = "#f5f7fa",
    fg = "#17212b"
  ),
  header = shiny::tags$head(
    shiny::tags$style(shiny::HTML("
      html { font-size: 13px; }
      body, .form-control, .form-select, .btn { font-size: .9rem; }
      .navbar-brand { font-size: 1.05rem; }
      .nav-link, .control-label, label { font-size: .88rem; }
      .card-header { font-size: .95rem; padding-top:.55rem; padding-bottom:.55rem; }
      .card-body { padding:.8rem; }
      .dataTables_wrapper { font-size:.78rem; }
      .dataTables_wrapper .form-control, .dataTables_wrapper .form-select {
        font-size:.78rem; min-height:1.8rem; padding:.2rem .4rem;
      }
      .navbar { box-shadow: 0 2px 10px rgba(20, 40, 60, .12); }
      .app-mark { display:inline-grid; place-items:center; width:2rem; height:2rem;
        margin-right:.55rem; border-radius:.55rem; color:white; background:#e76f51;
        font-weight:800; font-size:.85rem; }
      .control-label { font-weight: 600; }
      .mapping-strip { display:flex; gap:.75rem; overflow-x:auto; padding:.25rem 0 1rem; }
      .mapping-table-wrap { overflow:auto; max-height:620px; border:1px solid #d9e1e8;
        border-radius:.65rem; background:white; }
      .mapping-data-table { margin:0; width:max-content; min-width:100%; }
      .mapping-data-table th, .mapping-data-table td { min-width:170px; max-width:260px;
        padding:.36rem .5rem; border-right:1px solid #e5eaee; font-size:.78rem;
        text-overflow:ellipsis; white-space:nowrap; }
      .mapping-data-table td { overflow:hidden; }
      .mapping-data-table th { overflow:visible; }
      .mapping-data-table thead { position:sticky; top:0; z-index:20; }
      .mapping-data-table thead tr:first-child th { position:relative; z-index:22;
        overflow:visible; background:#eaf1f7; padding:.55rem; }
      .mapping-data-table thead tr:nth-child(2) th { background:#235789; color:white; }
      .mapping-data-table .form-group { margin:0; }
      .mapping-data-table select { position:relative; z-index:25; min-width:150px;
        font-weight:600; color:#17212b; background-color:#fff; }
      .mapping-data-table tbody tr:nth-child(even) { background:#f7f9fb; }
      .mapping-data-table .row-number { min-width:58px; width:58px; text-align:right;
        color:#66727e; background:#f1f4f6; font-family:monospace; }
      .method-buttons .btn { margin:0 .4rem .4rem 0; min-width:9rem; }
      .status-note { color:#607080; margin:.25rem 0 0; }
      .shiny-output-error-validation { color:#a33; }
      .exit-app-button { position:fixed; top:.48rem; right:.8rem; z-index:2000;
        padding:.28rem .8rem; font-size:.82rem; border-color:rgba(255,255,255,.7);
        color:white; background:#9b2c2c; }
      .exit-app-button:hover, .exit-app-button:focus { color:white; background:#7f1d1d; }
    "))
  ) |> shiny::tagList(
    shiny::actionButton(
      "exit_app",
      "Exit",
      class = "btn exit-app-button",
      icon = shiny::icon("power-off")
    )
  ),
  bslib::nav_panel(
    "Import & map",
    bslib::layout_sidebar(
      sidebar = bslib::sidebar(
        width = 330,
        shiny::fileInput(
          "source_file",
          "Input file",
          accept = c(".csv", ".txt", ".xls", ".xlsx")
        ),
        shiny::uiOutput("sheet_ui"),
        bslib::layout_columns(
          col_widths = c(6, 6),
          shiny::numericInput("start_row", "Start row", value = 1, min = 1, step = 1),
          shiny::numericInput("start_col", "Start column", value = 1, min = 1, step = 1)
        ),
        shiny::numericInput(
          "n_rows",
          "Rows to read",
          value = 0,
          min = 0,
          step = 1
        ),
        shiny::helpText("Use 0 to read every remaining row. The start row is treated as the header row."),
        shiny::p(
          class = "status-note",
          "The preview and selected range update automatically."
        )
      ),
      bslib::card(
        full_screen = TRUE,
        bslib::card_header("Uploaded file preview"),
        shiny::p(
          class = "status-note",
          "Rows and columns are numbered here so you can identify the starting cell. Up to 500 rows are previewed."
        ),
        DT::DTOutput("file_preview")
      ),
      bslib::card(
        full_screen = TRUE,
        bslib::card_header("Selected range and column assignments"),
        shiny::p(
          class = "status-note",
          "Choose one role above each needed column. Drug C is optional; leave unrelated columns blank."
        ),
        shiny::uiOutput("mapping_ui"),
        shiny::uiOutput("mapping_status"),
        shiny::div(
          class = "method-buttons",
          shiny::actionButton("create_bliss", "Create Bliss object", class = "btn-success")
        )
      )
    )
  ),
  bslib::nav_panel(
    "Analyze",
    bslib::layout_sidebar(
      sidebar = bslib::sidebar(
        width = 310,
        shiny::uiOutput("analysis_controls"),
        shiny::hr(),
        shiny::h6("Plot colors"),
        checkerboard_color_input("color_low", "Antagonism", "#C62828"),
        checkerboard_color_input("color_mid", "Additive / midpoint", "#FFFFFF"),
        checkerboard_color_input("color_high", "Synergy", "#18864B"),
        checkerboard_color_input("color_expected", "Expected-growth line", "#6495ED"),
        shiny::helpText("Enter a CSS color name or hex value."),
        shiny::hr(),
        shiny::uiOutput("export_ui")
      ),
      bslib::navset_card_tab(
        id = "result_tabs",
        bslib::nav_panel("Summary", DT::DTOutput("summary_table")),
        bslib::nav_panel("Heatmap", shiny::plotOutput("heatmap_plot", height = "620px")),
        bslib::nav_panel(
          "Bar plot",
          shiny::uiOutput("bar_output_ui")
        ),
        bslib::nav_panel(
          "Processed data",
          DT::DTOutput("processed_table")
        )
      )
    )
  )
)

checkerboard_app_server <- function(input, output, session) {
  rv <- shiny::reactiveValues(
    raw = NULL,
    object = NULL,
    summary = NULL
  )

  shiny::observeEvent(input$exit_app, {
    shiny::stopApp()
  })

  output$sheet_ui <- shiny::renderUI({
    shiny::req(input$source_file)
    extension <- tolower(tools::file_ext(input$source_file$name))
    if (!extension %in% c("xls", "xlsx")) return(NULL)
    sheets <- tryCatch(
      readxl::excel_sheets(input$source_file$datapath),
      error = function(e) character()
    )
    shiny::selectInput("sheet", "Worksheet", choices = sheets)
  })

  file_preview <- shiny::reactive({
    shiny::req(input$source_file)
    checkerboard_preview_data(
      path = input$source_file$datapath,
      filename = input$source_file$name,
      sheet = input$sheet
    )
  })

  output$file_preview <- DT::renderDT({
    preview <- file_preview()
    DT::datatable(
      preview,
      rownames = TRUE,
      colnames = names(preview),
      options = list(
        scrollX = TRUE,
        pageLength = 12,
        lengthMenu = c(12, 25, 50, 100),
        columnDefs = list(list(className = "dt-center", targets = "_all"))
      )
    )
  })

  shiny::observeEvent(
    list(
      input$source_file,
      input$sheet,
      input$start_row,
      input$start_col,
      input$n_rows
    ),
    {
      shiny::req(input$source_file)
      result <- tryCatch(
      checkerboard_read_data(
        path = input$source_file$datapath,
        filename = input$source_file$name,
        sheet = input$sheet,
        start_row = input$start_row,
        start_col = input$start_col,
        n_rows = input$n_rows
      ),
        error = function(e) e
      )
      if (inherits(result, "error")) {
        rv$raw <- NULL
        shiny::showNotification(conditionMessage(result), type = "error")
        return()
      }
      rv$raw <- result
      rv$object <- NULL
      rv$summary <- NULL
    },
    ignoreInit = TRUE
  )

  output$mapping_ui <- shiny::renderUI({
    shiny::req(rv$raw)
    choices <- stats::setNames(
      c("Ignore", "DrugA", "DrugB", "DrugC", "OD"),
      c("", "Drug A", "Drug B", "Drug C", "OD")
    )
    assignment_headers <- lapply(seq_along(rv$raw), function(index) {
      shiny::tags$th(
        shiny::selectInput(
          paste0("role_", index),
          label = NULL,
          choices = choices,
          selected = checkerboard_default_role(names(rv$raw)[index], index),
          selectize = FALSE
        )
      )
    })
    name_headers <- lapply(
      names(rv$raw),
      function(name) shiny::tags$th(title = name, name)
    )
    displayed <- utils::head(rv$raw, 100L)
    body_rows <- lapply(seq_len(nrow(displayed)), function(row_index) {
      values <- lapply(displayed[row_index, , drop = FALSE], function(value) {
        text <- if (is.na(value[[1]])) "NA" else as.character(value[[1]])
        shiny::tags$td(title = text, text)
      })
      shiny::tags$tr(
        shiny::tags$td(class = "row-number", row_index),
        values
      )
    })
    shiny::div(
      class = "mapping-table-wrap",
      shiny::tags$table(
        class = "table mapping-data-table",
        shiny::tags$thead(
          shiny::tags$tr(
            shiny::tags$th(class = "row-number", "Assign"),
            assignment_headers
          ),
          shiny::tags$tr(
            shiny::tags$th(class = "row-number", "Row"),
            name_headers
          )
        ),
        shiny::tags$tbody(body_rows)
      )
    )
  })

  current_mapping <- shiny::reactive({
    shiny::req(rv$raw)
    roles <- vapply(
      seq_along(rv$raw),
      function(index) input[[paste0("role_", index)]] %||% "Ignore",
      character(1)
    )
    required <- c("DrugA", "DrugB", "OD")
    counts <- table(factor(roles, levels = c(required, "DrugC")))
    errors <- character()
    if (any(counts[required] != 1L)) {
      errors <- c(errors, "Assign DrugA, DrugB, and OD exactly once.")
    }
    if (counts[["DrugC"]] > 1L) {
      errors <- c(errors, "DrugC can be assigned to at most one column.")
    }
    list(roles = roles, valid = !length(errors), errors = errors)
  })

  output$mapping_status <- shiny::renderUI({
    shiny::req(rv$raw)
    mapping <- current_mapping()
    if (mapping$valid) {
      drugs <- c("DrugA", "DrugB", if ("DrugC" %in% mapping$roles) "DrugC")
      return(shiny::p(
        class = "status-note",
        paste("Ready:", paste(drugs, collapse = " + "), "with OD response.")
      ))
    }
    shiny::div(
      class = "alert alert-warning",
      lapply(mapping$errors, shiny::div)
    )
  })

  shiny::observeEvent(input$create_bliss, {
    shiny::req(rv$raw)
    mapping <- current_mapping()
    if (!mapping$valid) {
      shiny::showNotification(paste(mapping$errors, collapse = " "), type = "warning")
      return()
    }
    role_order <- c("DrugA", "DrugB", if ("DrugC" %in% mapping$roles) "DrugC", "OD")
    selected <- match(role_order, mapping$roles)
    mapped <- rv$raw[, selected, drop = FALSE]
    drug_roles <- role_order[role_order != "OD"]
    drug_names <- vapply(
      seq_along(drug_roles),
      function(index) {
        checkerboard_drug_name(
          names(rv$raw)[selected[[index]]],
          fallback = drug_roles[[index]]
        )
      },
      character(1)
    )
    drug_names <- make.unique(drug_names)
    names(mapped) <- c(
      paste0(drug_names, ".Concentration"),
      "RelativeOD"
    )
    numeric_mapped <- lapply(mapped, function(column) suppressWarnings(as.numeric(column)))
    invalid <- vapply(
      seq_along(mapped),
      function(index) any(is.na(numeric_mapped[[index]]) & !is.na(mapped[[index]])),
      logical(1)
    )
    if (any(invalid)) {
      shiny::showNotification(
        paste("Mapped columns must be numeric:", paste(names(mapped)[invalid], collapse = ", ")),
        type = "error",
        duration = NULL
      )
      return()
    }
    mapped[] <- numeric_mapped
    object <- tryCatch(bliss$new(mapped), error = function(e) e)
    if (inherits(object, "error")) {
      shiny::showNotification(conditionMessage(object), type = "error", duration = NULL)
      return()
    }
    rv$object <- object
    rv$summary <- NULL
    shiny::showNotification("Bliss object created successfully.", type = "message")
  })

  output$analysis_controls <- shiny::renderUI({
    if (is.null(rv$object)) {
      return(shiny::p(class = "status-note", "Import and map data to begin."))
    }
    if (length(rv$object$drugs) == 3L) {
      shiny::selectInput(
        "stratify",
        "Stratify / facet by",
        choices = rv$object$drugs,
        selected = rv$object$drugs[[3]]
      )
    } else {
      shiny::p(
        class = "status-note",
        paste("Combination:", paste(rv$object$drugs, collapse = " + "))
      )
    }
  })

  stratify_value <- shiny::reactive({
    shiny::req(rv$object)
    if (length(rv$object$drugs) == 3L) input$stratify %||% rv$object$drugs[[3]] else NULL
  })

  analysis_summary <- shiny::reactive({
    shiny::req(rv$object)
    result <- tryCatch(
      rv$object$summary(stratify = stratify_value()),
      error = function(e) e
    )
    if (inherits(result, "error")) {
      shiny::validate(shiny::need(FALSE, conditionMessage(result)))
    }
    result
  })

  output$export_ui <- shiny::renderUI({
    if (is.null(rv$object)) return(NULL)
    shiny::tagList(
      shiny::downloadButton(
        "export_results",
        "Export results (.xlsx)",
        class = "btn-primary w-100"
      ),
      shiny::p(
        class = "status-note",
        sprintf(
          "%s processed combinations across %s drugs.",
          nrow(rv$object$data),
          length(rv$object$drugs)
        )
      )
    )
  })

  output$export_results <- shiny::downloadHandler(
    filename = function() {
      shiny::req(rv$object)
      paste0(
        "Checkerboard_",
        paste(rv$object$drugs, collapse = "_"),
        "_",
        Sys.Date(),
        ".xlsx"
      )
    },
    content = function(file) {
      shiny::req(rv$object)
      export(
        rv$object,
        stratify = stratify_value(),
        file = file
      )
    }
  )

  output$summary_table <- DT::renderDT({
    summary <- analysis_summary()
    DT::datatable(
      summary,
      rownames = FALSE,
      options = list(dom = "t", ordering = FALSE)
    ) |>
      DT::formatRound("sum_bliss", digits = 3)
  })

  output$heatmap_plot <- shiny::renderPlot({
    shiny::req(rv$object)
    plot <- rv$object$heatmap(
      stratify = stratify_value(),
      print = FALSE,
      low_color = input$color_low,
      mid_color = input$color_mid,
      high_color = input$color_high
    ) +
      ggplot2::theme(
        text = ggplot2::element_text(size = 8),
        plot.title = ggplot2::element_text(size = 10),
        plot.subtitle = ggplot2::element_text(size = 8),
        axis.title = ggplot2::element_text(size = 8),
        axis.text = ggplot2::element_text(size = 7),
        legend.text = ggplot2::element_text(size = 7),
        legend.title = ggplot2::element_text(size = 8)
      )
    print(plot)
  })

  output$bar_output_ui <- shiny::renderUI({
    shiny::req(rv$object)
    if (length(rv$object$drugs) == 2L) {
      plotly::plotlyOutput("bar_plotly", height = "650px")
    } else {
      shiny::plotOutput("bar_plot", height = "620px")
    }
  })

  output$bar_plotly <- plotly::renderPlotly({
    shiny::req(rv$object, length(rv$object$drugs) == 2L)
    plot <- rv$object$bar(
      print = FALSE,
      low_color = input$color_low,
      mid_color = input$color_mid,
      high_color = input$color_high,
      expected_color = input$color_expected,
      axis_title_size = 11,
      axis_tick_size = 9,
      legend_title_size = 10,
      legend_tick_size = 8
    )
    plotly::layout(
      plot,
      font = list(size = 9)
    )
  })

  output$bar_plot <- shiny::renderPlot({
    shiny::req(rv$object, length(rv$object$drugs) == 3L)
    plot <- rv$object$bar(
      stratify = stratify_value(),
      print = FALSE,
      low_color = input$color_low,
      mid_color = input$color_mid,
      high_color = input$color_high,
      expected_color = input$color_expected
    ) +
      ggplot2::theme(
        text = ggplot2::element_text(size = 8),
        plot.title = ggplot2::element_text(size = 10),
        axis.title = ggplot2::element_text(size = 8),
        axis.text = ggplot2::element_text(size = 7)
      )
    print(plot)
  })

  output$processed_table <- DT::renderDT({
    shiny::req(rv$object)
    DT::datatable(
      rv$object$data,
      rownames = FALSE,
      filter = "top",
      options = list(scrollX = TRUE, pageLength = 12)
    )
  })
}
