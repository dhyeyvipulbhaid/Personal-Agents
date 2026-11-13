//! Content-Length frames for JSON-RPC on stdin and stdout.
//! A frame is `Content-Length: <bytes>\r\n\r\n` followed by that many bytes.

use serde::Deserialize;

const MAX_FRAME_BYTES: usize = 1_000_000;

pub(crate) fn encode_frame(body: &[u8]) -> Vec<u8> {
    let mut frame = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    frame.extend_from_slice(body);
    frame
}

pub(crate) fn encode_request(id: u64, method: &str) -> Result<Vec<u8>, String> {
    check_method(method)?;
    let body = format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"{method}"}}"#);
    Ok(encode_frame(body.as_bytes()))
}

pub(crate) fn encode_request_params(
    id: u64,
    method: &str,
    params: Option<&serde_json::Value>,
) -> Result<Vec<u8>, String> {
    let Some(params) = params else {
        return encode_request(id, method);
    };
    check_method(method)?;
    let params_text = serde_json::to_string(params).map_err(|err| err.to_string())?;
    let body =
        format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"{method}","params":{params_text}}}"#);
    Ok(encode_frame(body.as_bytes()))
}

fn check_method(method: &str) -> Result<(), String> {
    if method.is_empty()
        || !method
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
    {
        return Err("invalid method".into());
    }
    Ok(())
}

/// An audit notification is a JSON-RPC message with method `audit` and no id.
pub(crate) fn audit_line(body: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    if value.get("method")?.as_str()? != "audit" || value.get("id").is_some() {
        return None;
    }
    let line = serde_json::to_string(value.get("params")?).ok()?;
    if line.contains('\n') || line.contains('\r') {
        return None;
    }
    Some(line)
}

/// Takes one complete frame out of `buf`. `Ok(None)` means the frame is not
/// finished yet.
pub(crate) fn next_frame(buf: &mut Vec<u8>) -> Result<Option<Vec<u8>>, String> {
    let Some(end) = buf.windows(4).position(|window| window == b"\r\n\r\n") else {
        return Ok(None);
    };
    let header =
        std::str::from_utf8(&buf[..end]).map_err(|_| "frame header is not utf-8".to_string())?;
    let length: usize = header
        .strip_prefix("Content-Length: ")
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| format!("bad frame header: {header}"))?;
    if length > MAX_FRAME_BYTES {
        return Err("frame is too large".into());
    }
    let start = end + 4;
    if buf.len() < start + length {
        return Ok(None);
    }
    let body = buf[start..start + length].to_vec();
    buf.drain(..start + length);
    Ok(Some(body))
}

/// Reads host stdout. One oversized frame is skipped so later replies still arrive.
pub(crate) struct FrameParser {
    buffer: Vec<u8>,
    skip: usize,
}

impl FrameParser {
    pub(crate) fn new() -> Self {
        Self {
            buffer: Vec::new(),
            skip: 0,
        }
    }

    pub(crate) fn clear(&mut self) {
        self.buffer.clear();
        self.skip = 0;
    }

    pub(crate) fn push(&mut self, chunk: &[u8]) -> Result<Vec<Vec<u8>>, String> {
        let mut rest = chunk;
        if self.skip > 0 {
            let drop_count = self.skip.min(rest.len());
            self.skip -= drop_count;
            rest = &rest[drop_count..];
        }
        self.buffer.extend_from_slice(rest);
        let mut frames = Vec::new();
        loop {
            match next_frame(&mut self.buffer) {
                Ok(None) => {
                    if self.buffer.len() > MAX_FRAME_BYTES {
                        self.buffer.clear();
                        return Err("frame is too large".into());
                    }
                    break;
                }
                Ok(Some(body)) => frames.push(body),
                Err(err) if err == "frame is too large" => {
                    if !self.discard_oversized() {
                        break;
                    }
                }
                Err(err) => {
                    self.buffer.clear();
                    return Err(err);
                }
            }
        }
        Ok(frames)
    }

    fn discard_oversized(&mut self) -> bool {
        let Some(end) = self
            .buffer
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
        else {
            self.buffer.clear();
            return false;
        };
        let Ok(header) = std::str::from_utf8(&self.buffer[..end]) else {
            self.buffer.clear();
            return false;
        };
        let Some(length) = header
            .strip_prefix("Content-Length: ")
            .and_then(|value| value.parse::<usize>().ok())
        else {
            self.buffer.clear();
            return false;
        };
        let start = end + 4;
        let Some(total) = start.checked_add(length) else {
            self.buffer.clear();
            return false;
        };
        if self.buffer.len() >= total {
            self.buffer.drain(..total);
            true
        } else {
            self.skip = total - self.buffer.len();
            self.buffer.clear();
            false
        }
    }
}

pub(crate) fn parse_response(body: &[u8]) -> Result<(u64, Result<String, String>), String> {
    let response: RpcResponse = serde_json::from_slice(body).map_err(|err| err.to_string())?;
    let value = if let Some(error) = response.error {
        Err(error.message)
    } else if let Some(result) = response.result {
        Ok(result)
    } else {
        Err("empty response".into())
    };
    Ok((response.id, value))
}

#[derive(Deserialize)]
struct RpcResponse {
    id: u64,
    #[serde(default)]
    result: Option<String>,
    #[serde(default)]
    error: Option<RpcError>,
}

#[derive(Deserialize)]
struct RpcError {
    message: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_round_trip_keeps_trailing_bytes() {
        let body = br#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
        let mut frame = encode_frame(body);
        frame.extend_from_slice(b"next");

        let decoded = next_frame(&mut frame).unwrap().unwrap();

        assert_eq!(decoded, body);
        assert_eq!(frame, b"next");
    }

    #[test]
    fn frame_waits_until_the_body_is_complete() {
        let body = br#"{"a":1}"#;
        let frame = encode_frame(body);
        let mut partial = frame[..frame.len() - 1].to_vec();

        assert!(next_frame(&mut partial).unwrap().is_none());
        partial.push(frame[frame.len() - 1]);

        assert_eq!(next_frame(&mut partial).unwrap().unwrap(), body);
        assert!(partial.is_empty());
    }

    #[test]
    fn frame_length_counts_bytes() {
        let body = "{\"t\":\"é\"}".as_bytes();
        assert_eq!(body.len(), 10);
        let frame = encode_frame(body);
        let header = format!("Content-Length: {}\r\n\r\n", body.len());
        assert!(frame.starts_with(header.as_bytes()));
    }

    #[test]
    fn an_oversized_frame_does_not_drop_the_next_one() {
        let mut parser = FrameParser::new();
        let huge = 1_500_000usize;
        let mut bytes = format!("Content-Length: {huge}\r\n\r\n").into_bytes();
        bytes.extend(std::iter::repeat(b'x').take(huge));
        bytes.extend(encode_frame(br#"{"jsonrpc":"2.0","id":7,"result":"pong"}"#));
        let mut got = Vec::new();
        for chunk in bytes.chunks(100_000) {
            got.extend(parser.push(chunk).unwrap());
        }
        assert_eq!(got, vec![br#"{"jsonrpc":"2.0","id":7,"result":"pong"}"#]);
    }

    #[test]
    fn a_bad_header_is_an_error() {
        let mut buffer = b"Nope: 1\r\n\r\n{}".to_vec();
        assert!(next_frame(&mut buffer).is_err());
    }

    #[test]
    fn ping_request_is_one_json_rpc_frame() {
        let mut frame = encode_request(1, "ping").unwrap();
        let body = next_frame(&mut frame).unwrap().unwrap();
        assert_eq!(body, br#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#);
        assert!(frame.is_empty());
    }

    #[test]
    fn parse_pong_and_version() {
        let (id, result) = parse_response(br#"{"jsonrpc":"2.0","id":1,"result":"pong"}"#).unwrap();
        assert_eq!(id, 1);
        assert_eq!(result.unwrap(), "pong");

        let (id, result) = parse_response(br#"{"jsonrpc":"2.0","id":2,"result":"0.0.0"}"#).unwrap();
        assert_eq!(id, 2);
        assert_eq!(result.unwrap(), "0.0.0");
    }
}
