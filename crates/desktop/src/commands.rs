use mp_core::api::{self, OpenFileRequest, OpenFileResponse};

#[tauri::command]
pub fn open_file(bytes: Vec<u8>, original_filename: String) -> Result<OpenFileResponse, String> {
    api::open_file(OpenFileRequest {
        bytes,
        original_filename,
    })
    .map_err(|e| e.to_string())
}
