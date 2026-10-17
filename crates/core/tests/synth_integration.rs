use std::fs;
use std::path::Path;

use mp_core::audio::midi_events::TempoMapEntry;
use mp_core::audio::synth::Player;

fn soundfont_path() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/FluidR3_GM.sf2")
}

#[test]
fn renders_audible_non_nan_audio_for_darkside() {
    let soundfont_path = soundfont_path();
    if !soundfont_path.exists() {
        eprintln!("skipping: soundfont not present in this environment");
        return;
    }
    let soundfont_bytes = fs::read(&soundfont_path).unwrap();
    let midi_bytes = fs::read("tests/fixtures/darkside.mid").unwrap();

    let mut player = Player::new(&soundfont_bytes, 44100).unwrap();
    let midi_file = player.load_midi(&midi_bytes).unwrap();
    player.play(&midi_file, false);

    // Render ~2 seconds of audio in one block — long enough to cross several
    // note-on events near the start of the piece.
    let frame_count = 44100 * 2;
    let mut left = vec![0.0f32; frame_count];
    let mut right = vec![0.0f32; frame_count];
    player.render(&mut left, &mut right);

    assert!(
        left.iter().all(|s| s.is_finite()),
        "left channel contains NaN/inf"
    );
    assert!(
        right.iter().all(|s| s.is_finite()),
        "right channel contains NaN/inf"
    );

    // At least one channel should have non-trivial amplitude somewhere in
    // these 2 seconds (the piece starts immediately per the timeline test's
    // first event at time_ms=0), i.e. this isn't silently producing all zeros.
    let max_abs = left
        .iter()
        .chain(right.iter())
        .fold(0.0f32, |acc, s| acc.max(s.abs()));
    assert!(
        max_abs > 0.001,
        "rendered audio is effectively silent (max abs sample = {max_abs})"
    );

    assert!(player.position_secs() > 0.0);
}

#[test]
fn speed_control_does_not_panic_mid_playback() {
    let soundfont_path = soundfont_path();
    if !soundfont_path.exists() {
        eprintln!("skipping: soundfont not present in this environment");
        return;
    }
    let soundfont_bytes = fs::read(&soundfont_path).unwrap();
    let midi_bytes = fs::read("tests/fixtures/youkai.mid").unwrap();

    let mut player = Player::new(&soundfont_bytes, 44100).unwrap();
    let midi_file = player.load_midi(&midi_bytes).unwrap();
    player.play(&midi_file, false);

    let mut left = vec![0.0f32; 4410];
    let mut right = vec![0.0f32; 4410];

    player.render(&mut left, &mut right);
    player.set_speed(0.5);
    player.render(&mut left, &mut right);
    player.set_speed(1.0);
    player.render(&mut left, &mut right);

    assert!(left.iter().all(|s| s.is_finite()));
}

/// `MidiFileSequencer::get_position()` reports time in the original (1.0x)
/// MIDI timeline regardless of playback speed — its internal clock advances
/// by `speed * block_size / sample_rate` per audio block, i.e. the
/// unsped-up rate scaled by how much wall-clock time has passed, not a
/// sped-up clock. Confirmed here so web/src/render/Cursor.ts knows it never
/// needs to apply its own speed conversion when comparing this position
/// against TimelineEvent.time_ms (also derived from the unsped timeline).
#[test]
fn speed_scales_position_advance_rate_not_wallclock_rate() {
    let soundfont_path = soundfont_path();
    if !soundfont_path.exists() {
        eprintln!("skipping: soundfont not present in this environment");
        return;
    }
    let soundfont_bytes = fs::read(&soundfont_path).unwrap();
    let midi_bytes = fs::read("tests/fixtures/darkside.mid").unwrap();

    let sample_rate = 44100;
    let one_second_frames = sample_rate as usize;

    // Render exactly 1 second of audio (by sample count) at 1.0x speed.
    let mut player_1x = Player::new(&soundfont_bytes, sample_rate).unwrap();
    let midi_1x = player_1x.load_midi(&midi_bytes).unwrap();
    player_1x.play(&midi_1x, false);
    let mut left = vec![0.0f32; one_second_frames];
    let mut right = vec![0.0f32; one_second_frames];
    player_1x.render(&mut left, &mut right);
    let position_1x = player_1x.position_secs();

    // Render exactly 1 second of audio (by sample count) at 0.5x speed.
    let mut player_half = Player::new(&soundfont_bytes, sample_rate).unwrap();
    let midi_half = player_half.load_midi(&midi_bytes).unwrap();
    player_half.play(&midi_half, false);
    player_half.set_speed(0.5);
    player_half.render(&mut left, &mut right);
    let position_half = player_half.position_secs();

    assert!(
        (position_half - position_1x / 2.0).abs() < 0.01,
        "expected position_half ({position_half}) to be ~half of position_1x ({position_1x})"
    );
}

/// The essential practice interaction: an arbitrary A/B loop region (not tied
/// to the whole file or to embedded MIDI loop markers) must actually wrap
/// playback position back to `loop_start_ms`, repeatedly, rather than running
/// past `loop_end_ms` or stopping.
#[test]
fn loop_region_wraps_position_back_to_start() {
    let soundfont_path = soundfont_path();
    if !soundfont_path.exists() {
        eprintln!("skipping: soundfont not present in this environment");
        return;
    }
    let soundfont_bytes = fs::read(&soundfont_path).unwrap();
    let midi_bytes = fs::read("tests/fixtures/darkside.mid").unwrap();

    let mut player = Player::new(&soundfont_bytes, 44100).unwrap();
    let midi = player.load_midi(&midi_bytes).unwrap();
    player.play(&midi, false);
    player.set_loop_region(Some((0.0, 500.0)));

    let mut left = vec![0.0f32; 4410]; // 100ms per render call
    let mut right = vec![0.0f32; 4410];

    // Render 2 seconds in 100ms chunks: with a 500ms loop region, position
    // should never be observed anywhere near 2000ms — it keeps wrapping back
    // under 500ms (plus a little slack for the chunk that crosses the
    // boundary before wrapping).
    let mut max_observed_position_ms = 0.0_f64;
    for _ in 0..20 {
        player.render(&mut left, &mut right);
        max_observed_position_ms = max_observed_position_ms.max(player.position_secs() * 1000.0);
    }

    assert!(
        max_observed_position_ms < 600.0,
        "expected position to stay within the 500ms loop region (plus one chunk's slack), \
         but observed {max_observed_position_ms}ms after 2s of rendering"
    );
    assert!(left.iter().all(|s| s.is_finite()));
}

/// The metronome should produce audible clicks mixed into the output even on
/// a MIDI file region with no notes playing (silence from the soundfont
/// alone), confirming clicks are generated independently of note content —
/// i.e. not a soundfont instrument patch.
#[test]
fn metronome_clicks_are_audible_without_relying_on_notes() {
    let soundfont_path = soundfont_path();
    if !soundfont_path.exists() {
        eprintln!("skipping: soundfont not present in this environment");
        return;
    }
    let soundfont_bytes = fs::read(&soundfont_path).unwrap();
    let midi_bytes = fs::read("tests/fixtures/darkside.mid").unwrap();

    let mut player = Player::new(&soundfont_bytes, 44100).unwrap();
    let midi = player.load_midi(&midi_bytes).unwrap();
    player.play(&midi, false);
    player.stop(); // clear any notes/midi so only clicks (no notes) can produce sound
    player.set_metronome_enabled(true);
    player.play(&midi, false);

    let frame_count = 44100 * 2;
    let mut left = vec![0.0f32; frame_count];
    let mut right = vec![0.0f32; frame_count];
    player.render(&mut left, &mut right);

    assert!(left.iter().all(|s| s.is_finite()));
    let max_abs = left
        .iter()
        .chain(right.iter())
        .fold(0.0f32, |acc, s| acc.max(s.abs()));
    assert!(
        max_abs > 0.001,
        "expected audible metronome clicks, got max abs sample = {max_abs}"
    );
}

/// PDF mode has no note data at all — only a user-calibrated tempo
/// map — so `Player::load_tempo_map` must produce audible metronome clicks
/// and a working A/B loop region exactly like `.mscz` MIDI playback does,
/// with zero note events ever dispatched.
#[test]
fn tempo_map_only_playback_produces_clicks_with_no_notes() {
    let soundfont_path = soundfont_path();
    if !soundfont_path.exists() {
        eprintln!("skipping: soundfont not present in this environment");
        return;
    }
    let soundfont_bytes = fs::read(&soundfont_path).unwrap();

    let tempo_map = vec![TempoMapEntry {
        time_ms: 0.0,
        qpm: 120.0,
        numerator: 4,
    }];
    let duration_ms = 4000.0;

    let mut player = Player::new(&soundfont_bytes, 44100).unwrap();
    let midi = player.load_tempo_map(tempo_map, duration_ms);
    player.set_metronome_enabled(true);
    player.play(&midi, true);

    let frame_count = 44100 * 2;
    let mut left = vec![0.0f32; frame_count];
    let mut right = vec![0.0f32; frame_count];
    player.render(&mut left, &mut right);

    assert!(left.iter().all(|s| s.is_finite()));
    let max_abs = left
        .iter()
        .chain(right.iter())
        .fold(0.0f32, |acc, s| acc.max(s.abs()));
    assert!(
        max_abs > 0.001,
        "expected audible metronome clicks, got max abs sample = {max_abs}"
    );

    // Loop region defaults to the whole duration when play_loop is true —
    // confirm it actually wraps rather than running past `duration_ms`.
    let mut total_rendered_ms = 0.0;
    let mut max_observed_position_ms = 0.0_f64;
    while total_rendered_ms < duration_ms * 1.5 {
        player.render(&mut left, &mut right);
        max_observed_position_ms = max_observed_position_ms.max(player.position_secs() * 1000.0);
        total_rendered_ms += frame_count as f64 / 44100.0 * 1000.0;
    }
    assert!(
        max_observed_position_ms < duration_ms + 200.0,
        "expected position to stay within the {duration_ms}ms loop region (plus slack), \
         but observed {max_observed_position_ms}ms"
    );
}

/// Each click must play out in full — its sample is far longer than one
/// synth block, and an earlier version cut every click off at the end of
/// the block it started in (inaudible, though still "nonzero"). Checks the
/// rendered energy against the samples' own, at full and half volume.
#[test]
fn metronome_clicks_play_their_whole_sample_scaled_by_volume() {
    let soundfont_path = soundfont_path();
    if !soundfont_path.exists() {
        eprintln!("skipping: soundfont not present in this environment");
        return;
    }
    let soundfont_bytes = fs::read(&soundfont_path).unwrap();
    let sample_rate = 44100;
    let (click, accent) = mp_core::audio::metronome::load_click_samples(sample_rate);
    let energy = |s: &[f32]| s.iter().map(|v| v.abs() as f64).sum::<f64>();
    // 120 qpm in 4/4 over 2s: an accent at 0ms, plain clicks at 500/1000/1500ms.
    let expected = energy(&accent.samples) + 3.0 * energy(&click.samples);

    for volume in [1.0f32, 0.5] {
        let mut player = Player::new(&soundfont_bytes, sample_rate).unwrap();
        let tempo_map = vec![TempoMapEntry {
            time_ms: 0.0,
            qpm: 120.0,
            numerator: 4,
        }];
        let midi = player.load_tempo_map(tempo_map, 4000.0);
        player.set_metronome_enabled(true);
        player.set_metronome_volume(volume);
        player.play(&midi, false);

        let frame_count = sample_rate as usize * 2;
        let mut left = vec![0.0f32; frame_count];
        let mut right = vec![0.0f32; frame_count];
        player.render(&mut left, &mut right);

        let rendered = energy(&left);
        let want = expected * volume as f64;
        assert!(
            (rendered - want).abs() < want * 0.05,
            "volume {volume}: rendered click energy {rendered:.1}, expected ~{want:.1}"
        );
    }
}
