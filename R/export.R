#' Export Bliss R6 objects to Excel
#'
#' Exports one or more Bliss R6 objects to an Excel (.xlsx) spreadsheet. Each object is written to a separate worksheet named by the drug combination. The summary table is styled with font size 14 and colored interpretation cells. Heatmap and bar plots (for 3-drug objects) are saved as images and inserted into the workbook.
#'
#' @param ... One or more Bliss R6 objects.
#' @param stratify (Optional) Name of drug to stratify summary and plots by (for 3-drug data).
#' @param file Path to the output .xlsx file.
#' @return Invisibly returns TRUE if successful.
#' @details
#' - Each worksheet is named by the drug combination (e.g., "DrugA+DrugB").
#' - The summary table is styled: font size 14, colored interpretation cells (red/white for Antagonistic, green/black for Synergistic, white/black for Additive).
#' - Heatmap and bar plots are saved as PNGs and inserted into the workbook (bar plot export only for 3-drug objects).
#' - Temporary image files are deleted after export.
#' @export

export <- function(..., stratify, file) {
  # load required packages
  require(openxlsx)
  require(ggplot2)
  require(grid)
  require(gridExtra)
  
  # detect ".xlsx" extension in the file name and export to Excel if present
  if (grepl("\\.xlsx$", file)) {
    # create a new workbook
    wb <- createWorkbook()
    # get the list of bliss objects from the arguments
    bliss_objects <- list(...)
    # loop through each bliss object and export it to a sheet in the workbook
    for (i in seq_along(bliss_objects)) {
      bliss_obj <- bliss_objects[[i]]
      # create a new sheet for the bliss object
      sheet_name <- paste(bliss_obj$drugs, collapse = "+")
      addWorksheet(wb, sheet_name)
      # export the interaction summary data frame to the sheet
      summary_df <- bliss_obj$summary(stratify = stratify) |> dplyr::mutate(sum_bliss = round(sum_bliss, 2))
      writeData(wb, sheet_name, summary_df, startCol = 1, startRow = 1)
      # Set column widths for the first 3 columns
      setColWidths(wb, sheet = sheet_name, cols = 1:3, widths = "auto")
      # Style: font size 14 for all
      addStyle(wb, sheet = sheet_name, style = createStyle(fontSize = 14), rows = 1:(nrow(summary_df)+1), cols = 1:ncol(summary_df), gridExpand = TRUE)
      # Style: color Interpretation cells
      interp_col <- which(names(summary_df) == "interpretation")
      for (row in 2:(nrow(summary_df)+1)) {
        val <- summary_df[["interpretation"]][row-1]
        if (val == "Antagonistic") {
          style <- createStyle(fontColour = "white", fgFill = "red", halign = "center")
        } else if (val == "Synergistic") {
          style <- createStyle(fontColour = "black", fgFill = "#00FF00", halign = "center")
        } else {
          style <- createStyle(fontColour = "black", fgFill = "white", halign = "center")
        }
        addStyle(wb, sheet = sheet_name, style = style, rows = row, cols = interp_col, gridExpand = FALSE, stack = TRUE)
      }
      # check if the bliss object has a heatmap plot
      if (!is.null(bliss_obj$heatmap)) {
        heatmap_plot <- bliss_obj$heatmap(stratify = stratify)
        # save the heatmap plot as an image      
        heatmap_file <- file.path(tempdir(),paste0("heatmap",i,".png"))
        ggplot2::ggsave(
          filename = heatmap_file,
          plot = heatmap_plot,
          width = 10,
          height = 10,
          dpi = 300
        )
        # insert the heatmap image into the sheet      
        insertImage(wb, sheet_name, heatmap_file, startCol = 5, startRow = 1, width = 10, height = 10)
      }
      # check if the bliss object has a bar plot
      if (!is.null(bliss_obj$bar)) {
        if (length(bliss_obj$drugs) == 2) {
          cli::cli_inform("2-drug bar plot is a plotly object, so cannot be exported to Excel.")
        } else {
          bar_plot <- bliss_obj$bar(stratify = stratify)
          # save the bar plot as an image      
          bar_file <- file.path(tempdir(),paste0("bar",i,".png"))
          ggplot2::ggsave(
            filename = bar_file,
            plot = bar_plot,
            width = 10,
            height = 10,
            dpi = 300
          )
          # insert the bar plot image into the sheet      
          insertImage(wb, sheet_name, bar_file, startCol = 15, startRow = 1, width = 10, height = 10)   
        }
      } 
  
    }
    # Window size
    setWindowSize(wb, windowWidth = 30000, windowHeight = 20000)
    # save the workbook to the specified file
    saveWorkbook(wb, file, overwrite = TRUE)
    # clean up temporary image files  
    invisible(file.remove(file.path(tempdir(), list.files(path = tempdir(), pattern = "heatmap\\d+.png"))))
    invisible(file.remove(file.path(tempdir(), list.files(path = tempdir(), pattern = "bar\\d+.png"))))
  } else {
    cli::cli_abort("File extension must be .xlsx.")
  } 
}
