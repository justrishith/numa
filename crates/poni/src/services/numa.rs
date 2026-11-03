//! NUMA's bridge from a finished WAV to the local NUMA Core.

use crate::events::{AppEvent, EventSink};
use std::path::PathBuf;
use std::time::Duration;

const CORE_TRANSCRIBE: &str = "http://127.0.0.1:8899/v1/audio/transcriptions";
const CORE_CHAT: &str = "http://127.0.0.1:8899/v1/chat/completions";
const CORE_SPEECH: &str = "http://127.0.0.1:8899/v1/audio/speech";

/// Largest clip accepted from Core (about eleven minutes of 24 kHz mono PCM).
const MAX_SPEECH_BYTES: u64 = 32 * 1024 * 1024;

/// Speak a NUMA response using Deepgram Aura audio returned by NUMA Core. The
/// audio arrives as bytes and is played straight from memory, so nothing is
/// written to disk. The Deepgram key stays in Core.
#[cfg(target_os = "windows")]
pub fn speak(text: String) {
    if text.trim().is_empty() {
        return;
    }
    std::thread::Builder::new()
        .name("numa-speech".into())
        .spawn(move || {
            crate::pinfo!("numa speech: requesting Aura audio");
            let result = (|| {
                let body = serde_json::json!({ "input": text });
                let client = crate::services::http::Client::new("OyenzaStudio/NUMA")
                    .map_err(|e| e.to_string())?;
                // A whole reply is synthesized before any of it arrives, so the
                // budget has to cover long answers (an 81 s clip is not unusual).
                let (status, audio) = client
                    .send_for_bytes(
                        crate::services::http::Method::Post,
                        CORE_SPEECH,
                        &[("Accept", "audio/wav")],
                        Some(&body.to_string()),
                        Duration::from_secs(120),
                        MAX_SPEECH_BYTES,
                    )
                    .map_err(|e| e.to_string())?;
                if !(200..300).contains(&status) {
                    let detail = String::from_utf8_lossy(&audio).trim().to_owned();
                    return Err(format!("NUMA TTS returned HTTP {status}: {detail}"));
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
        return Err("NUMA TTS returned too little audio".into());
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
            let result = (|| {
                let bytes =
                    std::fs::read(&path).map_err(|e| format!("can't read recording ({e})"))?;
                let client = crate::services::http::Client::new("OyenzaStudio/NUMA")
                    .map_err(|e| e.to_string())?;
                let response = client
                    .post_bytes(
                        CORE_TRANSCRIBE,
                        &[("Accept", "application/json")],
                        &bytes,
                        "audio/wav",
                        Duration::from_secs(20),
                    )
                    .map_err(|e| e.to_string())?;
                if !(200..300).contains(&response.status) {
                    return Err(format!("NUMA Core returned HTTP {}", response.status));
                }
                let json: serde_json::Value = serde_json::from_str(&response.body)
                    .map_err(|e| format!("invalid Core response ({e})"))?;
                json.get("text")
                    .and_then(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .ok_or_else(|| "NUMA Core returned no transcript".into())
            })();
            let _ = std::fs::remove_file(path);
            sink.send(match result {
                Ok(text) => AppEvent::NumaTranscript(text),
                Err(error) => AppEvent::NumaFailed(error),
            });
        })
        .ok();
}

/// Ask NUMA Core to route a transcript through the configured action agent.
pub fn ask(text: String, sink: EventSink) {
    std::thread::Builder::new()
        .name("numa-action".into())
        .spawn(move || {
            let result = (|| {
                let body = serde_json::json!({
                    "messages": [{ "role": "user", "content": text }],
                });
                let client = crate::services::http::Client::new("OyenzaStudio/NUMA")
                    .map_err(|e| e.to_string())?;
                let response = client
                    .send(
                        crate::services::http::Method::Post,
                        CORE_CHAT,
                        &[("Accept", "application/json")],
                        Some(&body.to_string()),
                        Duration::from_secs(60),
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
                        "NUMA Core returned HTTP {}: {detail}",
                        response.status
                    ));
                }
                let json: serde_json::Value = serde_json::from_str(&response.body)
                    .map_err(|e| format!("invalid Core response ({e})"))?;
                if let Some(action) = json.get("numa_action").and_then(serde_json::Value::as_str) {
                    sink.send(AppEvent::NumaMediaKey(action.to_owned()));
                }
                json.pointer("/choices/0/message/content")
                    .and_then(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .ok_or_else(|| "NUMA Core returned no response".into())
            })();
            sink.send(match result {
                Ok(text) => AppEvent::NumaResponse(text),
                Err(error) => AppEvent::NumaFailed(error),
            });
        })
        .ok();
}

/// Inject one approved Windows media key directly through user32. This is
/// intentionally a tiny allowlisted boundary: NUMA can request only the
/// media actions produced by `numa-core`, never arbitrary keyboard input.
#[cfg(target_os = "windows")]
pub fn send_media_key(action: &str) {
    let Some(key) = (match action {
        "play_pause" => Some(0xB3),
        "next" => Some(0xB0),
        "prev" => Some(0xB1),
        "volume_up" => Some(0xAF),
        "volume_down" => Some(0xAE),
        "mute" | "unmute" => Some(0xAD),
        _ => None,
    }) else {
        return;
    };
    unsafe {
        keybd_event(key, 0, 0, 0);
        keybd_event(key, 0, 2, 0);
    }
}

#[cfg(target_os = "windows")]
#[link(name = "user32")]
unsafe extern "system" {
    fn keybd_event(key: u8, scan: u8, flags: u32, extra: usize);
}
