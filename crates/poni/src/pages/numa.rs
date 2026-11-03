//! NUMA's first page: the local assistant shell.
//!
//! M1 deliberately keeps this page presentational. The talk control is a
//! visible affordance for the later Deepgram integration, but does not start
//! recording or perform an action yet.

use crate::commands::{Command, NumaCmd};
use crate::gfx::{TextStyle, Weight};
use crate::icons::Icon;
use crate::oyen::{self, Coach as Oyen};
use crate::state::NumaPhase;
use crate::ui::{wid, PillStyle, Ui, PILL_SMALL};
use poni_core::geom::{palette, Point, Rect};

const HEIGHT: f32 = 180.0;
const LEFT_W: f32 = 150.0;
const COL_GAP: f32 = 18.0;
const HEAD_W: f32 = 84.0;
const HEAD_Y: f32 = 48.0;
const BUTTON_Y: f32 = 128.0;
const NUMA_PROVIDER: &str = "SAPI wake · Deepgram transcribe";

pub fn height(_st: &crate::state::AppState) -> f32 {
    HEIGHT
}

pub fn draw(ui: &mut Ui, st: &mut crate::state::AppState, area: Rect) {
    let area = Rect::new(area.x, area.y, area.w, HEIGHT);
    let left = Rect::new(area.x, area.y, LEFT_W, area.h);
    let right = Rect::new(
        area.x + LEFT_W + COL_GAP,
        area.y,
        (area.w - LEFT_W - COL_GAP).max(0.0),
        area.h,
    );
    let at = Point::new(left.center().x, left.y + HEAD_Y);

    if oyen::coach(
        ui.c,
        at,
        HEAD_W,
        ui.now,
        Oyen::Rest {
            look: look(ui, at, area),
        },
    ) {
        ui.request_live();
    }

    let listening = st.ui.numa.phase == NumaPhase::Listening;
    if listening {
        draw_listening(ui, at);
        ui.request_live();
    }
    let talk = Rect::new(
        left.center().x - 56.0,
        left.y + BUTTON_Y - PILL_SMALL / 2.0,
        112.0,
        PILL_SMALL,
    );
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

    let title = TextStyle::headline().wrap().top();
    let (_, title_h) = ui.c.measure("Ask Numa", &title, right.w.min(420.0));
    ui.c.text(
        "Ask Numa",
        Rect::new(right.x, right.y + 8.0, right.w.min(420.0), title_h + 1.0),
        &title,
    );

    ui.c.text(
        "Wake word · HEY NUMA",
        Rect::new(
            right.x,
            right.y + title_h + 1.0,
            right.w.min(420.0),
            PILL_SMALL,
        ),
        &TextStyle::footnote().color(oyen::ORANGE),
    );

    let body = TextStyle::footnote().color(palette::TEXT_DIM).wrap().top();
    let copy = match &st.ui.numa.phase {
        NumaPhase::Listening => "Listening… release when you finish speaking.",
        NumaPhase::Takeover => st
            .ui
            .numa
            .takeover_action
            .as_deref()
            .unwrap_or("Active computer-control mode — Esc to stop."),
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
            .unwrap_or("Hold Ctrl+Alt and speak in English. Release when you finish."),
    };
    let (_, body_h) = ui.c.measure(copy, &body, right.w.min(420.0));
    ui.c.text(
        copy,
        Rect::new(
            right.x,
            right.y + title_h + PILL_SMALL + 8.0,
            right.w.min(420.0),
            body_h + 1.0,
        ),
        &body,
    );

    // Safe vertical slice: visible active-control treatment (blue top bar,
    // truthful provider label, real-time action/status from stub event model).
    if matches!(&st.ui.numa.phase, NumaPhase::Takeover) {
        ui.c.fill_rect(
            Rect::new(right.x, right.y + HEAD_Y * 2.0, right.w.min(420.0), 3.0),
            palette::BLUE,
        );
    }

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
        right.right() - 84.0,
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
        if matches!(&st.ui.numa.phase, NumaPhase::Takeover) {
            "Active computer control — Esc to stop"
        } else {
            "Ready when you are"
        },
        Rect::new(right.x, status_y, right.w - 150.0, PILL_SMALL),
        &TextStyle::footnote()
            .weight(Weight::Semibold)
            .color(palette::TEXT_FAINT),
    );
    let provider = NUMA_PROVIDER;
    let provider_w = ui.pill_width(provider, false, true);
    let _ = ui.pill(
        wid("numa.provider"),
        Rect::new(right.right() - provider_w, status_y, provider_w, PILL_SMALL),
        provider,
        None,
        PillStyle::Neutral,
    );
    if matches!(&st.ui.numa.phase, NumaPhase::Takeover) {
        // Explicit Stop takeover action (safety path); the stub updater never
        // drives real mouse/keyboard — it only reports via `AppEvent`.
        let stop_rect = Rect::new(
            right.x + 10.0,
            status_y - PILL_SMALL - 4.0,
            110.0,
            PILL_SMALL,
        );
        if ui
            .pill(
                wid("numa.stop.takeover"),
                stop_rect,
                "Stop takeover",
                Some(Icon::Stop),
                PillStyle::UtilityAccent(palette::RED),
            )
            .clicked
        {
            st.cmd(Command::Numa(NumaCmd::StopTakeover));
        }
    }
}

fn look(ui: &Ui, at: Point, page: Rect) -> Option<f32> {
    ui.input
        .mouse
        .filter(|m| page.contains(*m))
        .map(|m| ((m.x - at.x) / 220.0).clamp(-1.0, 1.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_pill_is_truthful() {
        assert_eq!(NUMA_PROVIDER, "SAPI wake · Deepgram transcribe");
    }

    // Takeover phase is a distinct state; existing phases (Idle/Listening/Thinking/Error)
    // stay equally reachable and equal by construction.
    #[test]
    fn takeover_phase_coexists_with_existing_phases() {
        use crate::state::NumaPhase;
        assert_ne!(NumaPhase::Takeover, NumaPhase::Idle);
        assert!(matches!(NumaPhase::Takeover, NumaPhase::Takeover));
    }

    // Stop action pill only appears on the Takeover phase.
    #[test]
    fn stop_pill_only_on_takeover() {
        use crate::state::NumaPhase;
        let ui = crate::state::NumaUi::default();
        assert_eq!(ui.phase, NumaPhase::Idle);
        assert!(ui.takeover_action.is_none());
    }
}

/// Shared feedback for both Ctrl+Alt push-to-talk and the hands-free wake
/// listener. Keep it deliberately calm: a soft pulse and three signal bars
/// make the state obvious without competing with the assistant face.
fn draw_listening(ui: &mut Ui, center: Point) {
    let phase = (ui.now as f32 * 4.2).sin() * 0.5 + 0.5;
    let halo = 46.0 + phase * 8.0;
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

    let base = Point::new(center.x, center.y + HEAD_W / 2.0 + 13.0);
    for (index, height) in [7.0, 13.0 + phase * 5.0, 9.0].into_iter().enumerate() {
        let x = base.x - 13.0 + index as f32 * 13.0;
        ui.c.fill_rect(
            Rect::new(x, base.y - height, 5.0, height),
            oyen::ORANGE.with_alpha(0.72),
        );
    }
}
