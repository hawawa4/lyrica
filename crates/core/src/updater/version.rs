//! Release version numbers: plain `MAJOR.MINOR.PATCH`, optionally `v`-prefixed.

fn parse(s: &str) -> Option<[u64; 3]> {
    let mut parts = s.trim().trim_start_matches('v').split('.');
    let mut v = [0u64; 3];
    for slot in &mut v {
        let p = parts.next()?;
        let n: u64 = p.parse().ok()?;
        // Reject "01" and "+1", which parse but aren't how releases are tagged.
        if n.to_string() != p {
            return None;
        }
        *slot = n;
    }
    parts.next().is_none().then_some(v)
}

/// Whether `v` is a release version number (so not a pre-release, not "dev").
pub fn is_release_version(v: &str) -> bool {
    parse(v).is_some()
}

/// Whether `latest` is a higher release version than `current`. False when
/// either side isn't a release version.
pub fn is_newer(latest: &str, current: &str) -> bool {
    match (parse(latest), parse(current)) {
        (Some(l), Some(c)) => l > c,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_numerically_not_lexically() {
        assert!(is_newer("2.10.0", "2.9.9"));
        assert!(is_newer("v3.0.0", "2.99.99"));
        assert!(is_newer("2.4.1", "2.4.0"));
        assert!(!is_newer("2.4.0", "2.4.0"));
        assert!(!is_newer("2.3.9", "2.4.0"));
    }

    #[test]
    fn non_release_versions_never_compare_as_newer() {
        assert!(!is_newer("2.5.0-rc1", "2.4.0"));
        assert!(!is_newer("2.5.0", "dev"));
        assert!(!is_newer("2.5", "2.4.0"));
        assert!(!is_newer("2.5.0.1", "2.4.0"));
        assert!(!is_newer("2.05.0", "2.4.0"));
        assert!(!is_release_version(""));
        assert!(is_release_version("v2.4.0"));
    }
}
