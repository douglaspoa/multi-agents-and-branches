// Quadro ao vivo — a IA (29/10). Uma conversa só, "desenhar": a IA explica DESENHANDO, com layout livre, devolvendo
// passos de alto nível (caixa, seta, círculo, texto, riscar, marcar…) que o front (87-quadro.js) saneia e desenha traço a
// traço, sincronizado com a fala. Serve pra: explicar como uma tarefa foi resolvida, explicar o que entendeu de uma
// demanda, responder uma pergunta sobre o que a pessoa riscou e REVISAR UM LAYOUT (desenha as mudanças por cima de um print).
// Mesmo caminho do protótipo (prototipo_ia.rs): claude_bin/claude_cmd com o motor escolhido; `chat_other` pros outros
// motores. SÓ LEITURA no repo (o código, a worktree da tarefa, o print de fundo) — nunca edita.
use super::*;

static QUADRO_PID: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

/// Origem no livro de uso (medidor).
pub(crate) const QUADRO_SOURCE: &str = "quadro";

/// A única conversa. Qualquer outro nome é recusado (o front nunca manda texto livre aqui).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind { Desenhar }

pub(crate) fn kind_of(k: &str) -> Result<Kind, String> {
    match k.trim() {
        "desenhar" => Ok(Kind::Desenhar),
        o => Err(format!("pedido de quadro desconhecido: {o}")),
    }
}
fn slot(_k: Kind) -> &'static std::sync::atomic::AtomicI32 { &QUADRO_PID }
/// Marcador de "parado" (o front casa o sufixo _STOPPED e não mostra erro).
pub(crate) fn stop_marker(_k: Kind) -> &'static str { "QUADRO_STOPPED" }
/// Evento das linhas "o que a IA está fazendo" ({ line }).
pub(crate) fn activity_event(_k: Kind) -> &'static str { "quadro-ai-activity-desenhar" }
/// Ferramentas permitidas no Claude: só leitura (o código, a worktree, o print de fundo; git só de consulta).
pub(crate) const QUADRO_TOOLS: &str = "Read,Grep,Glob,LS,Bash(git log:*),Bash(git show:*),Bash(git diff:*),Bash(git status:*)";

const SYS: &str = "Você está num QUADRO BRANCO do Starfork e explica DESENHANDO, ao vivo: cada passo seu vira um traço na tela, na ordem, sincronizado com a sua fala. Regras: (1) SÓ LEITURA — leia o projeto, a worktree da tarefa e as imagens citadas no pedido (Read/Grep/Glob/LS, git só de consulta) com parcimônia; NUNCA edite arquivos nem rode nada que mude algo. (2) O quadro é um viewBox de 1000 de largura por 600 de altura; x cresce pra direita, y pra baixo; tudo dentro dele, com margem de uns 20. Deixe a faixa de baixo (y acima de 540) livre: lá aparece a legenda da fala. (3) LAYOUT LIVRE: não preencha um molde — escolha a forma que melhor explica ESTE assunto (um trilho como o do git, uma linha de montagem com setas, uma balança de prós e contras, um mapa de caixas, antes × depois lado a lado, uma linha do tempo…). (4) Intercale fala e traço: um {\"say\":…} curto (uma frase, até 140 caracteres, português do Brasil, falando com a pessoa) e logo depois os traços daquela frase. No máximo uns 40 passos. (5) Textos curtos no desenho (rótulos de 1 a 5 palavras); tamanho 22 a 32; não sobreponha textos. (6) Cores por NOME: ink (padrão), red (problema/errado), green (solução/certo), blue (destaque/pergunta), mute (secundário); mark é marca-texto amarelo (só no passo mark). (7) Responda SOMENTE com UM bloco ```json — nada fora dele.\n\nFORMATO: {\"title\":\"título curto\",\"steps\":[PASSOS],\"changes\":[\"só na revisão de layout: cada mudança desenhada, em 1 frase imperativa\"]}. PASSOS (um objeto por passo, uma primitiva por objeto; a forma à mão é o app que desenha — você NÃO calcula caminhos SVG):\n{\"say\":\"frase\"}\n{\"box\":[x,y,w,h],\"label\":\"texto dentro (opcional)\",\"color\":\"ink\"}\n{\"arrow\":[x1,y1,x2,y2],\"bend\":0,\"color\":\"red\"}  (bend curva a seta: -80 a 80)\n{\"line\":[x1,y1,x2,y2],\"color\":\"ink\"}\n{\"circle\":[cx,cy,rx,ry],\"color\":\"blue\"}  (circular algo: rx/ry um pouco maiores que a coisa)\n{\"text\":[x,y],\"s\":\"texto\",\"size\":26,\"color\":\"green\"}  (x,y = início da linha de base)\n{\"cross\":[x,y,s]}  (X de riscar, s = meio tamanho)\n{\"check\":[x,y,s]}  (visto de certo)\n{\"mark\":[x,y,w,h]}  (marca-texto atrás de algo)\n{\"dot\":[x,y],\"color\":\"ink\"}\n{\"file\":[x,y,w,h],\"label\":\"nome.csv\",\"color\":\"green\"}  (um arquivo com a ponta dobrada)\n\nSe o pedido trouxer um PRINT DE FUNDO (revisar layout): abra a imagem com Read, desenhe POR CIMA dela no mesmo viewBox (a imagem ocupa 1000×600, centralizada), circule o que está ruim (red), desenhe a proposta (green) e liste cada mudança em changes. Se o pedido trouxer TRAÇOS DA PESSOA + uma PERGUNTA: responda sobre aquele ponto desenhando ALI perto e devolva só os passos NOVOS — eles são ACRESCENTADOS ao que já está no quadro (não repita nem apague o que existe; use espaço livre).";

/// System prompt da conversa (sem o "quem fala"/memória — isso entra em `quadro_sys`).
pub(crate) fn sys_for(_k: Kind) -> String { SYS.to_string() }
/// Instruções + cérebro do projeto (Padrões do time). Saída é JSON pra máquina: sem estilo de resposta do chat.
fn quadro_sys(k: Kind, repo: &Path, prompt: &str) -> String { memoria::with_memory(&sys_for(k), repo, prompt) }

/// Uma rodada da IA do quadro. `repo` = pasta onde a IA lê (a worktree da tarefa ligada, ou o projeto).
/// Devolve { text, sessionId } como os outros chats — o front lê o JSON de `text`.
#[tauri::command(async)]
pub fn quadro_ai(app: tauri::AppHandle, state: State<AppState>, kind: String, prompt: String, repo: Option<String>, model: Option<String>) -> Result<AiChat, String> {
    chat_logged("quadro_ai", quadro_ai_inner(app, state, kind, prompt, repo, model))
}
fn quadro_ai_inner(app: tauri::AppHandle, state: State<AppState>, kind: String, prompt: String, repo: Option<String>, model: Option<String>) -> Result<AiChat, String> {
    let k = kind_of(&kind)?;
    if prompt.trim().is_empty() { return Err("pedido vazio pra IA do quadro".into()); }
    let repo = chat_repo(&state, repo)?;
    let sys = quadro_sys(k, &repo, &prompt);
    let eng = chat_pick(&None).map_err(|e| repo_acesso::step("escolher a IA", e))?;
    if eng != ai_once::AiEngine::Claude {
        return chat_other(QUADRO_SOURCE, eng, &sys, &prompt, &None, &repo, 600, ChatStop::Slot(slot(k)), stop_marker(k), &emit_activity(&app, activity_event(k)));
    }
    let mut args: Vec<String> = vec![
        "-p".into(), prompt,
        "--output-format".into(), "stream-json".into(), "--verbose".into(),
        "--append-system-prompt".into(), sys,
        "--allowedTools".into(), QUADRO_TOOLS.into(),
    ];
    // bypass não respeita o --allowedTools (só as negações valem) → modo protegido do repo, como o protótipo
    args.extend(crate::protect_args_repo(&repo));
    // sem isto o harness nega ler o PNG do fundo
    args.push("--permission-mode".into());
    args.push("bypassPermissions".into());
    push_model(&mut args, &model);
    let mut cmd = claude_cmd(&claude_bin());
    cmd.args(&args).current_dir(&repo);
    run_claude_stream(&app, cmd, slot(k), stop_marker(k), 600, activity_event(k), usage_ledger::Tag::new(QUADRO_SOURCE, &repo, &model, &None))
}

/// PARA a rodada em andamento.
#[tauri::command(async)]
pub fn quadro_ai_stop(kind: String) -> Result<bool, String> { Ok(stop_slot(slot(kind_of(&kind)?))) }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uma_conversa_so_com_marcador_e_evento_proprios() {
        assert_eq!(kind_of("desenhar").unwrap(), Kind::Desenhar);
        assert_eq!(kind_of(" desenhar ").unwrap(), Kind::Desenhar);
        assert!(kind_of("gerar").is_err());
        assert!(kind_of("rm -rf").is_err());
        assert!(stop_marker(Kind::Desenhar).ends_with("_STOPPED"), "o front casa o sufixo _STOPPED");
        assert!(activity_event(Kind::Desenhar).starts_with("quadro-ai-activity-"));
    }

    #[test]
    fn so_leitura_json_e_as_primitivas_descritas() {
        assert!(!QUADRO_TOOLS.contains("Edit") && !QUADRO_TOOLS.contains("Write") && !QUADRO_TOOLS.contains("Bash(*") && !QUADRO_TOOLS.contains("git push"));
        let s = sys_for(Kind::Desenhar);
        assert!(s.contains("SÓ LEITURA") && s.contains("```json"));
        for p in ["\"say\"", "\"box\"", "\"arrow\"", "\"line\"", "\"circle\"", "\"text\"", "\"cross\"", "\"check\"", "\"mark\"", "\"dot\"", "\"file\"", "\"changes\""] {
            assert!(s.contains(p), "primitiva {p} descrita");
        }
        assert!(s.contains("1000") && s.contains("600"), "viewBox");
        assert!(s.contains("LAYOUT LIVRE") && s.contains("40 passos"));
        assert!(s.contains("ACRESCENTADOS"), "resposta à caneta só acrescenta");
        for c in ["ink", "red", "green", "blue", "mute", "mark"] { assert!(s.contains(c), "cor {c}"); }
    }

    #[test]
    fn quadro_conta_no_medidor_com_nome_proprio() {
        assert!(usage_ledger::SOURCES.contains(&QUADRO_SOURCE), "sem isto a rodada vira 'outros'");
    }
}
