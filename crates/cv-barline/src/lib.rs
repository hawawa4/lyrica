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

/// One detected staff (5 lines) and the barline x-positions found within its
/// vertical extent. `top`/`bottom` are pixel rows (inclusive) spanning from
/// the topmost to bottommost detected staff line, in the input image's own
/// pixel coordinate space (the caller is responsible for converting back to
/// PDF-point space if needed, same as `pdf-engine.ts`'s canvas coordinates).
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
    /// belonging to the same 5-line staff (not two separate staves).
    pub const MAX_GAP_WITHIN_STAFF: u32 = 40;
    /// A detected staff must have at least this many staff-line rows to
    /// count as real (cuts out stray single dark rows from noise/artifacts).
    pub const MIN_LINES_PER_STAFF: usize = 3;
    /// A column counts as a barline candidate if at least this fraction of
    /// its pixels within the staff's vertical band (plus margin) are dark —
    /// high enough to exclude note stems (which don't span the full staff
    /// height) and beams (horizontal, not vertical runs), but low enough to
    /// tolerate anti-aliasing/compression noise along the line.
    pub const BARLINE_COLUMN_DENSITY: f32 = 0.85;
    /// Extra pixels added above/below a staff's top/bottom line when
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
    let staves = group_into_staves(&staff_line_rows);

    staves
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

/// Groups staff-line rows into staves by proximity, then keeps only groups
/// with enough rows to plausibly be a real 5-line staff (not stray noise).
/// Returns each staff's `(top, bottom)` row span.
fn group_into_staves(staff_line_rows: &[u32]) -> Vec<(u32, u32)> {
    if staff_line_rows.is_empty() {
        return Vec::new();
    }

    let mut groups: Vec<Vec<u32>> = Vec::new();
    let mut current = vec![staff_line_rows[0]];
    for &row in &staff_line_rows[1..] {
        if row - current.last().unwrap() <= tuning::MAX_GAP_WITHIN_STAFF {
            current.push(row);
        } else {
            groups.push(std::mem::take(&mut current));
            current.push(row);
        }
    }
    groups.push(current);

    groups
        .into_iter()
        .filter(|g| g.len() >= tuning::MIN_LINES_PER_STAFF)
        .map(|g| (*g.first().unwrap(), *g.last().unwrap()))
        .collect()
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

    /// Draws a single synthetic staff system: 5 horizontal lines spanning
    /// `[ink_left, ink_right]` at the given row positions, plus vertical
    /// barlines at the given x-positions spanning the full staff height
    /// (with a small margin) — a stylized but structurally real test of the
    /// same signal (`StaffLines`/measure-boundary vertical dark runs) real
    /// engraved sheet music produces, confirmed against MuseScore's actual
    /// SVG output during Phase 9 development (see git history around that
    /// phase for the real-fixture screenshot verification of
    /// `saveSvg`'s `class="StaffLines"` polylines).
    fn draw_synthetic_staff(
        width: u32,
        height: u32,
        staff_rows: &[u32],
        barline_xs: &[u32],
        ink_left: u32,
        ink_right: u32,
    ) -> GrayImage {
        let mut img: GrayImage = ImageBuffer::from_pixel(width, height, Luma([255u8]));
        for &y in staff_rows {
            for x in ink_left..=ink_right {
                img.put_pixel(x, y, Luma([0u8]));
            }
        }
        let top = *staff_rows.first().unwrap();
        let bottom = *staff_rows.last().unwrap();
        for &bx in barline_xs {
            for y in top.saturating_sub(2)..=(bottom + 2).min(height - 1) {
                img.put_pixel(bx, y, Luma([0u8]));
            }
        }
        img
    }

    #[test]
    fn detects_one_staff_and_its_barlines() {
        let staff_rows = [100, 110, 120, 130, 140];
        let barline_xs = [50, 300, 550, 780];
        let img = draw_synthetic_staff(800, 300, &staff_rows, &barline_xs, 30, 790);

        let systems = detect_barlines_in_image(&img);
        assert_eq!(systems.len(), 1);
        let system = &systems[0];
        assert_eq!(system.top, 100);
        assert_eq!(system.bottom, 140);
        assert_eq!(system.barline_xs, vec![50, 300, 550, 780]);
    }

    #[test]
    fn detects_multiple_staff_systems_independently() {
        let mut img: GrayImage = ImageBuffer::from_pixel(800, 600, Luma([255u8]));

        let staff1 = draw_synthetic_staff(800, 600, &[100, 110, 120, 130, 140], &[50, 400], 30, 790);
        let staff2 = draw_synthetic_staff(800, 600, &[300, 310, 320, 330, 340], &[60, 420], 30, 790);
        for y in 0..600 {
            for x in 0..800 {
                let p1 = staff1.get_pixel(x, y).0[0];
                let p2 = staff2.get_pixel(x, y).0[0];
                if p1 == 0 || p2 == 0 {
                    img.put_pixel(x, y, Luma([0u8]));
                }
            }
        }

        let systems = detect_barlines_in_image(&img);
        assert_eq!(systems.len(), 2);
        assert_eq!(systems[0].top, 100);
        assert_eq!(systems[0].barline_xs, vec![50, 400]);
        assert_eq!(systems[1].top, 300);
        assert_eq!(systems[1].barline_xs, vec![60, 420]);
    }

    #[test]
    fn ignores_short_vertical_strokes_that_dont_span_the_staff() {
        let staff_rows = [100, 110, 120, 130, 140];
        let mut img = draw_synthetic_staff(800, 300, &staff_rows, &[50, 300], 30, 790);
        // A short stem-like stroke spanning only 2 of the 5 staff lines —
        // should not be picked up as a barline candidate.
        for y in 100..=110 {
            img.put_pixel(200, y, Luma([0u8]));
        }

        let systems = detect_barlines_in_image(&img);
        assert_eq!(systems.len(), 1);
        assert_eq!(systems[0].barline_xs, vec![50, 300]);
    }

    #[test]
    fn empty_image_detects_nothing() {
        let img: GrayImage = ImageBuffer::from_pixel(100, 100, Luma([255u8]));
        let systems = detect_barlines_in_image(&img);
        assert!(systems.is_empty());
    }

    #[test]
    fn detect_barlines_decodes_real_png_bytes() {
        let staff_rows = [50, 56, 62, 68, 74];
        let img = draw_synthetic_staff(400, 150, &staff_rows, &[20, 200, 380], 10, 390);

        let mut png_bytes: Vec<u8> = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut png_bytes), image::ImageFormat::Png)
            .unwrap();

        let systems = detect_barlines(&png_bytes).unwrap();
        assert_eq!(systems.len(), 1);
        assert_eq!(systems[0].barline_xs, vec![20, 200, 380]);
    }
}
