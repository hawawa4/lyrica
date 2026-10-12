pub mod api;
pub mod audio;
pub mod mscz;
pub mod timeline;

// Re-exported so downstream crates (e.g. crates/desktop, which needs
// `MidiFile` to hold a loaded file across play/stop calls) don't need their
// own separate rustysynth dependency just to name its types.
pub use rustysynth;
