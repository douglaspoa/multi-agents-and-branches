// Impede que uma janela de console abra junto no Windows (release).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    cardume_app_lib::run()
}
