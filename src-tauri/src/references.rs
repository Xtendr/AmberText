//! Read-only reference diagnostics through existing bounded filesystem owners.
use crate::{
    safe_io::{IoFailure, Revision},
    search,
    text_format::TextFormat,
};
use serde::Serialize;
use std::{
    fs,
    path::{Component, Path, PathBuf},
};
#[derive(Serialize)]
pub struct Catalogue {
    pub paths: Vec<String>,
    pub coverage: search::Coverage,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub content: String,
    pub revision: Revision,
    pub format: TextFormat,
    pub byte_length: usize,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub status: &'static str,
    pub canonical_path: Option<String>,
    pub outside: bool,
    pub message: String,
}
fn network(path: &Path) -> bool {
    let s = path.to_string_lossy();
    s.starts_with("//") || s.starts_with("\\\\")
}
fn local(path: &Path) -> Result<(), IoFailure> {
    if network(path) {
        return Err(IoFailure::new(
            "unsupported",
            "Network paths are not probed by reference diagnostics",
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        extern "system" {
            fn GetDriveTypeW(root: *const u16) -> u32;
        }
        let absolute = if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()?.join(path)
        };
        let drive = match absolute.components().next() {
            Some(Component::Prefix(prefix)) => match prefix.kind() {
                std::path::Prefix::Disk(drive) | std::path::Prefix::VerbatimDisk(drive) => drive,
                _ => {
                    return Err(IoFailure::new(
                        "unsupported",
                        "Non-local path namespace needs explicit review",
                    ))
                }
            },
            _ => {
                return Err(IoFailure::new(
                    "unsupported",
                    "AmberText couldn’t confirm which drive this file is on",
                ))
            }
        };
        let root = format!("{}:\\", drive as char);
        let wide: Vec<u16> = std::ffi::OsStr::new(&root)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        // Drive classification does not read a referenced file. Refuse mapped
        // remote and unknown drives before any ancestor/leaf metadata lookup.
        let kind = unsafe { GetDriveTypeW(wide.as_ptr()) };
        if kind <= 1 || kind == 4 {
            return Err(IoFailure::new(
                "unsupported",
                "Remote or unknown drive is not probed by reference diagnostics",
            ));
        }
    }
    Ok(())
}
fn reparse(meta: &fs::Metadata) -> bool {
    crate::search::link(meta)
}
// Inspect parents from the filesystem root before looking up a leaf. A leaf
// metadata lookup alone would already follow an ancestor junction/symlink.
// This is a read-only snapshot check, not protection against a concurrent
// filesystem retarget; it never grants authority to mutate these paths.
fn reject_reparse_ancestors(path: &Path) -> Result<(), IoFailure> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut prefix = PathBuf::new();
    for component in absolute.components() {
        prefix.push(component.as_os_str());
        if matches!(
            component,
            Component::Prefix(_) | Component::RootDir | Component::CurDir
        ) {
            continue;
        }
        match fs::symlink_metadata(&prefix) {
            Ok(meta) if reparse(&meta) || meta.file_type().is_symlink() => {
                return Err(IoFailure::new(
                    "unsupported",
                    "This file is reached through a shortcut or link, so AmberText won’t change it automatically",
                ))
            }
            Ok(_) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}
pub fn catalogue(root: &Path, cancelled: &impl Fn() -> bool) -> Result<Catalogue, IoFailure> {
    local(root)?;
    reject_reparse_ancestors(root)?;
    let canonical = fs::canonicalize(root)?;
    let cat = search::catalogue(root, cancelled)?;
    let paths = cat
        .files
        .iter()
        .map(|p| {
            p.strip_prefix(&canonical)
                .map(|relative| root.join(relative))
                .unwrap_or_else(|_| p.clone())
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    Ok(Catalogue {
        paths,
        coverage: cat.coverage,
    })
}
pub fn read(root: &Path, path: &Path) -> Result<Source, IoFailure> {
    local(root)?;
    local(path)?;
    reject_reparse_ancestors(root)?;
    reject_reparse_ancestors(path)?;
    let canonical_root = fs::canonicalize(root)?;
    let (content, revision, byte_length, format) = search::read_source(path, &canonical_root)?;
    Ok(Source {
        content,
        revision,
        byte_length,
        format,
    })
}
pub fn inspect(root: &Path, path: &Path) -> Result<Target, IoFailure> {
    local(root)?;
    local(path)?;
    reject_reparse_ancestors(root)?;
    if let Err(error) = reject_reparse_ancestors(path) {
        if error.kind == "unsupported" {
            return Ok(Target {
                status: "unknown",
                canonical_path: None,
                outside: false,
                message: error.message,
            });
        }
        return Err(error);
    }
    let canonical_root = fs::canonicalize(root)?;
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Target {
                status: "missing",
                canonical_path: None,
                outside: false,
                message: "Local target was not found at scan time".into(),
            })
        }
        Err(error) => return Err(error.into()),
    };
    if reparse(&meta) || meta.file_type().is_symlink() {
        return Ok(Target {
            status: "unknown",
            canonical_path: None,
            outside: false,
            message: "This file is reached through a shortcut or link, so AmberText won’t change it automatically".into(),
        });
    }
    if meta.is_file() {
        if let Err(error) = crate::safe_io::reject_hard_links(path, &meta) {
            return Ok(Target {
                status: "unknown",
                canonical_path: None,
                outside: false,
                message: error.message,
            });
        }
    }
    let canonical = fs::canonicalize(path)?;
    Ok(Target {
        status: if meta.is_file() { "present" } else { "unknown" },
        outside: !canonical.starts_with(canonical_root),
        canonical_path: Some(canonical.to_string_lossy().into_owned()),
        message: if meta.is_file() {
            "".into()
        } else {
            "Target is not a regular file".into()
        },
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "ambertext-reference-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn native_catalogue_read_and_target_identity_never_change_bytes() {
        let f = Fixture::new();
        let root = f.0.join("notes");
        fs::create_dir(&root).unwrap();
        let document = root.join("æ.md");
        let image = root.join("same image.png");
        let outside = f.0.join("outside.png");
        let original = "\u{feff}![æ](same%20image.png)\r\nNext".as_bytes();
        fs::write(&document, original).unwrap();
        fs::write(&image, [0, 1, 255]).unwrap();
        fs::write(&outside, [99]).unwrap();
        let cat = catalogue(&root, &|| false).unwrap();
        assert_eq!(cat.paths.len(), 1);
        assert!(!cat.coverage.partial);
        let source = read(&root, &document).unwrap();
        assert_eq!(source.content, "![æ](same%20image.png)\nNext");
        assert!(source.format.bom);
        assert_eq!(source.format.eol, "\r\n");
        let target = inspect(&root, &image).unwrap();
        assert_eq!(target.status, "present");
        assert!(!target.outside);
        assert_eq!(
            target.canonical_path,
            inspect(&root, &root.join("./same image.png"))
                .unwrap()
                .canonical_path
        );
        #[cfg(windows)]
        assert_eq!(
            target.canonical_path,
            inspect(&root, &root.join("SAME IMAGE.PNG"))
                .unwrap()
                .canonical_path
        );
        for folder in ["first", "second"] {
            fs::create_dir(root.join(folder)).unwrap();
            fs::write(root.join(folder).join("same.png"), [1]).unwrap();
        }
        assert_ne!(
            inspect(&root, &root.join("first/same.png"))
                .unwrap()
                .canonical_path,
            inspect(&root, &root.join("second/same.png"))
                .unwrap()
                .canonical_path
        );
        assert!(inspect(&root, &outside).unwrap().outside);
        assert_eq!(
            inspect(&root, &root.join("missing.png")).unwrap().status,
            "missing"
        );
        assert!(read(&root, &outside).is_err());
        assert_eq!(inspect(&root, &root).unwrap().status, "unknown");
        let alias = root.join("hard-link.png");
        fs::hard_link(&image, &alias).unwrap();
        assert_eq!(inspect(&root, &alias).unwrap().status, "unknown");
        assert_eq!(fs::read(&document).unwrap(), original);
        assert_eq!(fs::read(&image).unwrap(), [0, 1, 255]);
        assert_eq!(fs::read(&outside).unwrap(), [99]);
        let stopped = catalogue(&root, &|| true).unwrap();
        assert!(stopped.coverage.cancelled && stopped.coverage.partial);
    }
    #[test]
    fn oversized_and_network_sources_are_refused_without_reading() {
        let f = Fixture::new();
        let large = f.0.join("large.md");
        fs::write(&large, vec![b'x'; search::MAX_FILE_BYTES as usize + 1]).unwrap();
        assert!(read(&f.0, &large).is_err());
        assert!(catalogue(&f.0, &|| false).unwrap().coverage.partial);
        assert!(inspect(&f.0, Path::new("//server/share/image.png")).is_err());
        assert!(catalogue(Path::new("//server/share"), &|| false).is_err());
        assert_eq!(
            fs::metadata(&large).unwrap().len(),
            search::MAX_FILE_BYTES + 1
        );
    }
    #[cfg(windows)]
    #[test]
    fn ancestor_junction_is_review_only_without_reading_through_it() {
        use std::os::windows::process::CommandExt;
        let f = Fixture::new();
        let root = f.0.join("notes");
        let outside = f.0.join("outside");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        let original = b"Writing kept outside the selected folder";
        fs::write(outside.join("doc.md"), original).unwrap();
        fs::write(outside.join("image.png"), [0, 255]).unwrap();
        let link = root.join("linked");
        let output = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "Owned junction fixture unavailable: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let target = inspect(&root, &link.join("image.png")).unwrap();
        let read_refused = read(&root, &link.join("doc.md")).is_err();
        let root_refused = catalogue(&link, &|| false).is_err();
        let missing = inspect(&root, &link.join("missing.png")).unwrap();
        // Remove only this fixture's junction before ordinary fixture cleanup.
        fs::remove_dir(&link).unwrap();
        assert_eq!(target.status, "unknown");
        assert!(target.canonical_path.is_none());
        assert_eq!(missing.status, "unknown");
        assert!(read_refused && root_refused);
        assert_eq!(fs::read(outside.join("doc.md")).unwrap(), original);
        assert_eq!(fs::read(outside.join("image.png")).unwrap(), [0, 255]);
    }
}
