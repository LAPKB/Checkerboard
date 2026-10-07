use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT_STAGING_ID: AtomicU64 = AtomicU64::new(0);

/// Write into a unique same-directory staging file and replace the destination
/// only while the captured authorization remains current. A failed guard or
/// commit leaves any previous destination intact.
pub(crate) fn write_authorized(
    path: &Path,
    contents: &[u8],
    authorized: &dyn Fn() -> bool,
) -> io::Result<()> {
    if !authorized() {
        return Err(permission_denied());
    }
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let (staging_path, mut staging_file) = create_staging_file(parent)?;
    let result = (|| {
        staging_file.write_all(contents)?;
        staging_file.sync_all()?;
        drop(staging_file);
        if !authorized() {
            return Err(permission_denied());
        }
        replace_file(&staging_path, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staging_path);
    }
    result
}

fn create_staging_file(parent: &Path) -> io::Result<(PathBuf, File)> {
    for _ in 0..128 {
        let id = NEXT_STAGING_ID.fetch_add(1, Ordering::Relaxed);
        let path = parent.join(format!(".checkmate-{}-{id}.tmp", std::process::id()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not create unique Checkmate staging file",
    ))
}

fn permission_denied() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "protected write was revoked",
    )
}

#[cfg(not(windows))]
fn replace_file(staging: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(staging, destination)
}

#[cfg(windows)]
fn replace_file(staging: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x0000_0001;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }

    let staging = wide(staging);
    let destination = wide(destination);
    // Both paths are in the same directory and staging is exclusively owned.
    // SAFETY: the buffers are nul-terminated and remain alive for this call.
    let replaced = unsafe {
        MoveFileExW(
            staging.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if replaced == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::{SystemTime, UNIX_EPOCH},
    };

    fn private_temp_dir() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "checkmate-atomic-write-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&path).expect("create test directory");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
                .expect("make test directory private");
        }
        path
    }

    #[test]
    fn revoked_commit_keeps_the_previous_file_and_removes_staging() {
        let directory = private_temp_dir();
        let destination = directory.join("snapshot.ckm");
        fs::write(&destination, b"previous snapshot").expect("create old snapshot");
        let checks = Arc::new(AtomicUsize::new(0));
        let result = write_authorized(&destination, b"new snapshot", &|| {
            checks.fetch_add(1, Ordering::SeqCst) == 0
        });
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(
            fs::read(&destination).expect("previous file remains"),
            b"previous snapshot"
        );
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn authorized_commit_replaces_the_previous_file() {
        let directory = private_temp_dir();
        let destination = directory.join("export.xlsx");
        fs::write(&destination, b"old workbook").expect("create previous workbook");
        write_authorized(&destination, b"complete new workbook", &|| true).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"complete new workbook");
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        fs::remove_dir_all(directory).unwrap();
    }
}
