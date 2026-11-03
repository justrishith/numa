//! Local hands-free wake-word listener for NUMA.
//!
//! Windows' installed System.Speech recognizer listens locally and reports
//! recognized phrases to PONI. Only phrases containing "hey numa" are acted
//! on; the audio is not sent to Deepgram or any model while idle.

use crate::events::{AppEvent, EventSink};
use std::io::{BufRead, BufReader};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const SCRIPT: &str = r#"
Add-Type -AssemblyName System.Speech
$r = New-Object System.Speech.Recognition.SpeechRecognitionEngine
$r.SetInputToDefaultAudioDevice()
$g = New-Object System.Speech.Recognition.DictationGrammar
$r.LoadGrammar($g)
while ($true) {
  $x = $r.Recognize()
  if ($x -and $x.Text) {
    [Console]::Out.WriteLine($x.Text)
    [Console]::Out.Flush()
  }
}
"#;

/// How long a bare "hey numa" keeps listening for a command. The recognizer
/// only reports a phrase after the speaker pauses, so "…hey numa" and the
/// command that follows it almost always arrive as two separate lines.
pub const FOLLOW_UP: Duration = Duration::from_secs(8);
/// The same window in seconds, for the UI's own expiry.
pub const FOLLOW_UP_SECS: f64 = 8.0;

/// Pronunciation variants the local recognizer returns for "Numa".
const WAKE_PHRASES: [&str; 5] = [
    "hey numa",
    "hey numah",
    "hey nooma",
    "hey new ma",
    "hey n numa",
];

/// One line from the recognizer, already resolved against the wake word.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Line {
    /// The wake word was heard, with the words after it if there were any.
    Wake(Option<String>),
    /// A command heard inside the follow-up window, with no wake word.
    FollowUp(String),
    /// Not for NUMA.
    Ignore,
}

/// Lowercase, punctuation-flattened text, used only for matching the wake
/// word: the recognizer punctuates freely ("Hey, Numa.").
fn normalize(text: &str) -> String {
    text.trim()
        .to_lowercase()
        .replace(['-', ',', '.', '?', '!'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Decide what a single recognized line means.
///
/// `raw` is the untouched line: a follow-up command is passed on as spoken,
/// because stripping punctuation out of "what's 2+2" would change the request.
fn classify(normalized: &str, raw: &str, follow_up_open: bool) -> Line {
    // Longest phrase first: "hey numah" contains "hey numa", and a prefix
    // match would hand the leftover "h" to the model as a command.
    let wake = WAKE_PHRASES
        .iter()
        .filter_map(|phrase| normalized.find(*phrase).map(|index| (*phrase, index)))
        .max_by_key(|(phrase, _)| phrase.len());
    if let Some((phrase, index)) = wake {
        let rest = &normalized[index + phrase.len()..];
        // A word glued onto the wake word ("hey numaa") is not a wake word.
        if rest.is_empty() || rest.starts_with(' ') {
            let command = rest.trim();
            return if command.is_empty() {
                Line::Wake(None)
            } else {
                Line::Wake(Some(command.to_owned()))
            };
        }
    }
    let command = raw.trim();
    if follow_up_open && !command.is_empty() {
        return Line::FollowUp(command.to_owned());
    }
    Line::Ignore
}

pub struct WakeListener {
    stop: Arc<AtomicBool>,
    muted: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Child>>>,
    thread: Option<JoinHandle<()>>,
}

pub fn start(sink: EventSink) -> Result<WakeListener, String> {
    if std::env::var_os("NUMA_TEST_WAKE").is_some() {
        let test_sink = sink.clone();
        std::thread::Builder::new()
            .name("numa-wake-test".into())
            .spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(700));
                test_sink.send(AppEvent::NumaWake);
                test_sink.send(AppEvent::NumaTranscript("open spotify".into()));
            })
            .map_err(|e| format!("can't start wake test ({e})"))?;
    }
    let child = Arc::new(Mutex::new(None));
    let stop = Arc::new(AtomicBool::new(false));
    let muted = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();
    let thread_muted = muted.clone();
    let thread_child = child.clone();
    let thread = std::thread::Builder::new()
        .name("numa-wake".into())
        .spawn(move || {
            while !thread_stop.load(Ordering::Relaxed) {
                if thread_muted.load(Ordering::Relaxed) {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    continue;
                }
                let spawned = Command::new("powershell.exe")
                    .args([
                        "-NoProfile",
                        "-NonInteractive",
                        "-WindowStyle",
                        "Hidden",
                        "-Command",
                        SCRIPT,
                    ])
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .creation_flags(0x0800_0000)
                    .spawn();
                let Ok(mut process) = spawned else {
                    sink.send(AppEvent::Log(
                        "NUMA wake listener failed to start; retrying".into(),
                    ));
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    continue;
                };
                let Some(stdout) = process.stdout.take() else {
                    sink.send(AppEvent::Log(
                        "NUMA wake listener produced no output; retrying".into(),
                    ));
                    let _ = process.kill();
                    let _ = process.wait();
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    continue;
                };
                if let Ok(mut current) = thread_child.lock() {
                    *current = Some(process);
                }
                // Open while a wake word is waiting for its command. The
                // recognizer gives one phrase per pause, so "hey numa" alone
                // has to keep listening for the sentence that follows it.
                let mut follow_up_until: Option<Instant> = None;
                for line in BufReader::new(stdout).lines() {
                    if thread_stop.load(Ordering::Relaxed) {
                        break;
                    }
                    let Ok(text) = line else { break };
                    let normalized = normalize(&text);
                    if normalized.is_empty() {
                        continue;
                    }
                    if thread_muted.load(Ordering::Relaxed) {
                        continue;
                    }
                    let open = follow_up_until
                        .map(|until| Instant::now() < until)
                        .unwrap_or(false);
                    match classify(&normalized, &text, open) {
                        Line::Wake(Some(command)) => {
                            follow_up_until = None;
                            sink.send(AppEvent::NumaWake);
                            sink.send(AppEvent::NumaTranscript(command));
                        }
                        Line::Wake(None) => {
                            follow_up_until = Some(Instant::now() + FOLLOW_UP);
                            sink.send(AppEvent::NumaWake);
                        }
                        Line::FollowUp(command) => {
                            follow_up_until = None;
                            sink.send(AppEvent::NumaTranscript(command));
                        }
                        Line::Ignore => {}
                    }
                }
                if let Ok(mut current) = thread_child.lock() {
                    if let Some(mut process) = current.take() {
                        let _ = process.kill();
                        let _ = process.wait();
                    }
                }
                if !thread_stop.load(Ordering::Relaxed) && !thread_muted.load(Ordering::Relaxed) {
                    sink.send(AppEvent::Log("NUMA wake listener restarted".into()));
                    std::thread::sleep(std::time::Duration::from_millis(500));
                }
            }
        })
        .map_err(|e| format!("can't start wake listener thread ({e})"))?;
    Ok(WakeListener {
        stop,
        muted,
        child,
        thread: Some(thread),
    })
}

impl WakeListener {
    pub fn set_muted(&self, muted: bool) {
        self.muted.store(muted, Ordering::Relaxed);
        if muted {
            if let Ok(mut child) = self.child.lock() {
                if let Some(child) = child.as_mut() {
                    let _ = child.kill();
                }
            }
        }
    }
}

impl Drop for WakeListener {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Ok(mut child) = self.child.lock() {
            if let Some(child) = child.as_mut() {
                let _ = child.kill();
            }
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hear(text: &str, follow_up_open: bool) -> Line {
        classify(&normalize(text), text, follow_up_open)
    }

    #[test]
    fn a_bare_wake_word_opens_the_window() {
        assert_eq!(hear("Hey, Numa.", false), Line::Wake(None));
        assert_eq!(hear("hey numa", false), Line::Wake(None));
    }

    #[test]
    fn a_wake_word_with_its_command_keeps_the_command() {
        assert_eq!(
            hear("Hey Numa, open Spotify", false),
            Line::Wake(Some("open spotify".into()))
        );
    }

    #[test]
    fn pronunciation_variants_still_wake() {
        assert_eq!(
            hear("hey nooma play jazz", false),
            Line::Wake(Some("play jazz".into()))
        );
        assert_eq!(hear("hey numah", false), Line::Wake(None));
    }

    #[test]
    fn the_command_after_a_bare_wake_is_no_longer_dropped() {
        assert_eq!(
            hear("open spotify", true),
            Line::FollowUp("open spotify".into())
        );
    }

    #[test]
    fn the_window_closes_again() {
        assert_eq!(hear("open spotify", false), Line::Ignore);
    }

    #[test]
    fn a_word_glued_to_the_wake_word_is_not_a_command() {
        // "hey numah" must not leave "h" behind as a request.
        assert_eq!(hear("hey numaa", false), Line::Ignore);
        assert_eq!(
            hear("hey numah please", false),
            Line::Wake(Some("please".into()))
        );
    }

    #[test]
    fn a_follow_up_keeps_what_the_speaker_actually_said() {
        assert_eq!(
            hear("What's 2+2?", true),
            Line::FollowUp("What's 2+2?".into())
        );
    }

    #[test]
    fn the_window_is_seconds_not_minutes() {
        assert_eq!(FOLLOW_UP_SECS, FOLLOW_UP.as_secs_f64());
        assert!((5.0..=15.0).contains(&FOLLOW_UP_SECS));
    }
}
