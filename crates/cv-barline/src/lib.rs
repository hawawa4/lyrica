//! PDF-mode barline-detection assist (IMPLEMENTATION_PLAN.md Phase 9,
//! optional/skippable). Classical computer vision, not ML or OMR: detecting
//! barlines (vertical dark-pixel runs spanning staff height) is a
//! comparatively well-solved sub-problem even without machine learning,
//! unlike notehead/pitch recognition — see the handoff spec's PDF-mode
//! section for why full OMR was rejected as a core feature.
//!
//! Returns candidate x-positions as **suggestions only** — the caller (the
//! JS calibration UI) renders them as adjustable/dismissable markers the
//! user must confirm before they become real calibration points; this crate
//! never writes calibration data itself and has no knowledge of
//! `crates/core`'s sidecar storage.
//!
//! Input is a page's rendered bitmap as PNG bytes (handed from the JS
//! canvas via the API boundary, same pattern as Phase 4's MIDI/positions
//! data hand-off — `crates/core` still never parses `.mscz`/MIDI directly;
//! this crate is a separate, self-contained concern that only ever sees
//! pixels).

use image::GrayImage;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CvBarlineError {
    #[error("failed to decode image: {0}")]
    Decode(#[from] image::ImageError),
}

/// One detected **system** — one or more staves bracketed together (e.g. a
/// piano grand staff's treble+bass pair) — and the barline x-positions found
/// spanning its *entire* vertical extent. `top`/`bottom` are pixel rows
/// (inclusive) from the topmost staff line of the system's first staff to
/// the bottommost staff line of its last staff, in the input image's own
/// pixel coordinate space (the caller is responsible for converting back to
/// PDF-point space if needed, same as `pdf-engine.ts`'s canvas coordinates).
///
/// Grouping staves into systems (rather than detecting barlines per
/// individual 5-line staff) matters for correctness, not just presentation:
/// a real measure barline on a grand staff is one continuous vertical line
/// from the top of the treble staff to the bottom of the bass staff,
/// including the gap between them. Requiring that full span to be dark is
/// what actually distinguishes a real barline from a false positive like a
/// tall chord stack or stem, which only spans *one* staff's height and
/// leaves the inter-staff gap blank — checking each staff in isolation
/// (an earlier version of this module) couldn't tell the two apart and
/// produced exactly those false positives in practice.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StaffSystem {
    pub top: u32,
    pub bottom: u32,
    pub barline_xs: Vec<u32>,
}

/// Tuning constants. Kept as named constants rather than parameters since
/// callers (the suggestion UI) don't need to tune computer-vision internals
/// — if these ever need exposing, it should be because real test images
/// showed a concrete need, not speculatively.
mod tuning {
    /// Pixel luminance (0-255) at or below which a pixel counts as "ink".
    pub const DARK_THRESHOLD: u8 = 128;
    /// A row counts as a staff line if at least this fraction of its pixels
    /// (within the page's horizontal ink extent, not the whole page width —
    /// see `horizontal_ink_extent`) are dark.
    pub const STAFF_LINE_ROW_DENSITY: f32 = 0.5;
    /// Staff lines within this many pixels of each other are treated as
    /// belonging to the same 5-line staff (not two separate staves). Scaled
    /// by the detected staff-line spacing (see `group_into_staves`), not a
    /// fixed pixel count, so this works the same at any render resolution.
    pub const MAX_GAP_WITHIN_STAFF_LINE_SPACINGS: f32 = 3.0;
    /// A detected staff must have at least this many staff-line rows to
    /// count as real (cuts out stray single dark rows from noise/artifacts).
    pub const MIN_LINES_PER_STAFF: usize = 3;
    /// Two consecutive staves are grouped into the same system (e.g. a piano
    /// grand staff's treble+bass pair) if the gap between them is at most
    /// this many multiples of the staff-line spacing (see `group_into_staves`).
    /// Confirmed against real rendered sheet music: the gap *between* a
    /// grand staff's two staves and the gap *between separate systems* are
    /// both roughly proportional to the staff-line spacing, but at
    /// different multiples (~7x for intra-system, ~15x for inter-system in
    /// the fixture this was tuned against) — comfortably separated by this
    /// threshold, and this holds regardless of overall render resolution
    /// since both gaps and the line spacing scale together (unlike a fixed
    /// pixel threshold, or one relative to staff height, which didn't:
    /// confirmed empirically that the intra-system gap can exceed the
    /// staff's own height).
    pub const MAX_INTER_STAFF_GAP_LINE_SPACINGS: f32 = 10.0;
    /// A column counts as a barline candidate if at least this fraction of
    /// its pixels within the *entire system's* vertical band (plus margin,
    /// spanning every staff in the system and the gaps between them) are
    /// dark — high enough to exclude note stems/chord stacks (which don't
    /// span the full system height across every staff) and beams
    /// (horizontal, not vertical runs), but low enough to tolerate
    /// anti-aliasing/compression noise along the line.
    pub const BARLINE_COLUMN_DENSITY: f32 = 0.85;
    /// Extra pixels added above/below a system's top/bottom line when
    /// computing the barline column projection — barlines visually extend
    /// slightly past the outer staff lines.
    pub const STAFF_VERTICAL_MARGIN: u32 = 4;
    /// Adjacent barline-candidate columns within this many pixels of each
    /// other are merged into a single x-position (a barline is a few pixels
    /// wide, not a single-pixel column).
    pub const BARLINE_MERGE_DISTANCE: u32 = 6;
}

pub fn detect_barlines(png_bytes: &[u8]) -> Result<Vec<StaffSystem>, CvBarlineError> {
    let img = image::load_from_memory(png_bytes)?.to_luma8();
    Ok(detect_barlines_in_image(&img))
}

fn detect_barlines_in_image(img: &GrayImage) -> Vec<StaffSystem> {
    let (width, height) = img.dimensions();
    if width == 0 || height == 0 {
        return Vec::new();
    }

    let (ink_left, ink_right) = horizontal_ink_extent(img);
    if ink_left >= ink_right {
        return Vec::new();
    }
    let ink_width = ink_right - ink_left;

    let staff_line_rows = find_staff_line_rows(img, ink_left, ink_right, ink_width);
    let line_spacing = estimate_line_spacing(&staff_line_rows);
    let staves = group_into_staves(&staff_line_rows, line_spacing);
    let systems = group_staves_into_systems(&staves, line_spacing);

    systems
        .into_iter()
        .map(|(top, bottom)| {
            let barline_xs = find_barline_columns(img, top, bottom, ink_left, ink_right);
            StaffSystem { top, bottom, barline_xs }
        })
        .collect()
}

/// The leftmost/rightmost columns containing any ink at all, so row/column
/// density thresholds are relative to "the printed content's width," not the
/// full page width (which includes blank margins that would otherwise dilute
/// every density calculation).
fn horizontal_ink_extent(img: &GrayImage) -> (u32, u32) {
    let (width, height) = img.dimensions();
    let mut left = width;
    let mut right = 0u32;
    for y in 0..height {
        for x in 0..width {
            if is_dark(img.get_pixel(x, y).0[0]) {
                if x < left {
                    left = x;
                }
                if x > right {
                    right = x;
                }
            }
        }
    }
    if left > right {
        (0, 0)
    } else {
        (left, right)
    }
}

fn is_dark(luma: u8) -> bool {
    luma <= tuning::DARK_THRESHOLD
}

fn find_staff_line_rows(img: &GrayImage, ink_left: u32, ink_right: u32, ink_width: u32) -> Vec<u32> {
    let (_, height) = img.dimensions();
    let threshold = (ink_width as f32 * tuning::STAFF_LINE_ROW_DENSITY) as u32;
    let mut rows = Vec::new();
    for y in 0..height {
        let dark_count = (ink_left..=ink_right)
            .filter(|&x| is_dark(img.get_pixel(x, y).0[0]))
            .count() as u32;
        if dark_count >= threshold {
            rows.push(y);
        }
    }
    rows
}

/// Estimates the within-staff line spacing as the *smallest* gap between any
/// two consecutive detected staff-line rows: by construction, every gap in
/// `staff_line_rows` is either a within-staff line gap, an inter-staff gap
/// (within one system), or an inter-system gap, and the within-staff gap is
/// always the smallest of the three at any sane render resolution — so the
/// smallest gap present is necessarily a real within-staff line spacing. All
/// other distance thresholds in this module are expressed as multiples of
/// this value, so detection scales correctly at any render resolution
/// instead of being tuned to one fixed pixel gap.
fn estimate_line_spacing(staff_line_rows: &[u32]) -> f32 {
    staff_line_rows
        .windows(2)
        .map(|pair| pair[1] - pair[0])
        .min()
        .unwrap_or(1)
        .max(1) as f32
}

/// Groups staff-line rows into individual 5-line staves, using `line_spacing`
/// (see `estimate_line_spacing`) to scale the clustering threshold. Keeps
/// only groups with enough rows to plausibly be a real staff. Returns each
/// staff's `(top, bottom)` row span.
fn group_into_staves(staff_line_rows: &[u32], line_spacing: f32) -> Vec<(u32, u32)> {
    if staff_line_rows.is_empty() {
        return Vec::new();
    }

    let real_gap = (line_spacing * tuning::MAX_GAP_WITHIN_STAFF_LINE_SPACINGS).max(1.0) as u32;
    let groups = cluster_by_gap(staff_line_rows, real_gap);

    groups
        .into_iter()
        .filter(|g| g.len() >= tuning::MIN_LINES_PER_STAFF)
        .map(|g| (*g.first().unwrap(), *g.last().unwrap()))
        .collect()
}

fn cluster_by_gap(rows: &[u32], max_gap: u32) -> Vec<Vec<u32>> {
    if rows.is_empty() {
        return Vec::new();
    }
    let mut groups: Vec<Vec<u32>> = Vec::new();
    let mut current = vec![rows[0]];
    for &row in &rows[1..] {
        if row - current.last().unwrap() <= max_gap {
            current.push(row);
        } else {
            groups.push(std::mem::take(&mut current));
            current.push(row);
        }
    }
    groups.push(current);
    groups
}

/// Groups individual staves into systems (bracketed groups, e.g. a piano
/// grand staff's treble+bass pair) by comparing each inter-staff gap to the
/// staff-line spacing — see `MAX_INTER_STAFF_GAP_LINE_SPACINGS`'s docs for
/// why this (rather than a fixed pixel count, or a multiple of staff height)
/// is the resolution-independent reference.
fn group_staves_into_systems(staves: &[(u32, u32)], line_spacing: f32) -> Vec<(u32, u32)> {
    if staves.is_empty() {
        return Vec::new();
    }

    let max_gap = line_spacing * tuning::MAX_INTER_STAFF_GAP_LINE_SPACINGS;
    let mut systems: Vec<(u32, u32)> = Vec::new();
    let mut current = staves[0];
    for &(top, bottom) in &staves[1..] {
        let (_, current_bottom) = current;
        let gap = top.saturating_sub(current_bottom) as f32;
        if gap <= max_gap {
            current = (current.0, bottom);
        } else {
            systems.push(current);
            current = (top, bottom);
        }
    }
    systems.push(current);
    systems
}

fn find_barline_columns(img: &GrayImage, top: u32, bottom: u32, ink_left: u32, ink_right: u32) -> Vec<u32> {
    let (_, height) = img.dimensions();
    let band_top = top.saturating_sub(tuning::STAFF_VERTICAL_MARGIN);
    let band_bottom = (bottom + tuning::STAFF_VERTICAL_MARGIN).min(height.saturating_sub(1));
    let band_height = band_bottom - band_top + 1;
    let threshold = (band_height as f32 * tuning::BARLINE_COLUMN_DENSITY) as u32;

    let candidate_columns: Vec<u32> = (ink_left..=ink_right)
        .filter(|&x| {
            let dark_count = (band_top..=band_bottom).filter(|&y| is_dark(img.get_pixel(x, y).0[0])).count() as u32;
            dark_count >= threshold
        })
        .collect();

    merge_adjacent_columns(&candidate_columns)
}

/// Collapses runs of adjacent (within `BARLINE_MERGE_DISTANCE`) candidate
/// columns into a single x-position (their midpoint) — a real barline is a
/// few pixels wide, so without this every barline would produce several
/// nearly-identical candidates instead of one.
fn merge_adjacent_columns(columns: &[u32]) -> Vec<u32> {
    if columns.is_empty() {
        return Vec::new();
    }
    let mut merged = Vec::new();
    let mut run_start = columns[0];
    let mut run_end = columns[0];
    for &x in &columns[1..] {
        if x - run_end <= tuning::BARLINE_MERGE_DISTANCE {
            run_end = x;
        } else {
            merged.push((run_start + run_end) / 2);
            run_start = x;
            run_end = x;
        }
    }
    merged.push((run_start + run_end) / 2);
    merged
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Luma};

    fn blank(width: u32, height: u32) -> GrayImage {
        ImageBuffer::from_pixel(width, height, Luma([255u8]))
    }

    fn draw_staff_lines(img: &mut GrayImage, staff_rows: &[u32], ink_left: u32, ink_right: u32) {
        for &y in staff_rows {
            for x in ink_left..=ink_right {
                img.put_pixel(x, y, Luma([0u8]));
            }
        }
    }

    /// Draws a vertical line from `top` to `bottom` (inclusive) at `x` — used
    /// both for real barlines (spanning an entire system, across every staff
    /// and the gaps between them) and for the false-positive cases this
    /// module must reject (a stem/chord stack spanning only one staff).
    fn draw_vertical(img: &mut GrayImage, x: u32, top: u32, bottom: u32) {
        let height = img.height();
        for y in top..=bottom.min(height - 1) {
            img.put_pixel(x, y, Luma([0u8]));
        }
    }

    /// Draws one synthetic piano grand-staff system: two 5-line staves (a
    /// realistic tight gap between them, smaller than their own height —
    /// confirmed against MuseScore's actual rendered output during Phase 9
    /// development) plus real barlines spanning the *entire* system — from
    /// the top staff's top line straight through to the bottom staff's
    /// bottom line, including the gap. This is the actual signal a real
    /// measure barline produces; a false positive (chord stack, stem) spans
    /// only one staff and leaves the inter-staff gap blank, which
    /// `find_barline_columns`'s full-system density check is what catches.
    fn draw_synthetic_system(
        img: &mut GrayImage,
        top_staff_top: u32,
        line_spacing: u32,
        inter_staff_gap: u32,
        barline_xs: &[u32],
        ink_left: u32,
        ink_right: u32,
    ) -> (u32, u32) {
        let top_staff: Vec<u32> = (0..5).map(|i| top_staff_top + i * line_spacing).collect();
        let bottom_staff_top = *top_staff.last().unwrap() + inter_staff_gap;
        let bottom_staff: Vec<u32> = (0..5).map(|i| bottom_staff_top + i * line_spacing).collect();

        draw_staff_lines(img, &top_staff, ink_left, ink_right);
        draw_staff_lines(img, &bottom_staff, ink_left, ink_right);

        let system_top = *top_staff.first().unwrap();
        let system_bottom = *bottom_staff.last().unwrap();
        for &x in barline_xs {
            draw_vertical(img, x, system_top.saturating_sub(2), system_bottom + 2);
        }
        (system_top, system_bottom)
    }

    #[test]
    fn detects_one_grand_staff_system_and_its_full_height_barlines() {
        let mut img = blank(800, 300);
        let (top, bottom) = draw_synthetic_system(&mut img, 50, 10, 30, &[50, 300, 550, 780], 30, 790);

        let systems = detect_barlines_in_image(&img);
        assert_eq!(systems.len(), 1);
        assert_eq!(systems[0].top, top);
        assert_eq!(systems[0].bottom, bottom);
        assert_eq!(systems[0].barline_xs, vec![50, 300, 550, 780]);
    }

    #[test]
    fn detects_multiple_systems_independently() {
        let mut img = blank(800, 600);
        draw_synthetic_system(&mut img, 50, 10, 30, &[50, 400], 30, 790);
        draw_synthetic_system(&mut img, 350, 10, 30, &[60, 420], 30, 790);

        let systems = detect_barlines_in_image(&img);
        assert_eq!(systems.len(), 2);
        assert_eq!(systems[0].barline_xs, vec![50, 400]);
        assert_eq!(systems[1].barline_xs, vec![60, 420]);
    }

    /// The key real-world bug this module exists to avoid: a chord stack or
    /// stem that spans only one staff of a grand-staff system (not the full
    /// system height, including the inter-staff gap) must never be reported
    /// as a barline candidate — confirmed as a real false positive against
    /// actual rendered sheet music during Phase 9 development, when an
    /// earlier version of this module detected barlines per individual staff
    /// instead of per full system.
    #[test]
    fn ignores_a_tall_mark_confined_to_only_one_staff_of_a_system() {
        let mut img = blank(800, 300);
        let (top, bottom) = draw_synthetic_system(&mut img, 50, 10, 30, &[50, 300], 30, 790);
        // A chord-stack-like mark spanning the *entire* top staff's height
        // (not just a short stem) but stopping well before the bottom
        // staff — i.e. exactly what real false positives looked like.
        draw_vertical(&mut img, 200, top, top + 40);

        let systems = detect_barlines_in_image(&img);
        assert_eq!(systems.len(), 1);
        assert_eq!(systems[0].top, top);
        assert_eq!(systems[0].bottom, bottom);
        assert_eq!(systems[0].barline_xs, vec![50, 300]);
    }

    #[test]
    fn empty_image_detects_nothing() {
        let img = blank(100, 100);
        let systems = detect_barlines_in_image(&img);
        assert!(systems.is_empty());
    }

    #[test]
    fn detect_barlines_decodes_real_png_bytes() {
        let mut img = blank(400, 150);
        draw_synthetic_system(&mut img, 20, 6, 18, &[20, 200, 380], 10, 390);

        let mut png_bytes: Vec<u8> = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut png_bytes), image::ImageFormat::Png)
            .unwrap();

        let systems = detect_barlines(&png_bytes).unwrap();
        assert_eq!(systems.len(), 1);
        assert_eq!(systems[0].barline_xs, vec![20, 200, 380]);
    }
}
