//! Prova do PDF do relatório pelo MESMO caminho do app (relatorio.rs): WKWebView fora da tela → script de paginação
//! → createPDF → corte em A4. Sem janela e sem o app: a thread principal gira o run loop entre os passos.
//! Uso: cargo run --offline --example relatorio_pdf -- <relatorio.html> <saida.pdf>
#[cfg(target_os = "macos")]
fn main() {
    use cardume_app_lib::relatorio::{self, mac};
    use objc2_foundation::{MainThreadMarker, NSDate, NSRunLoop};
    use std::cell::RefCell;
    use std::rc::Rc;
    let a: Vec<String> = std::env::args().collect();
    let (ent, sai) = (a.get(1).expect("<relatorio.html>"), a.get(2).expect("<saida.pdf>"));
    let html = std::fs::read_to_string(ent).expect("ler o HTML");
    MainThreadMarker::new().expect("precisa rodar na thread principal");
    let gira = || unsafe { NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.05)) };
    mac::criar(1, &relatorio::html_pdf(&html)).expect("criar o webview");
    let mut h = None;
    for _ in 0..600 { gira(); if let Some(x) = relatorio::altura_pronta(&mac::titulo(1)) { h = Some(x); break; } }
    let h = h.expect("o documento não paginou em 30 s");
    let out: Rc<RefCell<Option<Result<Vec<u8>, String>>>> = Rc::new(RefCell::new(None));
    let o2 = out.clone();
    mac::pdf(1, h, Box::new(move |r| { *o2.borrow_mut() = Some(r); }));
    for _ in 0..600 { gira(); if out.borrow().is_some() { break; } }
    let alto = out.borrow_mut().take().expect("createPDF não respondeu em 30 s").expect("createPDF falhou");
    mac::fechar(1);
    let pdf = relatorio::paginar(&alto).expect("paginar");
    std::fs::write(sai, &pdf).expect("gravar o PDF");
    println!("altura {h} px · {} páginas · {} bytes → {sai}", relatorio::paginas(h), pdf.len());
}
#[cfg(not(target_os = "macos"))]
fn main() { eprintln!("só no macOS"); }
