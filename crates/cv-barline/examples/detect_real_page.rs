use cv_barline::detect_barlines;

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: detect_real_page <png_path>");
    let bytes = std::fs::read(&path).expect("read png");
    let systems = detect_barlines(&bytes).expect("detect");
    println!("detected {} staff system(s)", systems.len());
    for (i, s) in systems.iter().enumerate() {
        println!(
            "  system {i}: top={} bottom={} barlines={:?}",
            s.top, s.bottom, s.barline_xs
        );
    }
}
