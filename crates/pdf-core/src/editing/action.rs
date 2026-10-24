//! Serializable editing contract. No PDFium or document mutation.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EditState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_count: Option<i32>,
    pub revision: u64,
    pub dirty: bool,
    pub can_undo: bool,
    pub can_redo: bool,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EditAction {
    RemoveWatermark {
        page: Option<i32>,
    },
    ScaleText {
        page: i32,
        objects: Vec<usize>,
        sx: f32,
        sy: f32,
    },
    PasteGraphic {
        page: i32,
        source: Vec<u8>,
    },
    PasteImage {
        page: i32,
        png: Vec<u8>,
    },
    AddSignature {
        page: i32,
        png: Vec<u8>,
    },
    AddWatermark {
        page: Option<i32>,
        png: Vec<u8>,
        #[serde(rename = "widthRatio")]
        width_ratio: f32,
    },
    Page {
        page: i32,
        operation: crate::document::pages::PageOperation,
        destination: Option<i32>,
    },
    TransformGraphic {
        page: i32,
        object: usize,
        matrix: [f32; 6],
    },
    DeleteGraphic {
        page: i32,
        object: usize,
    },
    AlignBlock {
        page: i32,
        groups: Vec<usize>,
        text: Option<String>,
        alignment: crate::text::alignment::Alignment,
        width: Option<f32>,
        height: Option<f32>,
        font: Option<String>,
    },
    FlexibleEdit {
        page: i32,
        groups: Vec<usize>,
        object: Option<usize>,
        text: String,
        #[serde(deserialize_with = "deserialize_font_overrides")]
        fonts: std::collections::HashMap<usize, String>,
        width: Option<f32>,
        height: Option<f32>,
    },
    FlowBlocks {
        page: i32,
        groups: Vec<usize>,
        text: String,
        width: Option<f32>,
        height: Option<f32>,
    },
    FlowBlock {
        page: i32,
        group: usize,
        text: String,
        width: Option<f32>,
        height: Option<f32>,
    },
    EditWithFallback {
        page: i32,
        group: Option<usize>,
        object: Option<usize>,
        text: String,
    },
    Move {
        page: i32,
        group: Option<usize>,
        object: Option<usize>,
        dx: f32,
        dy: f32,
    },
    ChangeBlockFont {
        page: i32,
        group: usize,
        font: String,
        text: Option<String>,
        width: Option<f32>,
        height: Option<f32>,
    },
    ReflowBlock {
        page: i32,
        group: usize,
        text: String,
    },
    ReplaceGroup {
        page: i32,
        group: usize,
        text: String,
    },
    ChangeFont {
        page: i32,
        object: usize,
        font: String,
    },
    Replace {
        page: i32,
        object: usize,
        text: String,
    },
    Undo,
    Redo,
    Save {
        path: PathBuf,
    },
}

// JSON object keys are strings. Internally tagged enum deserialization buffers
// these keys, so deserialize them explicitly before converting to object IDs.
fn deserialize_font_overrides<'de, D>(
    deserializer: D,
) -> Result<std::collections::HashMap<usize, String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let fonts = std::collections::HashMap::<String, String>::deserialize(deserializer)?;
    fonts
        .into_iter()
        .map(|(key, font)| {
            let id = key.parse::<usize>().map_err(serde::de::Error::custom)?;
            if key != id.to_string() {
                return Err(serde::de::Error::custom("invalid font object ID"));
            }
            Ok((id, font))
        })
        .collect()
}

#[cfg(test)]
mod action_tests {
    use super::EditAction;

    #[test]
    fn accepts_json_font_keys_in_tagged_edit_action() {
        let json = r#"{"kind":"flexibleEdit","page":0,"groups":[],"object":258,"text":"수정","fonts":{"258":"pretendard"}}"#;
        let actions = [
            serde_json::from_str::<EditAction>(json).unwrap(),
            serde_json::from_value::<EditAction>(serde_json::from_str(json).unwrap()).unwrap(),
        ];
        for action in actions {
            let EditAction::FlexibleEdit { object, fonts, .. } = action else {
                panic!("wrong action")
            };
            assert_eq!(object, Some(258));
            assert_eq!(fonts.get(&258).map(String::as_str), Some("pretendard"));
        }
    }

    #[test]
    fn rejects_invalid_font_object_ids() {
        for key in [
            "-1",
            "1.5",
            "unknown",
            "0258",
            "+258",
            "184467440737095516160",
        ] {
            let value = serde_json::json!({"kind":"flexibleEdit","page":0,"groups":[1],"text":"text","fonts":{key:"pretendard"}});
            assert!(
                serde_json::from_value::<EditAction>(value).is_err(),
                "{key}"
            );
        }
        let value = serde_json::json!({"kind":"flexibleEdit","page":0,"groups":[1],"text":"text","fonts":{}});
        assert!(serde_json::from_value::<EditAction>(value).is_ok());
    }
}
