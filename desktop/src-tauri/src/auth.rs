#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[cfg(target_os = "macos")]
use std::process::Command;

use lapkb_desktop_session::Permit;
#[cfg(all(feature = "local-staging", any(unix, windows)))]
use lapkb_desktop_session::VerificationKeySet;
#[cfg(any(unix, windows))]
use lapkb_desktop_session::{LeaseVerifier, ProtectedApp};
#[cfg(any(unix, windows))]
use lapkb_desktop_session::{client::Client as LauncherSessionClient, client_store::ClientStore};
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, State};

#[cfg(not(all(windows, target_arch = "x86_64")))]
const LAUNCHER_BUNDLE_ID: &str = "org.lapkb.launcher";
const ACCESS_REFRESH_INTERVAL: Duration = Duration::from_secs(1);
const TRUST_CONFIGURATION_MESSAGE: &str = "Checkmate could not initialize shared access. Check this build's trusted configuration and OS secure storage, then reopen Checkmate.";
const AUTH_REQUIRED_MESSAGE: &str = "Open LAPKB Launcher to sign in or manage the active account.";
const ACCESS_LOCKED_MESSAGE: &str =
    "Checkmate access is locked. Open LAPKB Launcher to restore access.";
const ACCOUNT_SWITCHED_MESSAGE: &str =
    "The LAPKB account changed. Checkmate is locked until the new account is verified.";
#[cfg(any(target_os = "macos", all(windows, target_arch = "x86_64")))]
const LAUNCHER_OPEN_ERROR: &str = "Could not open LAPKB Launcher.";
#[cfg(not(any(target_os = "macos", all(windows, target_arch = "x86_64"))))]
const LAUNCHER_OPEN_UNSUPPORTED_MESSAGE: &str =
    "Opening LAPKB Launcher from Checkmate is not supported on this platform.";

#[cfg(all(feature = "local-staging", any(unix, windows)))]
mod local_staging {
    include!(concat!(env!("OUT_DIR"), "/local_staging_config.rs"));
}

#[cfg(any(unix, windows))]
enum SessionRuntime {
    Ready(Arc<LauncherSessionClient>),
    Locked,
}

#[cfg(not(any(unix, windows)))]
enum SessionRuntime {
    Locked,
}

impl SessionRuntime {
    fn new<R: Runtime>(app: &AppHandle<R>) -> Self {
        #[cfg(any(unix, windows))]
        {
            build_session_client(app)
                .map(Arc::new)
                .map(Self::Ready)
                .unwrap_or(Self::Locked)
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = app;
            Self::Locked
        }
    }

    fn is_ready(&self) -> bool {
        #[cfg(any(unix, windows))]
        {
            matches!(self, Self::Ready(_))
        }
        #[cfg(not(any(unix, windows)))]
        {
            false
        }
    }
}

type AccessRevokedHook = Arc<dyn Fn() + Send + Sync>;

#[cfg(test)]
struct DispatchPause {
    entered: std::sync::mpsc::SyncSender<()>,
    release: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
}

#[cfg(test)]
pub(crate) struct TestDispatchControl {
    entered: std::sync::mpsc::Receiver<()>,
    release: std::sync::mpsc::SyncSender<()>,
}

#[cfg(test)]
impl TestDispatchControl {
    pub(crate) fn wait_until_reached(&self) {
        self.entered
            .recv_timeout(Duration::from_secs(10))
            .expect("protected IPC reached the queued-handler boundary");
    }

    pub(crate) fn release(self) {
        self.release
            .send(())
            .expect("queued-handler boundary is still paused");
    }
}

#[derive(Clone)]
pub struct AuthState {
    runtime: Arc<SessionRuntime>,
    inner: Arc<Mutex<AuthInner>>,
    access_revoked: AccessRevokedHook,
    #[cfg(target_os = "macos")]
    startup_launcher_attempted: Arc<AtomicBool>,
    #[cfg(test)]
    dispatch_pause: Arc<Mutex<Option<Arc<DispatchPause>>>>,
}

#[derive(Clone)]
pub(crate) struct CapturedAuthorization {
    auth: AuthState,
    permit: Permit,
    account_id: String,
}

impl CapturedAuthorization {
    pub(crate) fn auth(&self) -> &AuthState {
        &self.auth
    }

    pub(crate) fn is_valid(&self) -> bool {
        self.auth
            .check_captured_permit(self.permit, &self.account_id)
    }
}

#[derive(Default)]
struct AuthInner {
    restoring: bool,
    authorized: bool,
    account_id: Option<String>,
    last_account_id: Option<String>,
    message: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuthUser {
    subject: String,
    display_name: String,
    email: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthPhase {
    Unconfigured,
    Restoring,
    SignedOut,
    Authenticated,
    Suspended,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthView {
    phase: AuthPhase,
    user: Option<AuthUser>,
    account_id: Option<String>,
    message: Option<String>,
}

impl AuthState {
    #[cfg(test)]
    pub(crate) fn test_pause_next_dispatch(&self) -> TestDispatchControl {
        let (entered, wait_until_reached) = std::sync::mpsc::sync_channel(0);
        let (release, wait_for_release) = std::sync::mpsc::sync_channel(0);
        *self
            .dispatch_pause
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Arc::new(DispatchPause {
            entered,
            release: Mutex::new(Some(wait_for_release)),
        }));
        TestDispatchControl {
            entered: wait_until_reached,
            release,
        }
    }

    #[cfg(test)]
    pub(crate) fn pause_test_dispatch(&self) {
        let pause = self
            .dispatch_pause
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(pause) = pause {
            let _ = pause.entered.send(());
            let release = pause
                .release
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take();
            if let Some(release) = release {
                let _ = release.recv();
            }
        }
    }

    /// Synthetic locked state for native tests. It never opens an OS vault or user store.
    #[cfg(test)]
    pub(crate) fn test_locked() -> Self {
        Self {
            runtime: Arc::new(SessionRuntime::Locked),
            inner: Arc::new(Mutex::new(AuthInner::default())),
            access_revoked: Arc::new(|| {}),
            #[cfg(target_os = "macos")]
            startup_launcher_attempted: Arc::new(AtomicBool::new(false)),
            dispatch_pause: Arc::new(Mutex::new(None)),
        }
    }

    #[cfg(all(test, unix))]
    pub(crate) fn test_authorized(client: Arc<LauncherSessionClient>) -> Option<Self> {
        let account_id = account_id_string(&client)?;
        client.permit()?;
        Some(Self {
            runtime: Arc::new(SessionRuntime::Ready(client)),
            inner: Arc::new(Mutex::new(AuthInner {
                authorized: true,
                account_id: Some(account_id.clone()),
                last_account_id: Some(account_id),
                ..AuthInner::default()
            })),
            access_revoked: Arc::new(|| {}),
            #[cfg(target_os = "macos")]
            startup_launcher_attempted: Arc::new(AtomicBool::new(false)),
            dispatch_pause: Arc::new(Mutex::new(None)),
        })
    }

    #[cfg(all(test, unix))]
    pub(crate) fn test_record_client_access(&self) -> bool {
        let client = match self.runtime.as_ref() {
            SessionRuntime::Ready(client) => Arc::clone(client),
            SessionRuntime::Locked => return false,
        };
        self.record_access(client.permit().is_some(), account_id_string(&client))
    }

    /// Load the shared Launcher client. The child stores no sign-in token and
    /// fails closed if the vault, broker, or embedded verifier is unavailable.
    pub fn load<R: Runtime>(
        app: &AppHandle<R>,
        access_revoked: impl Fn() + Send + Sync + 'static,
    ) -> Self {
        let runtime = Arc::new(SessionRuntime::new(app));
        let ready = runtime.is_ready();
        let state = Self {
            runtime,
            inner: Arc::new(Mutex::new(AuthInner {
                restoring: ready,
                message: (!ready).then_some(TRUST_CONFIGURATION_MESSAGE),
                ..AuthInner::default()
            })),
            access_revoked: Arc::new(access_revoked),
            #[cfg(target_os = "macos")]
            startup_launcher_attempted: Arc::new(AtomicBool::new(false)),
            #[cfg(test)]
            dispatch_pause: Arc::new(Mutex::new(None)),
        };
        if ready {
            tauri::async_runtime::spawn(state.clone().refresh_loop());
        }
        state
    }

    pub fn denial_message(&self) -> &'static str {
        if self.runtime.is_ready() {
            AUTH_REQUIRED_MESSAGE
        } else {
            TRUST_CONFIGURATION_MESSAGE
        }
    }

    /// Return a permit only while native status and the SDK client agree on the
    /// current verified opaque account.
    pub fn acquire_permit(&self) -> Option<Permit> {
        #[cfg(any(unix, windows))]
        {
            let client = match self.runtime.as_ref() {
                SessionRuntime::Ready(client) => Arc::clone(client),
                SessionRuntime::Locked => return None,
            };
            let account_id = account_id_string(&client)?;
            let inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if !inner.authorized || inner.account_id.as_deref() != Some(account_id.as_str()) {
                return None;
            }
            drop(inner);
            client.permit()
        }
        #[cfg(not(any(unix, windows)))]
        {
            None
        }
    }

    /// Capture the original SDK permit and verified account before the Tauri
    /// dispatcher queues the asynchronous command handler.
    pub(crate) fn capture_authorization(&self) -> Option<CapturedAuthorization> {
        #[cfg(any(unix, windows))]
        {
            let client = match self.runtime.as_ref() {
                SessionRuntime::Ready(client) => Arc::clone(client),
                SessionRuntime::Locked => return None,
            };
            if !self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .authorized
            {
                return None;
            }

            let account_id = account_id_string(&client)?;
            let permit = client.permit()?;
            if account_id_string(&client).as_deref() != Some(account_id.as_str())
                || client.permit() != Some(permit)
                || client.check_permit().is_err()
                || client.permit() != Some(permit)
            {
                return None;
            }
            let inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if !inner.authorized || inner.account_id.as_deref() != Some(account_id.as_str()) {
                return None;
            }
            drop(inner);
            if account_id_string(&client).as_deref() != Some(account_id.as_str())
                || client.permit() != Some(permit)
            {
                return None;
            }
            Some(CapturedAuthorization {
                auth: self.clone(),
                permit,
                account_id,
            })
        }
        #[cfg(not(any(unix, windows)))]
        {
            None
        }
    }

    pub fn check_permit(&self, permit: Permit) -> bool {
        #[cfg(any(unix, windows))]
        {
            let client = match self.runtime.as_ref() {
                SessionRuntime::Ready(client) => Arc::clone(client),
                SessionRuntime::Locked => return false,
            };
            self.acquire_permit() == Some(permit) && client.check_permit().is_ok()
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = permit;
            false
        }
    }

    fn check_captured_permit(&self, permit: Permit, account_id: &str) -> bool {
        #[cfg(any(unix, windows))]
        {
            let client = match self.runtime.as_ref() {
                SessionRuntime::Ready(client) => Arc::clone(client),
                SessionRuntime::Locked => return false,
            };
            account_id_string(&client).as_deref() == Some(account_id)
                && self.check_permit(permit)
                && client.check_permit().is_ok()
                && client.permit() == Some(permit)
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = (permit, account_id);
            false
        }
    }

    #[cfg(any(unix, windows))]
    async fn refresh_once(&self) {
        let client = match self.runtime.as_ref() {
            SessionRuntime::Ready(client) => Arc::clone(client),
            SessionRuntime::Locked => return,
        };
        let _ = client.refresh().await;
        self.record_access(client.permit().is_some(), account_id_string(&client));
    }

    #[cfg(not(any(unix, windows)))]
    async fn refresh_once(&self) {}

    async fn refresh_loop(self) {
        self.refresh_once().await;
        loop {
            tokio::time::sleep(ACCESS_REFRESH_INTERVAL).await;
            self.refresh_once().await;
        }
    }

    fn record_access(&self, authorized: bool, account_id: Option<String>) -> bool {
        let (accepted, revoke) = {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let account_changed = authorized
                && account_id.as_ref().is_some_and(|current| {
                    inner
                        .last_account_id
                        .as_ref()
                        .is_some_and(|previous| previous != current)
                });
            if authorized {
                if let Some(account_id) = account_id.as_ref() {
                    inner.account_id = Some(account_id.clone());
                    inner.last_account_id = Some(account_id.clone());
                }
            } else {
                inner.account_id = None;
            }
            let accepted = authorized && account_id.is_some() && !account_changed;
            let revoke = inner.authorized && !accepted;
            inner.authorized = accepted;
            inner.restoring = false;
            inner.message = if account_changed {
                Some(ACCOUNT_SWITCHED_MESSAGE)
            } else if accepted {
                None
            } else if inner.last_account_id.is_some() {
                Some(ACCESS_LOCKED_MESSAGE)
            } else {
                Some(AUTH_REQUIRED_MESSAGE)
            };
            (accepted, revoke)
        };
        if revoke {
            (self.access_revoked)();
        }
        accepted
    }

    fn view(&self) -> AuthView {
        let fresh = self.acquire_permit().is_some();
        let inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let account_id = inner
            .account_id
            .clone()
            .or_else(|| inner.last_account_id.clone());
        let (phase, user) = if !self.runtime.is_ready() {
            (AuthPhase::Unconfigured, None)
        } else if inner.restoring {
            (AuthPhase::Restoring, None)
        } else if inner.authorized && fresh {
            let user = account_id.as_ref().map(|account_id| AuthUser {
                subject: account_id.clone(),
                display_name: "LAPKB account".into(),
                email: None,
            });
            if user.is_some() {
                (AuthPhase::Authenticated, user)
            } else {
                (AuthPhase::Suspended, None)
            }
        } else if inner.last_account_id.is_some() {
            (AuthPhase::Suspended, None)
        } else {
            (AuthPhase::SignedOut, None)
        };
        AuthView {
            phase,
            user,
            account_id,
            message: if self.runtime.is_ready() {
                inner.message.map(str::to_owned)
            } else {
                Some(TRUST_CONFIGURATION_MESSAGE.into())
            },
        }
    }

    pub(crate) fn open_launcher(&self, startup: bool) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            if startup && self.startup_launcher_attempted.swap(true, Ordering::AcqRel) {
                return Ok(());
            }
            let mut command = Command::new("/usr/bin/open");
            if startup {
                command.arg("-g");
            }
            let status = command
                .arg("-b")
                .arg(LAUNCHER_BUNDLE_ID)
                .status()
                .map_err(|_| LAUNCHER_OPEN_ERROR.to_string())?;
            if status.success() {
                Ok(())
            } else {
                Err(LAUNCHER_OPEN_ERROR.into())
            }
        }
        #[cfg(all(windows, target_arch = "x86_64"))]
        {
            windows_launcher::open_launcher(startup).map_err(|_| LAUNCHER_OPEN_ERROR.to_string())
        }
        #[cfg(not(any(target_os = "macos", all(windows, target_arch = "x86_64"))))]
        {
            let _ = (startup, LAUNCHER_BUNDLE_ID);
            Err(LAUNCHER_OPEN_UNSUPPORTED_MESSAGE.into())
        }
    }
}

#[cfg(all(windows, target_arch = "x86_64"))]
#[path = "windows_launcher.rs"]
mod windows_launcher;

#[cfg(any(unix, windows))]
fn account_id_string(client: &LauncherSessionClient) -> Option<String> {
    client
        .account_id()
        .map(|account_id| account_id.as_str().to_owned())
}

#[cfg(any(unix, windows))]
fn prepare_app_data_directory(path: &std::path::Path) -> Result<(), ()> {
    if !path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                std::path::Component::CurDir | std::path::Component::ParentDir
            )
        })
    {
        return Err(());
    }
    // Prepare only absent components of Tauri's fixed app-data path. Existing
    // permissions and the SDK's private-directory validation remain unchanged.
    let ancestors: Vec<_> = path.ancestors().collect();
    for directory in ancestors.into_iter().rev() {
        match std::fs::symlink_metadata(directory) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let mut builder = std::fs::DirBuilder::new();
                #[cfg(unix)]
                {
                    use std::os::unix::fs::DirBuilderExt;
                    builder.mode(0o700);
                }
                match builder.create(directory) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(_) => return Err(()),
                }
            }
            Err(_) => return Err(()),
        }
        let metadata = std::fs::symlink_metadata(directory).map_err(|_| ())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err(());
            }
        }
    }
    Ok(())
}

fn build_session_client<R: Runtime>(app: &AppHandle<R>) -> Result<LauncherSessionClient, ()> {
    let verifier = pinned_verifier()?;
    let broker_root = app.path().local_data_dir().map_err(|_| ())?;
    let broker_dir = broker_root.join("org.lapkb.launcher").join("broker");
    let app_data = app.path().app_data_dir().map_err(|_| ())?;
    prepare_app_data_directory(&app_data)?;
    let store =
        ClientStore::open(ProtectedApp::Checkerboard, app_data.join("session")).map_err(|_| ())?;
    LauncherSessionClient::new(ProtectedApp::Checkerboard, broker_dir, verifier, store)
        .map_err(|_| ())
}

#[cfg(any(unix, windows))]
fn pinned_verifier() -> Result<LeaseVerifier, ()> {
    #[cfg(feature = "local-staging")]
    {
        let kid = local_staging::SIGNING_KID.ok_or(())?;
        let public_key = local_staging::SIGNING_PUBLIC_KEY_B64.ok_or(())?;
        let keys =
            VerificationKeySet::from_base64([(kid.to_owned(), public_key)]).map_err(|_| ())?;
        Ok(LeaseVerifier::new(keys))
    }
    #[cfg(not(feature = "local-staging"))]
    {
        Err(())
    }
}

#[tauri::command]
pub fn auth_status(state: State<'_, AuthState>) -> AuthView {
    state.view()
}

#[tauri::command]
pub fn auth_open_launcher(
    state: State<'_, AuthState>,
    startup: Option<bool>,
) -> Result<(), String> {
    state.open_launcher(startup.unwrap_or(false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn missing_runtime_trust_stays_locked() {
        let state = AuthState::test_locked();
        assert!(state.acquire_permit().is_none());
        assert_eq!(state.denial_message(), TRUST_CONFIGURATION_MESSAGE);
    }

    #[test]
    fn account_switch_closes_authority_once_per_transition() {
        let count = Arc::new(AtomicUsize::new(0));
        let calls = Arc::clone(&count);
        let state = AuthState {
            runtime: Arc::new(SessionRuntime::Locked),
            inner: Arc::new(Mutex::new(AuthInner::default())),
            access_revoked: Arc::new(move || {
                calls.fetch_add(1, Ordering::SeqCst);
            }),
            #[cfg(target_os = "macos")]
            startup_launcher_attempted: Arc::new(AtomicBool::new(false)),
            dispatch_pause: Arc::new(Mutex::new(None)),
        };
        assert!(state.record_access(true, Some("account-a".into())));
        assert!(!state.record_access(true, Some("account-b".into())));
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert!(state.record_access(true, Some("account-b".into())));
        assert!(!state.record_access(false, None));
        assert_eq!(count.load(Ordering::SeqCst), 2);
    }
}
