use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=LAPKB_LOCAL_SIGNING_KID");
    println!("cargo:rerun-if-env-changed=LAPKB_LOCAL_SIGNING_PUBLIC_KEY_B64");

    if env::var_os("CARGO_FEATURE_LOCAL_STAGING").is_some() {
        let kid = env::var("LAPKB_LOCAL_SIGNING_KID").ok();
        let public_key = env::var("LAPKB_LOCAL_SIGNING_PUBLIC_KEY_B64").ok();
        let output = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo output directory"));
        fs::write(
            output.join("local_staging_config.rs"),
            format!(
                "pub const SIGNING_KID: Option<&str> = {kid:?};\n\
                 pub const SIGNING_PUBLIC_KEY_B64: Option<&str> = {public_key:?};\n"
            ),
        )
        .expect("write local staging verification configuration");
    }

    tauri_build::build()
}
