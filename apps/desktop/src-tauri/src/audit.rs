//! Append-only audit log. Lines are added at the end and earlier bytes stay.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

pub fn append_audit(path: &Path, line: &str) -> Result<(), String> {
    if line.is_empty() || line.contains('\n') || line.contains('\r') {
        return Err("audit line is invalid".into());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| err.to_string())?;
    writeln!(file, "{line}").map_err(|err| err.to_string())?;
    file.flush().map_err(|err| err.to_string())?;
    Ok(())
}

pub fn read_audit_newest_first(path: &Path) -> Result<Vec<String>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(path).map_err(|err| err.to_string())?;
    let mut lines: Vec<String> = text
        .lines()
        .filter(|line| !line.is_empty())
        .map(ToString::to_string)
        .collect();
    lines.reverse();
    Ok(lines)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_keeps_earlier_bytes_and_reads_newest_first() {
        let dir = std::env::temp_dir().join(format!("pa-audit-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("audit.log");
        append_audit(&path, r#"{"n":1}"#).unwrap();
        let first = std::fs::read(&path).unwrap();
        append_audit(&path, r#"{"n":2}"#).unwrap();
        let second = std::fs::read(&path).unwrap();

        assert!(second.starts_with(&first));
        assert_eq!(
            read_audit_newest_first(&path).unwrap(),
            vec![r#"{"n":2}"#.to_string(), r#"{"n":1}"#.to_string()]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
