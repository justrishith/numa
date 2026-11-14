//! Live NUMA Gateway events: a minimal WebSocket client for `/v1/events`.
//!
//! The gateway pushes every execution transition (`execution.created`,
//! `approval.required`, `tool.started`, `execution.succeeded`, …) as JSON
//! frames. Poni stays a dumb mirror: the thread here connects, keeps the
//! connection alive and forwards each message to the UI thread, which folds
//! it into `st.ui.numa.gateway`. Nothing else talks to the socket.
//!
//! std-only on purpose: `TcpStream` speaks plain HTTP, the gateway listens on
//! loopback without TLS, so RFC 6455 is ~150 lines instead of a tokio tree.
//! Reconnects run with a small backoff; a dead gateway simply reads as
//! `connected: false` in the notch, never as an error dialog.

use crate::events::{AppEvent, EventSink};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

/// Where the gateway's event stream lives. Loopback, plain HTTP.
const GATEWAY_EVENTS: &str = "127.0.0.1:8900";
const GATEWAY_EVENTS_PATH: &str = "/v1/events";

/// First retry delay after a lost connection.
const RECONNECT_MIN: Duration = Duration::from_secs(2);
/// Retry delay ceiling: the gateway being down must not spin a core.
const RECONNECT_MAX: Duration = Duration::from_secs(30);

/// One parsed message from the gateway's event stream.
#[derive(Clone, Debug, PartialEq)]
pub enum GatewayEvent {
    /// The socket is up (`gateway.ready` arrived or first frame will).
    Connected,
    /// The socket dropped; the UI should dim its gateway strip.
    Disconnected,
    /// One execution transition: `{type, executionId, data}`.
    Execution {
        kind: String,
        id: String,
        data: serde_json::Value,
    },
}

/// Spawn the long-lived stream thread. One per process; it reconnects for the
/// app's whole lifetime and never panics on malformed input.
pub fn start(sink: EventSink) {
    std::thread::Builder::new()
        .name("numa-events".into())
        .spawn(move || run(sink))
        .ok();
}

fn run(sink: EventSink) {
    let mut backoff = RECONNECT_MIN;
    loop {
        let report = |connected: bool| {
            sink.send(AppEvent::NumaGateway(if connected {
                GatewayEvent::Connected
            } else {
                GatewayEvent::Disconnected
            }));
        };
        match connect() {
            Ok(mut ws) => {
                backoff = RECONNECT_MIN;
                report(true);
                crate::pinfo!("numa events: gateway stream connected");
                if let Err(error) = pump(&mut ws, &sink) {
                    crate::pwarn!("numa events: stream dropped ({error})");
                }
                report(false);
            }
            Err(error) => {
                crate::pwarn!("numa events: connect failed ({error})");
                report(false);
            }
        }
        std::thread::sleep(backoff);
        backoff = (backoff * 2).min(RECONNECT_MAX);
    }
}

/// Connect and complete the RFC 6455 opening handshake.
fn connect() -> Result<Ws, String> {
    use std::net::ToSocketAddrs;
    let addr = GATEWAY_EVENTS
        .to_socket_addrs()
        .map_err(|e| e.to_string())?
        .next()
        .ok_or("no address for gateway")?;
    let mut stream =
        TcpStream::connect_timeout(&addr, Duration::from_secs(3)).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(90)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    stream.set_nodelay(true).map_err(|e| e.to_string())?;

    // Loopback noise, not cryptographic — but RFC 6455 (and the gateway's
    // `ws` server) require the key to decode to exactly 16 bytes.
    let key = format!("poni-{:011}", std::process::id());
    let request = format!(
        "GET {GATEWAY_EVENTS_PATH} HTTP/1.1\r\n\
         Host: {GATEWAY_EVENTS}\r\n\
         Upgrade: websocket\r\n\
         Connection: Upgrade\r\n\
         Sec-WebSocket-Key: {}\r\n\
         Sec-WebSocket-Version: 13\r\n\r\n",
        base64_key(&key),
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| e.to_string())?;
    let response = read_handshake(&mut stream)?;
    if !response.contains(" 101 ") {
        return Err(format!("handshake refused: {}", first_line(&response)));
    }
    Ok(Ws { stream })
}

fn read_handshake(stream: &mut TcpStream) -> Result<String, String> {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        stream.read(&mut byte).map_err(|e| e.to_string())?;
        head.push(byte[0]);
        if head.ends_with(b"\r\n\r\n") {
            return Ok(String::from_utf8_lossy(&head).into_owned());
        }
        if head.len() > 16 * 1024 {
            return Err("handshake response too large".into());
        }
    }
}

fn first_line(response: &str) -> &str {
    response.lines().next().unwrap_or("(empty)")
}

/// Base64 of the handshake key. The alphabet is fixed; the length of the input
/// is a multiple of 3 in no case, so both padding paths are exercised.
fn base64_key(input: &str) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = input.as_bytes();
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// A WebSocket connection that can be pumped for frames.
struct Ws {
    stream: TcpStream,
}

impl Ws {
    /// Send one masked frame. Client frames must carry a masking key; a
    /// fixed-but-nonzero key is RFC-legal and needs no RNG.
    fn send_frame(&mut self, opcode: u8, payload: &[u8]) -> Result<(), String> {
        let mut frame = Vec::with_capacity(payload.len() + 14);
        frame.push(0x80 | opcode);
        let mask = [0x5au8, 0xa5, 0x3c, 0xc3];
        let len = payload.len();
        if len < 126 {
            frame.push(0x80 | len as u8);
        } else if len <= u16::MAX as usize {
            frame.push(0x80 | 126);
            frame.extend_from_slice(&(len as u16).to_be_bytes());
        } else {
            frame.push(0x80 | 127);
            frame.extend_from_slice(&(len as u64).to_be_bytes());
        }
        frame.extend_from_slice(&mask);
        for (index, byte) in payload.iter().enumerate() {
            frame.push(byte ^ mask[index % 4]);
        }
        self.stream.write_all(&frame).map_err(|e| e.to_string())
    }

    /// Read one unmasked frame from the server: (opcode, payload).
    fn read_frame(&mut self) -> Result<(u8, Vec<u8>), String> {
        let mut head = [0u8; 2];
        self.stream.read_exact(&mut head).map_err(io_error)?;
        let opcode = head[0] & 0x0f;
        let masked = head[1] & 0x80 != 0;
        let len = match head[1] & 0x7f {
            126 => {
                let mut ext = [0u8; 2];
                self.stream.read_exact(&mut ext).map_err(io_error)?;
                u16::from_be_bytes(ext) as u64
            }
            127 => {
                let mut ext = [0u8; 8];
                self.stream.read_exact(&mut ext).map_err(io_error)?;
                u64::from_be_bytes(ext)
            }
            n => n as u64,
        };
        if len > 4 * 1024 * 1024 {
            return Err("gateway frame too large".into());
        }
        let mask = if masked {
            let mut m = [0u8; 4];
            self.stream.read_exact(&mut m).map_err(io_error)?;
            Some(m)
        } else {
            None
        };
        let mut payload = vec![0u8; len as usize];
        self.stream.read_exact(&mut payload).map_err(io_error)?;
        if let Some(mask) = mask {
            for (index, byte) in payload.iter_mut().enumerate() {
                *byte ^= mask[index % 4];
            }
        }
        Ok((opcode, payload))
    }
}

fn io_error(error: std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut => "read timed out".into(),
        _ => error.to_string(),
    }
}

/// Read frames forever, forwarding text messages and answering pings.
fn pump(ws: &mut Ws, sink: &EventSink) -> Result<(), String> {
    let mut partial: Vec<u8> = Vec::new();
    loop {
        let (opcode, payload) = ws.read_frame()?;
        match opcode {
            0x1 => {
                let mut text = std::mem::take(&mut partial);
                text.extend_from_slice(&payload);
                forward(&text, sink);
            }
            0x0 => partial.extend_from_slice(&payload),
            0x2 => return Err("binary frame from gateway (unexpected)".into()),
            0x8 => return Err("gateway closed the stream".into()),
            0x9 => ws.send_frame(0xA, &payload)?, // ping → pong
            0xA => {}                             // unsolicited pong
            other => return Err(format!("unknown opcode {other:#x}")),
        }
    }
}

/// Parse one stream message and hand it to the UI thread. Unparseable frames
/// are logged and dropped — a bad line must never kill the stream.
fn forward(text: &[u8], sink: &EventSink) {
    let Ok(text) = std::str::from_utf8(text) else {
        crate::pwarn!("numa events: dropped a non-UTF8 frame");
        return;
    };
    let Ok(msg) = serde_json::from_str::<serde_json::Value>(text) else {
        crate::pwarn!("numa events: dropped an unparseable frame: {text:.120}");
        return;
    };
    let kind = msg
        .get("type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if kind.is_empty() {
        crate::pwarn!("numa events: frame without a type: {text:.120}");
        return;
    }
    let event = match kind.as_str() {
        "gateway.ready" => GatewayEvent::Connected,
        _ => {
            let Some(id) = msg
                .get("executionId")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
            else {
                crate::pwarn!("numa events: {kind} without an executionId");
                return;
            };
            GatewayEvent::Execution {
                kind,
                id,
                data: msg.get("data").cloned().unwrap_or(serde_json::Value::Null),
            }
        }
    };
    sink.send(AppEvent::NumaGateway(event));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_rfc_shape() {
        // The handshake key must decode to exactly 16 bytes; the gateway's
        // `ws` server refuses anything else with 400 (verified live).
        let key = base64_key("poni-0004294967295");
        assert_eq!(key, "cG9uaS0wMDA0Mjk0OTY3Mjk1");
        assert_eq!(base64_key("0123456789abcdef"), "MDEyMzQ1Njc4OWFiY2RlZg==");
        // Padding paths for shorter inputs still hold.
        assert_eq!(base64_key("foobar"), "Zm9vYmFy");
        assert_eq!(base64_key("foob"), "Zm9vYg==");
    }

    #[test]
    fn forward_maps_gateway_ready_to_connected() {
        let (tx, rx) = std::sync::mpsc::channel();
        let sink = EventSink::new(
            tx,
            crate::events::SendHwnd::new(windows::Win32::Foundation::HWND::default()),
        );
        forward(br#"{"type":"gateway.ready","at":"now"}"#, &sink);
        assert!(matches!(
            rx.recv().unwrap(),
            AppEvent::NumaGateway(GatewayEvent::Connected)
        ));
    }

    #[test]
    fn forward_requires_execution_id_for_execution_events() {
        let (tx, rx) = std::sync::mpsc::channel();
        let sink = EventSink::new(
            tx,
            crate::events::SendHwnd::new(windows::Win32::Foundation::HWND::default()),
        );
        // No executionId: dropped, nothing sent.
        forward(br#"{"type":"tool.started","data":{}}"#, &sink);
        assert!(rx.recv_timeout(Duration::from_millis(50)).is_err());
        // With one: forwarded with its data.
        forward(
            br#"{"type":"execution.created","executionId":"e1","data":{"toolId":"composio.gmail.get.profile"}}"#,
            &sink,
        );
        let AppEvent::NumaGateway(GatewayEvent::Execution { kind, id, data }) = rx.recv().unwrap()
        else {
            panic!("expected a gateway execution event");
        };
        assert_eq!(kind, "execution.created");
        assert_eq!(id, "e1");
        assert_eq!(data["toolId"], "composio.gmail.get.profile");
    }

    #[test]
    fn forward_survives_garbage() {
        let (tx, _rx) = std::sync::mpsc::channel();
        let sink = EventSink::new(
            tx,
            crate::events::SendHwnd::new(windows::Win32::Foundation::HWND::default()),
        );
        forward(b"not json at all", &sink); // must not panic
        forward(br#"{"no":"type"}"#, &sink);
    }
}
