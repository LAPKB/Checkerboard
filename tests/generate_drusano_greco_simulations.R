# Generate deterministic, censored checkerboards for the native Drusano-Greco
# recovery tests. Run from the repository root with:
#
#   Rscript tests/generate_drusano_greco_simulations.R

doses <- c(0, 0.125, 0.25, 0.5, 1, 2, 4, 8)
ec50_1 <- 1
ec50_2 <- 2
h1 <- 1
h2 <- 2
b1 <- 0
b2 <- 0
censor_effect <- 0.9
options(digits = 17)

solve_effect <- function(d1, d2, alpha_12) {
  u <- d1 / ec50_1
  v <- d2 / ec50_2
  if (u <= 1e-15 && v <= 1e-15) {
    return(0)
  }
  if (v <= 1e-15) {
    h1_d <- h1 * exp(b1 * tanh(log(u)))
    xm0 <- u^h1_d
    return(xm0 / (1 + xm0))
  }
  if (u <= 1e-15) {
    h2_d <- h2 * exp(b2 * tanh(log(v)))
    xm0 <- v^h2_d
    return(xm0 / (1 + xm0))
  }

  h1_d <- h1 * exp(b1 * tanh(log(u)))
  h2_d <- h2 * exp(b2 * tanh(log(v)))
  h_1 <- 1 / h1_d
  h_2 <- 1 / h2_d
  h_12 <- (h_1 + h_2) / 2
  w <- alpha_12 * u * v
  balance <- function(log_xm0) {
    u * exp(-h_1 * log_xm0) +
      v * exp(-h_2 * log_xm0) +
      w * exp(-h_12 * log_xm0) - 1
  }

  low <- -32
  high <- 32
  stopifnot(sign(balance(low)) != sign(balance(high)))
  for (iteration in seq_len(200)) {
    midpoint <- (low + high) / 2
    if (sign(balance(midpoint)) == sign(balance(low))) {
      low <- midpoint
    } else {
      high <- midpoint
    }
  }
  log_xm0 <- (low + high) / 2
  if (log_xm0 >= 0) {
    1 / (1 + exp(-log_xm0))
  } else {
    xm0 <- exp(log_xm0)
    xm0 / (1 + xm0)
  }
}

write_fixture <- function(alpha_12, filename) {
  grid <- expand.grid(
    ConcDrug1 = doses,
    ConcDrug2 = doses,
    KEEP.OUT.ATTRS = FALSE
  )
  latent_effect <- mapply(solve_effect, grid$ConcDrug1, grid$ConcDrug2,
                          MoreArgs = list(alpha_12 = alpha_12))
  censored <- latent_effect > censor_effect
  observed_effect <- pmin(latent_effect, censor_effect)
  fixture <- data.frame(
    Drug1 = "Drug 1",
    Drug2 = "Drug 2",
    ConcDrug1 = grid$ConcDrug1,
    ConcDrug2 = grid$ConcDrug2,
    UnitDrug1 = "mg/L",
    UnitDrug2 = "mg/L",
    Response = 1 - observed_effect,
    LatentEffect = latent_effect,
    CENS = as.integer(censored),
    TrueEc50Drug1 = ec50_1,
    TrueEc50Drug2 = ec50_2,
    TrueH1 = h1,
    TrueH2 = h2,
    TrueAlpha12 = alpha_12,
    TrueB1 = b1,
    TrueB2 = b2,
    stringsAsFactors = FALSE
  )
  write.table(
    fixture,
    file = file.path("tests", filename),
    sep = ",",
    row.names = FALSE,
    col.names = TRUE,
    quote = FALSE
  )
}

write_fixture(-0.5, "drusano_greco_alpha_negative.csv")
write_fixture(0, "drusano_greco_alpha_zero.csv")
write_fixture(0.5, "drusano_greco_alpha_positive.csv")

# Cross-method fixtures: choose alpha so responses generated from Equation 2
# have a requested mean two-drug Bliss score in percentage points. These are
# deliberately uncensored so the Bliss target and Drusano recovery test use the
# same observed surface.
mean_bliss <- function(alpha_12) {
  grid <- expand.grid(d1 = doses, d2 = doses, KEEP.OUT.ATTRS = FALSE)
  effect <- mapply(solve_effect, grid$d1, grid$d2,
                   MoreArgs = list(alpha_12 = alpha_12))
  effect_1 <- vapply(grid$d1, function(d1) solve_effect(d1, 0, alpha_12), numeric(1))
  effect_2 <- vapply(grid$d2, function(d2) solve_effect(0, d2, alpha_12), numeric(1))
  expected <- effect_1 + effect_2 - effect_1 * effect_2
  combination <- grid$d1 > 0 & grid$d2 > 0
  mean(100 * (effect - expected)[combination])
}

write_bliss_fixture <- function(target_bliss, filename) {
  alpha_12 <- uniroot(
    function(alpha) mean_bliss(alpha) - target_bliss,
    interval = c(-0.99, 20),
    tol = 1e-13
  )$root
  grid <- expand.grid(doses, doses, KEEP.OUT.ATTRS = FALSE)
  names(grid) <- c("Drug 1 (mg/L)", "Drug 2 mg/L")
  latent_effect <- mapply(
    solve_effect,
    grid[["Drug 1 (mg/L)"]],
    grid[["Drug 2 mg/L"]],
    MoreArgs = list(alpha_12 = alpha_12)
  )
  fixture <- data.frame(
    grid,
    Response = 1 - latent_effect,
    LatentEffect = latent_effect,
    CENS = 0L,
    TrueEc50Drug1 = ec50_1,
    TrueEc50Drug2 = ec50_2,
    TrueH1 = h1,
    TrueH2 = h2,
    TrueAlpha12 = alpha_12,
    TrueB1 = b1,
    TrueB2 = b2,
    TargetMeanBliss = target_bliss,
    check.names = FALSE,
    stringsAsFactors = FALSE
  )
  write.table(
    fixture,
    file = file.path("tests", filename),
    sep = ",",
    row.names = FALSE,
    col.names = TRUE,
    quote = FALSE
  )
}

write_bliss_fixture(-12, "drusano_greco_bliss_minus12.csv")
write_bliss_fixture(0.5, "drusano_greco_bliss_plus0_5.csv")
write_bliss_fixture(10, "drusano_greco_bliss_plus10.csv")
