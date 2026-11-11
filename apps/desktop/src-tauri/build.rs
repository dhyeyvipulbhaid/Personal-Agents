fn main() {
    let attributes = tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "host_version",
            "note_displayed_host_version",
            "widgets",
            "ollama_status",
            "audit_log",
            "approvals",
            "approval_act",
            "revenue_status",
            "capabilities",
            "list_models",
            "set_models",
            "chat_state",
            "chat_send",
            "chat_stop",
            "chat_approve",
            "chat_new",
            "chat_open",
            "mail_state",
            "memory_list",
            "memory_remember",
            "memory_delete",
            "builder_plan",
            "builder_install",
        ]),
    );
    tauri_build::try_build(attributes).expect("failed to run tauri build");
}
