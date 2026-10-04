//! Fixed current-user Launcher re-entry, not an authorization or updater API.
//! Launcher 0.1.9 is bootstrapped manually from the website with its checksum;
//! there is deliberately no invented Launcher signing key/self-update claim.
//! This native boundary verifies the local scope, ACL, path, PE product/version,
//! and immutable open-file identity. It never accepts a caller path/argument.
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle},
    },
    path::{Component, Path, PathBuf, Prefix},
    process::{Command, Stdio},
    ptr,
    sync::atomic::{AtomicBool, Ordering},
};
use windows_sys::Win32::{
    Foundation::{
        ERROR_FILE_NOT_FOUND, ERROR_NO_MORE_ITEMS, ERROR_PATH_NOT_FOUND, GENERIC_READ,
        GENERIC_WRITE, INVALID_HANDLE_VALUE, LocalFree,
    },
    Security::{
        Authorization::{ConvertSidToStringSidW, GetSecurityInfo, SE_FILE_OBJECT},
        *,
    },
    Storage::FileSystem::*,
    System::{Com::CoTaskMemFree, Registry::*, Threading::*},
    UI::Shell::{FOLDERID_LocalAppData, SHGetKnownFolderPath},
};
static STARTUP_ATTEMPTED: AtomicBool = AtomicBool::new(false);
const PRODUCT: &str = "LAPKB Launcher";
const BINARY: &str = "lapkb-launcher.exe";
const KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LAPKB Launcher";
fn wide(s: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain(Some(0)).collect()
}
fn registry(hive: HKEY, name: &str, view: u32) -> Result<Option<String>, ()> {
    registry_at(hive, KEY, name, view)
}
fn registry_at(hive: HKEY, key: &str, name: &str, view: u32) -> Result<Option<String>, ()> {
    let mut buffer = [0u16; 2048];
    let mut size = std::mem::size_of_val(&buffer) as u32;
    let status = unsafe {
        RegGetValueW(
            hive,
            wide(key).as_ptr(),
            wide(name).as_ptr(),
            RRF_RT_REG_SZ | view,
            ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if matches!(status, ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND) {
        return Ok(None);
    }
    if status != 0 || size < 2 || size as usize > std::mem::size_of_val(&buffer) || size % 2 != 0 {
        return Err(());
    }
    let end = size as usize / 2 - 1;
    if buffer[end] != 0 || buffer[..end].contains(&0) {
        return Err(());
    }
    Ok(Some(String::from_utf16(&buffer[..end]).map_err(|_| ())?))
}
fn local_data() -> Result<PathBuf, ()> {
    let mut output = ptr::null_mut();
    if unsafe { SHGetKnownFolderPath(&FOLDERID_LocalAppData, 0, ptr::null_mut(), &mut output) } < 0
        || output.is_null()
    {
        return Err(());
    }
    let result = (|| {
        let mut length = 0;
        while unsafe { *output.add(length) } != 0 {
            length += 1;
            if length > 32767 {
                return Err(());
            }
        }
        Ok(PathBuf::from(
            String::from_utf16(unsafe { std::slice::from_raw_parts(output, length) })
                .map_err(|_| ())?,
        ))
    })();
    unsafe { CoTaskMemFree(output.cast()) };
    result
}
fn component(name: &str) -> Result<(), ()> {
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    if name.is_empty()
        || name.ends_with(['.', ' '])
        || name.chars().any(|c| {
            c.is_control() || matches!(c, ':' | '<' | '>' | '"' | '|' | '?' | '*' | '/' | '\\')
        })
        || matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        )
        || ["COM", "LPT"].iter().any(|p| {
            stem.strip_prefix(p).is_some_and(|n| {
                matches!(
                    n,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        })
    {
        return Err(());
    }
    Ok(())
}
fn local_path(path: &Path) -> Result<(), ()> {
    let mut parts = path.components();
    let Some(Component::Prefix(prefix)) = parts.next() else {
        return Err(());
    };
    let Prefix::Disk(letter) = prefix.kind() else {
        return Err(());
    };
    if !matches!(parts.next(), Some(Component::RootDir))
        || unsafe { GetDriveTypeW(wide(format!("{}:\\", char::from(letter))).as_ptr()) } != 3
    {
        return Err(());
    }
    for part in parts {
        let Component::Normal(name) = part else {
            return Err(());
        };
        component(name.to_str().ok_or(())?)?;
    }
    Ok(())
}
fn sid_text(sid: *mut core::ffi::c_void) -> Result<String, ()> {
    if sid.is_null() || unsafe { IsValidSid(sid) } == 0 {
        return Err(());
    }
    let mut output = ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut output) } == 0 {
        return Err(());
    }
    let result = (|| {
        let mut length = 0;
        while unsafe { *output.add(length) } != 0 {
            length += 1;
            if length > 256 {
                return Err(());
            }
        }
        String::from_utf16(unsafe { std::slice::from_raw_parts(output, length) }).map_err(|_| ())
    })();
    unsafe { LocalFree(output.cast()) };
    result
}
fn user_sid() -> Result<String, ()> {
    let mut handle = ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut handle) } == 0 {
        return Err(());
    }
    let token = unsafe { File::from_raw_handle(handle) };
    let mut size = 0;
    unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            ptr::null_mut(),
            0,
            &mut size,
        )
    };
    if size == 0 || size > 65536 {
        return Err(());
    }
    let mut buffer = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            buffer.as_mut_ptr().cast(),
            size,
            &mut size,
        )
    } == 0
    {
        return Err(());
    }
    if (size as usize) < std::mem::size_of::<TOKEN_USER>() {
        return Err(());
    }
    let sid = unsafe { (*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid };
    let start = buffer.as_ptr() as usize;
    let address = sid as usize;
    if address < start
        || address
            .checked_add(8)
            .is_none_or(|n| n > start + size as usize)
    {
        return Err(());
    }
    let length = 8 + unsafe { *sid.cast::<u8>().add(1) } as usize * 4;
    if length > 68
        || address
            .checked_add(length)
            .is_none_or(|n| n > start + size as usize)
    {
        return Err(());
    }
    sid_text(sid)
}
// Windows servicing may own OS directories, never our state or product files.
const TRUSTED_INSTALLER: &str = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
fn acl_trusted(who: &str, user: &str, directory: bool, owned: bool) -> bool {
    who == user
        || matches!(who, "S-1-5-18" | "S-1-5-32-544")
        || (directory && !owned && who == TRUSTED_INSTALLER)
}
fn acl_owner_allowed(owner: &str, user: &str, directory: bool, owned: bool) -> bool {
    if owned {
        owner == user
    } else {
        acl_trusted(owner, user, directory, false)
    }
}
fn acl_grant_allowed(
    who: &str,
    user: &str,
    mask: u32,
    flags: u8,
    directory: bool,
    owned: bool,
) -> bool {
    if flags & !0x1f != 0 {
        return false;
    }
    if flags & 8 != 0 {
        return true;
    } // inherit-only does not apply to this object
    if acl_trusted(who, user, directory, owned) {
        return true;
    }
    // On OS ancestry only, Users/Authenticated Users can create siblings. Held
    // existing children are not delete-shared; these rights cannot replace them.
    // The same bits on files mean WRITE_DATA/APPEND_DATA and are always unsafe.
    let sibling_creation = directory && !owned && matches!(who, "S-1-5-32-545" | "S-1-5-11");
    let mutations = DELETE
        | WRITE_DAC
        | WRITE_OWNER
        | FILE_DELETE_CHILD
        | FILE_WRITE_EA
        | FILE_WRITE_ATTRIBUTES
        | GENERIC_WRITE
        | 0x10000000
        | if sibling_creation {
            0
        } else {
            FILE_WRITE_DATA | FILE_APPEND_DATA
        };
    mask & mutations == 0
}
fn acl(file: &File, user: &str, directory: bool, owned: bool) -> Result<(), ()> {
    let mut owner = ptr::null_mut();
    let mut dacl = ptr::null_mut();
    let mut sd = ptr::null_mut();
    if unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            ptr::null_mut(),
            &mut dacl,
            ptr::null_mut(),
            &mut sd,
        )
    } != 0
    {
        return Err(());
    }
    let result = (|| {
        if sd.is_null() || dacl.is_null() {
            return Err(());
        }
        let owner = sid_text(owner)?;
        if !acl_owner_allowed(&owner, user, directory, owned) {
            return Err(());
        }
        let mut info = ACL_SIZE_INFORMATION::default();
        if unsafe {
            GetAclInformation(
                dacl,
                (&mut info as *mut ACL_SIZE_INFORMATION).cast(),
                std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
        } == 0
            || info.AceCount > 256
        {
            return Err(());
        }
        for index in 0..info.AceCount {
            let mut ace = ptr::null_mut();
            if unsafe { GetAce(dacl, index, &mut ace) } == 0 || ace.is_null() {
                return Err(());
            }
            let header = unsafe { &*ace.cast::<ACE_HEADER>() };
            if header.AceType == 1 {
                continue;
            }
            if header.AceType != 0 {
                return Err(());
            }
            let offset = std::mem::offset_of!(ACCESS_ALLOWED_ACE, SidStart);
            if (header.AceSize as usize) < offset + 8 {
                return Err(());
            }
            let allowed = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
            let sid = ptr::addr_of!(allowed.SidStart) as *mut core::ffi::c_void;
            if offset + 8 + unsafe { *sid.cast::<u8>().add(1) } as usize * 4
                != header.AceSize as usize
            {
                return Err(());
            }
            if !acl_grant_allowed(
                &sid_text(sid)?,
                user,
                allowed.Mask,
                header.AceFlags,
                directory,
                owned,
            ) {
                return Err(());
            }
        }
        Ok(())
    })();
    if !sd.is_null() {
        unsafe { LocalFree(sd.cast()) };
    }
    result
}
fn open(path: &Path, directory: bool, owned: bool, user: &str) -> Result<File, ()> {
    local_path(path)?;
    let handle = unsafe {
        CreateFileW(
            wide(path).as_ptr(),
            GENERIC_READ | READ_CONTROL,
            FILE_SHARE_READ | if directory { FILE_SHARE_WRITE } else { 0 },
            ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT
                | if directory {
                    FILE_FLAG_BACKUP_SEMANTICS
                } else {
                    0
                },
            ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(());
    }
    let file = unsafe { File::from_raw_handle(handle) };
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0
        || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory
        || (!directory && info.nNumberOfLinks != 1)
    {
        return Err(());
    }
    acl(&file, user, directory, owned)?;
    Ok(file)
}
fn pe_product(path: &Path, file: &mut File) -> Result<(), ()> {
    let mut dos = [0u8; 64];
    file.read_exact(&mut dos).map_err(|_| ())?;
    if &dos[..2] != b"MZ" {
        return Err(());
    }
    let offset = u32::from_le_bytes(dos[60..64].try_into().map_err(|_| ())?) as u64;
    if !(64..=1048576).contains(&offset) {
        return Err(());
    }
    file.seek(SeekFrom::Start(offset)).map_err(|_| ())?;
    let mut pe = [0u8; 6];
    file.read_exact(&mut pe).map_err(|_| ())?;
    if &pe[..4] != b"PE\0\0" || u16::from_le_bytes([pe[4], pe[5]]) != 0x8664 {
        return Err(());
    }
    let size = unsafe { GetFileVersionInfoSizeW(wide(path).as_ptr(), ptr::null_mut()) };
    if size == 0 || size > 1048576 {
        return Err(());
    }
    let mut buffer = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
    if unsafe { GetFileVersionInfoW(wide(path).as_ptr(), 0, size, buffer.as_mut_ptr().cast()) } == 0
    {
        return Err(());
    }
    let query = |name: &str| -> Result<(*mut core::ffi::c_void, u32), ()> {
        let mut output = ptr::null_mut();
        let mut length = 0;
        if unsafe {
            VerQueryValueW(
                buffer.as_ptr().cast(),
                wide(name).as_ptr(),
                &mut output,
                &mut length,
            )
        } == 0
            || output.is_null()
        {
            return Err(());
        }
        Ok((output, length))
    };
    let (fixed, length) = query("\\")?;
    let start = buffer.as_ptr() as usize;
    let bounded = |pointer: *mut core::ffi::c_void, count: usize| {
        pointer as usize >= start
            && (pointer as usize)
                .checked_add(count)
                .is_some_and(|n| n <= start + size as usize)
    };
    if length as usize != std::mem::size_of::<VS_FIXEDFILEINFO>()
        || !bounded(fixed, length as usize)
    {
        return Err(());
    }
    let fixed = unsafe { ptr::read_unaligned(fixed.cast::<VS_FIXEDFILEINFO>()) };
    let version = (
        fixed.dwProductVersionMS >> 16,
        fixed.dwProductVersionMS & 65535,
        fixed.dwProductVersionLS >> 16,
    );
    if fixed.dwSignature != 0xfeef04bd
        || fixed.dwProductVersionLS & 65535 != 0
        || version < (0, 1, 9)
    {
        return Err(());
    }
    let (translations, length) = query("\\VarFileInfo\\Translation")?;
    if length == 0 || length > 64 || length % 4 != 0 || !bounded(translations, length as usize) {
        return Err(());
    }
    let translations =
        unsafe { std::slice::from_raw_parts(translations.cast::<u16>(), length as usize / 2) };
    for pair in translations.chunks_exact(2) {
        let (product, chars) = query(&format!(
            "\\StringFileInfo\\{:04x}{:04x}\\ProductName",
            pair[0], pair[1]
        ))?;
        if chars == 0 || chars > 256 || !bounded(product, chars as usize * 2) {
            return Err(());
        }
        let text = unsafe { std::slice::from_raw_parts(product.cast::<u16>(), chars as usize) };
        if text.last() != Some(&0)
            || String::from_utf16(&text[..text.len() - 1]).map_err(|_| ())? != PRODUCT
        {
            return Err(());
        }
    }
    Ok(())
}

struct RegistryKey(HKEY);
impl Drop for RegistryKey {
    fn drop(&mut self) {
        unsafe { RegCloseKey(self.0) };
    }
}
fn reject_other_registrations() -> Result<(), ()> {
    const ROOT: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    for (hive, key_view, value_view) in [
        (HKEY_LOCAL_MACHINE, KEY_WOW64_64KEY, RRF_SUBKEY_WOW6464KEY),
        (HKEY_LOCAL_MACHINE, KEY_WOW64_32KEY, RRF_SUBKEY_WOW6432KEY),
        (HKEY_CURRENT_USER, KEY_WOW64_64KEY, RRF_SUBKEY_WOW6464KEY),
        (HKEY_CURRENT_USER, KEY_WOW64_32KEY, RRF_SUBKEY_WOW6432KEY),
    ] {
        let mut handle = ptr::null_mut();
        let status = unsafe {
            RegOpenKeyExW(
                hive,
                wide(ROOT).as_ptr(),
                0,
                KEY_READ | key_view,
                &mut handle,
            )
        };
        if matches!(status, ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND) {
            continue;
        }
        if status != 0 {
            return Err(());
        }
        let key = RegistryKey(handle);
        let mut exhausted = false;
        for index in 0..8192 {
            if std::time::Instant::now() > deadline {
                return Err(());
            }
            let mut name = [0u16; 256];
            let mut length = name.len() as u32;
            let status = unsafe {
                RegEnumKeyExW(
                    key.0,
                    index,
                    name.as_mut_ptr(),
                    &mut length,
                    ptr::null(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                )
            };
            if status == ERROR_NO_MORE_ITEMS {
                exhausted = true;
                break;
            }
            if status != 0 || length as usize >= name.len() {
                return Err(());
            }
            let leaf = String::from_utf16(&name[..length as usize]).map_err(|_| ())?;
            if hive == HKEY_CURRENT_USER && leaf.eq_ignore_ascii_case(PRODUCT) {
                continue;
            }
            if registry_at(hive, &format!("{ROOT}\\{leaf}"), "DisplayName", value_view)?
                .is_some_and(|display| display.eq_ignore_ascii_case(PRODUCT))
            {
                return Err(());
            }
        }
        if !exhausted {
            return Err(());
        }
    }
    Ok(())
}

pub(super) fn open_launcher(startup: bool) -> Result<(), ()> {
    if startup && STARTUP_ATTEMPTED.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    reject_other_registrations()?;
    for (hive, view) in [
        (HKEY_LOCAL_MACHINE, RRF_SUBKEY_WOW6464KEY),
        (HKEY_LOCAL_MACHINE, RRF_SUBKEY_WOW6432KEY),
    ] {
        if registry(hive, "DisplayName", view)?.is_some() {
            return Err(());
        }
    }
    let view = RRF_SUBKEY_WOW6464KEY;
    // Shared HKCU views can name the same current-user registration. Accept
    // only equal aliases, never a differing 32-bit/custom installation.
    if registry(HKEY_CURRENT_USER, "DisplayName", RRF_SUBKEY_WOW6432KEY)?.is_some() {
        for field in [
            "DisplayName",
            "MainBinaryName",
            "InstallLocation",
            "DisplayVersion",
        ] {
            if registry(HKEY_CURRENT_USER, field, view)?
                != registry(HKEY_CURRENT_USER, field, RRF_SUBKEY_WOW6432KEY)?
            {
                return Err(());
            }
        }
    }
    if registry(HKEY_CURRENT_USER, "DisplayName", view)?.as_deref() != Some(PRODUCT)
        || registry(HKEY_CURRENT_USER, "MainBinaryName", view)?.as_deref() != Some(BINARY)
    {
        return Err(());
    }
    for msi_view in [view, RRF_SUBKEY_WOW6432KEY] {
        let mut msi = 0u32;
        let mut bytes = 4;
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                wide(KEY).as_ptr(),
                wide("WindowsInstaller").as_ptr(),
                RRF_RT_REG_DWORD | msi_view,
                ptr::null_mut(),
                (&mut msi as *mut u32).cast(),
                &mut bytes,
            )
        };
        if !(status == ERROR_FILE_NOT_FOUND || (status == 0 && bytes == 4 && msi == 0)) {
            return Err(());
        }
    }
    let data = local_data()?;
    let root = data.join(PRODUCT);
    let registered = registry(HKEY_CURRENT_USER, "InstallLocation", view)?.ok_or(())?;
    let registered = registered
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .ok_or(())?;
    if Path::new(registered) != root {
        return Err(());
    }
    let user = user_sid()?;
    let mut held = Vec::new();
    let mut current = PathBuf::new();
    for part in root.components() {
        current.push(part.as_os_str());
        if matches!(part, Component::Prefix(_)) {
            continue;
        }
        held.push(open(
            &current,
            true,
            current == data || current == root,
            &user,
        )?);
    }
    let path = root.join(BINARY);
    let mut executable = open(&path, false, true, &user)?;
    pe_product(&path, &mut executable)?;
    // Empty argument vector, fixed direct native spawn; no credentials/shell,
    // renderer path, UninstallString, hidden elevation or owner replacement.
    let child = Command::new(&path)
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| ())?;
    drop(executable);
    drop(held);
    std::thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn servicing_ancestor_and_current_user_product_acl_fixtures() {
        const USER: &str = "S-1-5-21-111-222-333-1001";
        const STRANGER: &str = "S-1-5-21-111-222-333-1002";
        // Drive-root/OS ancestry: servicing owner, administrator/system full
        // access, user-group read/traverse plus sibling creation, creator-owner
        // full access only on inherited children. No host ACL is changed.
        let ancestor = [
            (TRUSTED_INSTALLER, FILE_ALL_ACCESS, 0u8),
            ("S-1-5-18", FILE_ALL_ACCESS, 0),
            ("S-1-5-32-544", FILE_ALL_ACCESS, 0),
            ("S-1-5-32-545", 0x1200a9, 0),
            ("S-1-5-11", 0x1200a9 | FILE_APPEND_DATA, 0),
            ("S-1-3-0", FILE_ALL_ACCESS, 0x0b),
        ];
        assert!(acl_owner_allowed(TRUSTED_INSTALLER, USER, true, false));
        for (sid, mask, flags) in ancestor {
            assert!(
                acl_grant_allowed(sid, USER, mask, flags, true, false),
                "{sid}"
            );
        }
        assert!(acl_owner_allowed(USER, USER, true, true));
        for owner in [
            TRUSTED_INSTALLER,
            "S-1-5-18",
            "S-1-5-32-544",
            STRANGER,
            "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478465",
        ] {
            assert!(!acl_owner_allowed(owner, USER, true, true));
        }
        assert!(!acl_owner_allowed(TRUSTED_INSTALLER, USER, false, false));
        assert!(!acl_owner_allowed(STRANGER, USER, true, false));
        for (sid, mask, flags) in [
            (USER, FILE_ALL_ACCESS, 0),
            ("S-1-5-18", FILE_ALL_ACCESS, 0x13),
            ("S-1-5-32-544", FILE_ALL_ACCESS, 0x13),
            ("S-1-5-32-545", 0x1200a9, 0x13),
        ] {
            assert!(acl_grant_allowed(sid, USER, mask, flags, true, true));
        }
        // ADD_SUBDIRECTORY on a safe ancestor is not APPEND_DATA on a file.
        for sid in ["S-1-5-11", "S-1-5-32-545"] {
            for mask in [FILE_WRITE_DATA, FILE_APPEND_DATA] {
                assert!(acl_grant_allowed(sid, USER, mask, 0, true, false));
                assert!(!acl_grant_allowed(sid, USER, mask, 0, true, true));
                assert!(!acl_grant_allowed(sid, USER, mask, 0, false, false));
            }
        }
        for sid in [STRANGER, "S-1-1-0", "S-1-5-11", "S-1-5-32-545"] {
            for mask in [
                DELETE,
                WRITE_DAC,
                WRITE_OWNER,
                FILE_DELETE_CHILD,
                FILE_WRITE_EA,
                FILE_WRITE_ATTRIBUTES,
                0x40000000,
                0x10000000,
            ] {
                assert!(
                    !acl_grant_allowed(sid, USER, mask, 0, true, false),
                    "{sid} {mask:x}"
                );
            }
        }
        assert!(!acl_grant_allowed(
            STRANGER,
            USER,
            FILE_APPEND_DATA,
            0,
            true,
            false
        ));
        assert!(!acl_grant_allowed(
            TRUSTED_INSTALLER,
            USER,
            FILE_ALL_ACCESS,
            0,
            true,
            true
        ));
        assert!(!acl_grant_allowed(
            TRUSTED_INSTALLER,
            USER,
            FILE_ALL_ACCESS,
            0,
            false,
            false
        ));
        assert!(!acl_grant_allowed(
            USER,
            USER,
            FILE_ALL_ACCESS,
            0x80,
            true,
            false
        ));
        // An inherited effective broad grant on our product is still unsafe.
        assert!(!acl_grant_allowed(
            STRANGER,
            USER,
            FILE_ALL_ACCESS,
            0x13,
            true,
            true
        ));
    }
    #[test]
    fn no_network_relative_or_device_paths_qualify() {
        for path in [
            "\\\\server\\share\\app.exe",
            "C:app.exe",
            "app.exe",
            "C:\\foo\\..\\app.exe",
            "C:\\NUL",
        ] {
            assert!(local_path(Path::new(path)).is_err());
        }
    }
}
