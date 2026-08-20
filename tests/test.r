

dat <- openxlsx::read.xlsx("/Users/mneely/Library/CloudStorage/OneDrive-CHILDRENSHOSPITALLOSANGELES/Documents/LAPK/Pmetrics/Gibson/src/checkerboards/2-Drug/MAB_ATCC_2D_TIDY.xlsx", sheet = 1)

dat <- dat |> dplyr::transmute(
  PairIndex = 1,
  Drug1 = "DETA",
  Drug2 = "CFZ",
  Conc1 = DETA.Concentration,
  Conc2 = CFZ.Concentration,
  Response = 100 * Relative.OD600,
  ConcUnit = "ug/mL"
)


readr::write_csv(dat, "~/Downloads/test.csv")

library(synergyfinder)
dat2 <- ReshapeData(dat, data_type = "viability", impute = TRUE)

res <- CalculateSynergy(data = dat2, method = "Bliss")
PlotDoseResponseCurve(res, drug1 = "DETA", drug2 = "CFZ", response_type = "viability", plot_type = "3D")
Plot2DrugHeatmap(res, drugs = 1:2, plot_value = "response")

mean(res$synergy_scores_statistics$Bliss_synergy_mean)
mean(res$synergy_scores$Bliss_synergy)

res$drug_pairs$Bliss_synergy



dat3a <- openxlsx::read.xlsx("/Users/mneely/Library/CloudStorage/OneDrive-CHILDRENSHOSPITALLOSANGELES/Documents/LAPK/Pmetrics/Gibson/src/checkerboards/3-Drug/3D_Tidy_AMK.xlsx", sheet = 1) |> dplyr::transmute(
  PairIndex = 1,
  Drug1 = "DETA",
  Drug2 = "CFZ",
  Drug3 = "AMK",
  Conc1 = DETA.Concentration,
  Conc2 = CFZ.Concentration,
  Conc3 = AMK.Concentration,
  Response = 100 * Relative.OD600,
  ConcUnit = "ug/mL"
)
readr::write_csv(dat3a, "~/Downloads/test3a.csv")

dat3b <- openxlsx::read.xlsx("/Users/mneely/Library/CloudStorage/OneDrive-CHILDRENSHOSPITALLOSANGELES/Documents/LAPK/Pmetrics/Gibson/src/checkerboards/3-Drug/3D_Tidy_BDQ.xlsx", sheet = 1) |> dplyr::transmute(
  PairIndex = 2,
  Drug1 = "DETA",
  Drug2 = "CFZ",
  Drug3 = "BDQ",
  Conc1 = DETA.Concentration,
  Conc2 = CFZ.Concentration,
  Conc3 = BDQ.Concentration,
  Response = 100 * Relative.OD600,
  ConcUnit = "ug/mL"
)
readr::write_csv(dat3b, "~/Downloads/test3b.csv")
dat3 <- dplyr::bind_rows(dat3a, dat3b) |> ReshapeData(data_type = "viability", impute = TRUE)

res3 <- CalculateSynergy(data = dat3, method = "Bliss")

res3a <- CalculateSynergy(data = dat3a |> ReshapeData(data_type = "viability", impute = TRUE, seed = 123, iteration = 10), method = "Bliss", seed = 123, iteration = 10)

PlotMultiDrugSurface(
  data = res3,
  plot_block = 1,
  plot_value = "response",
  summary_statistic = NULL,
  distance_method = "mahalanobis",
  show_data_points = FALSE
)

res3$drug_pairs$Bliss_synergy
res3a$drug_pairs$Bliss_synergy
