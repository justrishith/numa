//! NUMA's page: the warm, cozy home of the notch's calico cat.
//!
//! The left half is hers: the full face, her eyes carrying the assistant's
//! state (listening, thinking, an approval waiting, the night's sleep). The
//! right half is the conversation: what was heard, what NUMA said, and the
//! gateway's runs woven in as feed rows — including Approve/Cancel on runs
//! that ask for permission, so the notch answers instead of only mirroring.

use crate::commands::{Command, NumaCmd};
use crate::gfx::{TextStyle, Weight};
use crate::icons::Icon;
use crate::oyen::{self};
use crate::state::{NumaGatewayUi, NumaPhase, NumaRun, NumaRunState};
use crate::ui::{wid, wid_n, PillStyle, Ui, PILL_SMALL};
use poni_core::datetime::fmt_clock;
use poni_core::geom::{palette, Color, Point, Rect};

const HEIGHT: f32 = 210.0;
/// The open-history panel: a title and three turns, with a gap above and
/// below, added to the page so it never runs into the feed or the bottom row.
const HISTORY_HEIGHT: f32 = 148.0;
const HISTORY_ROWS: usize = 3;
const HISTORY_ROW_H: f32 = 22.0;
/// The pinned bottom row: the audio line and the mute pill, plus the gap
/// between them. History stops this far above the page's bottom edge.
const BOTTOM_BLOCK_H: f32 = 61.0;
const BOTTOM_GAP: f32 = 8.0;
const LEFT_W: f32 = 168.0;
const COL_GAP: f32 = 16.0;
const HEAD_W: f32 = 96.0;
const FACE_Y: f32 = 92.0;
const TALK_Y: f32 = 156.0;
const NUMA_PROVIDER: &str = "SAPI wake · Deepgram transcribe";

// The warm coat of the page: cards tinted toward the calico's cream and
// ginger rather than the app's neutral greys, so the notch feels like her
// den. The cards are dark in every theme (her den stays cozy on the light
// Oyen island too), while text uses the theme's own adaptive inks — cream
// text would vanish on the light island. Accents stay Oyen's orange.
const WARM_CARD: Color = Color::hex(0x34271D);
const WARM_CARD_SOFT: Color = Color::hex(0x2A2018);
const WARM_INK: Color = Color::hex(0xFFE7C9);

/// How many feed rows the page shows: an approval always leads, then the
/// newest run; two at most, so the conversation keeps its room.
const FEED_ROWS: usize = 2;

pub fn height(st: &crate::state::AppState) -> f32 {
    HEIGHT
        + if st.ui.numa.history_open {
            HISTORY_HEIGHT
        } else {
            0.0
        }
}

pub fn draw(ui: &mut Ui, st: &mut crate::state::AppState, area: Rect) {
    let area = Rect::new(area.x, area.y, area.w, height(st));
    let left = Rect::new(area.x, area.y, LEFT_W, area.h);
    let right = Rect::new(
        area.x + LEFT_W + COL_GAP,
        area.y,
        (area.w - LEFT_W - COL_GAP).max(0.0),
        area.h,
    );
    let at = Point::new(left.center().x, left.y + FACE_Y);

    // Her den: a soft warm panel behind the face.
    ui.c.fill_rrect(
        Rect::new(left.x + 10.0, left.y + 10.0, LEFT_W - 20.0, HEIGHT - 20.0),
        18.0,
        WARM_CARD_SOFT,
    );

    let waiting = st
        .ui
        .numa
        .gateway
        .runs
        .iter()
        .any(|r| r.state == NumaRunState::Waiting);
    let look = look(ui, at, area);
    if oyen::numa_face(
        ui.c,
        at,
        HEAD_W,
        ui.now,
        &st.ui.numa.phase,
        look,
        waiting,
        st.local.hour,
    ) {
        ui.request_live();
    }
    if st.ui.numa.phase == NumaPhase::Listening {
        draw_listening(ui, at);
        ui.request_live();
    }

    let listening = st.ui.numa.phase == NumaPhase::Listening;
    let talk = Rect::new(left.center().x - 56.0, left.y + TALK_Y, 112.0, PILL_SMALL);
    let label = if listening {
        "Stop recording"
    } else {
        "Push to talk"
    };
    let icon = if listening { Icon::Stop } else { Icon::Mic };
    if ui
        .pill(
            wid("numa.talk"),
            talk,
            label,
            Some(icon),
            PillStyle::Primary(oyen::ORANGE),
        )
        .clicked
    {
        st.cmd(Command::Numa(if listening {
            NumaCmd::Stop
        } else {
            NumaCmd::Start
        }));
    }

    // ---- the right column: header, what was said, the gateway feed
    let title = TextStyle::headline()
        .weight(Weight::Bold)
        .color(palette::TEXT);
    ui.c.text(
        "NUMA",
        Rect::new(right.x, right.y + 8.0, 120.0, 22.0),
        &title,
    );

    // The clock lives here now (the idle pill belongs to the cat), just
    // left of the history pill so the two never meet.
    let time = fmt_clock(&st.local, st.settings.use_24h);
    let time_w = ui.c.measure(&time, &TextStyle::footnote(), 200.0).0 + 4.0;
    ui.c.text(
        &time,
        Rect::new(right.right() - 108.0 - time_w, right.y + 8.0, time_w, 22.0),
        &TextStyle::footnote()
            .weight(Weight::Semibold)
            .tabular()
            .color(palette::TEXT_DIM),
    );

    let body = TextStyle::footnote().color(palette::TEXT).wrap().top();
    let copy = match &st.ui.numa.phase {
        NumaPhase::Listening => "Listening… release when you finish speaking.",
        NumaPhase::Thinking => st
            .ui
            .numa
            .response
            .as_deref()
            .unwrap_or("NUMA is working on it…"),
        NumaPhase::Error(error) => error.as_str(),
        NumaPhase::Idle => st
            .ui
            .numa
            .transcript
            .as_deref()
            .or(st.ui.numa.response.as_deref())
            .unwrap_or("Say “hey numa”, or hold the talk button."),
    };
    let (_, body_h) = ui.c.measure(copy, &body, right.w.min(420.0));
    let body_h = body_h.min(36.0);
    ui.c.text(
        copy,
        Rect::new(right.x, right.y + 34.0, right.w.min(420.0), body_h + 1.0),
        &body,
    );

    // The gateway feed, woven in: one status line, then run cards.
    draw_gateway_feed(ui, st, &right, right.y + 34.0 + body_h + 10.0);

    let history_rect = Rect::new(right.right() - 96.0, right.y + 8.0, 96.0, PILL_SMALL);
    if ui
        .pill(
            wid("numa.history"),
            history_rect,
            if st.ui.numa.history_open {
                "Hide chat"
            } else {
                "Chat history"
            },
            None,
            PillStyle::Neutral,
        )
        .clicked
    {
        st.ui.numa.history_open = !st.ui.numa.history_open;
    }

    if st.ui.numa.history_open {
        // Anchored to the bottom: the history panel's last row ends a gap
        // above the pinned bottom row, never on top of it.
        let history_y = area.bottom()
            - BOTTOM_BLOCK_H
            - BOTTOM_GAP
            - (PILL_SMALL + HISTORY_ROWS as f32 * HISTORY_ROW_H);
        ui.c.text(
            "Local chat history",
            Rect::new(right.x, history_y, right.w.min(420.0), PILL_SMALL),
            &TextStyle::footnote().color(palette::TEXT_DIM),
        );
        let turns = st
            .ui
            .numa
            .history
            .iter()
            .rev()
            .take(HISTORY_ROWS)
            .collect::<Vec<_>>();
        if turns.is_empty() {
            ui.c.text(
                "No local turns yet.",
                Rect::new(
                    right.x,
                    history_y + PILL_SMALL,
                    right.w.min(420.0),
                    PILL_SMALL,
                ),
                &TextStyle::footnote().color(palette::TEXT_DIM),
            );
        } else {
            for (index, turn) in turns.into_iter().rev().enumerate() {
                let line = format!("{} → {}", turn.user, turn.response);
                ui.c.text(
                    &line,
                    Rect::new(
                        right.x,
                        history_y + PILL_SMALL + index as f32 * HISTORY_ROW_H,
                        right.w.min(420.0),
                        21.0,
                    ),
                    &TextStyle::footnote().color(palette::TEXT_DIM),
                );
            }
        }
    }

    // ---- the bottom row: mic and output, then the provider pill
    let status_y = area.bottom() - PILL_SMALL;
    let audio_status = if st.ui.numa.mic_muted {
        "Input: muted · Output: default speaker".to_owned()
    } else if st.volume.known {
        let output = if st.volume.muted {
            "muted".to_owned()
        } else {
            format!(
                "{}%",
                (st.volume.level.clamp(0.0, 1.0) * 100.0).round() as u32
            )
        };
        format!("Input: default mic · Output: {output}")
    } else {
        "Input: default mic · Output: checking".to_owned()
    };
    ui.c.text(
        &audio_status,
        Rect::new(
            right.x,
            status_y - PILL_SMALL - 4.0,
            right.w.min(300.0),
            PILL_SMALL,
        ),
        &TextStyle::footnote().color(palette::TEXT_DIM),
    );
    let mute_rect = Rect::new(
        right.right() - 184.0,
        status_y - PILL_SMALL - 5.0,
        84.0,
        PILL_SMALL,
    );
    if ui
        .pill(
            wid("numa.mute"),
            mute_rect,
            if st.ui.numa.mic_muted {
                "Unmute mic"
            } else {
                "Mute mic"
            },
            None,
            PillStyle::Neutral,
        )
        .clicked
    {
        st.cmd(Command::Numa(if st.ui.numa.mic_muted {
            NumaCmd::Unmute
        } else {
            NumaCmd::Mute
        }));
    }
    ui.c.text(
        "Ready when you are",
        Rect::new(right.x, status_y, right.w - 150.0, PILL_SMALL),
        &TextStyle::footnote()
            .weight(Weight::Semibold)
            .color(palette::TEXT_FAINT),
    );
    // The provider line is information, not a control: plain faint text,
    // never pill chrome that promises a click it cannot answer.
    let provider_ts = TextStyle::footnote().color(palette::TEXT_FAINT);
    let (provider_w, _) = ui.c.measure(NUMA_PROVIDER, &provider_ts, 260.0);
    ui.c.text(
        NUMA_PROVIDER,
        Rect::new(right.right() - provider_w, status_y, provider_w, PILL_SMALL),
        &provider_ts,
    );
}

/// The feed's rows: an approval always leads, then the newest run, two at
/// most. Pure so the page's tests can pin the order.
fn feed_rows(gateway: &NumaGatewayUi) -> Vec<NumaRun> {
    let mut rows: Vec<NumaRun> = gateway
        .runs
        .iter()
        .rev()
        .filter(|r| r.state == NumaRunState::Waiting)
        .cloned()
        .collect();
    for run in gateway.runs.iter().rev() {
        if rows.len() >= FEED_ROWS {
            break;
        }
        if !rows.iter().any(|r| r.id == run.id) {
            rows.push(run.clone());
        }
    }
    rows.truncate(FEED_ROWS);
    rows
}

/// The gateway feed: a status line ("Gateway · online", the cat's orange when
/// she can hear the core) and one warm card per recent run, with Approve and
/// Cancel right on the card when a run waits for permission. `top` is where
/// the status line starts.
fn draw_gateway_feed(ui: &mut Ui, st: &mut crate::state::AppState, right: &Rect, top: f32) {
    let gateway = &st.ui.numa.gateway;
    let (dot, line) = if gateway.connected {
        (oyen::ORANGE, "Gateway · online")
    } else {
        (palette::TEXT_FAINT, "Gateway · offline")
    };
    ui.c.fill_rect(Rect::new(right.x, top + 7.0, 6.0, 6.0), dot);
    ui.c.text(
        line,
        Rect::new(right.x + 12.0, top, 140.0, PILL_SMALL),
        &TextStyle::footnote()
            .weight(Weight::Semibold)
            .color(if gateway.connected {
                palette::TEXT_DIM
            } else {
                palette::TEXT_FAINT
            }),
    );

    let rows = feed_rows(gateway);
    let mut y = top + PILL_SMALL + 4.0;
    for (index, run) in rows.iter().enumerate() {
        let card = Rect::new(right.x, y, right.w.min(420.0), 30.0);
        ui.c.fill_rrect(card, 10.0, WARM_CARD);
        let color = match run.state {
            NumaRunState::Waiting | NumaRunState::Running => oyen::ORANGE,
            NumaRunState::Done => palette::GREEN,
            NumaRunState::Failed | NumaRunState::Cancelled => palette::RED,
        };
        ui.c.fill_rect(Rect::new(card.x + 10.0, y + 12.0, 6.0, 6.0), color);
        ui.c.text(
            &format!("{} · {}", run.tool, run.state.label()),
            Rect::new(card.x + 24.0, y, card.w - 190.0, 30.0),
            &TextStyle::footnote().color(if run.state == NumaRunState::Waiting {
                WARM_INK
            } else {
                palette::TEXT_DIM
            }),
        );
        if run.state == NumaRunState::Waiting {
            let ok = Rect::new(card.right() - 158.0, y + 4.0, 74.0, 22.0);
            if ui
                .pill(
                    wid_n("numa.run.approve", index as u64),
                    ok,
                    "Approve",
                    None,
                    PillStyle::Primary(oyen::ORANGE),
                )
                .clicked
            {
                st.cmd(Command::Numa(NumaCmd::Approve(run.id.clone())));
            }
            let no = Rect::new(card.right() - 78.0, y + 4.0, 68.0, 22.0);
            if ui
                .pill(
                    wid_n("numa.run.cancel", index as u64),
                    no,
                    "Cancel",
                    None,
                    PillStyle::Neutral,
                )
                .clicked
            {
                st.cmd(Command::Numa(NumaCmd::Cancel(run.id.clone())));
            }
        }
        y += 36.0;
    }
}

fn look(ui: &Ui, at: Point, page: Rect) -> Option<f32> {
    ui.input
        .mouse
        .filter(|m| page.contains(*m))
        .map(|m| ((m.x - at.x) / 220.0).clamp(-1.0, 1.0))
}

/// Shared feedback for both Ctrl+Alt push-to-talk and the hands-free wake
/// listener. Keep it deliberately calm: a soft pulse and three signal bars
/// make the state obvious without competing with the assistant face.
fn draw_listening(ui: &mut Ui, center: Point) {
    let phase = (ui.now as f32 * 4.2).sin() * 0.5 + 0.5;
    let halo = 56.0 + phase * 8.0;
    ui.c.stroke_circle(
        center,
        halo,
        oyen::ORANGE.with_alpha(0.16 + phase * 0.12),
        2.0,
    );
    ui.c.stroke_circle(
        center,
        halo + 7.0,
        oyen::ORANGE.with_alpha(0.05 + phase * 0.06),
        1.0,
    );

    let base = Point::new(center.x, center.y + HEAD_W / 2.0 + 16.0);
    for (index, height) in [7.0, 13.0 + phase * 5.0, 9.0].into_iter().enumerate() {
        let x = base.x - 13.0 + index as f32 * 13.0;
        ui.c.fill_rect(
            Rect::new(x, base.y - height, 5.0, height),
            oyen::ORANGE.with_alpha(0.72),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_label_is_truthful() {
        assert_eq!(NUMA_PROVIDER, "SAPI wake · Deepgram transcribe");
    }

    // The feed leads with what needs a decision, then shows the newest run —
    // never more than two rows, whatever the stream did.
    #[test]
    fn feed_leads_with_approvals_then_newest() {
        use crate::state::NumaGatewayUi;
        let mut gateway = NumaGatewayUi::default();
        gateway.apply(
            "execution.created",
            "old",
            &serde_json::json!({ "toolId": "composio.gmail.get.profile" }),
        );
        gateway.apply("execution.succeeded", "old", &serde_json::json!({}));
        gateway.apply(
            "execution.created",
            "fresh",
            &serde_json::json!({ "toolId": "composio.todoist.filter.tasks" }),
        );
        gateway.apply("approval.required", "fresh", &serde_json::json!({}));
        let rows = feed_rows(&gateway);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "fresh");
        assert_eq!(rows[0].state, NumaRunState::Waiting);
        assert_eq!(rows[1].id, "old");
    }

    #[test]
    fn feed_caps_rows_and_skips_unknown_runs() {
        use crate::state::NumaGatewayUi;
        let mut gateway = NumaGatewayUi::default();
        for index in 0..4 {
            gateway.apply(
                "execution.created",
                &format!("e{index}"),
                &serde_json::json!({ "toolId": "composio.gmail.get.profile" }),
            );
        }
        let rows = feed_rows(&gateway);
        assert_eq!(rows.len(), FEED_ROWS);
        assert_eq!(rows[0].id, "e3");
        assert_eq!(rows[1].id, "e2");
    }

    // The gateway state machine mirrors the stream: an unknown run never
    // appears, a known one walks created → (approval) → done.
    #[test]
    fn gateway_state_walks_the_lifecycle() {
        use crate::state::NumaGatewayUi;
        let mut gateway = NumaGatewayUi::default();
        assert_eq!(gateway.runs.len(), 0);
        gateway.apply(
            "execution.created",
            "e1",
            &serde_json::json!({ "toolId": "composio.gmail.get.profile" }),
        );
        assert_eq!(gateway.runs[0].state, NumaRunState::Running);
        assert_eq!(gateway.runs[0].tool, "gmail.get.profile");
        gateway.apply("approval.required", "e1", &serde_json::json!({}));
        assert_eq!(gateway.runs[0].state, NumaRunState::Waiting);
        gateway.apply("tool.started", "e1", &serde_json::json!({}));
        assert_eq!(gateway.runs[0].state, NumaRunState::Running);
        gateway.apply("execution.succeeded", "e1", &serde_json::json!({}));
        assert_eq!(gateway.runs[0].state, NumaRunState::Done);
        // Events for runs the notch never saw are ignored, not invented.
        gateway.apply("execution.failed", "e9", &serde_json::json!({}));
        assert_eq!(gateway.runs.len(), 1);
    }

    #[test]
    fn gateway_state_survives_failure_and_cancel() {
        use crate::state::NumaGatewayUi;
        let mut gateway = NumaGatewayUi::default();
        gateway.apply(
            "execution.created",
            "e1",
            &serde_json::json!({ "toolId": "composio.todoist.filter.tasks" }),
        );
        gateway.apply("execution.cancelled", "e1", &serde_json::json!({}));
        assert_eq!(gateway.runs[0].state, NumaRunState::Cancelled);
        gateway.apply(
            "execution.created",
            "e2",
            &serde_json::json!({ "toolId": "composio.gmail.create.email.draft" }),
        );
        gateway.apply("execution.failed", "e2", &serde_json::json!({}));
        assert_eq!(gateway.runs[1].state, NumaRunState::Failed);
    }

    #[test]
    fn gateway_state_caps_finished_history() {
        use crate::state::NumaGatewayUi;
        let mut gateway = NumaGatewayUi::default();
        for index in 0..8 {
            gateway.apply(
                "execution.created",
                &format!("e{index}"),
                &serde_json::json!({ "toolId": "composio.gmail.get.profile" }),
            );
            gateway.apply(
                "execution.succeeded",
                &format!("e{index}"),
                &serde_json::json!({}),
            );
        }
        // All runs finished: the list stays capped, newest kept.
        assert!(gateway.runs.len() <= NumaGatewayUi::RUN_CAP);
        assert_eq!(gateway.runs.last().unwrap().id, "e7");
    }
}
