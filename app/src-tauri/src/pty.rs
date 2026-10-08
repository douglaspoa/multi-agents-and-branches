//! TERMINAL DE VERDADE por tarefa: o CLI OFICIAL (`claude` / `codex`) roda num PTY dentro do app.
//!
//! Este módulo é só o "cano": spawna o processo num pseudo-terminal (portable-pty), lê a saída numa
//! thread e entrega em LOTES (um evento a cada ~16 ms no máximo, nunca um por byte), escreve,
//! redimensiona e mata. O que o agente FAZ (feed, custo, ocupado/livre, sessão) não vem daqui — vem
//! dos hooks do próprio CLI (`cli.mjs hook …`, src/terminal.ts). Nada de raspar a tela.
//!
//! Regras:
//!  - a sessão vive com a aba fechada/escondida: sem ninguém olhando (`attached` = false) a saída só
//!    vai pro histórico (scrollback) — não sai evento nenhum pra janela (CPU parada);
//!  - histórico LIMITADO (`scroll_cap` bytes, corta numa quebra de linha) e PERSISTIDO em disco
//!    (`log_path`), pra reabrir a tarefa depois de reiniciar o app e ver o que aconteceu;
//!  - o processo nasce LÍDER de sessão/grupo (o portable-pty faz setsid): matar = o grupo inteiro
//!    (claude + MCP + servidores que ele subiu). Registro dos pids em disco → varredura no boot.
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Janela de agrupamento da saída: o 1º pedaço acorda o despachante, que junta o que chegar nesse
/// intervalo e manda UM evento. Sem saída, a thread fica bloqueada (0% de CPU).
pub const BATCH_MS: u64 = 16;
/// Histórico padrão por sessão (bytes crus do terminal).
pub const SCROLL_CAP: usize = 1_500_000;
/// Gravação do histórico em disco enquanto a saída corre (no fim do processo grava sempre).
const PERSIST_EVERY: Duration = Duration::from_secs(4);
/// Respiro entre colar (bracketed paste) e o Enter: o Enter no MESMO pacote do fim da colagem vira
/// quebra de linha dentro da caixa em vez de enviar.
pub const PASTE_ENTER_MS: u64 = 150;

/// Para onde vai o que o terminal produz. O app implementa com eventos Tauri; os testes, com canais.
pub trait PtySink: Send + Sync + 'static {
    fn data(&self, task_id: &str, chunk: &str);
    /// `pid` = o líder que saiu (a sessão pode já ter sido trocada por outra — quem recebe compara)
    fn exit(&self, task_id: &str, pid: u32, code: Option<u32>);
}

#[derive(Clone, Debug)]
pub struct SpawnSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    pub env_remove: Vec<String>,
    pub cols: u16,
    pub rows: u16,
    pub log_path: Option<PathBuf>,
    pub scroll_cap: usize,
    /// "claude" | "codex" (só rótulo)
    pub engine: String,
}

/// Histórico limitado em bytes. Ao estourar, descarta do começo até a próxima quebra de linha
/// (não corta uma linha no meio — sequências de escape costumam terminar antes do \n).
#[derive(Default)]
pub struct Scrollback {
    buf: VecDeque<u8>,
    cap: usize,
    pub dirty: bool,
    /// bytes já empurrados desde o início (posição ABSOLUTA do fim do buffer)
    total: u64,
    /// posição absoluta onde termina o que veio do .log da sessão ANTERIOR (pré-carregado no spawn)
    pre: u64,
}
impl Scrollback {
    pub fn new(cap: usize) -> Self { Scrollback { buf: VecDeque::new(), cap: cap.max(1024), dirty: false, total: 0, pre: 0 } }
    /// Histórico da sessão ANTERIOR (o .log): fica no arquivo (persistência), mas o retrato do attach não o devolve —
    /// a IA retomada (`claude --resume`) reimprime a conversa sozinha; devolver os dois duplicava e "pulava" a tela.
    pub fn preload(&mut self, b: &[u8]) { self.push(b); self.pre = self.total; self.dirty = false; }
    pub fn push(&mut self, b: &[u8]) {
        self.total += b.len() as u64;
        self.buf.extend(b.iter().copied());
        if self.buf.len() > self.cap {
            let mut cut = self.buf.len() - self.cap;
            // avança até depois do próximo \n (no máximo 4 KB além do necessário)
            let lim = (cut + 4096).min(self.buf.len());
            if let Some(i) = (cut..lim).find(|&i| self.buf[i] == b'\n') { cut = i + 1; }
            self.buf.drain(..cut);
        }
        self.dirty = true;
    }
    pub fn len(&self) -> usize { self.buf.len() }
    pub fn bytes(&self) -> Vec<u8> { self.buf.iter().copied().collect() }
    pub fn text(&self) -> String { String::from_utf8_lossy(&self.bytes()).into_owned() }
    /// Só o que ESTA sessão produziu (sem o pré-carregado do .log anterior).
    pub fn session_text(&self) -> String {
        let start = self.total - self.buf.len() as u64;
        let skip = self.pre.saturating_sub(start).min(self.buf.len() as u64) as usize;
        String::from_utf8_lossy(&self.buf.iter().skip(skip).copied().collect::<Vec<u8>>()).into_owned()
    }
}

/// Separa a parte UTF-8 COMPLETA de um lote; o resto (caractere partido no fim) fica pro próximo.
pub fn split_utf8(buf: &mut Vec<u8>) -> String {
    match std::str::from_utf8(buf) {
        Ok(s) => { let s = s.to_string(); buf.clear(); s }
        Err(e) => {
            let ok = e.valid_up_to();
            if e.error_len().is_none() {
                // incompleto no fim: guarda o pedaço
                let s = String::from_utf8_lossy(&buf[..ok]).into_owned();
                buf.drain(..ok);
                s
            } else {
                // byte inválido de verdade: troca por U+FFFD e segue
                let s = String::from_utf8_lossy(buf).into_owned();
                buf.clear();
                s
            }
        }
    }
}

/// Texto pronto pra colar: normaliza quebras e tira qualquer fim-de-colagem embutido (o texto não
/// pode "sair" da colagem e virar tecla).
pub fn paste_payload(text: &str) -> Vec<u8> {
    let clean = text.replace("\r\n", "\n").replace('\r', "\n").replace("\x1b[201~", "").replace("\x1b[200~", "");
    let mut v = Vec::with_capacity(clean.len() + 12);
    v.extend_from_slice(b"\x1b[200~");
    v.extend_from_slice(clean.as_bytes());
    v.extend_from_slice(b"\x1b[201~");
    v
}

pub struct PtySession {
    pub task_id: String,
    pub pid: u32,
    pub engine: String,
    pub started_at: i64,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    scroll: Arc<Mutex<Scrollback>>,
    /// QUANTAS telas olham (janela principal + painéis do canvas): cada attach +1, cada detach −1 (nunca abaixo de 0).
    /// Era um booleano: o detach de uma tela (aba escondida, fit com largura 0) cortava o term-data das outras.
    attached: Arc<AtomicUsize>,
    alive: Arc<AtomicBool>,
    log_path: Option<PathBuf>,
    size: Mutex<(u16, u16)>,
    /// mensagens esperando a sessão ficar livre (hook Stop)
    queue: Mutex<VecDeque<String>>,
    queue_worker: AtomicBool,
    /// ms (epoch) da última saída do processo — sessão "falando" não é ociosa
    last_out: Arc<AtomicI64>,
    /// ms (epoch) desde quando NINGUÉM olha (0 = alguém olhando) — base do encerramento de terminal parado
    unseen_since: AtomicI64,
}

pub const SETTLE_OPEN_MS: i64 = 1500;
pub const SETTLE_QUIET_MS: i64 = 300;
/// PURA: dá pra colar? (a IA não está no meio de desenhar a abertura)
pub fn settled_at(started_at: i64, last_out: i64, now: i64) -> bool { now - started_at >= SETTLE_OPEN_MS && now - last_out >= SETTLE_QUIET_MS }
fn pty_now() -> i64 { now_ms() }
pub fn now_ms() -> i64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0) }

impl PtySession {
    pub fn alive(&self) -> bool { self.alive.load(Ordering::SeqCst) }
    pub fn size(&self) -> (u16, u16) { *self.size.lock().unwrap_or_else(|e| e.into_inner()) }
    pub fn write_bytes(&self, b: &[u8]) -> Result<(), String> {
        if !self.alive() { return Err("o terminal desta tarefa já foi encerrado".into()); }
        let mut w = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        w.write_all(b).and_then(|_| w.flush()).map_err(|e| format!("falha ao escrever no terminal: {e}"))
    }
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let (cols, rows) = (cols.clamp(20, 500), rows.clamp(5, 300));
        {
            let mut s = self.size.lock().unwrap_or_else(|e| e.into_inner());
            if *s == (cols, rows) { return Ok(()); }
            *s = (cols, rows);
        }
        self.master.lock().unwrap_or_else(|e| e.into_inner())
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("falha ao redimensionar: {e}"))
    }
    /// Liga o envio de eventos e devolve o histórico ATÉ AQUI — sob o mesmo cadeado do despachante:
    /// nada se perde nem duplica entre o retrato e o 1º evento.
    /// O retrato é só DESTA sessão (o .log da anterior fica de fora — ver Scrollback::preload).
    pub fn attach(&self) -> String {
        let sb = self.scroll.lock().unwrap_or_else(|e| e.into_inner());
        self.attached.fetch_add(1, Ordering::SeqCst);
        self.unseen_since.store(0, Ordering::SeqCst);
        sb.session_text()
    }
    pub fn detach(&self) {
        if let Ok(1) = self.attached.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1)) {
            self.unseen_since.store(now_ms(), Ordering::SeqCst);
        }
    }
    pub fn watchers(&self) -> usize { self.attached.load(Ordering::SeqCst) }
    /// (desde quando ninguém olha — 0 = alguém olhando, última saída) em ms epoch
    pub fn idle_marks(&self) -> (i64, i64) { (self.unseen_since.load(Ordering::SeqCst), self.last_out.load(Ordering::SeqCst)) }
    /// Pronto pra receber colagem: aberto há ≥ SETTLE_OPEN_MS e sem saída nos últimos SETTLE_QUIET_MS.
    pub fn settled(&self, now: i64) -> bool { settled_at(self.started_at, self.last_out.load(Ordering::SeqCst), now) }
    pub fn queue_len(&self) -> usize { self.queue.lock().unwrap_or_else(|e| e.into_inner()).len() }
    pub fn snapshot(&self) -> String { self.scroll.lock().unwrap_or_else(|e| e.into_inner()).text() }
    pub fn persist(&self) { persist_scroll(&self.scroll, self.log_path.as_deref()); }
    /// Mata o GRUPO (TERM → espera → KILL). Devolve se morreu.
    pub fn kill(&self, grace: Duration) -> bool {
        if !self.alive() { return true; }
        kill_group(self.pid, false);
        let t0 = Instant::now();
        while t0.elapsed() < grace {
            if !self.alive() || !pid_alive(self.pid) { break; }
            std::thread::sleep(Duration::from_millis(30));
        }
        if self.alive() && pid_alive(self.pid) {
            kill_group(self.pid, true);
            let _ = self.child.lock().unwrap_or_else(|e| e.into_inner()).kill();
        }
        let t1 = Instant::now();
        while t1.elapsed() < Duration::from_millis(800) {
            if !self.alive() { return true; }
            std::thread::sleep(Duration::from_millis(20));
        }
        !pid_alive(self.pid)
    }
}

fn persist_scroll(scroll: &Arc<Mutex<Scrollback>>, path: Option<&Path>) {
    let Some(p) = path else { return };
    let bytes = {
        let mut sb = scroll.lock().unwrap_or_else(|e| e.into_inner());
        if !sb.dirty { return; }
        sb.dirty = false;
        sb.bytes()
    };
    if let Some(d) = p.parent() { let _ = std::fs::create_dir_all(d); }
    let tmp = p.with_extension("log.tmp");
    if std::fs::write(&tmp, &bytes).is_ok() { let _ = std::fs::rename(&tmp, p); }
}

#[cfg(unix)]
pub fn pid_alive(pid: u32) -> bool { unsafe { libc::kill(pid as i32, 0) == 0 } }
#[cfg(windows)]
pub fn pid_alive(pid: u32) -> bool {
    std::process::Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"]).output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(&format!("\"{pid}\""))).unwrap_or(false)
}
/// Sinal pro GRUPO do processo (o líder do PTY é líder de sessão → pgid = pid).
#[cfg(unix)]
pub fn kill_group(pid: u32, hard: bool) {
    let sig = if hard { libc::SIGKILL } else { libc::SIGTERM };
    unsafe { libc::kill(-(pid as i32), sig); libc::kill(pid as i32, sig); }
}
#[cfg(windows)]
pub fn kill_group(pid: u32, _hard: bool) {
    let _ = std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).output();
}

/// Registro dos pids vivos em disco (varredura no boot: app fechado à força não deixa claude órfão).
#[derive(Clone)]
pub struct PidRegistry { pub path: PathBuf }
impl PidRegistry {
    fn read(&self) -> Vec<(u32, String)> {
        std::fs::read_to_string(&self.path).ok()
            .and_then(|s| serde_json::from_str::<Vec<(u32, String)>>(&s).ok())
            .unwrap_or_default()
    }
    fn write(&self, v: &[(u32, String)]) {
        if let Some(d) = self.path.parent() { let _ = std::fs::create_dir_all(d); }
        let _ = std::fs::write(&self.path, serde_json::to_string(v).unwrap_or_else(|_| "[]".into()));
    }
    pub fn add(&self, pid: u32, task: &str) { let mut v = self.read(); v.retain(|x| x.0 != pid); v.push((pid, task.to_string())); self.write(&v); }
    pub fn remove(&self, pid: u32) { let mut v = self.read(); let n = v.len(); v.retain(|x| x.0 != pid); if v.len() != n { self.write(&v); } }
    /// Mata o que sobrou de uma execução anterior do app. `is_ours` confere o pid (pid reciclado
    /// por outro programa não pode morrer). Devolve quantos matou.
    pub fn sweep(&self, is_ours: impl Fn(u32) -> bool) -> usize {
        let mut n = 0;
        for (pid, _) in self.read() {
            if pid_alive(pid) && is_ours(pid) {
                kill_group(pid, false);
                std::thread::sleep(Duration::from_millis(300));
                if pid_alive(pid) { kill_group(pid, true); }
                n += 1;
            }
        }
        self.write(&[]);
        n
    }
}

/// O processo `pid` é um CLI de agente (claude/codex/node) ou o SHELL do terminal integrado (a linha dele leva o
/// caminho do `starfork` da worktree: `zsh -l -i -c '…/.cardume/term/bin/starfork' ia …; zsh -l -i`)? Sem `ps`
/// (Windows) → só pelo registro.
pub fn looks_like_agent(pid: u32) -> bool {
    if cfg!(windows) { return true; }
    std::process::Command::new("ps").args(["-ww", "-o", "command=", "-p", &pid.to_string()]).output()
        .map(|o| command_is_ours(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or(false)
}
/// PURA: a linha de comando é de um processo nosso?
pub fn command_is_ours(cmd: &str) -> bool {
    let s = cmd.to_lowercase();
    s.contains("claude") || s.contains("codex") || s.contains("node") || s.contains("starfork-fake-cli") || s.contains(SHELL_MARK)
}
/// Marca do shell do terminal integrado na linha de comando (o shim da worktree).
pub const SHELL_MARK: &str = ".cardume/term/bin/starfork";

pub struct PtyManager {
    sessions: Mutex<HashMap<String, Arc<PtySession>>>,
    sink: Arc<dyn PtySink>,
    pub registry: Option<PidRegistry>,
}

impl PtyManager {
    pub fn new(sink: Arc<dyn PtySink>, registry: Option<PidRegistry>) -> Self {
        PtyManager { sessions: Mutex::new(HashMap::new()), sink, registry }
    }
    pub fn get(&self, task_id: &str) -> Option<Arc<PtySession>> {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner()).get(task_id).cloned()
    }
    pub fn live(&self, task_id: &str) -> Option<Arc<PtySession>> { self.get(task_id).filter(|s| s.alive()) }
    pub fn list(&self) -> Vec<Arc<PtySession>> { self.sessions.lock().unwrap_or_else(|e| e.into_inner()).values().cloned().collect() }

    pub fn spawn(&self, task_id: &str, spec: SpawnSpec) -> Result<Arc<PtySession>, String> {
        if let Some(s) = self.live(task_id) { return Ok(s); }
        let sys = native_pty_system();
        let (cols, rows) = (spec.cols.clamp(20, 500), spec.rows.clamp(5, 300));
        let pair = sys.openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| format!("falha ao abrir o terminal: {e}"))?;
        let mut cmd = CommandBuilder::new(&spec.program);
        cmd.args(&spec.args);
        cmd.cwd(&spec.cwd);
        for k in &spec.env_remove { cmd.env_remove(k); }
        for (k, v) in &spec.env { cmd.env(k, v); }
        let child = pair.slave.spawn_command(cmd).map_err(|e| format!("falha ao iniciar {}: {e}", spec.program))?;
        drop(pair.slave); // senão a leitura nunca chega ao fim quando o processo sai
        let pid = child.process_id().unwrap_or(0);
        let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        // histórico anterior desta tarefa (sessão retomada): continua no mesmo arquivo
        let mut sb = Scrollback::new(spec.scroll_cap);
        if let Some(p) = &spec.log_path { if let Ok(old) = std::fs::read(p) { sb.preload(&old); } }
        let scroll = Arc::new(Mutex::new(sb));
        let sess = Arc::new(PtySession {
            task_id: task_id.to_string(),
            pid,
            engine: spec.engine.clone(),
            started_at: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0),
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            scroll: scroll.clone(),
            attached: Arc::new(AtomicUsize::new(0)),
            alive: Arc::new(AtomicBool::new(true)),
            log_path: spec.log_path.clone(),
            size: Mutex::new((cols, rows)),
            queue: Mutex::new(VecDeque::new()),
            queue_worker: AtomicBool::new(false),
            last_out: Arc::new(AtomicI64::new(now_ms())),
            unseen_since: AtomicI64::new(now_ms()),
        });
        if let Some(r) = &self.registry { r.add(pid, task_id); }
        self.sessions.lock().unwrap_or_else(|e| e.into_inner()).insert(task_id.to_string(), sess.clone());

        // leitor: bytes → canal (bloqueia no read; sem saída = sem CPU)
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        std::thread::Builder::new().name(format!("pty-read-{task_id}")).spawn(move || {
            let mut reader = reader;
            let mut buf = vec![0u8; 16 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => { if tx.send(buf[..n].to_vec()).is_err() { break; } }
                }
            }
        }).map_err(|e| e.to_string())?;

        // despachante: junta o que chegar em BATCH_MS e manda UM evento (só se alguém está olhando)
        let sink = self.sink.clone();
        let (tid, sc, att, lp, lo) = (task_id.to_string(), scroll.clone(), sess.attached.clone(), spec.log_path.clone(), sess.last_out.clone());
        let s2 = sess.clone();
        let reg = self.registry.clone();
        std::thread::Builder::new().name(format!("pty-batch-{task_id}")).spawn(move || {
            let mut pending: Vec<u8> = Vec::new();
            let mut last_persist = Instant::now();
            let flush = |pending: &mut Vec<u8>| {
                let text = split_utf8(pending);
                if text.is_empty() { return; }
                lo.store(now_ms(), Ordering::SeqCst);
                let send = { let mut sb = sc.lock().unwrap_or_else(|e| e.into_inner()); sb.push(text.as_bytes()); att.load(Ordering::SeqCst) > 0 };
                if send { sink.data(&tid, &text); }
            };
            while let Ok(first) = rx.recv() {
                pending.extend_from_slice(&first);
                let until = Instant::now() + Duration::from_millis(BATCH_MS);
                loop {
                    let now = Instant::now();
                    if now >= until || pending.len() > 256 * 1024 { break; }
                    match rx.recv_timeout(until - now) {
                        Ok(more) => pending.extend_from_slice(&more),
                        Err(mpsc::RecvTimeoutError::Timeout) => break,
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
                flush(&mut pending);
                if last_persist.elapsed() >= PERSIST_EVERY { persist_scroll(&sc, lp.as_deref()); last_persist = Instant::now(); }
            }
            if !pending.is_empty() { let s = String::from_utf8_lossy(&pending).into_owned(); pending.clear(); pending.extend_from_slice(s.as_bytes()); flush(&mut pending); }
            // fim da saída = processo saiu (ou fechou o terminal): espera o código, grava e avisa
            let code = { let mut c = s2.child.lock().unwrap_or_else(|e| e.into_inner()); c.wait().ok().map(|st| st.exit_code()) };
            s2.alive.store(false, Ordering::SeqCst);
            // netos que ficaram no grupo (servidor que o agente subiu) morrem junto
            kill_group(s2.pid, true);
            persist_scroll(&sc, lp.as_deref());
            if let Some(r) = &reg { r.remove(s2.pid); }
            sink.exit(&tid, s2.pid, code);
        }).map_err(|e| e.to_string())?;
        Ok(sess)
    }

    pub fn kill(&self, task_id: &str) -> bool {
        match self.get(task_id) { Some(s) => s.kill(Duration::from_millis(1500)), None => true }
    }
    /// Fim do app: mata todos (em paralelo) e grava os históricos.
    pub fn kill_all(&self) {
        let all = self.list();
        let hs: Vec<_> = all.into_iter().map(|s| std::thread::spawn(move || { s.kill(Duration::from_millis(800)); s.persist(); })).collect();
        for h in hs { let _ = h.join(); }
    }

    /// Cola o texto (bracketed paste) e dá Enter depois de um respiro.
    pub fn send_text(&self, task_id: &str, text: &str) -> Result<(), String> {
        let s = self.live(task_id).ok_or("o terminal desta tarefa não está aberto")?;
        s.write_bytes(&paste_payload(text))?;
        std::thread::sleep(Duration::from_millis(PASTE_ENTER_MS));
        s.write_bytes(b"\r")
    }
    /// Interrompe o turno (Esc, como a pessoa faria no terminal).
    pub fn interrupt(&self, task_id: &str) -> Result<(), String> {
        let s = self.live(task_id).ok_or("o terminal desta tarefa não está aberto")?;
        s.write_bytes(b"\x1b")
    }

    /// Enfileira e entrega quando a sessão estiver LIVRE. `idle()` diz o estado (vem do hook Stop/
    /// UserPromptSubmit gravado no banco): Some(true) livre, Some(false) ocupada, None = não sei.
    /// Uma mensagem por vez: depois de entregar, espera a sessão ficar ocupada (ou 8 s) e livre de novo.
    pub fn enqueue(self: &Arc<Self>, task_id: &str, text: String, idle: Arc<dyn Fn() -> Option<bool> + Send + Sync>) -> Result<usize, String> {
        let s = self.live(task_id).ok_or("o terminal desta tarefa não está aberto")?;
        let n = { let mut q = s.queue.lock().unwrap_or_else(|e| e.into_inner()); q.push_back(text); q.len() };
        if s.queue_worker.swap(true, Ordering::SeqCst) { return Ok(n); }
        let me = self.clone();
        let tid = task_id.to_string();
        std::thread::spawn(move || {
            let poll = Duration::from_millis(400);
            loop {
                if !s.alive() { break; }
                // terminal acabou de abrir (a IA ainda desenhando — ex.: retomada ao abrir a tarefa): a colagem se perderia
                if !s.settled(pty_now()) { std::thread::sleep(Duration::from_millis(100)); continue; }
                if idle() != Some(false) {
                    let next = s.queue.lock().unwrap_or_else(|e| e.into_inner()).pop_front();
                    let Some(msg) = next else { break };
                    if me.send_text(&tid, &msg).is_err() { break; }
                    // espera o turno COMEÇAR (o hook UserPromptSubmit marca ocupado) antes da próxima
                    let t0 = Instant::now();
                    while t0.elapsed() < Duration::from_secs(8) && idle() != Some(false) && s.alive() { std::thread::sleep(Duration::from_millis(100)); }
                    continue;
                }
                std::thread::sleep(poll);
            }
            s.queue_worker.store(false, Ordering::SeqCst);
            // corrida: alguém enfileirou enquanto o worker saía
            if s.alive() && !s.queue.lock().unwrap_or_else(|e| e.into_inner()).is_empty() {
                if let Some(m) = s.queue.lock().unwrap_or_else(|e| e.into_inner()).pop_front() { let _ = me.enqueue(&tid, m, idle); }
            }
        });
        Ok(n)
    }
    /// Tira (e devolve) o que estava na fila — reabrir o terminal (troca de IA) leva junto, nada se perde.
    pub fn take_queue(&self, task_id: &str) -> Vec<String> {
        self.get(task_id).map(|s| s.queue.lock().unwrap_or_else(|e| e.into_inner()).drain(..).collect()).unwrap_or_default()
    }
    pub fn queued(&self, task_id: &str) -> usize {
        self.get(task_id).map(|s| s.queue.lock().unwrap_or_else(|e| e.into_inner()).len()).unwrap_or(0)
    }
}

/// Histórico gravado de uma tarefa sem sessão viva (reabrir depois de reiniciar).
pub fn read_log(path: &Path) -> String { std::fs::read(path).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default() }

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[derive(Default)]
    struct TestSink { out: Mutex<HashMap<String, String>>, exits: Mutex<Vec<(String, Option<u32>)>>, events: Mutex<usize> }
    impl PtySink for TestSink {
        fn data(&self, t: &str, c: &str) { self.out.lock().unwrap().entry(t.into()).or_default().push_str(c); *self.events.lock().unwrap() += 1; }
        fn exit(&self, t: &str, _pid: u32, code: Option<u32>) { self.exits.lock().unwrap().push((t.into(), code)); }
    }
    impl TestSink {
        fn text(&self, t: &str) -> String { self.out.lock().unwrap().get(t).cloned().unwrap_or_default() }
        fn wait_for(&self, t: &str, needle: &str, ms: u64) -> bool {
            let t0 = Instant::now();
            while t0.elapsed() < Duration::from_millis(ms) { if self.text(t).contains(needle) { return true; } std::thread::sleep(Duration::from_millis(20)); }
            false
        }
    }

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("starfork-pty-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    /// CLI falso: imprime um banner, ecoa cada linha, responde "size" com o tamanho do terminal e,
    /// com "spawn", deixa um neto dormindo no MESMO grupo (pra provar que o kill pega o grupo).
    fn fake_cli(dir: &Path) -> PathBuf {
        let p = dir.join("starfork-fake-cli.sh");
        std::fs::write(&p, "#!/bin/sh\nstty -echo 2>/dev/null\necho \"FAKE-CLI pronto em $(pwd)\"\nwhile IFS= read -r line; do\n  case \"$line\" in\n    size) stty size ;;\n    spawn) sleep 300 & echo \"NETO $!\" ;;\n    quit) echo tchau; exit 3 ;;\n    flood) i=0; while [ $i -lt 3000 ]; do echo \"linha $i ççç\"; i=$((i+1)); done; echo FIM-FLOOD ;;\n    *) echo \"ECO:$line\" ;;\n  esac\ndone\n").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }
    fn spec(dir: &Path, cap: usize) -> SpawnSpec {
        SpawnSpec { program: fake_cli(dir).display().to_string(), args: vec![], cwd: dir.to_path_buf(), env: vec![("STARFORK_T".into(), "1".into())], env_remove: vec![],
            cols: 100, rows: 30, log_path: Some(dir.join("term").join("t.log")), scroll_cap: cap, engine: "fake".into() }
    }

    #[test]
    fn fila_so_cola_depois_que_a_abertura_assentou() {
        assert!(!settled_at(1000, 1000, 1000 + SETTLE_OPEN_MS - 1), "acabou de abrir");
        assert!(!settled_at(0, 5000, 5000 + SETTLE_QUIET_MS - 1), "ainda desenhando");
        assert!(settled_at(0, 5000, 5000 + SETTLE_QUIET_MS));
    }

    #[test]
    fn scrollback_preload_fica_no_arquivo_mas_fora_do_retrato_da_sessao() {
        let mut sb = Scrollback::new(1024);
        sb.preload(b"VELHO-1\nVELHO-2\n");
        assert!(!sb.dirty, "pré-carregado não precisa regravar");
        assert_eq!(sb.session_text(), "", "nada desta sessão ainda");
        sb.push(b"NOVO\n");
        assert_eq!(sb.session_text(), "NOVO\n");
        assert!(sb.text().starts_with("VELHO-1"), "o arquivo continua com tudo");
        // estourou o teto: o começo (velho) sai; o retrato continua só com o novo, sem pedaço do velho
        let mut sb = Scrollback::new(1024);
        sb.preload(&vec![b'v'; 900]);
        sb.push(&[b"\n".as_slice(), &vec![b'n'; 600]].concat());
        assert!(sb.len() <= 1024 + 4096);
        let st = sb.session_text();
        assert!(!st.contains('v') && st.ends_with(&"n".repeat(600)), "{}", st.len());
    }

    #[test]
    fn retrato_do_attach_nao_repete_o_log_anterior_e_marca_quem_nao_olha() {
        let d = tmpdir("preload");
        std::fs::create_dir_all(d.join("term")).unwrap();
        std::fs::write(d.join("term").join("t.log"), "SESSAO-ANTIGA\r\n").unwrap();
        let sink = Arc::new(TestSink::default());
        let m = Arc::new(PtyManager::new(sink.clone(), None));
        let s = m.spawn("t1", spec(&d, SCROLL_CAP)).unwrap();
        let t0 = Instant::now();
        while !s.snapshot().contains("FAKE-CLI pronto") && t0.elapsed() < Duration::from_secs(5) { std::thread::sleep(Duration::from_millis(20)); }
        assert!(s.snapshot().starts_with("SESSAO-ANTIGA"), "o histórico em disco continua");
        let (unseen0, out0) = s.idle_marks();
        assert!(unseen0 > 0 && out0 > 0, "nasce sem ninguém olhando, com saída marcada");
        let snap = s.attach();
        assert!(snap.contains("FAKE-CLI pronto") && !snap.contains("SESSAO-ANTIGA"), "retrato só desta sessão: {snap:?}");
        assert_eq!(s.idle_marks().0, 0, "olhando = não conta como parado");
        s.attach(); s.detach();
        assert_eq!(s.idle_marks().0, 0, "ainda há quem olhe");
        s.detach();
        assert!(s.idle_marks().0 > 0, "ninguém olhando: marca desde quando");
        m.kill("t1");
        assert!(std::fs::read_to_string(d.join("term").join("t.log")).unwrap().starts_with("SESSAO-ANTIGA"), "o .log segue acumulando");
    }

    #[test]
    fn duas_telas_anexadas_um_detach_nao_corta_a_outra_e_detach_a_mais_nao_fica_negativo() {
        let d = tmpdir("conta");
        let sink = Arc::new(TestSink::default());
        let m = Arc::new(PtyManager::new(sink.clone(), None));
        let s = m.spawn("t1", spec(&d, SCROLL_CAP)).unwrap();
        let t0 = Instant::now();
        while !s.snapshot().contains("FAKE-CLI pronto") && t0.elapsed() < Duration::from_secs(5) { std::thread::sleep(Duration::from_millis(20)); }
        s.attach(); s.attach(); // janela principal + painel do canvas
        assert_eq!(s.watchers(), 2);
        s.detach(); // a janela principal escondeu a aba
        s.write_bytes(b"um\r").unwrap();
        assert!(sink.wait_for("t1", "ECO:um", 5000), "o painel continua recebendo: {:?}", sink.text("t1"));
        s.detach(); s.detach(); s.detach(); // detach a mais não fica negativo
        assert_eq!(s.watchers(), 0);
        std::thread::sleep(Duration::from_millis(BATCH_MS * 3));
        let before = sink.text("t1");
        s.write_bytes(b"dois\r").unwrap();
        let t1 = Instant::now();
        while !s.snapshot().contains("ECO:dois") && t1.elapsed() < Duration::from_secs(5) { std::thread::sleep(Duration::from_millis(20)); }
        std::thread::sleep(Duration::from_millis(BATCH_MS * 3));
        assert_eq!(sink.text("t1"), before, "ninguém olhando = sem eventos");
        s.attach(); // um attach volta a emitir (não precisou "pagar" os detaches a mais)
        assert_eq!(s.watchers(), 1);
        s.write_bytes(b"tres\r").unwrap();
        assert!(sink.wait_for("t1", "ECO:tres", 5000));
        m.kill("t1");
    }

    #[test]
    fn spawn_escreve_ecoa_e_so_emite_quando_anexado() {
        let d = tmpdir("eco");
        let sink = Arc::new(TestSink::default());
        let m = Arc::new(PtyManager::new(sink.clone(), None));
        let s = m.spawn("t1", spec(&d, SCROLL_CAP)).unwrap();
        // sem ninguém olhando: nada de evento, mas o histórico guarda
        let t0 = Instant::now();
        while !s.snapshot().contains("FAKE-CLI pronto") && t0.elapsed() < Duration::from_secs(5) { std::thread::sleep(Duration::from_millis(20)); }
        assert!(s.snapshot().contains("FAKE-CLI pronto"), "banner no histórico");
        assert_eq!(sink.text("t1"), "", "escondido = sem eventos");
        let snap = s.attach();
        assert!(snap.contains("FAKE-CLI pronto"));
        s.write_bytes(b"ola\r").unwrap();
        assert!(sink.wait_for("t1", "ECO:ola", 5000), "eco chega por evento: {:?}", sink.text("t1"));
        m.send_text("t1", "colado").unwrap();
        // o fake não entende bracketed paste: recebe os marcadores + texto; o Enter vem separado
        assert!(sink.wait_for("t1", "colado", 5000));
        m.kill("t1");
    }

    #[test]
    fn redimensiona() {
        let d = tmpdir("size");
        let sink = Arc::new(TestSink::default());
        let m = Arc::new(PtyManager::new(sink.clone(), None));
        let s = m.spawn("t2", spec(&d, SCROLL_CAP)).unwrap();
        s.attach();
        s.resize(132, 40).unwrap();
        s.write_bytes(b"size\r").unwrap();
        assert!(sink.wait_for("t2", "40 132", 5000), "stty size: {:?}", sink.text("t2"));
        assert_eq!(s.size(), (132, 40));
        m.kill("t2");
    }

    #[test]
    fn lotes_agrupam_a_saida_e_historico_tem_teto_e_vai_pro_disco() {
        let d = tmpdir("flood");
        let sink = Arc::new(TestSink::default());
        let m = Arc::new(PtyManager::new(sink.clone(), None));
        let s = m.spawn("t3", spec(&d, 20_000)).unwrap();
        s.attach();
        s.write_bytes(b"flood\r").unwrap();
        assert!(sink.wait_for("t3", "FIM-FLOOD", 10_000));
        let evs = *sink.events.lock().unwrap();
        assert!(evs < 600, "3000 linhas viraram {evs} eventos — tem que ser em lote");
        assert!(sink.text("t3").contains("linha 2999 ççç"), "UTF-8 inteiro entre lotes");
        assert!(s.snapshot().len() <= 20_000, "histórico limitado: {}", s.snapshot().len());
        assert!(s.snapshot().contains("FIM-FLOOD"));
        s.write_bytes(b"quit\r").unwrap();
        let t0 = Instant::now();
        while s.alive() && t0.elapsed() < Duration::from_secs(5) { std::thread::sleep(Duration::from_millis(20)); }
        assert!(!s.alive());
        let t0 = Instant::now();
        while sink.exits.lock().unwrap().is_empty() && t0.elapsed() < Duration::from_secs(3) { std::thread::sleep(Duration::from_millis(20)); }
        assert_eq!(sink.exits.lock().unwrap()[0], ("t3".to_string(), Some(3)));
        let disk = read_log(&d.join("term").join("t.log"));
        assert!(disk.contains("tchau") && disk.len() <= 20_000, "persistido e limitado");
    }

    #[test]
    fn kill_derruba_o_grupo_inteiro_e_registro_varre() {
        let d = tmpdir("kill");
        let sink = Arc::new(TestSink::default());
        let reg = PidRegistry { path: d.join("pids.json") };
        let m = Arc::new(PtyManager::new(sink.clone(), Some(reg.clone())));
        let s = m.spawn("t4", spec(&d, SCROLL_CAP)).unwrap();
        s.attach();
        s.write_bytes(b"spawn\r").unwrap();
        assert!(sink.wait_for("t4", "NETO ", 5000));
        let txt = sink.text("t4");
        let neto: u32 = txt.split("NETO ").nth(1).unwrap().split_whitespace().next().unwrap().trim().parse().unwrap();
        assert!(pid_alive(neto));
        assert!(std::fs::read_to_string(&reg.path).unwrap().contains(&s.pid.to_string()), "pid registrado");
        assert!(m.kill("t4"));
        let t0 = Instant::now();
        while pid_alive(neto) && t0.elapsed() < Duration::from_secs(3) { std::thread::sleep(Duration::from_millis(30)); }
        assert!(!pid_alive(neto), "o neto (servidor que o agente subiu) morre junto");
        let t0 = Instant::now();
        while std::fs::read_to_string(&reg.path).unwrap().contains(&format!("{},", s.pid)) && t0.elapsed() < Duration::from_secs(3) { std::thread::sleep(Duration::from_millis(30)); }
        // varredura de boot: um pid "órfão" registrado (processo vivo fora do app) morre
        let mut orphan = std::process::Command::new(fake_cli(&d));
        let mut ch = { use std::os::unix::process::CommandExt; unsafe { orphan.pre_exec(|| { libc::setsid(); Ok(()) }); } orphan.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null()).spawn().unwrap() };
        reg.add(ch.id(), "velha");
        assert_eq!(reg.sweep(looks_like_agent), 1);
        let _ = ch.wait();
        assert!(!pid_alive(ch.id()));
        assert_eq!(std::fs::read_to_string(&reg.path).unwrap(), "[]");
    }

    #[test]
    fn fila_entrega_so_quando_livre_e_uma_por_vez() {
        let d = tmpdir("fila");
        let sink = Arc::new(TestSink::default());
        let m = Arc::new(PtyManager::new(sink.clone(), None));
        let s = m.spawn("t5", spec(&d, SCROLL_CAP)).unwrap();
        s.attach();
        let busy = Arc::new(AtomicBool::new(true));
        let b2 = busy.clone();
        let idle: Arc<dyn Fn() -> Option<bool> + Send + Sync> = Arc::new(move || Some(!b2.load(Ordering::SeqCst)));
        assert_eq!(m.enqueue("t5", "primeira".into(), idle.clone()).unwrap(), 1);
        assert_eq!(m.enqueue("t5", "segunda".into(), idle.clone()).unwrap(), 2);
        std::thread::sleep(Duration::from_millis(900));
        assert!(!sink.text("t5").contains("primeira"), "ocupada: segura");
        busy.store(false, Ordering::SeqCst);
        assert!(sink.wait_for("t5", "primeira", 5000));
        // simula o hook: entregou → sessão ocupada; a segunda espera
        busy.store(true, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(900));
        assert!(!sink.text("t5").contains("segunda"));
        busy.store(false, Ordering::SeqCst);
        assert!(sink.wait_for("t5", "segunda", 5000));
        assert_eq!(m.queued("t5"), 0);
        m.kill("t5");
    }

    #[test]
    #[cfg(unix)]
    fn shell_do_terminal_integrado_e_reconhecido_na_varredura() {
        assert!(command_is_ours("/bin/zsh -l -i -c '/Users/a/repo/.cardume/worktrees/t/.cardume/term/bin/starfork' ia claude; '/bin/zsh' -l -i"));
        assert!(!command_is_ours("/bin/zsh -l -i"), "shell qualquer (pid reciclado) não é nosso");
        let mut ch = std::process::Command::new("/bin/sh").args(["-c", "sleep 30; : /x/.cardume/term/bin/starfork"]).spawn().unwrap();
        std::thread::sleep(Duration::from_millis(200));
        assert!(looks_like_agent(ch.id()), "a varredura do boot reconhece o shell pela linha (ps -ww: sem cortar)");
        let _ = ch.kill(); let _ = ch.wait();
    }

    #[test]
    fn utf8_partido_e_colagem_segura() {
        let mut b = "olá".as_bytes().to_vec();
        let last = b.pop().unwrap();
        assert_eq!(split_utf8(&mut b), "ol");
        b.push(last);
        assert_eq!(split_utf8(&mut b), "á");
        let p = String::from_utf8(paste_payload("a\r\nb\x1b[201~c")).unwrap();
        assert_eq!(p, "\x1b[200~a\nbc\x1b[201~");
    }
}
