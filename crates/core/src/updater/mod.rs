//! Checks GitHub releases for a newer Lyrica and installs it in place:
//! AppImage installs replace themselves, `.deb` installs hand the downloaded
//! package to apt through `pkexec`. Nothing here knows about Tauri — the
//! desktop shell wraps `check` / `install` / `relaunch` in commands.

mod install;
mod release;
mod version;

use std::path::{Path, PathBuf};

use serde::Serialize;
use thiserror::Error;

pub use install::{relaunch, Progress, ProgressPhase};
pub use release::{Asset, Client, Release};
pub use version::{is_newer, is_release_version};

/// The running version, from the workspace `Cargo.toml` (which the release
/// workflow requires to match the tag).
pub fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[derive(Debug, Error)]
pub enum UpdateError {
    #[error("{0}")]
    Network(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Verify(String),
    #[error("{0}")]
    Install(String),
    #[error("the password prompt was cancelled")]
    AuthCancelled,
}

pub type Result<T> = std::result::Result<T, UpdateError>;

/// How this copy of Lyrica was installed, which decides how it updates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallKind {
    AppImage,
    Deb,
    /// A bare executable (`cargo run`, `cargo install`, `/usr/local/bin`).
    /// Releases don't ship one, so there is nothing to update it from.
    Binary,
    /// A platform no release is built for.
    Unsupported,
}

/// The running installation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Install {
    pub kind: InstallKind,
    /// The file to replace (AppImage) or the installed executable to
    /// relaunch (deb).
    pub path: PathBuf,
}

impl Install {
    /// Inspects the running process.
    pub fn detect() -> Install {
        if !cfg!(target_os = "linux") {
            return Install::unsupported();
        }
        let Ok(mut exe) = std::env::current_exe() else {
            return Install::unsupported();
        };
        if let Ok(resolved) = exe.canonicalize() {
            exe = resolved;
        }
        Install::from_env(std::env::var_os("APPIMAGE").as_deref(), &exe)
    }

    fn unsupported() -> Install {
        Install {
            kind: InstallKind::Unsupported,
            path: PathBuf::new(),
        }
    }

    /// Classifies an install from the `APPIMAGE` env var (set by the AppImage
    /// runtime) and the resolved executable path.
    fn from_env(appimage: Option<&std::ffi::OsStr>, exe: &Path) -> Install {
        if let Some(appimage) = appimage.filter(|a| !a.is_empty()) {
            let path = PathBuf::from(appimage);
            if path.is_file() {
                return Install {
                    kind: InstallKind::AppImage,
                    path,
                };
            }
        }
        // Package-managed files live under /usr; /usr/local is hand-placed.
        let kind = if exe.starts_with("/usr") && !exe.starts_with("/usr/local") {
            InstallKind::Deb
        } else {
            InstallKind::Binary
        };
        Install {
            kind,
            path: exe.to_path_buf(),
        }
    }

    /// The release asset to download for `version` (Tauri names bundles
    /// `Lyrica_<version>_<arch>.<ext>`).
    fn asset_name(&self, version: &str) -> Option<String> {
        let ext = match self.kind {
            InstallKind::AppImage => "AppImage",
            InstallKind::Deb => "deb",
            InstallKind::Binary | InstallKind::Unsupported => return None,
        };
        let arch = match std::env::consts::ARCH {
            "x86_64" => "amd64",
            _ => return None,
        };
        Some(format!("Lyrica_{version}_{arch}.{ext}"))
    }

    /// Why `install` can't run for this installation, or `None` when it can.
    pub fn blocker(&self) -> Option<String> {
        match self.kind {
            InstallKind::Unsupported => {
                Some("In-app updates aren't available on this platform.".into())
            }
            InstallKind::Binary => Some(
                "This copy wasn't installed from an AppImage or .deb package, so it can't \
                 update itself."
                    .into(),
            ),
            InstallKind::Deb => install::deb_prerequisites()
                .map(|why| format!("Installing the package needs {why}.")),
            InstallKind::AppImage => None,
        }
    }
}

/// The result of checking GitHub for a newer release.
#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub available: bool,
    pub page_url: String,
    pub kind: InstallKind,
    /// Whether `install` can do the update from inside the app; `reason` says
    /// why not when it can't (the release page is then the way to update).
    pub can_install: bool,
    pub reason: Option<String>,
}

/// Asks GitHub for the latest release and compares it with the running one.
pub fn check(client: &Client, current: &str) -> Result<UpdateInfo> {
    let release = client.latest()?;
    let install = Install::detect();
    let blocker = install.blocker();
    Ok(UpdateInfo {
        current: current.to_string(),
        available: is_newer(&release.version, current),
        latest: release.version,
        page_url: release.page_url,
        kind: install.kind,
        can_install: blocker.is_none(),
        reason: blocker,
    })
}

/// Downloads the latest release, verifies it against the release's checksums
/// and puts it in place for the running installation. The running process
/// keeps going until it is restarted (see `relaunch`). Returns the path to
/// relaunch.
pub fn install_latest(
    client: &Client,
    current: &str,
    report: &mut dyn FnMut(Progress),
) -> Result<PathBuf> {
    if !is_release_version(current) {
        return Err(UpdateError::Install(
            "development builds can't be updated".into(),
        ));
    }
    // Re-fetch rather than trust an earlier check: a newer release may have
    // been published since.
    let release = client.latest()?;
    if !is_newer(&release.version, current) {
        return Err(UpdateError::Install(
            "already running the latest version".into(),
        ));
    }
    let install = Install::detect();
    if let Some(blocker) = install.blocker() {
        return Err(UpdateError::Install(blocker));
    }
    install::install(client, &release, &install, report)?;
    Ok(install.path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn appimage_env_wins_when_the_file_exists() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("Lyrica.AppImage");
        std::fs::write(&image, b"x").unwrap();
        let got = Install::from_env(
            Some(image.as_os_str()),
            Path::new("/tmp/.mount_x/usr/bin/lyrica"),
        );
        assert_eq!(got.kind, InstallKind::AppImage);
        assert_eq!(got.path, image);
    }

    #[test]
    fn stale_appimage_env_falls_back_to_the_executable() {
        let got = Install::from_env(
            Some(OsStr::new("/nonexistent/x.AppImage")),
            Path::new("/usr/bin/lyrica"),
        );
        assert_eq!(got.kind, InstallKind::Deb);
    }

    #[test]
    fn usr_is_deb_but_usr_local_is_a_plain_binary() {
        let kind = |exe: &str| Install::from_env(None, Path::new(exe)).kind;
        assert_eq!(kind("/usr/bin/lyrica"), InstallKind::Deb);
        assert_eq!(kind("/usr/local/bin/lyrica"), InstallKind::Binary);
        assert_eq!(
            kind("/home/me/lyrica/target/debug/lyrica"),
            InstallKind::Binary
        );
        assert_eq!(kind("/usr2/lyrica"), InstallKind::Binary);
    }

    #[test]
    fn asset_names_follow_tauri_bundle_naming() {
        let appimage = Install {
            kind: InstallKind::AppImage,
            path: PathBuf::new(),
        };
        let deb = Install {
            kind: InstallKind::Deb,
            path: PathBuf::new(),
        };
        let binary = Install {
            kind: InstallKind::Binary,
            path: PathBuf::new(),
        };
        if std::env::consts::ARCH == "x86_64" {
            assert_eq!(
                appimage.asset_name("2.5.0").unwrap(),
                "Lyrica_2.5.0_amd64.AppImage"
            );
            assert_eq!(deb.asset_name("2.5.0").unwrap(), "Lyrica_2.5.0_amd64.deb");
        }
        assert_eq!(binary.asset_name("2.5.0"), None);
    }

    #[test]
    fn a_bare_binary_cannot_self_update() {
        let binary = Install {
            kind: InstallKind::Binary,
            path: PathBuf::new(),
        };
        assert!(binary.blocker().is_some());
    }
}
