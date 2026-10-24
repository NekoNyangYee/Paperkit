//! Desktop startup, managed state and IPC registration.
use crate::commands::{files, preview, updates};
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(files::AppState::default())
        .manage(updates::UpdateState::default())
        .setup(|app| {
            #[cfg(debug_assertions)]
            let library = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("resources/pdfium/pdfium.dll");
            #[cfg(not(debug_assertions))]
            let library = app.path().resolve(
                "resources/pdfium/pdfium.dll",
                tauri::path::BaseDirectory::Resource,
            )?;
            let font_directory = library
                .parent()
                .and_then(|p| p.parent())
                .ok_or("Invalid resource path")?
                .join("fonts");
            let engine = pdf_core::Paperframe::start_with_fonts(library, font_directory.clone())
                .map_err(|_| std::io::Error::other("Could not start PDFium worker"))?;
            app.manage(preview::PreviewState(engine, font_directory));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            updates::download_update,
            updates::install_update,
            files::receive_file_input,
            files::synchronize_selection,
            files::clear_selection,
            preview::render_selected_page,
            preview::edit_document,
            preview::list_fonts,
            preview::editor_font,
            preview::document_font,
            preview::copy_graphic,
            preview::import_original_font,
            preview::editing_background,
            preview::release_preview
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Paperkit desktop application");
}
