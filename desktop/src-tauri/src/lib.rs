mod auth;
mod commands;
mod error;
mod protected_output;
pub mod services;

use auth::{AuthState, CapturedAuthorization};
use commands::{
    AnalysisProgress, AnalyzeDiamondRequest, AnalyzeTableRequest, DrusanoFitProgress,
    FitMusycRequest, MusycFitProgress, PrepareDrusanoDataRequest,
};
use error::AppError;
use protected_output::{ProtectedOutput, ProtectedResult, protect_result};
use serde::Serialize;
use std::future::Future;
use tauri::{AppHandle, Manager, Runtime};

fn access_denied(authorization: &CapturedAuthorization) -> AppError {
    AppError::new("accessDenied", authorization.auth().denial_message())
}

/// Run queued/blocking work only with the exact permit captured at the
/// synchronous dispatcher boundary, then recheck before publishing its result.
pub(crate) fn run_protected_work<T, F>(
    authorization: CapturedAuthorization,
    work: F,
) -> Result<T, AppError>
where
    F: FnOnce(CapturedAuthorization) -> Result<T, AppError>,
{
    if !authorization.is_valid() {
        return Err(access_denied(&authorization));
    }
    let result = work(authorization.clone());
    if !authorization.is_valid() {
        return Err(access_denied(&authorization));
    }
    result
}

async fn protected_blocking<T, F>(
    label: &'static str,
    authorization: CapturedAuthorization,
    work: F,
) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce(CapturedAuthorization) -> Result<T, AppError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || run_protected_work(authorization, work))
        .await
        .map_err(|error| AppError::new("workerError", format!("{label} task failed: {error}")))?
}

fn command_arg<'de, R, T>(
    invoke: &'de tauri::ipc::Invoke<R>,
    command: &'static str,
    key: &'static str,
) -> Result<T, tauri::ipc::InvokeError>
where
    R: Runtime,
    T: tauri::ipc::CommandArg<'de, R>,
{
    T::from_command(tauri::ipc::CommandItem {
        plugin: None,
        name: command,
        key,
        message: &invoke.message,
        acl: &invoke.acl,
    })
}

fn reject_protected<R: Runtime>(
    invoke: tauri::ipc::Invoke<R>,
    authorization: CapturedAuthorization,
    error: tauri::ipc::InvokeError,
) -> bool {
    invoke
        .resolver
        .reject(ProtectedOutput::new(authorization, error.0));
    true
}

fn queue_protected<R, T, F, Fut>(
    invoke: tauri::ipc::Invoke<R>,
    authorization: CapturedAuthorization,
    handler: F,
) -> bool
where
    R: Runtime,
    T: Serialize + Send + 'static,
    F: FnOnce(CapturedAuthorization) -> Fut + Send + 'static,
    Fut: Future<Output = ProtectedResult<T>> + Send + 'static,
{
    invoke.resolver.respond_async(async move {
        #[cfg(test)]
        authorization.auth().pause_test_dispatch();
        handler(authorization)
            .await
            .map_err(tauri::ipc::InvokeError::from)
    });
    true
}

macro_rules! dispatch_blocking {
    ($invoke:ident, $authorization:ident, $command:literal, $label:literal, $handler:path $(, $argument:ident: $ty:ty => $key:literal)* $(,)?) => {{
        $(
            let $argument: $ty = match command_arg::<R, $ty>(&$invoke, $command, $key) {
                Ok(value) => value,
                Err(error) => return reject_protected($invoke, $authorization, error),
            };
        )*
        queue_protected($invoke, $authorization, move |authorization| async move {
            let result = protected_blocking($label, authorization.clone(), move |_| {
                $handler($($argument),*)
            }).await;
            protect_result(authorization, result)
        })
    }};
}

macro_rules! dispatch_async {
    ($invoke:ident, $authorization:ident, $command:literal, $handler:path $(, $argument:ident: $ty:ty => $key:literal)* $(,)?) => {{
        $(
            let $argument: $ty = match command_arg::<R, $ty>(&$invoke, $command, $key) {
                Ok(value) => value,
                Err(error) => return reject_protected($invoke, $authorization, error),
            };
        )*
        queue_protected($invoke, $authorization, move |authorization| async move {
            let result = $handler(authorization.clone(), $($argument),*).await;
            protect_result(authorization, result)
        })
    }};
}

fn is_protected_command(command: &str) -> bool {
    matches!(
        command,
        "list_worksheets"
            | "import_preview"
            | "infer_mics"
            | "prepare_drusano_data"
            | "suggest_drusano_censor_limit"
            | "fit_drusano_greco"
            | "fit_musyc"
            | "simulate_drusano_regimen"
            | "analyze_table"
            | "analyze_diamond"
            | "export_results"
            | "save_project_snapshot"
            | "load_project_snapshot"
            | "quit_application"
    )
}

fn register_commands<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    let auth_handlers: Box<dyn Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync> =
        Box::new(tauri::generate_handler![
            auth::auth_status,
            auth::auth_open_launcher,
        ]);

    builder.invoke_handler(move |invoke| {
        let command = invoke.message.command().to_owned();
        if !is_protected_command(&command) {
            return auth_handlers(invoke);
        }

        // Capture the original SDK capability and its verified account before
        // Tauri queues any asynchronous command handler or blocking work.
        let state = invoke.message.state_ref().try_get::<AuthState>();
        let denial_message = state.as_ref().map_or_else(
            || "Checkmate access is locked.".to_string(),
            |auth| auth.denial_message().to_string(),
        );
        let authorization = state
            .as_ref()
            .and_then(|auth| auth.capture_authorization());
        drop(state);
        let Some(authorization) = authorization else {
            invoke
                .resolver
                .reject(AppError::new("accessDenied", denial_message));
            return true;
        };

        match command.as_str() {
            "list_worksheets" => dispatch_blocking!(
                invoke,
                authorization,
                "list_worksheets",
                "worksheet listing",
                commands::list_worksheets,
                path: String => "path"
            ),
            "import_preview" => dispatch_blocking!(
                invoke,
                authorization,
                "import_preview",
                "import preview",
                commands::import_preview,
                request: services::importer::ImportRequest => "request"
            ),
            "infer_mics" => dispatch_blocking!(
                invoke,
                authorization,
                "infer_mics",
                "MIC inference",
                commands::infer_mics,
                request: commands::InferMicsRequest => "request"
            ),
            "prepare_drusano_data" => dispatch_blocking!(
                invoke,
                authorization,
                "prepare_drusano_data",
                "Drusano data preparation",
                commands::prepare_drusano_data,
                request: PrepareDrusanoDataRequest => "request"
            ),
            "suggest_drusano_censor_limit" => dispatch_blocking!(
                invoke,
                authorization,
                "suggest_drusano_censor_limit",
                "Drusano censor suggestion",
                commands::suggest_drusano_censor_limit,
                request: commands::SuggestDrusanoCensorLimitRequest => "request"
            ),
            "fit_drusano_greco" => dispatch_async!(
                invoke,
                authorization,
                "fit_drusano_greco",
                commands::fit_drusano_greco_protected,
                request: PrepareDrusanoDataRequest => "request",
                on_progress: tauri::ipc::Channel<ProtectedOutput<DrusanoFitProgress>> => "onProgress"
            ),
            "fit_musyc" => dispatch_async!(
                invoke,
                authorization,
                "fit_musyc",
                commands::fit_musyc_protected,
                request: FitMusycRequest => "request",
                on_progress: tauri::ipc::Channel<ProtectedOutput<MusycFitProgress>> => "onProgress"
            ),
            "simulate_drusano_regimen" => dispatch_async!(
                invoke,
                authorization,
                "simulate_drusano_regimen",
                commands::simulate_drusano_regimen_protected,
                request: services::drusano_greco::DrusanoRegimenSimulationRequest => "request"
            ),
            "analyze_table" => dispatch_async!(
                invoke,
                authorization,
                "analyze_table",
                commands::analyze_table_protected,
                request: AnalyzeTableRequest => "request",
                on_progress: tauri::ipc::Channel<ProtectedOutput<AnalysisProgress>> => "onProgress"
            ),
            "analyze_diamond" => dispatch_async!(
                invoke,
                authorization,
                "analyze_diamond",
                commands::analyze_diamond_protected,
                request: AnalyzeDiamondRequest => "request",
                on_progress: tauri::ipc::Channel<ProtectedOutput<AnalysisProgress>> => "onProgress"
            ),
            "export_results" => dispatch_async!(
                invoke,
                authorization,
                "export_results",
                commands::export_results_protected,
                request: commands::ExportResultsRequest => "request"
            ),
            "save_project_snapshot" => dispatch_async!(
                invoke,
                authorization,
                "save_project_snapshot",
                commands::save_project_snapshot_protected,
                path: String => "path",
                snapshot_json: String => "snapshotJson"
            ),
            "load_project_snapshot" => dispatch_async!(
                invoke,
                authorization,
                "load_project_snapshot",
                commands::load_project_snapshot_protected,
                path: String => "path"
            ),
            "quit_application" => {
                let app: AppHandle<R> = match command_arg::<R, AppHandle<R>>(
                    &invoke,
                    "quit_application",
                    "app",
                ) {
                    Ok(value) => value,
                    Err(error) => return reject_protected(invoke, authorization, error),
                };
                queue_protected(invoke, authorization, move |authorization| async move {
                    let result = commands::quit_application_protected(&authorization, app);
                    protect_result(authorization, result)
                })
            }
            _ => {
                invoke
                    .resolver
                    .reject(AppError::new("unknownCommand", "Unknown protected command."));
                true
            }
        }
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            app.manage(AuthState::load(app.handle(), || {}));
            Ok(())
        });
    register_commands(builder)
        .run(tauri::generate_context!())
        .expect("error while running Checkmate");
}

#[cfg(test)]
mod protected_dispatch_tests;
