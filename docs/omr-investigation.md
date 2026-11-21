# OMR investigation (PDF → MusicXML / measure boxes)

Status: research + feasibility test only (2026-11-21). Nothing here is wired into the app.

## How PDF mode finds measures today

- `PracticeView.openPdf…` → on a PDF with no saved points, `autoScanBarlines` renders every page
  with pdf.js at `PDF_BASE_WIDTH (700) × zoom × devicePixelRatio`, exports PNG bytes, and calls
  `detect_barlines` (desktop command → `mp_core::api::detect_barlines` → `crates/cv-barline`).
- `cv-barline` is classical CV: finds staff-line rows (≥50% dark), groups them into staves and
  staves into systems by gap/line-spacing ratios, then keeps columns that are ≥85% dark across the
  whole system height. Returns `StaffSystem { top, bottom, barline_xs }` in pixels.
- `CalibrationOverlay.pointsFromBarlines` turns **every barline x** (including the system's left
  edge and final barline) into a `CalibrationPoint { page, x, y (fractions), time_ms, measure }`,
  1000 ms apart. Points persist at `{base_dir}/pdfs/{blake3}/calibration.json`
  (`pdf_calibration.rs`). There is no manual editing UI anymore; fix = clear + rescan.
- Points drive click-to-seek, drag-select → L-to-loop (`loopRegionForPointRange`), the cursor
  highlight, and `pdf_tempo_map` (piecewise-constant tempo, fixed 4/4 numerator) for
  **metronome-only** playback. PDFs have no audio.

## Engines

| Engine | License | Runtime / size | Speed (this box, CPU) | Measure geometry | Notes |
|---|---|---|---|---|---|
| **Audiveris 5.11** | AGPL-3.0 | jpackage'd, bundles its own JRE; `.deb` 78 MB, 187 MB installed; ~1 GB RSS; headless `-batch -export` works with no display | 4–7 s/page (7.6 s for a 1-page piece incl. JVM start; 83 s for 16 pages) | **Yes** — the `.omr` book (zip) has per-sheet `<picture width height>`, per-system `<stack left right>` and staff-line y's → exact measure boxes | Classical (non-ML for most steps) pipeline, very active, handles repeats/voltas. Ignores tempo marks; OCR needs Tesseract language data (only for text). |
| **homr 0.7.1** | AGPL-3.0 | Python ≥3.10 + onnxruntime + OpenCV; venv 556 MB (3 ONNX models ≈150 MB + OCR models) | ~9 s/page (CPU) | Not in output (MusicXML only; has internal staff/barline detection one could patch to emit) | Per-image input; needed a manual `pip install onnxruntime`. |
| oemer | MIT | Python + onnxruntime/TF, ~400 MB models | reported 1–3 min/page CPU | No | Last commit Apr 2025; weaker on polyphonic piano. Not tested. |
| tf-end-to-end / other academic | MIT | TF | — | No | Single-staff monophonic only — useless for piano. |
| Rust-native | — | — | — | — | Nothing usable exists. homr's ONNX models could in theory run via `ort`, but its whole Python pre/post-processing would need porting. |

Licensing: Lyrica is GPL-3.0-only. AGPL-3.0 is explicitly combinable with GPL-3.0 (§13 of both),
and running Audiveris as a separate process is mere aggregation anyway. Bundling it means shipping
its source offer; no conflict for an open-source GPL app.

## Hands-on test (Audiveris 5.11 batch, homr on one page)

PDFs copied from the library (read-only) to scratch. Ground truth = the matching `.mscz` next to
the PDF; notes compared as per-measure pitch multisets (tied continuations/graces skipped).

| Piece (pages, kind) | GT measures | Audiveris measures | Pitch P / R | Measures w/ rhythm ≠ time sig | cv-barline barlines (systems) @85 dpi / @170 dpi |
|---|---|---|---|---|---|
| Bad Apple (2, MuseScore vector) | 47 | 45 | 1.00 / 0.99 | 0 | 0 (2) / 0 (2) |
| Flowering Night (4, vector) | 107 | 107 | 0.97 / 0.95 | 4 | 99 (18) / 106 (18) |
| Prontera (9, vector) | 206 | 206 | 0.99 / 0.91 | 3 | 45 (16) / 257 (51) |
| Une vie à t'aimer (16, vector) | 241 | 242 (247 boxes) | 0.99 / 0.90 | 22; piano split into **3 parts** | 334 (79) / 244 (17) |
| Bach Bourrée (1, LilyPond vector) | ? | 26 (2 pickup halves) | n/a | 0 (pickups only) | 0 (1) / 33 (6) |
| Chopin Waltz B.150 (2, scan) | ? | 57 | n/a | 1 (pickup) | 14 (1) / 24 (1) |
| Chopin Raindrop (3, old scan) | 89 | 106 boxes, 86 exported | n/a | **40/86** | 69 (8) / 158 (5) |

homr on Prontera p.2 (23 measures): 23 measures, pitch P 1.00 / R 0.95, 0 rhythm errors, 9.4 s —
same quality as Audiveris on that page (P 1.00 / R 0.93).

cv-barline numbers use Ghostscript rasterization at app-like widths (~700 px and ~1400 px), not
pdf.js, so treat them as indicative: with N measures per system it should emit N+1 barlines
(e.g. Prontera p.2 @170 dpi was perfect: 23 measures, 6 systems, 29 barlines). But results swing
with resolution and it collapsed entirely on several clean vector PDFs (Bad Apple, Bourrée,
Flowering p.1 found one 5-px "system").

Takeaways:
- On clean engraved PDFs Audiveris gets the **measure structure essentially right** (exact counts
  on 4/5, repeats/voltas recognised) and ~90–99% of pitches; rhythm is consistent in >95% of
  measures. Missing notes (recall < precision) dominate over wrong notes.
- On old scans it degrades badly (Raindrop: phantom measures, 47% of measures rhythmically broken,
  wrong key change). Audio from that would be actively misleading.
- No tempo is ever recognised → playback starts at the default tempo.
- MusicXML import through webmscore was not tested here (needs a browser); Audiveris writes
  standard MusicXML 4 via proxymusic, but the 3-part split on the Clair Obscur score shows the
  output can be structurally odd.

## Architecture options

1. **Bundle Audiveris** (+78 MB `.deb`, ~+190 MB AppImage, JRE included). Simple UX, big download
   for a feature most PDFs don't need. Tauri `externalBin` wants a single binary; this is a
   directory → ship as a resource dir.
2. **Optional external tool (recommended)**: detect `/opt/audiveris/bin/Audiveris` (the official
   `.deb` path), `$PATH`, or a user-set path; show "Recognise measures (Audiveris)" in PDF tabs only
   when found, else a hint linking the release page. Zero cost for users who don't care.
3. homr as external tool: same shape, but Python env management on users' machines is worse than a
   self-contained `.deb`, and no geometry without patching it.

Plug-in points (all mirroring existing patterns):
- `crates/core/src/omr.rs` (behind an `omr` feature like `updater`): locate engine, run
  `Audiveris -batch -export -output <tmp> -- <pdf>` via `std::process::Command` (stream log lines
  `Page … raw measures` / `StepMonitoring` as progress), then parse the `.omr` zip with the
  already-present `zip` + `quick-xml` deps into `Vec<MeasureBox { page, x0, x1, y0, y1 }>`
  (fractions of `picture` width/height = same convention as `CalibrationPoint`).
- Cache under the existing sidecar layout: `{base_dir}/pdfs/{blake3}/omr/score.mxl` +
  `boxes.json` (+ engine version, so a newer Audiveris can invalidate).
- `crates/desktop`: `run_omr(path, Channel<Progress>)` thin wrapper, like `install_update`.
- Web: (b) boxes → `CalibrationPoint`s (left edge x, system mid y) replacing the CV scan;
  (a) load `score.mxl` through the existing MusicXML path into an engine score used only for
  MIDI/timeline, while still displaying the PDF and driving the cursor from boxes by printed-measure
  index (timeline events carry the printed measure via elid order; repeats unroll naturally).

## Recommendation

- **(b) yes, first.** Use Audiveris (optional external tool) as a better measure detector: on the
  test set it beat cv-barline on every vector PDF, gives real boxes (start *and* end of each
  measure, so the last measure on a system stops being ambiguous), and needs no new UI concepts.
  Keep cv-barline as the zero-dependency fallback. Effort ≈ 2–3 days.
- **(a) maybe later, gated.** Playable PDFs are attractive and the structure is good enough on
  clean engravings, but ~5–10% missing notes and occasional structural weirdness mean audio must
  be opt-in, clearly labelled "recognised audio – may contain errors", off by default, and
  disabled automatically when the score fails sanity checks (MusicXML measure count ≠ box count,
  >10% of measures with rhythm ≠ time signature, >2 parts for a piano score). Never auto-trust
  scans. Effort ≈ 1–2 weeks (hybrid PDF-display + engine-timeline tab kind is the bulk).
- Risks: wrong notes are worse than no audio for practice (users learn mistakes); measure-count
  mismatches break the box↔timeline mapping (detect and fall back to metronome-only); ~5 s/page
  latency (run in background with progress, cache by hash); AGPL is compatible with GPL-3.0 but
  bundling would add a source-offer obligation and ~200 MB; Audiveris CLI flags/`.omr` schema can
  change between versions (pin a tested version range).
