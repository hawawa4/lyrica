use std::fs;
use std::path::Path;

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

    assert!(left.iter().all(|s| s.is_finite()), "left channel contains NaN/inf");
    assert!(right.iter().all(|s| s.is_finite()), "right channel contains NaN/inf");

    // At least one channel should have non-trivial amplitude somewhere in
    // these 2 seconds (the piece starts immediately per the timeline test's
    // first event at time_ms=0), i.e. this isn't silently producing all zeros.
    let max_abs = left
        .iter()
        .chain(right.iter())
        .fold(0.0f32, |acc, s| acc.max(s.abs()));
    assert!(max_abs > 0.001, "rendered audio is effectively silent (max abs sample = {max_abs})");

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
