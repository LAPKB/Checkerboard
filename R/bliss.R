#' Bliss Independence R6 Class
#'
#' An R6 class for analyzing drug combination data using the Bliss independence model. Provides methods for data import, summary statistics, and visualization (heatmap, bar plot) of Bliss interactions.
#'
#' @section Methods:
#' - initialize(file): Import and process data from a data frame or a `.xlsx`/`.csv` file.
#' - summary(stratify = NULL): Summarize Bliss interaction results, optionally stratified by a drug.
#' - heatmap(stratify = NULL): Plot a heatmap of Bliss interaction values. For 2 drugs, shows a single heatmap. For 3 drugs, facets by the third drug (or specified stratify argument).
#' - bar(stratify = NULL): For 2 drugs, creates a 3D interactive bar plot. For 3 drugs, creates a summary bar plot stratified by one drug.
#'
#' @export
##' @keywords Bliss, synergy, drug, R6, interaction
bliss <- R6::R6Class(
  "bliss",
  public = list(
    ##' @field data A tibble containing the processed drug combination data with Bliss calculations.
    data = NULL,
    ##' @field drugs A character vector of drug names extracted from the data.
    drugs = NULL,
    ##' @description
    ##' Create a new bliss object and import data from a data frame or a `.xlsx`/`.csv` file.
    ##' @param file A data frame, or a path to a `.xlsx` or `.csv` file containing drug combination data.
    #' The structure of the file should be as follows:
    #' - Columns for drug concentrations (e.g., "DrugA Concentration", "DrugB Concentration", "DrugC Concentration" for 3 drugs). 
    #' The order of drug columns does not matter, but they must be named with "Concentration" in the header.
    #' - A column for the observed response (e.g., "OD" or "Relative OD"). The header must contain "OD" or "Relative".
    #' - The file can contain multiple rows for the same drug combination (replicates), which will be averaged during processing.
    #' - The file can contain additional columns (e.g., "Organism") which will be ignored during processing.
    #' 
    #' Example file structure:
    #'
    #' | DrugA.Concentration | DrugB.Concentration | DrugC.Concentration | Relative OD | Organism |
    #' |---|---|---|---|---|
    #' | 0 | 0 | 0 | 1.0 | E. coli |
    #' | 0.1 | 0 | 0 | 0.8 | E. coli |
    #' | 0 | 0.1 | 0 | 0.85 | E. coli |
    #' | 0.1 | 0.1 | 0 | 0.6 | E. coli |
    #' | 0.1 | 0.1 | 0.1 | 0.4 | E. coli |
    #' | ... | ... | ... | ... | ... |
    #' 
    ##' @return A new bliss object with data loaded and processed.
    initialize = function(file) {
      # Internal calc_bliss implementation
      calc_bliss <- function(file) {
        if (inherits(file, "data.frame")) {
          dat <- file
        } else if (is.character(file) && length(file) == 1) {
          file_ext <- tools::file_ext(file) |> tolower()

          dat <- dplyr::case_when(
            file_ext == "xlsx" ~ list(openxlsx::read.xlsx(file)),
            file_ext == "csv" ~ list(readr::read_csv(file, show_col_types = FALSE, progress = FALSE)),
            .default = list(NULL)
          )[[1]]

          if (is.null(dat)) {
            stop("Unsupported file extension: .", file_ext, ". Please provide a .xlsx or .csv file.")
          }
        } else {
          stop("Input must be either a data frame or a single file path to a .xlsx or .csv file.")
        }

        dat <- dat |>
          dplyr::select(dplyr::matches(c("Concentration", "Relative")))  # Remove organism column
        
        # Get number of drugs (all columns except last OD column)
        n_drugs <- ncol(dat) - 1
        if (!n_drugs %in% c(2, 3)) {
          stop("Expected 2 or 3 drug columns, found ", n_drugs)
        }
        
        # Clean column names: strip "Concentration" if present
        names(dat) <- names(dat) |> 
          stringr::str_remove_all("\\.(?i)concentration") |> 
          stringr::str_trim() |> 
          stringr::str_remove("^_|_$")  # Remove leading/trailing underscores
        
        # Rename last column to "od"
        names(dat)[ncol(dat)] <- "od"
        drug_names <- names(dat)[1:n_drugs]
        

        # Normalize OD to control (all drugs = 0)
        control_filter <- purrr::map(drug_names, ~ rlang::expr(!!rlang::sym(.x) == 0)) |> 
          purrr::reduce(~ rlang::expr(!!.x & !!.y))
        
        control_od <- dat |> 
          dplyr::filter(!!control_filter) |> 
          dplyr::pull(od) |> 
          mean()
        
        dat <- dat |> 
          dplyr::mutate(
            effect = 1 - od / control_od,
            effect = pmax(0, pmin(1, effect)),
            effect = dplyr::if_else(
              dplyr::if_all(dplyr::all_of(drug_names), ~ .x == 0),
              0,
              effect
            )
          )
        
        # Average replicates
        dat_avg <- dat |> 
          dplyr::summarize(effect = mean(effect), .by = dplyr::all_of(drug_names))
        
        # Calculate individual drug effects (other drugs = 0)
        effect_single <- purrr::map(drug_names, function(drug) {
          other_drugs <- setdiff(drug_names, drug)
          filter_expr <- purrr::map(other_drugs, ~ rlang::expr(!!rlang::sym(.x) == 0)) |> 
            purrr::reduce(~ rlang::expr(!!.x & !!.y))
          
          dat_avg |> 
            dplyr::filter(!!filter_expr) |> 
            dplyr::select(dplyr::all_of(drug), effect) |> 
            dplyr::rename(!!paste0("effect_", drug) := effect)
        })
        
        # Join individual effects
        bliss_dat <- dat_avg
        for (i in seq_along(drug_names)) {
          bliss_dat <- bliss_dat |> 
            dplyr::left_join(effect_single[[i]], by = drug_names[i])
        }
        
        # Calculate Bliss expected and interaction
        effect_cols <- paste0("effect_", drug_names)
        
        bliss_dat <- bliss_dat |> 
          dplyr::mutate(
            # Bliss expected: 1 - product of (1 - E_i) for all drugs
            bliss_expected = 1 - purrr::reduce(dplyr::across(dplyr::all_of(effect_cols)), ~ .x * (1 - .y), .init = 1),
            bliss_interaction = effect - bliss_expected
          )
        
        # Fix Bliss expected calculation using correct formula
        # For n drugs: E_expected = 1 - (1-E1)(1-E2)...(1-En)
        bliss_dat <- bliss_dat |> 
          dplyr::rowwise() |> 
          dplyr::mutate(
            bliss_expected = 1 - prod(1 - dplyr::c_across(dplyr::all_of(effect_cols))),
            bliss_interaction = effect - bliss_expected
          ) |> 
          dplyr::ungroup()
        
        bliss_dat
      }
      self$data <- calc_bliss(file)
      self$drugs <- names(self$data) |> purrr::discard(~ stringr::str_detect(., stringr::regex("effect|bliss", ignore_case = TRUE)))
    },
    ##' @description
    ##' Summarize Bliss interaction results, optionally stratified by a drug.
    ##' @param stratify (Optional) Name of drug to stratify summary by (for 3-drug data).
    ##' @return A tibble with Bliss interaction summary and interpretation.
    summary = function(stratify = NULL) {
      # Internal summarize_bliss_by_drug implementation
      summarize_bliss_by_drug <- function(bliss_dat, stratify = NULL) {
        drug_names <- names(bliss_dat) |> purrr::discard(~ stringr::str_detect(., stringr::regex("effect|bliss", ignore_case = TRUE)))
        if (length(drug_names) == 2) {
          # No stratification, just total sum (no total row)
          sum_bliss <- sum(bliss_dat$bliss_interaction, na.rm = TRUE)
          interpretation <- dplyr::case_when(
            sum_bliss > 1 ~ "Synergistic",
            sum_bliss < 0 ~ "Antagonistic",
            TRUE ~ "Additive"
          )
          summary_df <- tibble::tibble(
            sum_bliss = sum_bliss,
            interpretation = interpretation
          )
          title <- paste0("Bliss Interaction Summary ", drug_names[1], " + ", drug_names[2])
          ft <- summary_df |>
            flextable::flextable() |>
            flextable::set_header_labels(
              sum_bliss = "Sum Bliss",
              interpretation = "Interpretation"
            ) |>
            flextable::colformat_double(j = c("sum_bliss"), digits = 3) |>
            flextable::set_caption(title) |>
            flextable::theme_vanilla() |>
            flextable::autofit()
          print(ft)
          return(summary_df)
        } else {
          # Stratify by specified drug
          if (is.null(stratify) || !stratify %in% drug_names) {
            stop("Please specify a valid drug for stratification.")
          }
          other_drugs <- setdiff(drug_names, stratify)
          title_drugs <- paste(other_drugs, collapse = " + ")
          title <- paste0("Bliss Interaction Summary\n", title_drugs, ", stratified by ", stratify)
          summary_df <- bliss_dat |>
            dplyr::group_by(.data[[stratify]]) |>
            dplyr::summarize(
              sum_bliss = sum(bliss_interaction, na.rm = TRUE),
              .groups = "drop"
            ) |>
            dplyr::mutate(
              interpretation = dplyr::case_when(
                sum_bliss > 1 ~ "Synergistic",
                sum_bliss < 0 ~ "Antagonistic",
                TRUE ~ "Additive"
              )
            )
          # Add total row only for stratified (3-drug) case
          total_sum <- sum(summary_df$sum_bliss, na.rm = TRUE)
          total_interp <- dplyr::case_when(
            total_sum > 1 ~ "Synergistic",
            total_sum < 0 ~ "Antagonistic",
            TRUE ~ "Additive"
          )
          summary_df[[stratify]] <- as.character(summary_df[[stratify]])
          total_row <- tibble::tibble(
            !!stratify := "Total",
            sum_bliss = total_sum,
            interpretation = total_interp
          )
          summary_df_total <- dplyr::bind_rows(summary_df, total_row)
          ft <- summary_df_total |>
            flextable::flextable() |>
            flextable::set_header_labels(
              sum_bliss = "Sum Bliss",
              interpretation = "Interpretation"
            ) |>
            flextable::colformat_double(j = c("sum_bliss"), digits = 3) |>
            flextable::set_caption(title) |>
            flextable::theme_vanilla() |>
            flextable::autofit()
          print(ft)
          return(summary_df_total)
        }
      }
      summarize_bliss_by_drug(self$data, stratify)
    },
    ##' @description
    ##' Plot a heatmap of Bliss interaction values. For 2 drugs, shows a single heatmap. For 3 drugs, facets by the third drug (or specified stratify argument).
    ##' @param stratify (Optional) Name of drug to facet by (for 3-drug data).
    ##' @param print (Optional) Whether to print the plot immediately. Default TRUE.
    ##' @param low_color Color used for antagonistic interactions.
    ##' @param mid_color Color used for additive interactions at zero.
    ##' @param high_color Color used for synergistic interactions.
    ##' @return Invisibly returns the ggplot object (2 drugs) or prints the plot (3 drugs).
    heatmap = function(
      stratify = NULL,
      print = TRUE,
      low_color = "red",
      mid_color = "white",
      high_color = "green"
    ) {
      if (length(self$drugs) == 2) {
        plot_data <- self$data |>
          dplyr::mutate(
            bliss_interaction = dplyr::if_else(
              dplyr::if_all(dplyr::all_of(self$drugs), ~ abs(.x) < 1e-12),
              0,
              bliss_interaction
            )
          )

        # 2-drug heatmap (stratify argument ignored)
        p_ggplot <- ggplot2::ggplot(plot_data, ggplot2::aes(
          x = factor(.data[[self$drugs[2]]]),
          y = factor(.data[[self$drugs[1]]]),
          fill = bliss_interaction
        )) +
          ggplot2::geom_tile(color = "grey50", linewidth = 0.5) +
          ggplot2::scale_fill_gradient2(
            low = low_color, mid = mid_color, high = high_color, midpoint = 0,
            name = "Bliss\nInteraction",
            limits = c(-max(abs(self$data$bliss_interaction), na.rm = TRUE), max(abs(self$data$bliss_interaction), na.rm = TRUE))
          ) +
          ggplot2::labs(
            title = paste("Bliss Interaction Surface:", paste(self$drugs, collapse = " + ")),
            x = paste(self$drugs[2], "Concentration"),
            y = paste(self$drugs[1], "Concentration")
          ) +
          ggplot2::coord_fixed() +
          ggplot2::theme_minimal() +
          ggplot2::theme(axis.text.x = ggplot2::element_text(angle = 45, hjust = 1))
        if (print) print(p_ggplot)
        return(invisible(p_ggplot))
      } else if (length(self$drugs) == 3) {
        plot_data <- self$data |>
          dplyr::mutate(
            bliss_interaction = dplyr::if_else(
              dplyr::if_all(dplyr::all_of(self$drugs), ~ abs(.x) < 1e-12),
              0,
              bliss_interaction
            )
          )

        # 3-drug faceted heatmap, stratified by 'stratify' argument
        drug_names <- self$drugs
        if (is.null(stratify) || !stratify %in% drug_names) {
          stratify <- drug_names[3]  # default to 3rd drug
        }
        other_drugs <- setdiff(drug_names, stratify)
        max_abs <- max(abs(plot_data$bliss_interaction), na.rm = TRUE)
        p_ggplot_3d <- ggplot2::ggplot(plot_data, ggplot2::aes(
          x = factor(.data[[other_drugs[2]]]),
          y = factor(.data[[other_drugs[1]]]),
          fill = bliss_interaction
        )) +
          ggplot2::geom_tile(color = "grey50", linewidth = 0.3) +
          ggplot2::scale_fill_gradient2(
            low = low_color, mid = mid_color, high = high_color, midpoint = 0,
            name = "Bliss\nInteraction",
            limits = c(-max_abs, max_abs)
          ) +
          ggplot2::facet_wrap(stats::as.formula(paste("~", stratify)),
                     labeller = ggplot2::labeller(.default = function(x) paste(stratify, "=", signif(as.numeric(x), 3)))) +
          ggplot2::labs(
            title = paste("Bliss Interaction:", paste(self$drugs, collapse = " + ")),
            subtitle = paste("Faceted by", stratify, "concentration"),
            x = paste(other_drugs[2], "Concentration"),
            y = paste(other_drugs[1], "Concentration")
          ) +
          ggplot2::theme_minimal() +
          ggplot2::theme(
            axis.text.x = ggplot2::element_text(angle = 45, hjust = 1, size = 7),
            axis.text.y = ggplot2::element_text(size = 7),
            strip.text = ggplot2::element_text(size = 9, face = "bold"),
            panel.spacing = grid::unit(0.5, "lines")
          )
        if (print) print(p_ggplot_3d)
        return(invisible(p_ggplot_3d))
        
      } else {
        stop("Heatmap only implemented for 2 or 3 drugs.")
      }
    },
    ##' @description
    ##' Create a bar plot of Bliss interaction. For 2 drugs, creates a 3D interactive plotly bar plot. For 3 drugs, creates a summary bar plot stratified by one drug.
    ##' @param stratify (Optional) Name of drug to stratify by (for 3-drug data).
    #' @param print (Optional) Whether to print the plot immediately. Default TRUE.
    ##' @param x_label (Optional) Custom x-axis label. Defaults to the second drug name.
    ##' @param y_label (Optional) Custom y-axis label. Defaults to the first drug name (2-drug) or "Sum Bliss" (3-drug).
    ##' @param snapshot_file (Optional) File path to save a static high-resolution image of the 2-drug plotly bar plot (e.g., .png, .pdf, .svg).
    ##' @param snapshot_width (Optional) Snapshot width in pixels. Default 2400.
    ##' @param snapshot_height (Optional) Snapshot height in pixels. Default 1800.
    ##' @param snapshot_scale (Optional) Snapshot scale multiplier for higher resolution. Default 2.
    ##' @param camera_eye (Optional) 3D camera eye position controlling rotation/view for 2-drug plotly bar plots. Accepts either a named list (e.g., list(x = 1.5, y = 1.5, z = 1.2)) or numeric vector (e.g., c(1.5, 1.5, 1.2)). The values define the camera location relative to the plot center: x controls left-right viewpoint (positive x views more from the +x side, negative x from the opposite side); y controls front-back viewpoint (positive y views more from the +y side, negative y from the opposite side); z controls vertical elevation (larger z looks more from above, smaller z flattens toward a side-on view). Increasing the overall magnitude (distance from the origin) zooms out, decreasing it zooms in. Useful presets: isometric = c(1.5, 1.5, 1.2), front-ish = c(0.2, 2.2, 0.9), side-ish = c(2.2, 0.2, 0.9), top-down = c(0.01, 0.01, 3.0).
    ##' @param axis_title_size (Optional) Axis title font size for 2-drug plotly bar plots. Default 14.
    ##' @param axis_tick_size (Optional) Axis tick font size for 2-drug plotly bar plots. Default 12.
    ##' @param legend_title_size (Optional) Legend title font size for 2-drug plotly bar plots. Default 14.
    ##' @param legend_tick_size (Optional) Legend tick font size for 2-drug plotly bar plots. Default 11.
    ##' @param legend_thickness (Optional) Legend colorbar thickness (pixels) for 2-drug plotly bar plots. Default 20.
    ##' @param legend_length (Optional) Legend colorbar relative length (0-1) for 2-drug plotly bar plots. Default 0.6.
    ##' @param low_color Color used for antagonistic interactions.
    ##' @param mid_color Color used for additive interactions.
    ##' @param high_color Color used for synergistic interactions.
    ##' @param expected_color Color used for the expected-growth wireframe in the 2-drug plot.
    ##' @return A plotly object (2 drugs) or ggplot object (3 drugs).
    bar = function(
      stratify = NULL,
      print = TRUE,
      x_label = NULL,
      y_label = NULL,
      snapshot_file = NULL,
      snapshot_width = 2400,
      snapshot_height = 1800,
      snapshot_scale = 2,
      camera_eye = list(x = 1.5, y = 1.5, z = 1.2),
      axis_title_size = 14,
      axis_tick_size = 12,
      legend_title_size = 14,
      legend_tick_size = 11,
      legend_thickness = 20,
      legend_length = 0.6,
      low_color = "red",
      mid_color = "white",
      high_color = "green",
      expected_color = "cornflowerblue"
    ) {
      if (length(self$drugs) == 3) {
        # 3-drug summary bar plot
        summary_tbl <- self$summary(stratify = stratify)
        strat_col <- setdiff(names(summary_tbl), c("sum_bliss", "interpretation"))
        summary_tbl[[strat_col]] <- as.character(summary_tbl[[strat_col]])
        # Ensure "Total" is the last row
        summary_tbl[[strat_col]][nrow(summary_tbl)] <- "Total"
        # Set factor order so Total is last
        summary_tbl[[strat_col]] <- factor(summary_tbl[[strat_col]], levels = summary_tbl[[strat_col]])
        # Color mapping
        bar_colors <- dplyr::case_when(
          summary_tbl$sum_bliss < 0 ~ low_color,
          summary_tbl$sum_bliss > 1 ~ high_color,
          TRUE ~ mid_color
        )
        # Plot
        x_axis_label <- if (is.null(x_label)) strat_col else x_label
        y_axis_label <- if (is.null(y_label)) "Sum Bliss" else y_label

        p <- ggplot2::ggplot(summary_tbl, ggplot2::aes(x = .data[[strat_col]], y = sum_bliss)) +
          ggplot2::geom_col(fill = bar_colors, color = "grey50") +
          ggplot2::geom_text(
            ggplot2::aes(
              label = round(sum_bliss, 2),
              vjust = ifelse(sum_bliss >= 0, -0.5, 1.5)
            ),
            size = 3
          ) +
          ggplot2::labs(
            x = x_axis_label,
            y = y_axis_label,
            title = paste0("Bliss Interaction Summary\n", paste(setdiff(self$drugs, strat_col), collapse = " + "), ", stratified by ", strat_col)
          ) +
          ggplot2::theme_minimal()
        if (print) print(p)
        return(invisible(p))
      }
      if (length(self$drugs) != 2) stop("Bar plot only implemented for 2 or 3 drugs.")
      bliss_matrix <- self$data |> 
        dplyr::select(dplyr::all_of(self$drugs), bliss_interaction) |> 
        tidyr::pivot_wider(names_from = dplyr::all_of(self$drugs[2]), values_from = bliss_interaction) |> 
        tibble::column_to_rownames(self$drugs[1]) |> 
        as.matrix()
      effect_matrix <- self$data |> 
        dplyr::select(dplyr::all_of(self$drugs), effect) |> 
        tidyr::pivot_wider(names_from = dplyr::all_of(self$drugs[2]), values_from = effect) |> 
        tibble::column_to_rownames(self$drugs[1]) |> 
        as.matrix()
      drug1_vals <- as.numeric(rownames(bliss_matrix))
      drug2_vals <- as.numeric(colnames(bliss_matrix))
      n_row <- nrow(effect_matrix)
      n_col <- ncol(effect_matrix)
      max_z <- max(abs(bliss_matrix), na.rm = TRUE)
      legend_bound <- max(max_z, 0.05)
      expected_rgb <- tryCatch(
        grDevices::col2rgb(expected_color, alpha = TRUE),
        error = function(e) NULL
      )
      if (!is.null(expected_rgb)) {
        expected_color <- sprintf(
          "rgba(%d,%d,%d,%.3f)",
          expected_rgb[["red", 1]],
          expected_rgb[["green", 1]],
          expected_rgb[["blue", 1]],
          expected_rgb[["alpha", 1]] / 255
        )
      }
      bliss_to_color <- function(bliss_val, max_abs) {
        if (bliss_val >= -0.05 && bliss_val <= 0.05) {
          return(mid_color)
        }
        denominator <- max(max_abs - 0.05, .Machine$double.eps)
        if (bliss_val < -0.05) {
          intensity <- (abs(bliss_val) - 0.05) / denominator
          palette <- grDevices::colorRamp(c(mid_color, low_color))
        } else {
          intensity <- (bliss_val - 0.05) / denominator
          palette <- grDevices::colorRamp(c(mid_color, high_color))
        }
        intensity <- pmin(1, pmax(0, intensity))
        rgb <- palette(intensity)
        sprintf("rgb(%d,%d,%d)", round(rgb[[1]]), round(rgb[[2]]), round(rgb[[3]]))
      }
      # 3D Bar Plot
      bar_traces <- list()
      expected_wire_x <- c()
      expected_wire_y <- c()
      expected_wire_z <- c()
      
      for (i in 1:n_row) {
        for (j in 1:n_col) {
          bliss_val <- bliss_matrix[i, j]
          effect_val <- effect_matrix[i, j]

          is_control_point <- abs(drug1_vals[i]) < 1e-12 && abs(drug2_vals[j]) < 1e-12

          growth_val <- (1 - effect_val) * 100
          if (is_control_point) growth_val <- 100

          bliss_expected <- effect_val - bliss_val
          expected_growth <- (1 - bliss_expected) * 100
          if (is_control_point) expected_growth <- 100
          expected_growth <- pmax(0, pmin(100, expected_growth))

          bar_color <- bliss_to_color(bliss_val, max_z)

          # Bar dimensions (centered at each concentration point with small gap)
          x_min <- j - 0.35
          x_max <- j + 0.35
          y_min <- i - 0.35
          y_max <- i + 0.35
          z_min <- 0
          z_max <- growth_val
          
          # 8 vertices of the rectangular prism
          bar_x <- c(x_min, x_max, x_max, x_min, x_min, x_max, x_max, x_min)
          bar_y <- c(y_min, y_min, y_max, y_max, y_min, y_min, y_max, y_max)
          bar_z <- c(z_min, z_min, z_min, z_min, z_max, z_max, z_max, z_max)
          
          # 12 triangular faces (2 per rectangular face, 6 faces)
          bar_i <- c(0, 0, 4, 4, 0, 0, 2, 2, 0, 0, 1, 1)
          bar_j <- c(1, 2, 6, 7, 1, 5, 3, 7, 3, 7, 2, 6)
          bar_k <- c(2, 3, 5, 6, 5, 4, 7, 6, 7, 4, 6, 5)
          
          bar_traces[[length(bar_traces) + 1]] <- list(
            type = "mesh3d",
            x = bar_x,
            y = bar_y,
            z = bar_z,
            i = bar_i,
            j = bar_j,
            k = bar_k,
            facecolor = rep(bar_color, 12),
            flatshading = TRUE,
            lighting = list(ambient = 0.8, diffuse = 0.5, specular = 0.2),
            showscale = FALSE,
            hoverinfo = "none"
          )
          
          # Add dark grey outline edges for this bar
          edge_x <- c(x_min, x_max, x_max, x_min, x_min, NA,
                      x_min, x_max, x_max, x_min, x_min, NA,
                      x_min, x_min, NA, x_max, x_max, NA,
                      x_max, x_max, NA, x_min, x_min, NA)
          edge_y <- c(y_min, y_min, y_max, y_max, y_min, NA,
                      y_min, y_min, y_max, y_max, y_min, NA,
                      y_min, y_min, NA, y_min, y_min, NA,
                      y_max, y_max, NA, y_max, y_max, NA)
          edge_z <- c(z_min, z_min, z_min, z_min, z_min, NA,
                      z_max, z_max, z_max, z_max, z_max, NA,
                      z_min, z_max, NA, z_min, z_max, NA,
                      z_min, z_max, NA, z_min, z_max, NA)
          
          bar_traces[[length(bar_traces) + 1]] <- list(
            type = "scatter3d",
            mode = "lines",
            x = edge_x,
            y = edge_y,
            z = edge_z,
            line = list(color = "rgb(80,80,80)", width = 2),
            showlegend = FALSE,
            hoverinfo = "none"
          )
          
          # Add wireframe rectangle at expected growth height
          expected_wire_x <- c(expected_wire_x, x_min, x_max, NA, x_max, x_max, NA, x_max, x_min, NA, x_min, x_min, NA)
          expected_wire_y <- c(expected_wire_y, y_min, y_min, NA, y_min, y_max, NA, y_max, y_max, NA, y_max, y_min, NA)
          expected_wire_z <- c(expected_wire_z, rep(expected_growth, 2), NA, rep(expected_growth, 2), NA, 
                              rep(expected_growth, 2), NA, rep(expected_growth, 2), NA)
        }
      }
      
      # Create hover markers at top of each bar
      bar_hover_x <- numeric(0)
      bar_hover_y <- numeric(0)
      bar_hover_z <- numeric(0)
      bar_hover_text <- character(0)
      bar_hover_colors <- character(0)
      
      for (i in 1:n_row) {
        for (j in 1:n_col) {
          bliss_val <- bliss_matrix[i, j]
          effect_val <- effect_matrix[i, j]

          is_control_point <- abs(drug1_vals[i]) < 1e-12 && abs(drug2_vals[j]) < 1e-12

          growth_val <- (1 - effect_val) * 100
          if (is_control_point) growth_val <- 100

          bliss_expected <- effect_val - bliss_val
          expected_growth <- (1 - bliss_expected) * 100
          if (is_control_point) expected_growth <- 100

          bar_hover_x <- c(bar_hover_x, j)
          bar_hover_y <- c(bar_hover_y, i)
          bar_hover_z <- c(bar_hover_z, growth_val + 2)
          bar_hover_text <- c(bar_hover_text, paste0(
            self$drugs[2], ": ", signif(drug2_vals[j], 3), "<br>",
            self$drugs[1], ": ", signif(drug1_vals[i], 3), "<br>",
            "Growth: ", round(growth_val, 1), "%<br>",
            "Expected: ", round(expected_growth, 1), "%<br>",
            "Bliss: ", round(bliss_val, 3)
          ))
          bar_hover_colors <- c(bar_hover_colors, bliss_to_color(bliss_val, max_z))
        }
      }
      
      # Build the bar plot
      p_barplot <- plotly::plot_ly()

      # Add all bar traces (mesh3d for bars, scatter3d for edges)
      for (trace in bar_traces) {
        if (trace$type == "mesh3d") {
          p_barplot <- p_barplot |> plotly::add_trace(
            type = trace$type,
            x = trace$x,
            y = trace$y,
            z = trace$z,
            i = trace$i,
            j = trace$j,
            k = trace$k,
            facecolor = trace$facecolor,
            flatshading = trace$flatshading,
            lighting = trace$lighting,
            showscale = trace$showscale,
            hoverinfo = trace$hoverinfo
          )
        } else {
          p_barplot <- p_barplot |> plotly::add_trace(
            type = trace$type,
            mode = trace$mode,
            x = trace$x,
            y = trace$y,
            z = trace$z,
            line = trace$line,
            showlegend = trace$showlegend,
            hoverinfo = trace$hoverinfo
          )
        }
      }

      # Add expected growth wireframes (medium blue lines)
      p_barplot <- p_barplot |>
        plotly::add_trace(
          type = "scatter3d",
          x = expected_wire_x,
          y = expected_wire_y,
          z = expected_wire_z,
          mode = "lines",
          line = list(color = expected_color, width = 3),
          showlegend = FALSE,
          hoverinfo = "none"
        )

      # Add hover markers
      if (length(bar_hover_x) > 0) {
        p_barplot <- p_barplot |>
          plotly::add_trace(
            type = "scatter3d",
            x = bar_hover_x,
            y = bar_hover_y,
            z = bar_hover_z,
            mode = "markers",
            marker = list(size = 15, color = "rgba(0,0,0,0.01)"),
            text = bar_hover_text,
            hoverinfo = "text",
            hoverlabel = list(
              bgcolor = bar_hover_colors,
              font = list(color = "black"),
              bordercolor = "rgb(80,80,80)"
            ),
            showlegend = FALSE
          )
      }

      # Add colorbar legend
      p_barplot <- p_barplot |>
        plotly::add_trace(
          type = "scatter3d",
          x = c(1, 1),
          y = c(1, 1),
          z = c(0, 0),
          mode = "markers",
          marker = list(
            size = 0.01,
            opacity = 0,
            color = c(-legend_bound, legend_bound),
            colorscale = list(
              list(0, low_color),
              list((legend_bound - 0.05) / (2 * legend_bound), mid_color),
              list((legend_bound + 0.05) / (2 * legend_bound), mid_color),
              list(1, high_color)
            ),
            cmin = -legend_bound,
            cmax = legend_bound,
            colorbar = list(
              title = list(text = "Bliss<br>Interaction", font = list(size = legend_title_size)),
              tickvals = c(-legend_bound, 0, legend_bound),
              ticktext = c("Antagonism", "Additive<br>(-0.05 to 0.05)", "Synergy"),
              tickfont = list(size = legend_tick_size),
              len = legend_length,
              thickness = legend_thickness,
              x = 1.02
            ),
            showscale = TRUE
          ),
          hoverinfo = "none",
          showlegend = FALSE
        )

      x_axis_label <- if (is.null(x_label)) self$drugs[2] else x_label
      y_axis_label <- if (is.null(y_label)) self$drugs[1] else y_label
      camera_eye_list <- camera_eye

      if (is.numeric(camera_eye) && length(camera_eye) == 3) {
        camera_eye_list <- list(x = camera_eye[[1]], y = camera_eye[[2]], z = camera_eye[[3]])
      }

      if (
        !is.list(camera_eye_list) ||
          !all(c("x", "y", "z") %in% names(camera_eye_list))
      ) {
        stop("camera_eye must be a named list with x, y, z or a numeric vector of length 3.")
      }

      # Add layout (axes, title, etc.)
      p_barplot <- p_barplot |>
        plotly::layout(
          title = paste("3D Bar Plot:", paste(self$drugs, collapse = " + ")),
          scene = list(
            xaxis = list(
              title = list(text = x_axis_label, font = list(size = axis_title_size, family = "Arial Black")),
              tickvals = seq_along(drug2_vals),
              ticktext = signif(drug2_vals, 3),
              tickfont = list(size = axis_tick_size)
            ),
            yaxis = list(
              title = list(text = y_axis_label, font = list(size = axis_title_size, family = "Arial Black")),
              tickvals = seq_along(drug1_vals),
              ticktext = signif(drug1_vals, 3),
              tickfont = list(size = axis_tick_size)
            ),
            zaxis = list(
              title = list(text = "% Growth", font = list(size = axis_title_size, family = "Arial Black")),
              range = c(0, 100),
              tickfont = list(size = axis_tick_size)
            ),
            camera = list(
              eye = camera_eye_list
            )
          )
        )

      if (!is.null(snapshot_file)) {
        tryCatch(
          {
            plotly::save_image(
              p_barplot,
              file = snapshot_file,
              width = snapshot_width,
              height = snapshot_height,
              scale = snapshot_scale
            )
          },
          error = function(e) {
            stop(
              "Failed to save plot snapshot. This requires Plotly static image export support (Kaleido). ",
              "Install Kaleido in the Python environment used by reticulate. Original error: ",
              e$message
            )
          }
        )
      }

      if (print) print(p_barplot)
      return(invisible(p_barplot))
    }
  )
)
