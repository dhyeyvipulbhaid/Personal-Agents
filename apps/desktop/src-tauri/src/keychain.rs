//! The memory key lives in the OS keychain.
//! macOS uses Keychain. Windows uses Credential Manager.
//! Nothing in this module writes the key to a log.

use base64::{engine::general_purpose::STANDARD, Engine as _};

#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
pub const SERVICE: &str = "com.personalagents.desktop";
#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
pub const ACCOUNT: &str = "memory-bank";

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const MISSING_STORE: &str =
    "Memory encryption stores the key in the macOS Keychain or Windows Credential Manager.";

pub trait SecretStore {
    fn get(&self) -> Result<Option<String>, String>;
    fn set(&self, secret: &str) -> Result<(), String>;
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
        Err(err) => Err(keychain_error(err)),
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn os_set(secret: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE, ACCOUNT).map_err(keychain_error)?;
    entry.set_password(secret).map_err(keychain_error)
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
