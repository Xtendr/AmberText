use crate::safe_io::IoFailure;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TextFormat {
    pub encoding: String,
    pub bom: bool,
    pub eol: String,
    pub confirmed: bool,
}

impl Default for TextFormat {
    fn default() -> Self {
        Self {
            encoding: "utf8".into(),
            bom: false,
            eol: "\n".into(),
            confirmed: true,
        }
    }
}

const HIGH: [char; 32] = [
    '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž', '\u{8f}',
    '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9d}', 'ž', 'Ÿ',
];
fn undefined_byte(byte: u8) -> bool {
    matches!(byte, 0x81 | 0x8d | 0x8f | 0x90 | 0x9d)
}

pub fn line_ending(text: &str) -> String {
    let bytes = text.as_bytes();
    let (mut lf, mut crlf, mut cr) = (false, false, false);
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'\r' {
            if bytes.get(at + 1) == Some(&b'\n') {
                crlf = true;
                at += 1;
            } else {
                cr = true;
            }
        } else if bytes[at] == b'\n' {
            lf = true;
        }
        at += 1;
    }
    if u8::from(lf) + u8::from(crlf) + u8::from(cr) > 1 {
        "mixed"
    } else if crlf {
        "\r\n"
    } else if cr {
        "\r"
    } else {
        "\n"
    }
    .into()
}

pub fn decode(bytes: &[u8]) -> Result<(String, TextFormat), IoFailure> {
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) || bytes.contains(&0) {
        return Err(IoFailure::new("unsupported", "This file is not supported UTF-8 or Windows-1252 text. Its bytes have not been changed."));
    }
    let bom = bytes.starts_with(&[0xef, 0xbb, 0xbf]);
    let body = if bom { &bytes[3..] } else { bytes };
    let (content, encoding, confirmed) = match std::str::from_utf8(body) {
        Ok(text) => (text.to_owned(), "utf8", true),
        Err(_) if bom => {
            return Err(IoFailure::new(
                "unsupported",
                "The UTF-8 file contains invalid bytes. It has not been converted.",
            ))
        }
        Err(_) => {
            if body.iter().any(|b| undefined_byte(*b)) {
                return Err(IoFailure::new("unsupported", "The file contains ambiguous bytes that cannot be safely interpreted as Windows-1252."));
            }
            (
                body.iter()
                    .map(|b| {
                        if (0x80..0xa0).contains(b) {
                            HIGH[(*b - 0x80) as usize]
                        } else {
                            *b as char
                        }
                    })
                    .collect(),
                "windows1252",
                false,
            )
        }
    };
    let eol = line_ending(&content);
    Ok((
        content,
        TextFormat {
            encoding: encoding.into(),
            bom,
            eol,
            confirmed,
        },
    ))
}

pub fn encode(content: &str, format: &TextFormat) -> Result<Vec<u8>, IoFailure> {
    if !["\n", "\r\n", "\r"].contains(&format.eol.as_str()) {
        return Err(IoFailure::new("confirmation", "This file has mixed line endings. Choose a line-ending format before saving edited text."));
    }
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let text = normalized.replace('\n', &format.eol);
    match format.encoding.as_str() {
        "utf8" => {
            let mut bytes = if format.bom {
                vec![0xef, 0xbb, 0xbf]
            } else {
                vec![]
            };
            bytes.extend_from_slice(text.as_bytes());
            Ok(bytes)
        }
        "windows1252" => {
            if !format.confirmed || format.bom {
                return Err(IoFailure::new(
                    "confirmation",
                    "Confirm the Windows-1252 interpretation before saving.",
                ));
            }
            text.chars().map(|ch| {
                if let Some(at) = HIGH.iter().position(|candidate| *candidate == ch) {
                    let byte = at as u8 + 0x80;
                    if !undefined_byte(byte) { return Ok(byte); }
                } else if (ch as u32) < 0x80 || (0xa0..=0xff).contains(&(ch as u32)) { return Ok(ch as u8); }
                Err(IoFailure::new("unsupported", "Windows-1252 cannot represent every character in this writing. Choose UTF-8 to preserve them."))
            }).collect()
        }
        _ => Err(IoFailure::new(
            "unsupported",
            "Unsupported text encoding; no file was changed.",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn utf8_bom_and_all_uniform_endings_round_trip() {
        for bom in [false, true] {
            for eol in ["\n", "\r\n", "\r"] {
                let format = TextFormat {
                    bom,
                    eol: eol.into(),
                    ..TextFormat::default()
                };
                let bytes = encode("שלום æ\nمرحبا 123\n", &format).unwrap();
                let (content, found) = decode(&bytes).unwrap();
                assert_eq!(format, found);
                assert_eq!(encode(&content, &found).unwrap(), bytes);
            }
        }
    }
    #[test]
    fn cp1252_is_interpretation_until_confirmed_and_round_trips() {
        let bytes = [b'a', 0xe6, 0xf8, 0xe9, 0x80, 0x93, 0x94, b'\r', b'\n'];
        let (content, mut format) = decode(&bytes).unwrap();
        assert!(!format.confirmed);
        assert_eq!(encode(&content, &format).unwrap_err().kind, "confirmation");
        format.confirmed = true;
        assert_eq!(encode(&content, &format).unwrap(), bytes);
        assert_eq!(
            encode(&(content + "🙂"), &format).unwrap_err().kind,
            "unsupported"
        );
    }
    #[test]
    fn invalid_utf8_utf16_and_undefined_bytes_are_not_guessed() {
        for bytes in [
            vec![0xef, 0xbb, 0xbf, 0xff],
            vec![0xff, 0xfe, b'a', 0],
            vec![b'a', 0, b'b'],
            vec![0x81, 0xe9],
        ] {
            assert!(decode(&bytes).is_err());
        }
    }
    #[test]
    fn mixed_endings_require_explicit_choice() {
        let (text, mut format) = decode(b"a\r\nb\nc\r").unwrap();
        assert_eq!(format.eol, "mixed");
        assert_eq!(encode(&text, &format).unwrap_err().kind, "confirmation");
        format.eol = "\r\n".into();
        assert_eq!(encode(&text, &format).unwrap(), b"a\r\nb\r\nc\r\n");
    }
}
