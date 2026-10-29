// Protótipo — a IA (frente "ia", 27/10). Um comando só pras três conversas do protótipo com a IA do usuário:
//  - "gerar": desenha a 1ª versão (telas Desktop e Celular em HTML+CSS, blocos com data-blk);
//  - "olhar": lê os comentários (posição, alvo, seletor, recortes PNG) e propõe UMA correção por comentário (+ crítica);
//  - "diff":  compara a Prévia real da tarefa com a tela do protótipo e lista as diferenças.
// Mesmo caminho dos chats: claude_bin/claude_cmd (claude_runnable) com o motor escolhido; `chat_other` pros outros
// motores. SÓ LEITURA no repo (olhar telas/estilos existentes, CLAUDE.md, skills, os PNGs anexados) — nunca edita.
// Quem monta o pedido e lê o JSON é o front (85-prototipo-ia.js, partes puras testadas); aqui só o sistema + a rodada.
use super::*;

static PROTO_GEN_PID: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);
static PROTO_OLHAR_PID: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);
static PROTO_DIFF_PID: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

/// Origem no livro de uso (medidor): tudo do protótipo conta junto.
pub(crate) const PROTO_SOURCE: &str = "prototipo";

/// As três conversas. Qualquer outro nome é recusado (o front nunca manda texto livre aqui).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind { Gerar, Olhar, Diff }

pub(crate) fn kind_of(k: &str) -> Result<Kind, String> {
    match k.trim() {
        "gerar" => Ok(Kind::Gerar),
        "olhar" => Ok(Kind::Olhar),
        "diff" => Ok(Kind::Diff),
        o => Err(format!("pedido de protótipo desconhecido: {o}")),
    }
}
fn slot(k: Kind) -> &'static std::sync::atomic::AtomicI32 {
    match k { Kind::Gerar => &PROTO_GEN_PID, Kind::Olhar => &PROTO_OLHAR_PID, Kind::Diff => &PROTO_DIFF_PID }
}
/// Marcador de "parado" (o front casa o sufixo _STOPPED e não mostra erro).
pub(crate) fn stop_marker(k: Kind) -> &'static str {
    match k { Kind::Gerar => "PROTO_GEN_STOPPED", Kind::Olhar => "PROTO_OLHAR_STOPPED", Kind::Diff => "PROTO_DIFF_STOPPED" }
}
/// Evento das linhas "o que a IA está fazendo" ({ line }).
pub(crate) fn activity_event(k: Kind) -> &'static str {
    match k { Kind::Gerar => "proto-ai-activity-gerar", Kind::Olhar => "proto-ai-activity-olhar", Kind::Diff => "proto-ai-activity-diff" }
}
/// Ferramentas permitidas no Claude: só leitura (ler o código, as telas e os PNGs anexados; git só de consulta).
pub(crate) const PROTO_TOOLS: &str = "Read,Grep,Glob,LS,Bash(git log:*),Bash(git show:*),Bash(git status:*)";

const SYS_BASE: &str = "Você trabalha no PROTÓTIPO do Starfork: telas em HTML+CSS que servem de REFERÊNCIA visual antes do código (não são o código do app). Regras que valem sempre: (1) SÓ LEITURA — você pode e deve ler o projeto (Read/Grep/Glob/LS) pra copiar o visual que já existe (cores, fontes, espaçamentos, componentes, textos), as regras do time (CLAUDE.md, AGENTS.md, .claude/skills, .cardume/policy.json, docs de design) e as imagens PNG citadas no pedido; NUNCA edite arquivos nem rode comandos que mudem algo. Leia com parcimônia: poucas leituras direcionadas. (2) HTML sem <script>, sem atributos on*, sem javascript:, sem <iframe>/<object>/<embed>, sem fontes ou imagens de fora (use cores e formas; imagem só se o pedido citar um arquivo de assets/). (3) Cada bloco editável tem data-blk=\"nome-curto\" (minúsculas, hífen) — o mesmo nome nas duas telas quando é o mesmo bloco. (4) Acessibilidade: contraste de texto ≥ 4,5:1, alvo de toque ≥ 44px no celular, todo campo com rótulo, botões com texto. (5) Português do Brasil nos textos da tela. (6) Responda SOMENTE com UM bloco ```json no formato pedido — nada fora dele.";

const SYS_GERAR: &str = "TAREFA: desenhar a 1ª versão da tela descrita. Devolva {\"title\":\"nome curto da tela\",\"notes\":\"1 frase: o que você aproveitou do projeto\",\"screens\":[{\"id\":\"desk\",\"name\":\"Desktop · 1280\",\"w\":1280,\"h\":840,\"html\":\"…\",\"css\":\"…\"},{\"id\":\"cel\",\"name\":\"Celular · 390\",\"w\":390,\"h\":844,\"html\":\"…\",\"css\":\"…\"}]}. O html é o CONTEÚDO do <body> (sem <html>/<head>/<body>); o css vale só pra aquela tela.";
const SYS_OLHAR: &str = "TAREFA: revisar o protótipo pelos COMENTÁRIOS abertos (cada um com tela, posição, alvo, seletor e um recorte PNG) e, se pedido, fazer a CRÍTICA DE DESIGN. Proponha UMA correção por comentário (e uma por problema da crítica), mexendo SÓ no bloco necessário. Devolva {\"propostas\":[{\"pinId\":1,\"titulo\":\"verbo + o quê (curto)\",\"explicacao\":\"1-2 frases com o porquê (cite o número: ex. contraste 1,6:1 → 5,4:1)\",\"blk\":\"nome do data-blk alterado\",\"screen\":\"desk\"|\"cel\"|null,\"html\":\"o NOVO outerHTML do bloco, com o mesmo data-blk\",\"css\":\"regras novas ou trocadas (pode ser vazio)\"}]}. pinId é o id do comentário; null na crítica. screen null = o bloco muda nas duas telas. Comentário que não pede mudança visual: proposta com html vazio e a resposta na explicacao. Nada de proposta sem comentário ou problema real.";
const SYS_DIFF: &str = "TAREFA: comparar a PRÉVIA REAL da tarefa (print citado no pedido e o código da branch, que você pode ler) com a TELA DO PROTÓTIPO aprovado (HTML+CSS e print citados). Liste só diferenças que importam pra quem pediu (conteúdo, estado, hierarquia, cor/contraste, tamanho de alvo, ordem) — não pixel a pixel. Devolva {\"iguais\":N,\"diffs\":[{\"titulo\":\"curto\",\"detalhe\":\"o que o protótipo tem e a Prévia não (ou o contrário)\",\"blk\":\"data-blk do protótipo ou null\"}]}. Sem diferenças: diffs vazio.";

/// System prompt da conversa (sem o "quem fala"/memória/estilo — isso entra em `proto_sys`).
pub(crate) fn sys_for(k: Kind) -> String {
    let t = match k { Kind::Gerar => SYS_GERAR, Kind::Olhar => SYS_OLHAR, Kind::Diff => SYS_DIFF };
    format!("{SYS_BASE}\n\n{t}")
}
/// Instruções + QUEM ESTÁ FALANDO + cérebro do projeto (Padrões do time). O estilo de resposta do chat NÃO entra:
/// a saída aqui é JSON pra máquina.
fn proto_sys(k: Kind, repo: &Path, prompt: &str) -> String { memoria::with_memory(&sys_for(k), repo, prompt) }

/// Uma rodada da IA do protótipo. `repo` = pasta onde a IA lê (o projeto; no "diff", a worktree da tarefa).
/// Devolve { text, sessionId } como os outros chats — o front lê o JSON de `text`.
#[tauri::command(async)]
pub fn proto_ai(app: tauri::AppHandle, state: State<AppState>, kind: String, prompt: String, repo: Option<String>, model: Option<String>) -> Result<AiChat, String> {
    chat_logged("proto_ai", proto_ai_inner(app, state, kind, prompt, repo, model))
}
fn proto_ai_inner(app: tauri::AppHandle, state: State<AppState>, kind: String, prompt: String, repo: Option<String>, model: Option<String>) -> Result<AiChat, String> {
    let k = kind_of(&kind)?;
    if prompt.trim().is_empty() { return Err("pedido vazio pra IA do protótipo".into()); }
    let repo = chat_repo(&state, repo)?;
    let sys = proto_sys(k, &repo, &prompt);
    let eng = chat_pick(&None).map_err(|e| repo_acesso::step("escolher a IA", e))?;
    if eng != ai_once::AiEngine::Claude {
        return chat_other(PROTO_SOURCE, eng, &sys, &prompt, &None, &repo, 600, ChatStop::Slot(slot(k)), stop_marker(k), &emit_activity(&app, activity_event(k)));
    }
    let mut args: Vec<String> = vec![
        "-p".into(), prompt,
        "--output-format".into(), "stream-json".into(), "--verbose".into(),
        "--append-system-prompt".into(), sys,
        "--allowedTools".into(), PROTO_TOOLS.into(),
    ];
    // bypass não respeita o --allowedTools (só as negações valem) → modo protegido do repo, como o planner
    args.extend(crate::protect_args_repo(&repo));
    // sem isto o harness nega ler os PNGs dos recortes
    args.push("--permission-mode".into());
    args.push("bypassPermissions".into());
    push_model(&mut args, &model);
    let mut cmd = claude_cmd(&claude_bin());
    cmd.args(&args).current_dir(&repo);
    run_claude_stream(&app, cmd, slot(k), stop_marker(k), 600, activity_event(k), usage_ledger::Tag::new(PROTO_SOURCE, &repo, &model, &None))
}

/// PARA a rodada em andamento daquela conversa (gerar/olhar/diff).
#[tauri::command(async)]
pub fn proto_ai_stop(kind: String) -> Result<bool, String> { Ok(stop_slot(slot(kind_of(&kind)?))) }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn so_tres_conversas_e_cada_uma_com_slot_marcador_e_evento_proprios() {
        assert_eq!(kind_of("gerar").unwrap(), Kind::Gerar);
        assert_eq!(kind_of(" olhar ").unwrap(), Kind::Olhar);
        assert_eq!(kind_of("diff").unwrap(), Kind::Diff);
        assert!(kind_of("rm -rf").is_err());
        let ks = [Kind::Gerar, Kind::Olhar, Kind::Diff];
        for (i, a) in ks.iter().enumerate() {
            assert!(stop_marker(*a).ends_with("_STOPPED"), "o front casa o sufixo _STOPPED");
            assert!(activity_event(*a).starts_with("proto-ai-activity-"));
            for b in &ks[i + 1..] {
                assert!(!std::ptr::eq(slot(*a), slot(*b)), "parar um não derruba o outro");
                assert_ne!(stop_marker(*a), stop_marker(*b));
            }
        }
    }

    #[test]
    fn so_leitura_e_json_em_toda_conversa() {
        assert!(!PROTO_TOOLS.contains("Edit") && !PROTO_TOOLS.contains("Write") && !PROTO_TOOLS.contains("Bash(*") && !PROTO_TOOLS.contains("Bash(git push"));
        for k in [Kind::Gerar, Kind::Olhar, Kind::Diff] {
            let s = sys_for(k);
            assert!(s.contains("SÓ LEITURA") && s.contains("```json"), "{k:?}");
            assert!(s.contains("sem <script>") && s.contains("data-blk"), "{k:?}");
        }
        assert!(sys_for(Kind::Gerar).contains("\"desk\"") && sys_for(Kind::Gerar).contains("\"cel\""));
        assert!(sys_for(Kind::Olhar).contains("pinId") && sys_for(Kind::Olhar).contains("CRÍTICA"));
        assert!(sys_for(Kind::Diff).contains("diffs"));
    }

    #[test]
    fn prototipo_conta_no_medidor_com_nome_proprio() {
        assert!(usage_ledger::SOURCES.contains(&PROTO_SOURCE), "sem isto a rodada vira 'outros'");
    }
}
