fn main() {
    let attributes = tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "host_version",
            "note_displayed_host_version",
            "widgets",
        ]),
    );
    tauri_build::try_build(attributes).expect("failed to run tauri build");
}
