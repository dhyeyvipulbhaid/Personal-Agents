//! The memory key lives in the OS keychain.
//! macOS uses Keychain. Windows uses Credential Manager.
//! Nothing in this module writes the key to a log.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::sync::Mutex;

#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
pub const SERVICE: &str = "com.personalagents.desktop";
#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
pub const ACCOUNT: &str = "memory-bank";

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const MISSING_STORE: &str =
    "Memory encryption stores the key in the macOS Keychain or Windows Credential Manager.";

pub const DENIED_MESSAGE: &str = "Keychain access was denied";
pub const MISSING_KEY_MESSAGE: &str =
    "Memory is encrypted, but the key is missing from the macOS Keychain or Windows Credential Manager.";
pub const WRONG_PASSPHRASE_MESSAGE: &str = "The passphrase does not match this memory file.";

pub trait SecretStore {
    fn get(&self) -> Result<Option<String>, String>;
    fn set(&self, secret: &str) -> Result<(), String>;
}

/// One keychain read per session. A denial is remembered so later graph,
/// recall, and retain calls do not prompt again until the user presses Retry.
pub struct SessionKeys {
    cached: Mutex<Option<CachedKey>>,
}

enum CachedKey {
    Value(String),
    Missing,
    Denied(String),
}

impl SessionKeys {
    pub fn new() -> Self {
        Self {
            cached: Mutex::new(None),
        }
    }

    pub fn read(&self, store: &impl SecretStore) -> Result<String, String> {
        let mut slot = self.cached.lock().expect("key cache");
        if let Some(cached) = slot.as_ref() {
            return cached_result(cached);
        }
        let next = match store.get() {
            Ok(Some(value)) if !value.trim().is_empty() => {
                CachedKey::Value(value.trim().to_string())
            }
            Ok(_) => CachedKey::Missing,
            Err(err) if is_keychain_denial(&err) => CachedKey::Denied(DENIED_MESSAGE.to_string()),
            Err(err) => return Err(err),
        };
        let result = cached_result(&next);
        *slot = Some(next);
        result
    }

    /// A new user action, such as Retry or Encrypt, may read the keychain once.
    pub fn retry(&self, store: &impl SecretStore) -> Result<String, String> {
        *self.cached.lock().expect("key cache") = None;
        self.read(store)
    }

    pub fn remember(&self, key: String) {
        *self.cached.lock().expect("key cache") = Some(CachedKey::Value(key));
    }

    pub fn remembered(&self) -> Option<String> {
        match self.cached.lock().expect("key cache").as_ref() {
            Some(CachedKey::Value(key)) => Some(key.clone()),
            _ => None,
        }
    }

    pub fn clear(&self) {
        *self.cached.lock().expect("key cache") = None;
    }

    pub fn deny(&self) {
        *self.cached.lock().expect("key cache") = Some(CachedKey::Denied(DENIED_MESSAGE.into()));
    }
}

fn cached_result(cached: &CachedKey) -> Result<String, String> {
    match cached {
        CachedKey::Value(key) => Ok(key.clone()),
        CachedKey::Missing => Err(MISSING_KEY_MESSAGE.into()),
        CachedKey::Denied(err) => Err(err.clone()),
    }
}

pub fn is_keychain_denial(err: &str) -> bool {
    let lower = err.to_lowercase();
    err.starts_with(DENIED_MESSAGE)
        || lower.contains("platform secure storage failure")
        || lower.contains("couldn't access platform secure storage")
        || lower.contains("errsecauthfailed")
        || lower.contains("errsecusercanceled")
        || lower.contains("user canceled")
        || lower.contains("user cancelled")
        || lower.contains("-25293")
        || lower.contains(" -128")
}

pub struct PassphraseSeal {
    pub salt: String,
    pub check: String,
}

/// Derive a memory key. Only the salt and a check are stored, not the key.
pub fn seal_passphrase(passphrase: &str) -> Result<(String, PassphraseSeal), String> {
    check_passphrase(passphrase)?;
    let mut salt = [0u8; 16];
    getrandom::getrandom(&mut salt)
        .map_err(|_| "Could not generate a passphrase salt.".to_string())?;
    let key = derive_passphrase(passphrase, &salt)?;
    Ok((
        STANDARD.encode(key),
        PassphraseSeal {
            salt: STANDARD.encode(salt),
            check: STANDARD.encode(key_check(&key)),
        },
    ))
}

pub fn open_passphrase(passphrase: &str, seal: &PassphraseSeal) -> Result<String, String> {
    check_passphrase(passphrase)?;
    let salt = STANDARD
        .decode(seal.salt.trim())
        .map_err(|_| "The passphrase record is not valid.".to_string())?;
    let expected = STANDARD
        .decode(seal.check.trim())
        .map_err(|_| "The passphrase record is not valid.".to_string())?;
    let key = derive_passphrase(passphrase, &salt)?;
    if !eq_bytes(&key_check(&key), &expected) {
        return Err(WRONG_PASSPHRASE_MESSAGE.into());
    }
    Ok(STANDARD.encode(key))
}

fn check_passphrase(passphrase: &str) -> Result<(), String> {
    if passphrase.trim().chars().count() < 8 {
        return Err("Use a passphrase of at least 8 characters.".into());
    }
    Ok(())
}

fn derive_passphrase(passphrase: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let params = argon2::Params::new(19_456, 2, 1, Some(32))
        .map_err(|_| "Could not derive a memory key.".to_string())?;
    let mut key = [0u8; 32];
    argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params)
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|_| "Could not derive a memory key.".to_string())?;
    Ok(key)
}

fn key_check(key: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(b"personal-agents-memory-v1");
    hasher.update(key);
    hasher.finalize().into()
}

fn eq_bytes(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (left_byte, right_byte) in left.iter().zip(right.iter()) {
        diff |= left_byte ^ right_byte;
    }
    diff == 0
}

pub struct OsSecretStore;

impl SecretStore for OsSecretStore {
    fn get(&self) -> Result<Option<String>, String> {
        os_get()
    }

    fn set(&self, secret: &str) -> Result<(), String> {
        os_set(secret)
    }
}

#[cfg(test)]
pub fn load_or_create(store: &impl SecretStore) -> Result<String, String> {
    if let Some(existing) = store.get()? {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    let created = generate_key()?;
    store.set(&created)?;
    Ok(created)
}

/// Write a key only when a later read of the same service and account returns it.
/// A failure here must not be followed by encrypting the bank.
#[cfg(test)]
pub fn store_and_verify(store: &impl SecretStore) -> Result<String, String> {
    let key = load_or_create(store)?;
    let read_back = store.get()?.map(|value| value.trim().to_string());
    match read_back {
        Some(value) if value == key => Ok(key),
        _ => Err(
            "The memory key could not be read back from the macOS Keychain or Windows Credential Manager. Memory was not encrypted."
                .into(),
        ),
    }
}

pub fn generate_key() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|_| "Could not generate a memory key.".to_string())?;
    Ok(STANDARD.encode(bytes))
}

pub fn redact(text: &str, secret: &str) -> String {
    let hidden = secret.trim();
    if hidden.is_empty() {
        return text.to_string();
    }
    text.replace(hidden, "[redacted]")
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn os_get() -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(SERVICE, ACCOUNT).map_err(keychain_error)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(keyring::Error::NoStorageAccess(err)) | Err(keyring::Error::PlatformFailure(err)) => {
            Err(format!("{DENIED_MESSAGE} ({err})"))
        }
        Err(err) => Err(keychain_error(err)),
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn os_set(secret: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE, ACCOUNT).map_err(keychain_error)?;
    match entry.set_password(secret) {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoStorageAccess(err)) | Err(keyring::Error::PlatformFailure(err)) => {
            Err(format!("{DENIED_MESSAGE} ({err})"))
        }
        Err(err) => Err(keychain_error(err)),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn os_get() -> Result<Option<String>, String> {
    Err(MISSING_STORE.into())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn os_set(_secret: &str) -> Result<(), String> {
    Err(MISSING_STORE.into())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn keychain_error(err: impl std::fmt::Display) -> String {
    format!("The keychain could not be used ({err}).")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    struct MemoryStore(Mutex<Option<String>>);

    impl SecretStore for MemoryStore {
        fn get(&self) -> Result<Option<String>, String> {
            Ok(self.0.lock().expect("store").clone())
        }

        fn set(&self, secret: &str) -> Result<(), String> {
            *self.0.lock().expect("store") = Some(secret.to_string());
            Ok(())
        }
    }

    #[test]
    fn a_generated_key_round_trips_and_stays_out_of_the_log() {
        let store = MemoryStore(Mutex::new(None));
        let key = load_or_create(&store).expect("key");
        assert_eq!(load_or_create(&store).expect("same key"), key);
        let bytes = STANDARD.decode(key.as_bytes()).expect("base64");
        assert_eq!(bytes.len(), 32);
        let line = redact(&format!("unlock failed: {key}"), &key);
        assert!(!line.contains(&key));
        assert!(line.contains("[redacted]"));
    }

    #[test]
    fn the_keychain_names_are_stable() {
        assert_eq!(SERVICE, "com.personalagents.desktop");
        assert_eq!(ACCOUNT, "memory-bank");
    }

    #[test]
    fn write_then_verify_reads_the_same_key() {
        let store = MemoryStore(Mutex::new(None));
        let key = store_and_verify(&store).expect("verified");
        assert_eq!(store.get().expect("read").as_deref(), Some(key.as_str()));
        assert_eq!(store_and_verify(&store).expect("same"), key);
    }

    struct ForgetfulStore;

    impl SecretStore for ForgetfulStore {
        fn get(&self) -> Result<Option<String>, String> {
            Ok(None)
        }

        fn set(&self, _secret: &str) -> Result<(), String> {
            Ok(())
        }
    }

    #[test]
    fn a_store_that_cannot_be_read_back_does_not_yield_a_key() {
        let err = store_and_verify(&ForgetfulStore).expect_err("verify");
        assert!(err.contains("Memory was not encrypted"));
        assert!(!err.contains("AAAA"));
    }

    struct CountingStore {
        reads: AtomicUsize,
        writes: AtomicUsize,
    }

    impl SecretStore for CountingStore {
        fn get(&self) -> Result<Option<String>, String> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            Ok(None)
        }

        fn set(&self, _secret: &str) -> Result<(), String> {
            self.writes.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    struct DenyStore {
        reads: AtomicUsize,
    }

    impl SecretStore for DenyStore {
        fn get(&self) -> Result<Option<String>, String> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            Err(
                "Platform secure storage failure: The user name or passphrase you entered is not correct. (-25293)"
                    .into(),
            )
        }

        fn set(&self, _secret: &str) -> Result<(), String> {
            Ok(())
        }
    }

    #[test]
    fn a_denied_keychain_read_is_not_retried() {
        let store = DenyStore {
            reads: AtomicUsize::new(0),
        };
        let session = SessionKeys::new();
        let first = session.read(&store).expect_err("denied");
        let second = session.read(&store).expect_err("cached");
        assert!(first.starts_with(DENIED_MESSAGE));
        assert_eq!(second, first);
        assert_eq!(store.reads.load(Ordering::SeqCst), 1);
        let third = session.retry(&store).expect_err("one more read");
        assert!(third.starts_with(DENIED_MESSAGE));
        assert_eq!(store.reads.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_passphrase_round_trips_and_a_wrong_one_is_rejected() {
        let (key, seal) = seal_passphrase("correct horse").expect("seal");
        assert_eq!(open_passphrase("correct horse", &seal).expect("open"), key);
        let wrong = open_passphrase("wrong horse", &seal).expect_err("wrong");
        assert_eq!(wrong, WRONG_PASSPHRASE_MESSAGE);
        assert!(!seal.salt.contains("correct"));
        assert!(!seal.check.contains(&key));
        assert!(!key.contains("correct"));
    }

    #[test]
    fn a_failing_key_store_is_not_retried() {
        let store = CountingStore {
            reads: AtomicUsize::new(0),
            writes: AtomicUsize::new(0),
        };
        let err = store_and_verify(&store).expect_err("verify");
        assert!(err.contains("Memory was not encrypted"));
        assert_eq!(store.reads.load(Ordering::SeqCst), 2);
        assert_eq!(store.writes.load(Ordering::SeqCst), 1);
    }
}
