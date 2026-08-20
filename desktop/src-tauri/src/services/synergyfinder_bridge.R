suppressPackageStartupMessages(library(synergyfinder))
suppressPackageStartupMessages(library(jsonlite))

payload <- fromJSON(paste(readLines(file("stdin"), warn = FALSE), collapse = ""), simplifyVector = FALSE)
drug_names <- unlist(payload$drugNames, use.names = FALSE)
drug_count <- length(drug_names)
rows <- payload$rows
policy <- payload$policy

if (!identical(as.character(packageVersion("synergyfinder")), "3.20.0")) {
  stop("SynergyFinder+ compatibility mode requires synergyfinder 3.20.0; installed version is ",
       as.character(packageVersion("synergyfinder")), ".")
}

input <- data.frame(block_id = rep(1, length(rows)))
for (i in seq_len(drug_count)) {
  input[[paste0("drug", i)]] <- drug_names[[i]]
  input[[paste0("conc", i)]] <- vapply(rows, function(row) row$concentrations[[i]], numeric(1))
  input[[paste0("conc_unit", i)]] <- "unspecified"
}
input$response <- vapply(rows, function(row) row$od, numeric(1))

response_type <- policy$responseType
if (identical(response_type, "rawOd")) {
  control_index <- Reduce(`&`, lapply(seq_len(drug_count), function(i) input[[paste0("conc", i)]] == 0))
  control_mean <- mean(input$response[control_index])
  if (!is.finite(control_mean) || control_mean <= 0) stop("Raw OD control mean must be positive.")
  input$response <- 100 * input$response / control_mean
  reshape_type <- "viability"
} else if (identical(response_type, "viabilityFraction")) {
  input$response <- 100 * input$response
  reshape_type <- "viability"
} else {
  reshape_type <- response_type
}

control_index_input <- Reduce(`&`, lapply(seq_len(drug_count), function(i) input[[paste0("conc", i)]] == 0))
control_response <- mean(input$response[control_index_input])
if (identical(response_type, "viability") && is.finite(control_response) && control_response >= 0.5 && control_response <= 2) {
  stop("The untreated control response is near 1, but Viability (%) expects controls near 100. Select Fractional viability (0–1) and recalculate.")
}

reshaped <- ReshapeData(
  input,
  data_type = reshape_type,
  impute = FALSE,
  noise = FALSE,
  # ReshapeData bootstraps response-only p-values, which are not part of this
  # app's output. Keep its valid minimum small; CalculateSynergy below performs
  # the requested Bliss bootstrap and resets the seed before doing so.
  iteration = 2L,
  seed = as.integer(policy$randomSeed)
)
correction <- switch(policy$baselineCorrection, none = "non", part = "part", all = "all")
result <- CalculateSynergy(
  reshaped,
  method = "Bliss",
  correct_baseline = correction,
  iteration = as.integer(policy$bootstrapIterations),
  seed = as.integer(policy$randomSeed)
)

concs <- paste0("conc", seq_len(drug_count))
observed <- aggregate(result$response$response, result$response[concs], mean)
names(observed)[drug_count + 1] <- "response"
original <- aggregate(input$response, input[concs], mean)
names(original)[drug_count + 1] <- "original"
replicates <- aggregate(input$response, input[concs], length)
names(replicates)[drug_count + 1] <- "n"
scores <- Reduce(function(x, y) merge(x, y, by = concs, sort = FALSE),
                 list(result$synergy_scores, observed, original, replicates))

statistics <- result$synergy_scores_statistics
if (!is.null(statistics)) {
  keep <- c(concs, "Bliss_synergy_sem", "Bliss_synergy_ci_left", "Bliss_synergy_ci_right")
  keep <- intersect(keep, names(statistics))
  scores <- merge(scores, statistics[keep], by = concs, all.x = TRUE, sort = FALSE)
}

find_response <- function(values) {
  matches <- rep(TRUE, nrow(observed))
  for (i in seq_len(drug_count)) matches <- matches & observed[[concs[[i]]]] == values[[i]]
  observed$response[which(matches)[1]]
}

processed <- lapply(seq_len(nrow(scores)), function(row_index) {
  concentrations <- unname(as.numeric(scores[row_index, concs]))
  singles <- vapply(seq_len(drug_count), function(i) {
    coordinate <- rep(0, drug_count)
    coordinate[[i]] <- concentrations[[i]]
    find_response(coordinate)
  }, numeric(1))
  interaction <- scores$Bliss_synergy[[row_index]]
  interpretation <- if (interaction < -10) "antagonistic" else if (interaction > 10) "synergistic" else "additive"
  list(
    concentrations = concentrations,
    meanOriginalOd = scores$original[[row_index]],
    meanCensoredOd = scores$response[[row_index]],
    censoredReplicateCount = 0,
    effect = scores$response[[row_index]],
    singleAgentEffects = unname(singles),
    blissExpected = scores$Bliss_ref[[row_index]],
    blissInteraction = interaction,
    replicateCount = as.integer(scores$n[[row_index]]),
    interpretation = interpretation,
    blissSem = if ("Bliss_synergy_sem" %in% names(scores)) scores$Bliss_synergy_sem[[row_index]] else NULL,
    blissCiLeft = if ("Bliss_synergy_ci_left" %in% names(scores)) scores$Bliss_synergy_ci_left[[row_index]] else NULL,
    blissCiRight = if ("Bliss_synergy_ci_right" %in% names(scores)) scores$Bliss_synergy_ci_right[[row_index]] else NULL
  )
})

combination_index <- apply(scores[concs], 1, function(values) all(values > 0))
combination_scores <- scores$Bliss_synergy[combination_index]
mean_bliss <- mean(combination_scores)
p_column <- "Bliss_synergy_p_value"
p_value <- if (p_column %in% names(result$drug_pairs)) as.character(result$drug_pairs[[p_column]][[1]]) else NULL
summary_interpretation <- if (mean_bliss < -10) "antagonistic" else if (mean_bliss > 10) "synergistic" else "additive"

control_index <- Reduce(`&`, lapply(concs, function(column) input[[column]] == 0))
output <- list(
  drugNames = drug_names,
  control = list(
    replicateCount = sum(control_index),
    meanOd = mean(vapply(rows[control_index], function(row) row$od, numeric(1)))
  ),
  processed = processed,
  summary = list(
    sumBliss = sum(combination_scores),
    meanBliss = mean_bliss,
    positiveSum = sum(combination_scores[combination_scores > 0]),
    negativeSum = sum(combination_scores[combination_scores < 0]),
    combinationCount = length(combination_scores),
    pValue = p_value,
    interpretation = summary_interpretation
  ),
  warnings = list(),
  policy = policy
)
cat(toJSON(output, auto_unbox = TRUE, digits = 16, null = "null", na = "null"))
