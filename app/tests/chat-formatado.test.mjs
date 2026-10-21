// CHAT FORMATADO (21/10, pedido de usuário: "no chat de Nova demanda, a resposta vir mais formatada em markdown, estilo
// Claude… às vezes vêm textos gigantescos e sem formatação" + "testar o padrão da aviação: frases curtas e diretas").
// 1) mdToHtml (fonte única) aguenta o markdown que a IA manda — inclusive pela METADE (streaming) — sem quebrar o layout
//    e sem HTML ativo; 2) o estilo das respostas (Normal × Curto e direto) é uma preferência com chip no chat e em Ajustes,
//    que o Rust põe no prompt SÓ dos chats de conversa. `node --test app/tests/chat-formatado.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };
const fnOf = (src, name) => { const i = src.indexOf('function ' + name + '('); assert.ok(i >= 0, name); let d = 0; for (let k = src.indexOf('{', i); k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && !--d) return src.slice(i, k + 1); } };
const kb = read('js/23-kanban-artefatos-editor.js');
// só as 3 funções (como os testes antigos extraem): tudo o que é novo mora DENTRO do mdToHtml
const mdToHtml = new Function([fnOf(kb, 'mdSafeHref'), fnOf(kb, 'ghHtmlClean'), fnOf(kb, 'mdToHtml')].join('\n') + '\nreturn mdToHtml;')();
const prefs = read('js/12-chat-prefs-daily.js');
const S = new Function(cut(prefs, 'const CHAT_STYLES=', '// @estilo-puro-inicio') + cut(prefs, '// @estilo-puro-inicio', '// @estilo-puro-fim') +
  '\nreturn { CHAT_STYLES, chatStyleOf, chatStyleLabel, chatStyleChipHtml, chatStylePopHtml };')();

// HTML bem formado: toda tag abre/fecha na ordem, só tags do renderer, nenhum "<" cru de texto
const ALLOWED = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'pre', 'code', 'strong', 'em', 'del', 'a', 'blockquote', 'hr', 'br', 'div', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span']);
function wellFormed(h) {
  const st = [];
  for (const m of h.matchAll(/<(\/?)([a-z0-9]+)([^>]*)>/g)) {
    const [, close, tag] = m;
    if (!ALLOWED.has(tag)) return 'tag estranha: ' + m[0];
    if (/\son\w+=/i.test(m[3])) return 'atributo de evento: ' + m[0];
    if (tag === 'br' || tag === 'hr') continue;
    if (close) { if (st.pop() !== tag) return 'fecha fora de ordem: </' + tag + '> em ' + h; } else st.push(tag);
  }
  if (st.length) return 'ficou aberto: ' + st.join(',');
  if (/<(?![a-z/])/.test(h)) return '"<" cru no html';
  return '';
}

// a resposta longa (fictícia, loja) do harness — título, lista aninhada, numerada com código no meio, tabela, citação
const LOJA = `**Resumo:** o checkout da Loja Aurora perde pedidos quando o cupom expira no meio do pagamento.

## O que encontrei
- O cupom é validado **duas vezes**:
  - no carrinho (\`cart/coupon.ts:42\`)
  - no pagamento, já com o cupom vencido
- O erro não aparece pra pessoa — o botão só para de responder.

## Como corrigir
1. Validar o cupom uma vez só, no carrinho:
   \`\`\`ts
   const ok = await validarCupom(carrinho.cupom, agora);
   \`\`\`
2. Guardar o desconto no pedido (\`order.discount\`).

3. Mostrar a mensagem *"cupom expirou"* com o total novo.

| Opção | Esforço | Risco |
|---|---|---|
| Validar só no carrinho | baixo | baixo |
| Renovar o cupom | médio | alto |

> Dica: teste com um cupom que vence em 1 minuto.

---
Quer que eu monte a tarefa? Veja https://loja.exemplo.dev/checkout.`;

test('lista ANINHADA pelo recuo (sublista dentro do item, não lista solta)', () => {
  assert.equal(mdToHtml('- a\n  - a1\n  - a2\n    1. x\n- b'), '<ul><li>a<ul><li>a1</li><li>a2<ol><li>x</li></ol></li></ul></li><li>b</li></ul>');
  assert.equal(mdToHtml('- [ ] fazer\n- [x] feito').replace(/<span[^>]*>/g, '<s>').replace(/<\/span>/g, '</s>'), '<ul><li><s>☐</s> fazer</li><li><s>☑</s> feito</li></ul>');
});

test('numerada: linha em branco e código no meio NÃO reiniciam em 1', () => {
  assert.equal(mdToHtml('1. um\n\n2. dois\n\n3. três'), '<ol><li>um</li><li>dois</li><li>três</li></ol>');
  assert.equal(mdToHtml('1. Rode:\n   ```bash\n   npm i\n   ```\n2. Depois'), '<ol><li>Rode:<pre class="mdcode"><code>npm i</code></pre></li><li>Depois</li></ol>');
  assert.match(mdToHtml('texto\n\n3. continua do 3'), /<ol start="3"><li>continua do 3<\/li><\/ol>/, 'número inicial respeitado');
});

test('código: bloco em <pre> com o texto intacto; inline protegido (nada de *itálico* dentro de `código`)', () => {
  assert.equal(mdToHtml('```js\nif (a < b && c) x = "y" * 2;\n```'), '<pre class="mdcode"><code>if (a &lt; b &amp;&amp; c) x = &quot;y&quot; * 2;</code></pre>');
  assert.equal(mdToHtml('use `a*b*c` e **isso**'), '<p>use <code>a*b*c</code> e <strong>isso</strong></p>');
  assert.equal(mdToHtml('`[x](https://a.b)`'), '<p><code>[x](https://a.b)</code></p>', 'link dentro de código fica texto');
});

test('tabela, citação, separador, link solto e quebra forçada', () => {
  const h = mdToHtml(LOJA);
  assert.equal(wellFormed(h), '');
  assert.match(h, /<h2>O que encontrei<\/h2><ul><li>O cupom é validado <strong>duas vezes<\/strong>:<ul><li>no carrinho \(<code>cart\/coupon.ts:42<\/code>\)<\/li>/);
  assert.match(h, /<ol><li>Validar o cupom uma vez só, no carrinho:<pre class="mdcode"><code>const ok = await validarCupom\(carrinho.cupom, agora\);<\/code><\/pre><\/li><li>Guardar o desconto/);
  assert.match(h, /<li>Mostrar a mensagem <em>&quot;cupom expirou&quot;<\/em> com o total novo.<\/li><\/ol>/, 'o 3 segue na MESMA lista');
  assert.match(h, /<table class="mdtable"><thead><tr><th>Opção<\/th><th>Esforço<\/th><th>Risco<\/th><\/tr><\/thead><tbody><tr><td>Validar só no carrinho<\/td>/);
  assert.match(h, /<blockquote><p>Dica: teste com um cupom que vence em 1 minuto.<\/p><\/blockquote><hr>/);
  assert.match(h, /<a href="https:\/\/loja.exemplo.dev\/checkout" data-exthref="https:\/\/loja.exemplo.dev\/checkout" rel="noreferrer">https:\/\/loja.exemplo.dev\/checkout<\/a>\.<\/p>$/, 'o ponto final fica fora do link');
  assert.equal(mdToHtml('linha um  \nlinha dois'), '<p>linha um<br>linha dois</p>');
  assert.equal(mdToHtml('~~velho~~ novo'), '<p><del>velho</del> novo</p>');
});

test('STREAMING: cada pedaço da resposta (caractere a caractere) vira HTML bem formado, sem marcação crua no fim', () => {
  for (let n = 1; n <= LOJA.length; n++) {
    const h = mdToHtml(LOJA.slice(0, n));
    const bad = wellFormed(h); assert.equal(bad, '', `prefixo ${n}: ${bad}\n${JSON.stringify(LOJA.slice(0, n))}`);
  }
  // os casos que "piscavam": ** sem par, ``` aberto, cabeçalho de tabela esperando o separador, marcador sem texto
  assert.equal(mdToHtml('o total **ficou nega'), '<p>o total <strong>ficou nega</strong></p>');
  assert.equal(mdToHtml('rode `npm te'), '<p>rode <code>npm te</code></p>');
  assert.equal(mdToHtml('veja:\n```ts\nconst a = 1;'), '<p>veja:</p><pre class="mdcode"><code>const a = 1;</code></pre>');
  assert.match(mdToHtml('| Opção | Esforço |'), /^<div class="mdtablew"><table class="mdtable"><thead><tr><th>Opção<\/th><th>Esforço<\/th><\/tr><\/thead><tbody><\/tbody><\/table><\/div>$/);
  assert.match(mdToHtml('| Opção | Esforço |\n|---|--'), /<thead><tr><th>Opção<\/th>/);
  assert.match(mdToHtml('| a | b |\n|---|---|\n| 1 | 2'), /<tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody>/, 'a linha que está chegando já é linha da tabela');
  assert.equal(mdToHtml('- um\n- '), '<ul><li>um</li></ul>', 'marcador sem texto ainda não vira item vazio nem parágrafo "-"');
  assert.equal(mdToHtml('## Título\n\n#'), '<h2>Título</h2>');
  // a resposta COMPLETA não muda por causa do fecho de streaming: ** com par segue igual
  assert.equal(mdToHtml('**a** e **b**'), '<p><strong>a</strong> e <strong>b</strong></p>');
});

test('HTML malicioso da IA/issue é escapado em todo bloco novo (lista aninhada, citação, tabela, código, link solto)', () => {
  const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const docs = [
    '- a\n  - ' + evil, '> ' + evil + '\n> **b**', '| h |\n|---|\n| ' + evil + ' |', '```\n' + evil + '\n```', '`' + evil + '`',
    'https://x.dev/a"onmouseover="alert(1)', '[x](javascript:alert(3)) ' + evil, '1. ' + evil + '\n\n   ' + evil, '- [x] ' + evil,
  ];
  for (const d of docs) {
    const h = mdToHtml(d);
    assert.equal(wellFormed(h), '', d + ' → ' + h);
    assert.ok(!/<script|<img|javascript:/i.test(h), d + ' → ' + h);
    assert.ok(!/href="[^"]*"[^>]*onmouseover/i.test(h), 'aspas não saem do href: ' + h);
  }
});

test('estilo das respostas: só "curto" é curto — o resto (vazio, lixo, JSON com aspas) é Normal, o PADRÃO', () => {
  assert.deepEqual(S.CHAT_STYLES.map((o) => o.v), ['normal', 'curto']);
  for (const v of [undefined, null, '', 'normal', 'xyz', '"normal"']) assert.equal(S.chatStyleOf(v), 'normal', String(v));
  for (const v of ['curto', 'Curto', ' curto ', '"curto"']) assert.equal(S.chatStyleOf(v), 'curto', v);
  assert.equal(S.chatStyleLabel('curto'), 'Curto e direto');
  assert.match(S.chatStyleChipHtml('normal'), /data-chatstyle-btn[^>]*>.*Respostas:.*<b>Normal<\/b>/);
  assert.match(S.chatStyleChipHtml('curto'), /class="ndchip ccstyle set"/);
  const pop = S.chatStylePopHtml('curto');
  assert.match(pop, /data-chatstyle="normal"[^>]*aria-checked="false"/); assert.match(pop, /class="ndpop-opt on" data-chatstyle="curto"[^>]*aria-checked="true"/);
  assert.match(pop, /estilo aviação/);
});

test('seletor discreto no chat da Nova demanda e nos chats de conversa; e em Ajustes', () => {
  assert.match(fnOf(read('js/32-planner.js'), 'plRenderCtl'), /chatStyleChipHtml\(chatStyleGet\(\)\)/, 'Nova demanda: chip ao lado do "Tipo ▾"');
  for (const [f, id] of [['js/12-chat-prefs-daily.js', 'pcInput'], ['js/14-issues-projeto.js', 'trkNIInput'], ['js/34-orquestrador.js', 'orqChatTa']])
    assert.match(read(f), new RegExp(`chatComposer\\(\\{ input:'${id}'[^\\n]*styleSel:true`), f);
  assert.match(fnOf(read('js/30-anexos.js'), 'chatComposer'), /cfg\.styleSel && typeof chatStyleEnsure==='function'\) chatStyleEnsure\(box\)/);
  const aj = read('js/67-ajustes.js');
  assert.match(aj, /Respostas da IA nos chats/); assert.match(aj, /data-ajstyle="\$\{o\.v\}"/); assert.match(aj, /chatStyleSet\(b\.dataset\.ajstyle\)/);
  // persiste em settings.json (o que o Rust lê) — não só no navegador
  assert.match(fnOf(prefs, 'chatStyleSet'), /invoke\('write_setting',\{ key:'chatStyle', value:c \}\)/);
  assert.match(read('index.html'), /<link rel="stylesheet" href="css\/99-chat-md.css">/);
});

test('prompt: o estilo entra nos 4 chats de CONVERSA e não no agente que codifica', () => {
  const rs = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  const es = readFileSync(new URL('../src-tauri/src/estilo.rs', import.meta.url), 'utf8');
  assert.match(rs, /fn planner_sys\(repo: &Path, prompt: &str\) -> String \{ estilo::with_style\(/, 'Nova demanda');
  assert.match(rs, /fn project_chat_sys\(repo: &Path, prompt: &str\) -> String \{ estilo::with_style\(/, 'chat do projeto');
  assert.equal((rs.match(/let sys = estilo::with_style\(&memoria::with_memory\(&sys, &repo, &prompt\)\);/g) || []).length, 2, 'orquestrador + Nova issue');
  assert.equal((rs.match(/estilo::with_style\(/g) || []).length, 4, 'só esses 4 (nada de estilo no agente/terminal da tarefa)');
  assert.match(es, /pub const SETTING_KEY: &str = "chatStyle";/);
  // as regras do modo curto (o teste Rust confere que o Normal NÃO as leva)
  const curto = cut(es, 'pub const CURTO', 'pub fn block');
  for (const r of ['BLUF', 'primeira frase é a resposta', 'no máximo 5 bullets', 'até 12 palavras', 'sem repetir a pergunta', 'sem elogio', 'sem resumo final', 'numerada e fechada', 'Quer mais detalhe?']) assert.ok(curto.includes(r), r);
  const formato = cut(es, 'pub const FORMATO', 'pub const CURTO');
  assert.ok(formato.includes('markdown bem estruturado') && formato.includes('comece pela conclusão') && !formato.includes('5 bullets'));
});
