use super::*;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tauri::{App, WebviewWindow, test::MockRuntime};

fn mock_app(auth: AuthState) -> (App<MockRuntime>, WebviewWindow<MockRuntime>) {
    let app = register_commands(tauri::test::mock_builder().manage(auth))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app builds");
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("mock webview builds");
    (app, webview)
}

fn request(command: &str, payload: Value) -> tauri::webview::InvokeRequest {
    let url = if cfg!(any(windows, target_os = "android")) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    tauri::webview::InvokeRequest {
        cmd: command.into(),
        callback: tauri::ipc::CallbackFn(0),
        error: tauri::ipc::CallbackFn(1),
        url: url.parse().expect("mock URL parses"),
        body: tauri::ipc::InvokeBody::Json(payload),
        headers: Default::default(),
        invoke_key: tauri::test::INVOKE_KEY.to_string(),
    }
}

fn invoke(
    webview: &WebviewWindow<MockRuntime>,
    command: &str,
    payload: Value,
) -> Result<Value, Value> {
    tauri::test::get_ipc_response(webview, request(command, payload)).map(|body| {
        body.deserialize::<Value>()
            .expect("native IPC response is JSON")
    })
}

#[cfg(unix)]
mod broker_fixture {
    use ed25519_dalek::{Signer, SigningKey};
    use lapkb_authorization_protocol::{
        EnvelopeSigner, LeaseIssue, OriginBinding, SeatAuthority, SigningError, issue_online_lease,
    };
    use lapkb_desktop_session::{
        DeviceKey, LeaseVerifier, LicenseRequest, Nonce, OpaqueId, Proof, ProofAuthority,
        ProtectedApp, Reply, VerificationKeySet, client::Client, client_store::ClientStore,
        transport,
    };
    use std::{
        fs, io,
        path::PathBuf,
        sync::{Arc, Mutex as StdMutex, atomic::AtomicU64},
        time::{SystemTime, UNIX_EPOCH},
    };

    const DEVICE_SEED: [u8; 32] = [7; 32];
    const SERVICE_SEED: [u8; 32] = [11; 32];
    const BROKER_INSTANCE: Nonce = Nonce::from_bytes([9; 32]);
    const GENERATION: u64 = 1;
    static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);

    pub(super) struct PrivateTempDir(PathBuf);

    impl PrivateTempDir {
        pub(super) fn new() -> io::Result<Self> {
            for _ in 0..128 {
                let nonce = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos();
                let sequence = NEXT_DIRECTORY.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let path = PathBuf::from("/tmp").join(format!(
                    "checkmate-native-{}-{nonce}-{sequence}",
                    std::process::id()
                ));
                match fs::create_dir(&path) {
                    Ok(()) => {
                        use std::os::unix::fs::PermissionsExt;
                        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
                        return Ok(Self(path));
                    }
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(error) => return Err(error),
                }
            }
            Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "could not allocate a private test directory",
            ))
        }

        pub(super) fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for PrivateTempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    struct TestSigner(SigningKey);

    impl EnvelopeSigner for TestSigner {
        fn key_id(&self) -> &str {
            "checkmate-native-test"
        }

        fn sign(&self, signing_input: &[u8]) -> Result<[u8; 64], SigningError> {
            Ok(self.0.sign(signing_input).to_bytes())
        }
    }

    struct BrokerState {
        account_id: String,
        sequence: u64,
        issued_at: i64,
    }

    impl BrokerState {
        fn new() -> Self {
            Self::account("account-a", 1)
        }

        fn account(account_id: &str, sequence: u64) -> Self {
            let issued_at = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock after epoch")
                .as_secs() as i64;
            Self {
                account_id: account_id.to_owned(),
                sequence,
                issued_at,
            }
        }
    }

    fn signed_reply(state: &BrokerState, request: LicenseRequest) -> Reply {
        let device = DeviceKey::from_seed(DEVICE_SEED);
        let lease_id = match (state.account_id.as_str(), state.sequence) {
            ("account-a", 1) => "00000000-0000-0000-0000-000000000001",
            ("account-b", 1) => "00000000-0000-0000-0000-000000000002",
            _ => "00000000-0000-0000-0000-000000000003",
        }
        .parse()
        .expect("lease id");
        let issue = LeaseIssue {
            account_id: OpaqueId::new(state.account_id.clone()).expect("account id"),
            license_id: OpaqueId::new(format!("license-{}", state.account_id)).expect("license id"),
            lease_id,
            device_id: OpaqueId::new("native-test-device").expect("device id"),
            device_public_key: device.public_key(),
            app_ids: vec![ProtectedApp::Checkerboard],
            sequence: state.sequence,
            issued_at: state.issued_at,
            expires_at: state.issued_at + 31 * 86_400,
            origin: OriginBinding::new(
                "00000000-0000-0000-0000-000000000010"
                    .parse()
                    .expect("origin request id"),
                Nonce::from_bytes([8; 32]),
            )
            .expect("origin binding"),
            seat: Some(
                SeatAuthority::new(
                    "00000000-0000-0000-0000-000000000041"
                        .parse()
                        .expect("reservation id"),
                    1,
                    state.issued_at,
                    Some(state.issued_at + 30),
                )
                .expect("seat authority"),
            ),
        };
        let signer = TestSigner(SigningKey::from_bytes(&SERVICE_SEED));
        let Ok((envelope, _)) = issue_online_lease(&signer, &issue) else {
            return Reply::Locked;
        };
        let Ok(proof) = Proof::issue(
            request,
            &envelope,
            &device,
            BROKER_INSTANCE,
            GENERATION,
            state.issued_at,
            ProofAuthority::Connected,
        ) else {
            return Reply::Locked;
        };
        Reply::Granted { proof }
    }

    pub(super) struct SignedBroker {
        pub(super) client: Arc<Client>,
        state: Arc<StdMutex<BrokerState>>,
        task: tokio::task::JoinHandle<()>,
        _broker_directory: PrivateTempDir,
        _store_directory: PrivateTempDir,
    }

    impl SignedBroker {
        pub(super) fn new() -> Self {
            let service_key = SigningKey::from_bytes(&SERVICE_SEED);
            let verifier = LeaseVerifier::new(
                VerificationKeySet::new(vec![(
                    "checkmate-native-test".to_owned(),
                    service_key.verifying_key().to_bytes(),
                )])
                .expect("verification key"),
            );
            let broker_directory = PrivateTempDir::new().expect("broker directory");
            let broker_path =
                fs::canonicalize(broker_directory.path()).expect("canonical broker directory");
            let listener = transport::Listener::bind(&broker_path).expect("broker listener");
            let state = Arc::new(StdMutex::new(BrokerState::new()));
            let state_for_task = Arc::clone(&state);
            let task = tokio::spawn(async move {
                loop {
                    let Ok(mut stream) = listener.accept().await else {
                        break;
                    };
                    loop {
                        let Ok(request) =
                            transport::read_frame::<LicenseRequest>(&mut stream).await
                        else {
                            break;
                        };
                        let reply = {
                            let state = state_for_task.lock().expect("broker state lock");
                            signed_reply(&state, request)
                        };
                        if transport::write_frame(&mut stream, &reply).await.is_err() {
                            break;
                        }
                    }
                }
            });
            let store_directory = PrivateTempDir::new().expect("client store directory");
            let store_path =
                fs::canonicalize(store_directory.path()).expect("canonical client store directory");
            let store =
                ClientStore::from_key_for_testing(ProtectedApp::Checkerboard, store_path, [8; 32])
                    .expect("synthetic encrypted client store");
            let client = Arc::new(
                Client::new(ProtectedApp::Checkerboard, broker_path, verifier, store)
                    .expect("native SDK client"),
            );
            Self {
                client,
                state,
                task,
                _broker_directory: broker_directory,
                _store_directory: store_directory,
            }
        }

        pub(super) fn set_account(&self, account_id: &str, sequence: u64) {
            *self.state.lock().expect("broker state lock") =
                BrokerState::account(account_id, sequence);
        }

        pub(super) async fn stop(&mut self) {
            self.task.abort();
            let _ = (&mut self.task).await;
        }
    }

    impl Drop for SignedBroker {
        fn drop(&mut self) {
            self.task.abort();
        }
    }
}

#[test]
fn locked_dispatch_allows_only_auth_controls_and_preserves_known_command_names() {
    let (app, webview) = mock_app(AuthState::test_locked());
    let commands = [
        "list_worksheets",
        "import_preview",
        "infer_mics",
        "prepare_drusano_data",
        "suggest_drusano_censor_limit",
        "fit_drusano_greco",
        "fit_musyc",
        "simulate_drusano_regimen",
        "analyze_table",
        "analyze_diamond",
        "export_results",
        "save_project_snapshot",
        "load_project_snapshot",
        "quit_application",
    ];
    assert_eq!(commands.len(), 14);
    for command in commands {
        assert!(is_protected_command(command));
        assert_eq!(
            invoke(&webview, command, json!({})),
            Err(json!({
                "code": "accessDenied",
                "message": AuthState::test_locked().denial_message()
            })),
            "{command} is denied before argument parsing while locked"
        );
    }
    assert!(!is_protected_command("auth_status"));
    assert!(!is_protected_command("auth_open_launcher"));
    assert!(!is_protected_command("auth_use_here"));
    assert!(!is_protected_command("unknown_command"));
    assert!(invoke(&webview, "unknown_command", json!({})).is_err());
    let status = invoke(&webview, "auth_status", json!({})).expect("auth status is allowed");
    assert_eq!(status["phase"], "unconfigured");
    assert!(status["user"].is_null());
    assert!(status["seat"].is_null());
    drop(app);
}

#[cfg(unix)]
#[tokio::test]
async fn registered_dispatch_rejects_account_a_work_after_switch_to_b_and_preserves_snapshot() {
    use broker_fixture::SignedBroker;
    use std::thread;

    let broker = SignedBroker::new();
    broker
        .client
        .refresh()
        .await
        .expect("genuine account A permit");
    let auth =
        AuthState::test_authorized(Arc::clone(&broker.client)).expect("verified Checkmate permit");
    let directory = broker_fixture::PrivateTempDir::new().expect("snapshot directory");
    let path = directory.path().join("previous.ckm");
    std::fs::write(&path, b"previous account A snapshot").expect("previous snapshot");
    let (app, webview) = mock_app(auth.clone());

    let pause = auth.test_pause_next_dispatch();
    let pending_webview = webview.clone();
    let pending_path = path.display().to_string();
    let pending = thread::spawn(move || {
        invoke(
            &pending_webview,
            "save_project_snapshot",
            json!({"path": pending_path, "snapshotJson": "new account A data"}),
        )
    });
    pause.wait_until_reached();

    broker.set_account("account-b", 1);
    broker
        .client
        .refresh()
        .await
        .expect("genuine account B permit");
    assert!(
        !auth.test_record_client_access(),
        "first B observation locks A"
    );
    assert!(
        auth.test_record_client_access(),
        "verified B becomes current"
    );
    assert!(auth.acquire_permit().is_some());

    pause.release();
    assert!(
        pending
            .join()
            .expect("queued invocation completes")
            .is_err()
    );
    assert_eq!(
        std::fs::read(&path).expect("previous snapshot remains intact"),
        b"previous account A snapshot"
    );
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    drop(app);
}

#[cfg(unix)]
#[tokio::test]
async fn revoked_permit_blocks_a_queued_snapshot_commit() {
    use broker_fixture::{PrivateTempDir, SignedBroker};
    use std::thread;

    let broker = SignedBroker::new();
    broker
        .client
        .refresh()
        .await
        .expect("genuine signed permit");
    let auth = AuthState::test_authorized(Arc::clone(&broker.client)).expect("authorized state");
    let directory = PrivateTempDir::new().expect("snapshot directory");
    let path = directory.path().join("previous.ckm");
    std::fs::write(&path, b"previous snapshot").expect("previous file");
    let (app, webview) = mock_app(auth.clone());

    let pause = auth.test_pause_next_dispatch();
    let pending_webview = webview.clone();
    let pending_path = path.display().to_string();
    let pending = thread::spawn(move || {
        invoke(
            &pending_webview,
            "save_project_snapshot",
            json!({"path": pending_path, "snapshotJson": "revoked data"}),
        )
    });
    pause.wait_until_reached();

    broker.client.disconnect();
    assert!(!auth.test_record_client_access());
    pause.release();

    assert!(
        pending
            .join()
            .expect("queued invocation completes")
            .is_err()
    );
    assert_eq!(std::fs::read(&path).unwrap(), b"previous snapshot");
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    drop(app);
}

#[cfg(unix)]
#[tokio::test]
async fn revoked_signed_permit_blocks_progress_channel_and_snapshot_commit() {
    use broker_fixture::{PrivateTempDir, SignedBroker};
    let broker = SignedBroker::new();
    broker
        .client
        .refresh()
        .await
        .expect("genuine signed permit");
    let auth = AuthState::test_authorized(Arc::clone(&broker.client)).expect("authorized state");
    let authorization = auth
        .capture_authorization()
        .expect("capture original permit");

    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let events_in_channel = Arc::clone(&events);
    let channel = tauri::ipc::Channel::<ProtectedOutput<AnalysisProgress>>::new(move |body| {
        events_in_channel
            .lock()
            .expect("event list lock")
            .push(body.deserialize::<Value>().expect("progress is JSON"));
        Ok(())
    });
    protected_output::send(
        &authorization,
        &channel,
        AnalysisProgress {
            completed_iterations: 1,
            total_iterations: 10,
        },
    )
    .expect("valid permit emits progress");
    assert_eq!(events.lock().unwrap().len(), 1);

    let directory = PrivateTempDir::new().expect("snapshot directory");
    let path = directory.path().join("previous.ckm");
    std::fs::write(&path, b"previous snapshot").expect("previous file");
    broker.client.disconnect();
    assert!(
        protected_output::send(
            &authorization,
            &channel,
            AnalysisProgress {
                completed_iterations: 2,
                total_iterations: 10,
            },
        )
        .is_err(),
        "revoked event serialization must fail"
    );
    assert_eq!(
        events.lock().unwrap().len(),
        1,
        "revoked progress was not emitted"
    );
    assert!(
        services::snapshot::save(
            path.to_str().expect("UTF-8 temporary path"),
            "new snapshot",
            &|| authorization.is_valid(),
        )
        .is_err()
    );
    assert_eq!(std::fs::read(&path).unwrap(), b"previous snapshot");
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn captured_work_does_not_start_after_the_sdk_changes_accounts() {
    use broker_fixture::SignedBroker;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::thread;

    let broker = SignedBroker::new();
    broker
        .client
        .refresh()
        .await
        .expect("genuine account A permit");
    let auth = AuthState::test_authorized(Arc::clone(&broker.client)).expect("account A state");
    let authorization = auth.capture_authorization().expect("captured account A");
    let entered = Arc::new(AtomicBool::new(false));
    let entered_by_work = Arc::clone(&entered);
    let (release, wait) = mpsc::sync_channel(0);
    let worker = thread::spawn(move || {
        wait.recv().expect("queued work released");
        run_protected_work(authorization, move |_| {
            entered_by_work.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        })
    });

    broker.set_account("account-b", 1);
    broker.client.refresh().await.expect("account B proof");
    assert!(!auth.test_record_client_access());
    assert!(auth.test_record_client_access());
    release.send(()).expect("release queued work");
    assert!(worker.join().expect("worker completes").is_err());
    assert!(!entered.load(Ordering::SeqCst));
}

#[cfg(unix)]
#[tokio::test]
async fn broker_transport_failure_clears_captured_authorization_and_registered_status() {
    use broker_fixture::SignedBroker;

    let mut broker = SignedBroker::new();
    broker
        .client
        .refresh()
        .await
        .expect("genuine signed permit before broker failure");
    let auth =
        AuthState::test_authorized(Arc::clone(&broker.client)).expect("verified Checkmate permit");
    let original_authorization = auth
        .capture_authorization()
        .expect("capture the original signed permit");
    let (_app, webview) = mock_app(auth.clone());
    let initial_status = invoke(&webview, "auth_status", json!({}))
        .expect("registered auth_status is available before failure");
    assert_eq!(initial_status["phase"], "authenticated");

    broker.stop().await;
    assert!(
        broker.client.refresh().await.is_err(),
        "closed broker transport makes SDK refresh fail"
    );
    assert!(
        broker.client.permit().is_none(),
        "SDK discarded the prior permit"
    );
    assert!(
        !auth.test_record_client_access(),
        "AuthState records the SDK's missing permit as locked"
    );
    assert!(auth.acquire_permit().is_none());
    assert!(
        !original_authorization.is_valid(),
        "the captured original permit is rejected after transport failure"
    );

    let status = invoke(&webview, "auth_status", json!({}))
        .expect("registered auth_status remains available while locked");
    assert_eq!(status["phase"], "suspended");
    assert!(status["user"].is_null());
}
