use cv_barline::detect_barlines;
use image::{Rgb, RgbImage};

fn main() {
    let path = std::env::args().nth(1).expect("usage: overlay <png_path> <out_path>");
    let out_path = std::env::args().nth(2).expect("usage: overlay <png_path> <out_path>");
    let bytes = std::fs::read(&path).expect("read png");
    let systems = detect_barlines(&bytes).expect("detect");

    let img = image::load_from_memory(&bytes).unwrap().to_rgb8();
    let (width, height) = img.dimensions();
    let mut out: RgbImage = img;

    for system in &systems {
        for y in system.top..=system.bottom.min(height - 1) {
            out.put_pixel(0, y, Rgb([0, 255, 0]));
            out.put_pixel(width - 1, y, Rgb([0, 255, 0]));
        }
        for &x in &system.barline_xs {
            for y in system.top.saturating_sub(10)..=(system.bottom + 10).min(height - 1) {
                if x < width {
                    out.put_pixel(x, y, Rgb([255, 0, 0]));
                }
                if x + 1 < width {
                    out.put_pixel(x + 1, y, Rgb([255, 0, 0]));
                }
            }
        }
    }

    out.save(&out_path).unwrap();
    println!("wrote {out_path}");
}
