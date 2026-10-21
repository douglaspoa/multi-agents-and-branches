//! ESTILO DAS RESPOSTAS nos chats de CONVERSA do app (21/10, pedido de usuário: "às vezes vêm textos gigantescos e sem
//! formatação" + "testar o padrão da aviação: frases curtas e diretas"). Fonte única do texto que vai pro system prompt de
//! TODOS os chats em que a IA conversa com a pessoa: Nova demanda (planner), chat do projeto, chat do orquestrador e
//! Nova issue. NÃO vale pro agente que codifica nem pro terminal da tarefa.
//!
//! Dois modos, escolhidos pela pessoa (Ajustes › Este computador › Respostas da IA, ou o seletor ao lado da caixa do chat),
//! gravados em ~/.constellation/settings.json na chave `chatStyle` e lidos A CADA mensagem (trocar vale na próxima):
//! - `normal` (PADRÃO, inclusive pra quem acabou de instalar): markdown bem estruturado, conclusão primeiro.
//! - `curto`: o de cima + a fraseologia da aviação (BLUF — o essencial primeiro —, frases curtas, readback, perguntas
//!   fechadas). Não é o padrão porque corta contexto que quem está começando ainda quer ler; a pessoa escolhe.

/// Chave em settings.json (a tela grava com `write_setting`).
pub const SETTING_KEY: &str = "chatStyle";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Estilo { Normal, Curto }

/// Valor gravado → modo. Qualquer coisa que não seja "curto" é Normal (o padrão). PURA.
pub fn parse(raw: &str) -> Estilo {
    match raw.trim().trim_matches('"').to_lowercase().as_str() { "curto" => Estilo::Curto, _ => Estilo::Normal }
}

/// O modo escolhido nesta máquina agora (sem preferência gravada = Normal).
pub fn current() -> Estilo { parse(&crate::setting_get(SETTING_KEY).unwrap_or_default()) }

/// Formato de TODA resposta de conversa (os dois modos).
pub const FORMATO: &str = "## Formato do texto que a pessoa lê\n\
Vale para o que aparece no chat. Quando a resposta for um bloco JSON, vale para o campo de fala (`say`) — o formato JSON pedido acima NÃO muda; dentro do JSON, quebra de linha é \\n. Escreva em markdown bem estruturado:\n\
- comece pela conclusão (a resposta, a decisão ou a pergunta que falta); o contexto vem depois, só se ajudar;\n\
- itens, passos ou opções viram lista (`-` ou `1.`), um por linha; sublista com 2 espaços de recuo;\n\
- título (`##`) só quando a resposta tem duas ou mais partes que ajudam a navegar — nunca em resposta curta;\n\
- parágrafos de até 3 frases, separados por linha em branco: nada de parede de texto;\n\
- **negrito** só no que a pessoa não pode perder; `código` para arquivo, comando, função ou valor; bloco ``` com a linguagem para código de mais de uma linha;\n\
- tabela só para comparar duas ou mais coisas em dois ou mais critérios.\n";

/// Regras extras do modo "Curto e direto (estilo aviação)".
pub const CURTO: &str = "## Modo CURTO E DIRETO (estilo aviação) — escolhido pela pessoa\n\
Fraseologia de cabine: o essencial primeiro (BLUF — bottom line up front), sem enfeite. Regras OBRIGATÓRIAS no texto que a pessoa lê:\n\
1. A primeira frase é a resposta ou a decisão — uma frase só. Se a pessoa deu uma instrução, essa frase é o readback: \"Entendido: …\".\n\
2. Depois, no máximo 5 bullets, cada um com até 12 palavras.\n\
3. Sem introdução, sem repetir a pergunta, sem elogio, sem resumo final, sem despedida.\n\
4. Pergunta à pessoa: numerada e fechada, com as opções (ex.: \"1) Só o checkout · 2) Checkout e carrinho\"), uma por vez.\n\
5. Se houver detalhe útil que ficou de fora, termine com uma linha: \"Quer mais detalhe?\"\n\
Isto não diminui a investigação: leia o código o quanto precisar — só a RESPOSTA é curta.\n";

/// Bloco de estilo pro system prompt. PURA.
pub fn block(e: Estilo) -> String {
    match e { Estilo::Normal => FORMATO.to_string(), Estilo::Curto => format!("{FORMATO}\n{CURTO}") }
}

/// Anexa o estilo (no FIM: a última instrução é a que a IA mais segue) ao system prompt de um chat de conversa.
pub fn with_style_as(sys: &str, e: Estilo) -> String { format!("{sys}\n\n{}", block(e)) }
pub fn with_style(sys: &str) -> String { with_style_as(sys, current()) }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn padrao_e_normal() {
        for v in ["", "normal", "qualquer", "\"normal\"", "null"] { assert_eq!(parse(v), Estilo::Normal, "{v}"); }
        for v in ["curto", "Curto", " curto ", "\"curto\""] { assert_eq!(parse(v), Estilo::Curto, "{v}"); }
    }

    #[test]
    fn normal_pede_markdown_e_nao_as_regras_curtas() {
        let s = with_style_as("SYS", Estilo::Normal);
        assert!(s.starts_with("SYS\n\n"));
        assert!(s.contains("markdown bem estruturado") && s.contains("comece pela conclusão") && s.contains("nada de parede de texto"));
        assert!(s.contains("`say`"), "planner: vale pro campo de fala do JSON");
        assert!(!s.contains("CURTO E DIRETO") && !s.contains("no máximo 5 bullets") && !s.contains("Quer mais detalhe?"));
    }

    #[test]
    fn curto_inclui_as_regras_da_aviacao() {
        let s = with_style_as("SYS", Estilo::Curto);
        assert!(s.contains("markdown bem estruturado"), "o formato vale nos dois modos");
        for r in ["CURTO E DIRETO", "BLUF", "primeira frase é a resposta", "no máximo 5 bullets", "até 12 palavras",
                  "Sem introdução, sem repetir a pergunta, sem elogio, sem resumo final", "numerada e fechada", "Quer mais detalhe?", "readback"] {
            assert!(s.contains(r), "falta: {r}");
        }
        assert!(s.find("## Formato").unwrap() < s.find("## Modo CURTO").unwrap());
    }
}
