//! Downloading a release asset and putting it in place.

use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::{Asset, Client, Install, InstallKind, Release, Result, UpdateError};

/// Where an install is up to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProgressPhase {
    Downloading,
    /// For a `.deb`, this is the wait on the system's password prompt and apt.
    Installing,
    Done,
}

/// Reports an install in flight; `done`/`total` are bytes while downloading
/// (`total` is 0 when unknown).
#[derive(Debug, Clone, Copy, Serialize)]
pub struct Progress {
    pub phase: ProgressPhase,
    pub done: u64,
    pub total: u64,
}

impl Progress {
    fn phase(phase: ProgressPhase) -> Progress {
        Progress {
            phase,
            done: 0,
            total: 0,
        }
    }
}

const PROGRESS_EVERY: Duration = Duration::from_millis(100);

/// Downloads `release`'s asset for `install`, verifies it against the
/// release's checksums, and puts it in place.
pub(super) fn install(
    client: &Client,
    release: &Release,
    install: &Install,
    report: &mut dyn FnMut(Progress),
) -> Result<()> {
    let name = install.asset_name(&release.version).ok_or_else(|| {
        UpdateError::Install("self-update isn't available on this platform".into())
    })?;
    let asset = release.asset(&name).ok_or_else(|| {
        UpdateError::Install(format!("release {} has no {name} asset", release.version))
    })?;
    let want = client.checksum_for(release, &name)?;

    match install.kind {
        InstallKind::AppImage => install_appimage(client, asset, &want, &install.path, report),
        InstallKind::Deb => {
            if let Some(why) = deb_prerequisites() {
                return Err(UpdateError::Install(why));
            }
            install_deb(client, asset, &want, report, &run_deb_install)
        }
        InstallKind::Binary | InstallKind::Unsupported => Err(UpdateError::Install(
            "this installation can't update itself".into(),
        )),
    }?;
    report(Progress::phase(ProgressPhase::Done));
    Ok(())
}

/// Streams `asset` into `dest`, checking its SHA-256 against `want`.
fn download(
    client: &Client,
    asset: &Asset,
    dest: &mut impl Write,
    want: &str,
    report: &mut dyn FnMut(Progress),
) -> Result<()> {
    let mut resp = client.download(asset)?;
    let total = resp.body().content_length().unwrap_or(asset.size);
    let mut body = resp.body_mut().as_reader();

    let mut hash = Sha256::new();
    let mut buf = vec![0u8; 256 << 10];
    let mut done = 0u64;
    let mut last_report = Instant::now() - PROGRESS_EVERY;
    loop {
        let n = body
            .read(&mut buf)
            .map_err(|e| UpdateError::Network(format!("downloading {}: {e}", asset.name)))?;
        if n == 0 {
            break;
        }
        dest.write_all(&buf[..n])?;
        hash.update(&buf[..n]);
        done += n as u64;
        if last_report.elapsed() >= PROGRESS_EVERY {
            last_report = Instant::now();
            report(Progress {
                phase: ProgressPhase::Downloading,
                done,
                total,
            });
        }
    }
    report(Progress {
        phase: ProgressPhase::Downloading,
        done,
        total,
    });

    let got = hex(&hash.finalize());
    if got != want {
        return Err(UpdateError::Verify(format!(
            "checksum mismatch for {} (expected {want}, got {got})",
            asset.name
        )));
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Downloads next to `target` and atomically renames over it. The running
/// process keeps its own (old) inode, so it isn't disturbed. Fails up front,
/// before downloading anything, when the directory isn't writable — the
/// "can't self-update here" case.
fn install_appimage(
    client: &Client,
    asset: &Asset,
    want: &str,
    target: &Path,
    report: &mut dyn FnMut(Progress),
) -> Result<()> {
    let dir = target.parent().unwrap_or_else(|| Path::new("."));
    let mut tmp = tempfile::Builder::new()
        .prefix(".lyrica-update-")
        .tempfile_in(dir)
        .map_err(|e| {
            UpdateError::Install(format!("can't write next to {}: {e}", target.display()))
        })?;
    // Dropping `tmp` on any error below removes the partial download.
    download(client, asset, tmp.as_file_mut(), want, report)?;
    report(Progress::phase(ProgressPhase::Installing));

    let mode = std::fs::metadata(target)
        .map(|m| m.permissions().mode() & 0o777)
        .unwrap_or(0o755)
        | 0o111;
    tmp.as_file()
        .set_permissions(std::fs::Permissions::from_mode(mode))?;
    tmp.persist(target).map_err(|e| e.error)?;
    Ok(())
}

/// Downloads the package and lets `run` (apt via pkexec) install it.
fn install_deb(
    client: &Client,
    asset: &Asset,
    want: &str,
    report: &mut dyn FnMut(Progress),
    run: &dyn Fn(&Path) -> Result<()>,
) -> Result<()> {
    let dir = tempfile::tempdir()?;
    // apt's sandbox user needs to read the package; otherwise it only warns.
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755))?;
    let deb = dir.path().join(&asset.name);
    {
        let mut file = std::fs::File::create(&deb)?;
        download(client, asset, &mut file, want, report)?;
        file.flush()?;
    }
    report(Progress::phase(ProgressPhase::Installing));
    run(&deb)
}

/// Why a `.deb` update can't be run from here, or `None`.
pub(super) fn deb_prerequisites() -> Option<String> {
    ["pkexec", "apt-get"]
        .into_iter()
        .find(|tool| !on_path(tool))
        .map(|tool| format!("{tool} isn't installed"))
}

fn on_path(tool: &str) -> bool {
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|paths| std::env::split_paths(&paths).collect::<Vec<_>>())
        .any(|dir| dir.join(tool).is_file())
}

/// Runs apt through pkexec: a GUI app has no terminal for sudo, while polkit
/// shows the desktop's own password dialog. pkexec clears the environment, so
/// apt is told not to ask questions.
fn run_deb_install(deb: &Path) -> Result<()> {
    let out = Command::new("pkexec")
        .args([
            "env",
            "DEBIAN_FRONTEND=noninteractive",
            "apt-get",
            "install",
            "-y",
        ])
        .arg(deb)
        .output()?;
    if out.status.success() {
        return Ok(());
    }
    match out.status.code() {
        Some(126) => Err(UpdateError::AuthCancelled), // pkexec: dialog dismissed
        Some(127) => Err(UpdateError::Install(
            "not authorised to install packages".into(),
        )),
        _ => {
            let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
            text.push_str(&String::from_utf8_lossy(&out.stderr));
            Err(UpdateError::Install(format!(
                "apt-get failed ({}): {}",
                out.status,
                tail(&text, 400)
            )))
        }
    }
}

/// At most `n` trailing bytes of `s` (on a char boundary), trimmed.
fn tail(s: &str, n: usize) -> String {
    let s = s.trim();
    if s.len() <= n {
        return s.to_string();
    }
    let mut start = s.len() - n;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &s[start..])
}

/// Starts `path` in its own process group once this process has exited, so
/// the new version doesn't race the old one (for the audio device, say). The
/// caller quits the app right after.
pub fn relaunch(path: &Path) -> Result<()> {
    use std::os::unix::process::CommandExt;
    let mut cmd = Command::new("/bin/sh");
    cmd.args([
        "-c",
        r#"while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; exec "$0""#,
    ])
    .arg(path)
    .arg(std::process::id().to_string())
    .process_group(0)
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null());
    // The old AppImage's mount is about to vanish; the new one sets these up
    // for itself.
    for var in ["APPIMAGE", "APPDIR", "ARGV0", "OWD"] {
        cmd.env_remove(var);
    }
    cmd.spawn()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;
    use std::sync::Arc;

    /// A throwaway HTTP server: `GET <path>` returns the bytes registered for
    /// it, 404 otherwise. Stands in for GitHub's API and download CDN.
    fn serve(routes: Vec<(&'static str, Vec<u8>)>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let routes = Arc::new(routes);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let routes = Arc::clone(&routes);
                std::thread::spawn(move || {
                    let mut stream = stream.unwrap();
                    let mut request_line = String::new();
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    reader.read_line(&mut request_line).unwrap();
                    loop {
                        let mut header = String::new();
                        reader.read_line(&mut header).unwrap();
                        if header.trim().is_empty() {
                            break;
                        }
                    }
                    let path = request_line.split_whitespace().nth(1).unwrap_or("");
                    let (status, body) = match routes.iter().find(|(p, _)| *p == path) {
                        Some((_, body)) => ("200 OK", body.as_slice()),
                        None => ("404 Not Found", &b"not found"[..]),
                    };
                    let _ = write!(
                        stream,
                        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(body);
                });
            }
        });
        base
    }

    fn sha(bytes: &[u8]) -> String {
        hex(&Sha256::digest(bytes))
    }

    /// A release whose assets are the given `(name, bytes)` plus a checksum
    /// file claiming `claimed` digests (name, digest) — served by `serve`.
    fn release_with(assets: &[(&str, &[u8])], claimed: &[(&str, String)]) -> (Client, Release) {
        let sums: String = claimed
            .iter()
            .map(|(name, digest)| format!("{digest}  ./{name}\n"))
            .collect();
        let mut routes: Vec<(&'static str, Vec<u8>)> = vec![("/SHA256SUMS.txt", sums.into_bytes())];
        for (name, bytes) in assets {
            routes.push((
                Box::leak(format!("/{name}").into_boxed_str()),
                bytes.to_vec(),
            ));
        }
        let base = serve(routes);
        let mut listed: Vec<Asset> = assets
            .iter()
            .map(|(name, bytes)| Asset {
                name: name.to_string(),
                url: format!("{base}/{name}"),
                size: bytes.len() as u64,
            })
            .collect();
        listed.push(Asset {
            name: "SHA256SUMS.txt".into(),
            url: format!("{base}/SHA256SUMS.txt"),
            size: 0,
        });
        (
            Client::with_api_url(format!("{base}/unused")),
            Release {
                version: "2.5.0".into(),
                page_url: String::new(),
                assets: listed,
            },
        )
    }

    fn appimage_install(path: &Path) -> Install {
        Install {
            kind: InstallKind::AppImage,
            path: path.to_path_buf(),
        }
    }

    // Asset names depend on the host arch; these tests run on x86_64 only.
    fn asset_name(install: &Install) -> Option<String> {
        install.asset_name("2.5.0")
    }

    #[test]
    fn appimage_is_replaced_in_place_and_stays_executable() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("Lyrica.AppImage");
        std::fs::write(&target, b"old").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o750)).unwrap();
        let install = appimage_install(&target);
        let Some(name) = asset_name(&install) else {
            return;
        };

        let new = b"new appimage bytes".repeat(1000);
        let (client, release) = release_with(&[(&name, &new)], &[(&name, sha(&new))]);
        let mut phases = Vec::new();
        super::install(&client, &release, &install, &mut |p| phases.push(p.phase)).unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), new);
        let mode = std::fs::metadata(&target).unwrap().permissions().mode();
        assert_eq!(mode & 0o111, 0o111, "must stay executable: {mode:o}");
        assert_eq!(phases.first(), Some(&ProgressPhase::Downloading));
        assert_eq!(phases.last(), Some(&ProgressPhase::Done));
        assert!(phases.contains(&ProgressPhase::Installing));
        // No staging file left behind.
        let leftovers: Vec<_> = std::fs::read_dir(dir.path()).unwrap().collect();
        assert_eq!(leftovers.len(), 1);
    }

    #[test]
    fn a_checksum_mismatch_leaves_the_old_appimage_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("Lyrica.AppImage");
        std::fs::write(&target, b"old").unwrap();
        let install = appimage_install(&target);
        let Some(name) = asset_name(&install) else {
            return;
        };

        let (client, release) = release_with(&[(&name, b"tampered")], &[(&name, sha(b"genuine"))]);
        let err = super::install(&client, &release, &install, &mut |_| {}).unwrap_err();

        assert!(matches!(err, UpdateError::Verify(_)), "{err}");
        assert_eq!(std::fs::read(&target).unwrap(), b"old");
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            1,
            "staging file not cleaned up"
        );
    }

    #[test]
    fn a_release_without_checksums_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("Lyrica.AppImage");
        std::fs::write(&target, b"old").unwrap();
        let install = appimage_install(&target);
        let Some(name) = asset_name(&install) else {
            return;
        };

        let (client, mut release) = release_with(&[(&name, b"new")], &[(&name, sha(b"new"))]);
        release.assets.retain(|a| a.name != "SHA256SUMS.txt");
        let err = super::install(&client, &release, &install, &mut |_| {}).unwrap_err();

        assert!(matches!(err, UpdateError::Verify(_)), "{err}");
        assert_eq!(std::fs::read(&target).unwrap(), b"old");
    }

    #[test]
    fn a_missing_asset_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let install = appimage_install(&dir.path().join("Lyrica.AppImage"));
        if asset_name(&install).is_none() {
            return;
        }
        let (client, release) = release_with(&[], &[]);
        let err = super::install(&client, &release, &install, &mut |_| {}).unwrap_err();
        assert!(err.to_string().contains("has no"), "{err}");
    }

    #[test]
    fn an_unwritable_directory_fails_before_downloading() {
        let target = Path::new("/nonexistent-dir/Lyrica.AppImage");
        let install = appimage_install(target);
        let Some(name) = asset_name(&install) else {
            return;
        };
        let (client, release) = release_with(&[(&name, b"new")], &[(&name, sha(b"new"))]);
        let err = super::install(&client, &release, &install, &mut |_| {}).unwrap_err();
        assert!(err.to_string().contains("can't write next to"), "{err}");
    }

    #[test]
    fn deb_is_downloaded_readable_and_handed_to_the_installer() {
        let deb = b"fake deb".repeat(100);
        let (client, release) = release_with(&[("x.deb", &deb)], &[("x.deb", sha(&deb))]);
        let asset = release.asset("x.deb").unwrap();

        let seen = std::cell::RefCell::new(None);
        install_deb(&client, asset, &sha(&deb), &mut |_| {}, &|path| {
            let mode = std::fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(
                mode & 0o005,
                0o005,
                "apt's sandbox user must be able to read it"
            );
            *seen.borrow_mut() = Some((
                path.file_name().unwrap().to_owned(),
                std::fs::read(path).unwrap(),
            ));
            Ok(())
        })
        .unwrap();
        assert_eq!(*seen.borrow(), Some(("x.deb".into(), deb)));
    }

    #[test]
    fn a_cancelled_password_prompt_surfaces_as_such() {
        let (client, release) = release_with(&[("x.deb", b"d")], &[("x.deb", sha(b"d"))]);
        let asset = release.asset("x.deb").unwrap();
        let err = install_deb(&client, asset, &sha(b"d"), &mut |_| {}, &|_| {
            Err(UpdateError::AuthCancelled)
        })
        .unwrap_err();
        assert!(matches!(err, UpdateError::AuthCancelled));
    }

    #[test]
    fn latest_parses_a_github_release() {
        let body = r#"{"tag_name":"v2.5.0","html_url":"https://github.com/x/y/releases/tag/v2.5.0",
            "body":"notes","assets":[{"name":"a.deb","browser_download_url":"https://x/a.deb","size":7,"extra":1}]}"#;
        let base = serve(vec![("/latest", body.as_bytes().to_vec())]);
        let rel = Client::with_api_url(format!("{base}/latest"))
            .latest()
            .unwrap();
        assert_eq!(rel.version, "2.5.0");
        assert_eq!(rel.page_url, "https://github.com/x/y/releases/tag/v2.5.0");
        assert_eq!(
            rel.assets,
            vec![Asset {
                name: "a.deb".into(),
                url: "https://x/a.deb".into(),
                size: 7
            }]
        );
    }

    #[test]
    fn latest_rejects_odd_tags_and_http_errors() {
        let base = serve(vec![(
            "/latest",
            br#"{"tag_name":"nightly","html_url":"u"}"#.to_vec(),
        )]);
        assert!(Client::with_api_url(format!("{base}/latest"))
            .latest()
            .is_err());
        assert!(Client::with_api_url(format!("{base}/missing"))
            .latest()
            .is_err());
    }

    #[test]
    fn tail_keeps_the_end_on_a_char_boundary() {
        assert_eq!(tail("  short  ", 10), "short");
        assert_eq!(tail("abcdef", 3), "…def");
        assert_eq!(tail("ééé", 3), "…é");
    }
}
