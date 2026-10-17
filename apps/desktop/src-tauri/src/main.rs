#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod preview;
mod updater;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(commands::AppState::default())
        .manage(updater::UpdateState::default())
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
            updater::download_update,
            updater::install_update,
            commands::receive_file_input,
            commands::synchronize_selection,
            commands::clear_selection,
            preview::render_selected_page,
            preview::edit_document,
            preview::list_fonts,
            preview::editor_font,
            preview::document_font,
            preview::import_original_font,
            preview::editing_background,
            preview::release_preview
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Paperkit desktop application");
}
