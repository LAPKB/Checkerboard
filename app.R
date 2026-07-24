# Development launcher for the Checkerboard Shiny application.
#
# In an installed package, use Checkerboard::run_checkerboard_app().
if (!requireNamespace("pkgload", quietly = TRUE)) {
  stop("The 'pkgload' package is required to run the app from the source tree.")
}

pkgload::load_all(export_all = FALSE)
Checkerboard::run_checkerboard_app()
