use std::{collections::BTreeMap, env};

use checkerboard_core::drusano_greco::{DrusanoDataSet, DrusanoWell};
use checkmate_desktop_lib::services::musyc;

#[derive(Clone)]
struct Row {
    d1: f64,
    d2: f64,
    response: f64,
}

fn main() -> anyhow::Result<()> {
    let path = env::args()
        .nth(1)
        .ok_or_else(|| anyhow::anyhow!("usage: musyc_fit_csv FILE"))?;
    let mut reader = csv::Reader::from_path(path)?;
    let headers = reader.headers()?.clone();
    let column = |name: &str| {
        headers
            .iter()
            .position(|value| value == name)
            .ok_or_else(|| anyhow::anyhow!("missing {name}"))
    };
    let drug_a = column("DrugA")?;
    let drug_b = column("DrugB")?;
    let conc_a = column("ConcA")?;
    let conc_b = column("ConcB")?;
    let response = column("Response")?;
    let mut groups = BTreeMap::<(String, String), Vec<Row>>::new();
    for record in reader.records() {
        let record = record?;
        groups
            .entry((record[drug_a].into(), record[drug_b].into()))
            .or_default()
            .push(Row {
                d1: record[conc_a].parse()?,
                d2: record[conc_b].parse()?,
                response: record[response].parse()?,
            });
    }
    println!(
        "regimen,e0,e1,e2,e3,c1,c2,h1,h2,alpha12,alpha21,gamma12,gamma21,beta,r2,rmse,objective,iterations,converged,n"
    );
    for ((drug_1, drug_2), rows) in groups {
        let controls = rows
            .iter()
            .filter(|row| row.d1 == 0.0 && row.d2 == 0.0)
            .collect::<Vec<_>>();
        let control_mean =
            controls.iter().map(|row| row.response).sum::<f64>() / controls.len() as f64;
        let maximum_1 = rows.iter().map(|row| row.d1).fold(0.0, f64::max);
        let maximum_2 = rows.iter().map(|row| row.d2).fold(0.0, f64::max);
        let wells = rows
            .iter()
            .enumerate()
            .filter_map(|(index, row)| {
                if row.d1 == 0.0 && row.d2 == 0.0 {
                    return None;
                }
                let effect = 1.0 - row.response / control_mean;
                if !(0.0..1.0).contains(&effect) {
                    return None;
                }
                Some(DrusanoWell {
                    well_id: (index + 2).to_string(),
                    raw_response: row.response,
                    normalized_effect: effect,
                    normalized_doses: vec![row.d1 / maximum_1, row.d2 / maximum_2],
                    censored: false,
                })
            })
            .collect::<Vec<_>>();
        let n = wells.len();
        let result = musyc::fit(
            DrusanoDataSet {
                drug_names: vec![drug_1.clone(), drug_2.clone()],
                headers: vec![],
                rows: vec![],
                wells,
                eligible_well_count: n,
                control_count: controls.len(),
                excluded_boundary_count: 0,
                excluded_effect_below_zero_count: 0,
                excluded_effect_above_one_count: 0,
                censored_count: 0,
                response_censor_limit: None,
                normalized_effect_censor_limit: None,
                blank_value: 0.0,
                control_mean,
                max_concentrations: vec![maximum_1, maximum_2],
                warnings: vec![],
            },
            5_000,
        )?;
        let values = result
            .parameters
            .iter()
            .map(|parameter| parameter.value.to_string())
            .collect::<Vec<_>>();
        let regression = result.regression.as_ref();
        println!(
            "{}+{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{}",
            drug_1,
            drug_2,
            values[0],
            values[1],
            values[2],
            values[3],
            values[4],
            values[5],
            values[6],
            values[7],
            values[8],
            values[9],
            values[10],
            values[11],
            result.efficacy_beta,
            regression.map(|value| value.r_squared).unwrap_or(f64::NAN),
            regression
                .map(|value| value.root_mean_squared_error)
                .unwrap_or(f64::NAN),
            result.objective_function,
            result.iterations,
            result.converged,
            n,
        );
    }
    Ok(())
}
