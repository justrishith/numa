//! NUMA's bridge from a finished WAV to the local NUMA Gateway (port 8900).
//!
//! The gateway owns speech-to-text, the OpenCode coding lane and text-to-speech.
//! Poni only records, ships bytes and draws whatever comes back. Nothing here
//! talks to the retired `numa-core.mjs` edge on 8899.

use crate::events::{AppEvent, EventSink};
use std::path::PathBuf;
use std::time::Duration;

const GATEWAY_TRANSCRIBE: &str = "http://127.0.0.1:8900/v1/audio";
const GATEWAY_ASK: &str = "http://127.0.0.1:8900/v1/ask";
const GATEWAY_SPEECH: &str = "http://127.0.0.1:8900/v1/speech";

/// Largest clip accepted from the gateway (about eleven minutes of 24 kHz mono PCM).
const MAX_SPEECH_BYTES: u64 = 32 * 1024 * 1024;

/// Speak a NUMA response using the WAV returned by the gateway. The audio
/// arrives as bytes and is played straight from memory, so nothing is written
/// to disk. The Deepgram key stays in the gateway.
#[cfg(target_os = "windows")]
pub fn speak(text: String) {
    if text.trim().is_empty() {
        return;
    }
    std::thread::Builder::new()
        .name("numa-speech".into())
        .spawn(move || {
            crate::pinfo!("numa speech: requesting audio from gateway");
            let result = (|| {
                let body = serde_json::json!({ "input": text });
                let client = crate::services::http::Client::new("OyenzaStudio/NUMA")
                    .map_err(|e| e.to_string())?;
                // A whole reply is synthesized before any of it arrives, so the
                // budget has to cover long answers (an 81 s clip is not unusual).
                let (status, audio) = client
                    .send_for_bytes(
                        crate::services::http::Method::Post,
                        GATEWAY_SPEECH,
                        &[("Accept", "audio/wav")],
                        Some(&body.to_string()),
                        Duration::from_secs(120),
                        MAX_SPEECH_BYTES,
                    )
                    .map_err(|e| e.to_string())?;
                if !(200..300).contains(&status) {
                    let detail = String::from_utf8_lossy(&audio).trim().to_owned();
                    return Err(format!("NUMA speech returned HTTP {status}: {detail}"));
                }
                crate::pinfo!("numa speech: playing {} bytes from memory", audio.len());
                play_wav_memory(&audio)
            })();
            if let Err(error) = result {
                crate::pwarn!("numa speech failed: {error}");
            }
        })
        .ok();
}

/// Plays a WAV held in memory. `SND_MEMORY` reads the buffer until the clip
/// ends, so this blocks the speech thread for as long as it speaks.
#[cfg(target_os = "windows")]
fn play_wav_memory(wav: &[u8]) -> Result<(), String> {
    use windows::Win32::Media::Audio::{PlaySoundW, SND_MEMORY, SND_NODEFAULT};
    if wav.len() < 44 {
        return Err("NUMA speech returned too little audio".into());
    }
    // SAFETY: PlaySound only reads inside `wav`, which outlives this call
    // because the call is synchronous (no SND_ASYNC).
    let ok = unsafe {
        PlaySoundW(
            windows::core::PCWSTR(wav.as_ptr() as *const u16),
            None,
            SND_MEMORY | SND_NODEFAULT,
        )
    };
    if ok.as_bool() {
        Ok(())
    } else {
        Err("Windows audio playback failed".into())
    }
}

#[cfg(not(target_os = "windows"))]
pub fn speak(_text: String) {}

pub fn transcribe(path: PathBuf, sink: EventSink) {
    std::thread::Builder::new()
        .name("numa-transcribe".into())
        .spawn(move || {
            crate::pinfo!("numa transcription: sending recording to gateway");
            let result = (|| {
                let bytes =
                    std::fs::read(&path).map_err(|e| format!("can't read recording ({e})"))?;
                let client = crate::services::http::Client::new("OyenzaStudio/NUMA")
                    .map_err(|e| e.to_string())?;
                let response = client
                    .post_bytes(
                        GATEWAY_TRANSCRIBE,
                        &[("Accept", "application/json")],
                        &bytes,
                        "audio/wav",
                        Duration::from_secs(30),
                    )
                    .map_err(|e| e.to_string())?;
                if !(200..300).contains(&response.status) {
                    let detail = serde_json::from_str::<serde_json::Value>(&response.body)
                        .ok()
                        .and_then(|json| {
                            json.get("error")
                                .and_then(serde_json::Value::as_str)
                                .map(str::to_owned)
                        })
                        .unwrap_or_else(|| response.body.clone());
                    return Err(format!(
                        "NUMA gateway returned HTTP {}: {detail}",
                        response.status
                    ));
                }
                let json: serde_json::Value = serde_json::from_str(&response.body)
                    .map_err(|e| format!("invalid gateway response ({e})"))?;
                // An empty transcript is a real answer, not a transport error:
                // the gateway already retried once. Poni decides what to say.
                json.get("text")
                    .and_then(serde_json::Value::as_str)
                    .map(str::trim)
                    .map(str::to_owned)
                    .ok_or_else(|| "NUMA gateway returned no text field".into())
            })();
            let _ = std::fs::remove_file(path);
            if let Err(error) = &result {
                crate::pwarn!("numa transcription failed: {error}");
            }
            sink.send(match result {
                Ok(text) => AppEvent::NumaTranscript(text),
                Err(error) => AppEvent::NumaFailed(error),
            });
        })
        .ok();
}

/// The gateway's approval endpoints, under the executions root.
const GATEWAY_EXECUTIONS: &str = "http://127.0.0.1:8900/v1/executions";

/// Answer a gateway run that asked for permission: `approve` grants it,
/// otherwise it is cancelled. The event stream confirms the new state, so
/// this only reports transport trouble; the UI never waits on the answer.
pub fn decide(id: String, approve: bool) {
    let what = if approve { "approved" } else { "cancelled" };
    std::thread::Builder::new()
        .name("numa-decide".into())
        .spawn(move || {
            let url = format!(
                "{GATEWAY_EXECUTIONS}/{id}/{}",
                if approve { "approve" } else { "cancel" }
            );
            let result = (|| {
                let client = crate::services::http::Client::new("OyenzaStudio/NUMA")
                    .map_err(|e| e.to_string())?;
                let response = client
                    .send(
                        crate::services::http::Method::Post,
                        &url,
                        &[("Accept", "application/json")],
                        None,
                        Duration::from_secs(15),
                    )
                    .map_err(|e| e.to_string())?;
                if (200..300).contains(&response.status) {
                    Ok(())
                } else {
                    Err(format!(
                        "NUMA gateway returned HTTP {}: {}",
                        response.status,
                        response.body.trim()
                    ))
                }
            })();
            match result {
                Ok(()) => crate::pinfo!("numa: execution {id} {what}"),
                Err(error) => crate::pwarn!("numa {what} failed: {error}"),
            }
        })
        .ok();
}

/// Ask the gateway to carry out a request. Coding work runs in an OpenCode
/// session behind the gateway, so the budget has to cover real tool loops
/// rather than a single completion.
pub fn ask(text: String, sink: EventSink) {
    std::thread::Builder::new()
        .name("numa-action".into())
        .spawn(move || {
            let result = (|| {
                let body = serde_json::json!({ "text": text });
                let client = crate::services::http::Client::new("OyenzaStudio/NUMA")
                    .map_err(|e| e.to_string())?;
                let response = client
                    .send(
                        crate::services::http::Method::Post,
                        GATEWAY_ASK,
                        &[("Accept", "application/json")],
                        Some(&body.to_string()),
                        Duration::from_secs(300),
                    )
                    .map_err(|e| e.to_string())?;
                if !(200..300).contains(&response.status) {
                    let detail = serde_json::from_str::<serde_json::Value>(&response.body)
                        .ok()
                        .and_then(|json| {
                            json.get("error")
                                .and_then(serde_json::Value::as_str)
                                .map(str::to_owned)
                        })
                        .unwrap_or_else(|| response.body.clone());
                    return Err(format!(
                        "NUMA gateway returned HTTP {}: {detail}",
                        response.status
                    ));
                }
                let json: serde_json::Value = serde_json::from_str(&response.body)
                    .map_err(|e| format!("invalid gateway response ({e})"))?;
                json.get("reply")
                    .and_then(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .ok_or_else(|| "NUMA gateway returned no reply".into())
            })();
            sink.send(match result {
                Ok(text) => AppEvent::NumaResponse(text),
                Err(error) => AppEvent::NumaFailed(error),
            });
        })
        .ok();
}
