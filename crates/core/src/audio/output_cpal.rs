use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleRate, StreamConfig};
use thiserror::Error;

use super::synth::Player;

#[derive(Debug, Error)]
pub enum OutputError {
    #[error("no default output device found")]
    NoDevice,
    #[error("failed to query default output config: {0}")]
    Config(#[from] cpal::DefaultStreamConfigError),
    #[error("failed to build output stream: {0}")]
    BuildStream(#[from] cpal::BuildStreamError),
    #[error("failed to start output stream: {0}")]
    PlayStream(#[from] cpal::PlayStreamError),
}

/// The default output device's native sample rate. `Player` must be
/// constructed with this exact rate — the synth has no internal
/// resampling, so if the synth renders at a different rate than the device
/// actually plays back at, audio comes out at the wrong pitch/speed (or, on
/// some backends, cpal silently accepts a mismatched rate in the stream
/// config and produces no audible output at all rather than erroring).
pub fn default_output_sample_rate() -> Result<i32, OutputError> {
    let host = cpal::default_host();
    let device = host.default_output_device().ok_or(OutputError::NoDevice)?;
    let config = device.default_output_config()?;
    Ok(config.sample_rate().0 as i32)
}

/// Opens the system's default audio output device and streams `Player`'s
/// rendered audio to it. The stream must be kept alive (don't drop the
/// returned value) for playback to continue — cpal stops the stream on drop.
///
/// `player` must already be constructed with
/// [`default_output_sample_rate`]'s value (see its doc comment for why).
///
/// This is the one place desktop and web/server genuinely diverge: synth logic in `Player` is shared, but
/// the web/server target instead streams synthesized PCM to the browser's
/// Web Audio API over the API boundary rather than opening a cpal device.
pub fn start_output_stream(player: Arc<Mutex<Player>>) -> Result<cpal::Stream, OutputError> {
    let host = cpal::default_host();
    let device = host.default_output_device().ok_or(OutputError::NoDevice)?;

    let sample_rate = player.lock().unwrap().sample_rate() as u32;
    let config = StreamConfig {
        channels: 2,
        sample_rate: SampleRate(sample_rate),
        buffer_size: cpal::BufferSize::Default,
    };

    // Scratch buffers reused across callback invocations to avoid
    // reallocating on the audio thread every callback.
    let mut left_buf: Vec<f32> = Vec::new();
    let mut right_buf: Vec<f32> = Vec::new();

    let stream = device.build_output_stream(
        &config,
        move |data: &mut [f32], _info: &cpal::OutputCallbackInfo| {
            let frame_count = data.len() / 2;
            left_buf.resize(frame_count, 0.0);
            right_buf.resize(frame_count, 0.0);

            if let Ok(mut player) = player.lock() {
                player.render(&mut left_buf, &mut right_buf);
            }

            for i in 0..frame_count {
                data[2 * i] = left_buf[i];
                data[2 * i + 1] = right_buf[i];
            }
        },
        |err| eprintln!("audio output stream error: {err}"),
        None,
    )?;

    stream.play()?;
    Ok(stream)
}
