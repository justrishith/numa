//! NUMA local computer-control takeover — safe boundary / stub event model.
//!
//! This module defines the clear boundary: it reports tool events (`AppEvent`)
//! and writes a running `takeover_action` string, but never executes arbitrary
//! mouse/keyboard input. Real input injection is out of scope; the stub is
//! explicit so reviewers see where the boundary sits.

use crate::events::{AppEvent, EventSink};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// Tool event describing an action the takeover runner would take if it had
/// a safe abstraction for it. Each event carries a description, not an
/// execution payload — the UI reads these to show status.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolEvent {
    pub kind: ToolKind,
    pub description: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum ToolKind {
    #[default]
    Status,
    ActionRequested,
    SafetyStopped,
}

/// Safe updater thread: sends `NumaTakeoverState` messages with descriptions,
/// but never calls OS input APIs.
pub struct TakeoverRunner {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl TakeoverRunner {
    pub fn start(sink: EventSink) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_clone = stop.clone();
        let thread = std::thread::Builder::new()
            .name("numa-takeover-stub".into())
            .spawn(move || {
                let mut next_status = Instant::now();
                while !stop_clone.load(Ordering::Relaxed) {
                    if Instant::now() >= next_status {
                        sink.send(AppEvent::NumaTakeoverState(
                            "Takeover active — actions reported, not executed.".into(),
                        ));
                        next_status = Instant::now() + Duration::from_secs(2);
                    }
                    // Keep Stop/Escape teardown responsive instead of making
                    // Drop wait for the full status interval.
                    std::thread::sleep(Duration::from_millis(50));
                }
            })
            .ok();
        Self { stop, thread }
    }
}

impl Drop for TakeoverRunner {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}
