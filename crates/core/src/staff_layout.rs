//! Which staff of its part each staff is, read from a score's raw `.mscx`
//! XML, in staff order.
//!
//! webmscore's MIDI export writes one track per staff, in that same order, so
//! this is what lets the player mute "the lower staff" (a piano's left hand)
//! without knowing anything else about the score.

use quick_xml::events::Event;
use quick_xml::Reader;
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StaffLayoutError {
    #[error("xml error: {0}")]
    Xml(#[from] quick_xml::Error),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StaffRole {
    /// The only staff of its part (a violin, a vocal line): not affected by
    /// the upper/lower choice.
    Solo,
    /// First staff of a multi-staff part (a piano's right hand).
    Upper,
    /// Any later staff of a multi-staff part (a piano's left hand).
    Lower,
}

/// One role per staff, in the order the staves appear under their `<Part>`s.
pub fn parse_staff_roles(mscx_contents: &str) -> Result<Vec<StaffRole>, StaffLayoutError> {
    let mut reader = Reader::from_str(mscx_contents);
    reader.config_mut().trim_text(true);

    let mut stack: Vec<Vec<u8>> = Vec::new();
    let mut roles: Vec<StaffRole> = Vec::new();
    let mut staves_in_part = 0usize;

    loop {
        match reader.read_event()? {
            Event::Start(e) => {
                let name = e.name().as_ref().to_vec();
                if name == b"Staff" && stack.last().map(Vec::as_slice) == Some(b"Part") {
                    staves_in_part += 1;
                } else if name == b"Part" {
                    staves_in_part = 0;
                }
                stack.push(name);
            }
            Event::Empty(e) => {
                if e.name().as_ref() == b"Staff" && stack.last().map(Vec::as_slice) == Some(b"Part")
                {
                    staves_in_part += 1;
                }
            }
            Event::End(_) => {
                if let Some(name) = stack.pop() {
                    if name == b"Part" {
                        push_part(&mut roles, staves_in_part);
                        staves_in_part = 0;
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(roles)
}

fn push_part(roles: &mut Vec<StaffRole>, staves: usize) {
    match staves {
        0 => {}
        1 => roles.push(StaffRole::Solo),
        n => {
            roles.push(StaffRole::Upper);
            roles.extend(std::iter::repeat_n(StaffRole::Lower, n - 1));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grand_staff_is_upper_then_lower() {
        let mscx = r#"<museScore><Score>
            <Part><Staff id="1"><StaffType/></Staff><Staff id="2"><StaffType/></Staff></Part>
            <Staff id="1"><Measure/></Staff><Staff id="2"><Measure/></Staff>
          </Score></museScore>"#;
        assert_eq!(
            parse_staff_roles(mscx).unwrap(),
            vec![StaffRole::Upper, StaffRole::Lower]
        );
    }

    #[test]
    fn single_staff_parts_are_solo_and_parts_are_independent() {
        let mscx = r#"<museScore><Score>
            <Part><Staff id="1"/></Part>
            <Part><Staff id="2"/><Staff id="3"/></Part>
            <Part><Staff id="4"><StaffType/></Staff></Part>
            <Staff id="1"><Measure/></Staff>
          </Score></museScore>"#;
        assert_eq!(
            parse_staff_roles(mscx).unwrap(),
            vec![
                StaffRole::Solo,
                StaffRole::Upper,
                StaffRole::Lower,
                StaffRole::Solo
            ]
        );
    }
}
