//! The GitHub releases API and the checksum file attached to each release.

use std::io::Read;
use std::time::Duration;

use serde::Deserialize;

use super::version::is_release_version;
use super::{Result, UpdateError};

/// GitHub API endpoint for Lyrica's latest release (which excludes drafts and
/// pre-releases).
const LATEST_RELEASE_URL: &str = "https://api.github.com/repos/hawawa4/lyrica/releases/latest";

/// The release asset listing the SHA-256 of every installer.
const CHECKSUMS_ASSET: &str = "SHA256SUMS.txt";

const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const MAX_JSON_BYTES: u64 = 4 << 20;
const MAX_CHECKSUMS_BYTES: u64 = 1 << 20;

/// One downloadable file attached to a release.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Asset {
    pub name: String,
    pub url: String,
    pub size: u64,
}

/// A published GitHub release.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Release {
    /// The tag without any leading "v": "2.5.0".
    pub version: String,
    pub page_url: String,
    pub assets: Vec<Asset>,
}

impl Release {
    pub(super) fn asset(&self, name: &str) -> Option<&Asset> {
        self.assets.iter().find(|a| a.name == name)
    }
}

/// Talks to GitHub. `Client::default()` uses the real Lyrica repository.
#[derive(Debug, Clone)]
pub struct Client {
    api_url: String,
}

impl Default for Client {
    fn default() -> Self {
        Client::with_api_url(LATEST_RELEASE_URL)
    }
}

#[derive(Deserialize)]
struct RawRelease {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    assets: Vec<RawAsset>,
}

#[derive(Deserialize)]
struct RawAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

impl Client {
    /// For tests: point at a stand-in for the releases API.
    pub fn with_api_url(url: impl Into<String>) -> Client {
        Client {
            api_url: url.into(),
        }
    }

    fn agent(timeout: Duration) -> ureq::Agent {
        ureq::Agent::config_builder()
            .timeout_global(Some(timeout))
            .user_agent("lyrica-updater")
            .build()
            .into()
    }

    pub(super) fn get(
        &self,
        url: &str,
        accept: &str,
        timeout: Duration,
    ) -> Result<ureq::http::Response<ureq::Body>> {
        Self::agent(timeout)
            .get(url)
            .header("Accept", accept)
            .call()
            .map_err(|e| UpdateError::Network(format!("GET {url}: {e}")))
    }

    /// Fetches the newest published release.
    pub fn latest(&self) -> Result<Release> {
        let mut resp = self.get(&self.api_url, "application/vnd.github+json", CHECK_TIMEOUT)?;
        let raw: RawRelease =
            serde_json::from_reader(resp.body_mut().as_reader().take(MAX_JSON_BYTES))
                .map_err(|e| UpdateError::Network(format!("reading release info: {e}")))?;

        let version = raw.tag_name.trim_start_matches('v').to_string();
        if !is_release_version(&version) {
            return Err(UpdateError::Network(format!(
                "latest release has an unrecognised tag {:?}",
                raw.tag_name
            )));
        }
        Ok(Release {
            version,
            page_url: raw.html_url,
            assets: raw
                .assets
                .into_iter()
                .map(|a| Asset {
                    name: a.name,
                    url: a.browser_download_url,
                    size: a.size,
                })
                .collect(),
        })
    }

    /// Downloads the release's checksum file and returns the hex SHA-256
    /// listed for the asset called `name`.
    pub(super) fn checksum_for(&self, release: &Release, name: &str) -> Result<String> {
        let sums = release.asset(CHECKSUMS_ASSET).ok_or_else(|| {
            UpdateError::Verify(format!(
                "this release has no {CHECKSUMS_ASSET} file, so the download can't be verified"
            ))
        })?;
        let mut resp = self.get(&sums.url, "application/octet-stream", CHECK_TIMEOUT)?;
        let mut text = String::new();
        resp.body_mut()
            .as_reader()
            .take(MAX_CHECKSUMS_BYTES)
            .read_to_string(&mut text)
            .map_err(|e| UpdateError::Network(format!("reading {CHECKSUMS_ASSET}: {e}")))?;
        parse_checksum(&text, name)
    }

    pub(super) fn download(&self, asset: &Asset) -> Result<ureq::http::Response<ureq::Body>> {
        self.get(&asset.url, "application/octet-stream", DOWNLOAD_TIMEOUT)
    }
}

/// Finds `name` in `sha256sum` output (`<hex>  <name>`, where the name may
/// carry a `./` prefix — the release workflow runs `sha256sum ./*` — or a `*`
/// binary-mode marker).
fn parse_checksum(sums: &str, name: &str) -> Result<String> {
    for line in sums.lines() {
        let mut fields = line.split_whitespace();
        let (Some(hex), Some(file), None) = (fields.next(), fields.next(), fields.next()) else {
            continue;
        };
        let file = file.trim_start_matches('*');
        if file.strip_prefix("./").unwrap_or(file) != name {
            continue;
        }
        if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(UpdateError::Verify(format!(
                "malformed checksum for {name}"
            )));
        }
        return Ok(hex.to_ascii_lowercase());
    }
    Err(UpdateError::Verify(format!(
        "no checksum listed for {name}"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "1984c6e5264a7af394d6b76ca250c292e77953dc714e22cb6bd3a1414abd5970";
    const B: &str = "27e31f0ca4da0cea2355bd6a37fa868cd087144701fff16f2b172d3b19b41e2d";

    #[test]
    fn finds_a_checksum_in_the_workflows_dot_slash_format() {
        let sums = format!("{A}  ./Lyrica_2.4.0_amd64.AppImage\n{B}  ./Lyrica_2.4.0_amd64.deb\n");
        assert_eq!(parse_checksum(&sums, "Lyrica_2.4.0_amd64.deb").unwrap(), B);
        assert_eq!(
            parse_checksum(&sums, "Lyrica_2.4.0_amd64.AppImage").unwrap(),
            A
        );
    }

    #[test]
    fn accepts_plain_and_binary_mode_names() {
        assert_eq!(parse_checksum(&format!("{A}  x.deb"), "x.deb").unwrap(), A);
        assert_eq!(parse_checksum(&format!("{A} *x.deb"), "x.deb").unwrap(), A);
    }

    #[test]
    fn rejects_missing_and_malformed_entries() {
        assert!(parse_checksum(&format!("{A}  other.deb"), "x.deb").is_err());
        assert!(parse_checksum("abc  x.deb", "x.deb").is_err());
        // A longer name that merely ends in the wanted one must not match.
        assert!(parse_checksum(&format!("{A}  ./old-x.deb"), "x.deb").is_err());
    }
}
