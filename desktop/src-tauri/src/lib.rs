mod commands;
mod error;
pub mod services;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::list_worksheets,
            commands::import_preview,
            commands::infer_mics,
            commands::prepare_drusano_data,
            commands::suggest_drusano_censor_limit,
            commands::fit_drusano_greco,
            commands::fit_musyc,
            commands::simulate_drusano_regimen,
            commands::analyze_table,
            commands::export_results,
            commands::save_project_snapshot,
            commands::load_project_snapshot,
            commands::quit_application,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Checkmate");
}
