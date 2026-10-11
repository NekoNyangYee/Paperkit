fn main() {
    // Refresh the executable's Windows resources when branding assets change.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build();
}
