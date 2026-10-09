// NOVA DEMANDA FORMATADA (09/10: "na parte de criar uma nova tarefa o texto está vindo cru"): markdown de IA/issue
// aparece formatado em todo o fluxo de criar demanda, SEMPRE pelo mdToHtml (fonte única, escapa tudo), e a resposta do
// planner com ``` dentro do JSON não vaza mais crua no chat. `node --test app/tests/nova-demanda-formatada.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };
const fnOf = (src, name) => { const i = src.indexOf('function ' + name + '('); assert.ok(i >= 0, name); let d = 0; for (let k = src.indexOf('{', i); k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && !--d) return src.slice(i, k + 1); } };
const kb = read('js/23-kanban-artefatos-editor.js');
const M = new Function([fnOf(kb, 'mdSafeHref'), fnOf(kb, 'ghHtmlClean'), fnOf(kb, 'mdTidy'), fnOf(kb, 'mdToHtml'), cut(kb, '// @md-puro-inicio', '// @md-puro-fim'), fnOf(kb, 'mdPrevHtml'), fnOf(kb, 'mdPrevWants')].join('\n') +
  '\nreturn { mdTidy, mdToHtml, mdInline, mdListHtml, mdPlain, mdTitle, mdLooks, mdPrevHtml, mdPrevWants };')();
const pl = read('js/32-planner.js');
const plParseReply = new Function(cut(pl, '// @pl-reply-inicio', '// @pl-reply-fim') + '\nreturn plParseReply;')();

const OBJ = 'Hoje o **checkout** quebra.\n\n## Contexto\n- no `Safari`\n- só com cupom *vencido*\n\n1. abrir\n2. pagar\n\n```js\ntotal = a - b\n```\n\nVer [o ticket](https://exemplo.dev/t/1).';

test('mdToHtml (fonte única) formata o objetivo: título, listas, código em mono, link seguro', () => {
  const h = M.mdToHtml(OBJ);
  assert.match(h, /<strong>checkout<\/strong>/); assert.match(h, /<h2>Contexto<\/h2>/);
  assert.match(h, /<ul><li>no <code>Safari<\/code><\/li><li>só com cupom <em>vencido<\/em><\/li><\/ul>/);
  assert.match(h, /<ol><li>abrir<\/li><li>pagar<\/li><\/ol>/); assert.match(h, /<pre class="mdcode"><code>total = a - b<\/code><\/pre>/);
  assert.match(h, /data-exthref="https:\/\/exemplo.dev\/t\/1"/);
  assert.ok(!/\*\*|`|## /.test(h.replace(/<pre[\s\S]*?<\/pre>/g, '')), 'nada de marcação crua');
});

test('mdTidy: \\n literal (JSON escapado 2x) vira quebra; cerca ```markdown some; texto normal fica igual', () => {
  assert.equal(M.mdTidy('a\\n\\n- b\\n- c'), 'a\n\n- b\n- c');
  assert.match(M.mdToHtml('**Oi**\\n\\n- um\\n- dois'), /<p><strong>Oi<\/strong><\/p><ul><li>um<\/li><li>dois<\/li><\/ul>/);
  assert.equal(M.mdTidy('use `\\n` pra quebrar'), 'use `\\n` pra quebrar', 'um \\n citado não é tocado');
  assert.equal(M.mdTidy('linha\ncom \\n e \\n'), 'linha\ncom \\n e \\n', 'com quebra de verdade não mexe');
  for (const s of ['abra C:\\new\\notes\\x.txt', 'troque \\r\\n por \\n no CSV', 'o "\\n" e o "\\t" no printf']) assert.equal(M.mdTidy(s), s, 'não é markdown escapado: ' + s);
  assert.equal(M.mdTidy('```markdown\n# T\n- a\n```'), '# T\n- a');
  assert.match(M.mdToHtml('```js\nx\n```'), /mdcode/, 'cerca de código de verdade continua código');
});

test('mdInline: uma linha sem <p>, sem o marcador do começo; várias linhas viram bloco', () => {
  assert.equal(M.mdInline('**Total** recalcula'), '<strong>Total</strong> recalcula');
  assert.equal(M.mdInline('- botão `Pagar` visível'), 'botão <code>Pagar</code> visível');
  assert.equal(M.mdInline('1. mensagem *clara*'), 'mensagem <em>clara</em>');
  assert.equal(M.mdInline('## título'), 'título');
  assert.equal(M.mdInline('a\n- b\n- **c**'), 'a<br>b<br><strong>c</strong>', 'várias linhas num lugar de uma: <br>, nunca <p>/<ul> dentro de <span>');
});

test('mdListHtml: requisitos viram <ul>, cada um em uma linha, sem marcador duplicado', () => {
  assert.equal(M.mdListHtml(['**A**', '- b', '2. c', '', 'd\ne']), '<ul><li><strong>A</strong></li><li>b</li><li>c</li><li>d e</li></ul>');
  assert.equal(M.mdListHtml([]), '');
});

test('mdPlain: resumo de uma linha / título / chip sem marcação (o chamador ainda escapa)', () => {
  assert.equal(M.mdPlain('Corrigir **checkout** com `cupom`'), 'Corrigir checkout com cupom');
  assert.equal(M.mdPlain('Oi.\n\n## Contexto\n- um\n- dois'), 'Oi. Contexto • um • dois');
  assert.equal(M.mdPlain('- só um item'), 'só um item');
  assert.equal(M.mdPlain('a < b & "c"'), 'a < b & "c"', 'entidades voltam a texto (o esc() do chamador cuida)');
});

test('mdTitle: título vira nome de branch/cartão — tira só **, crase e #; não é resumo', () => {
  assert.equal(M.mdTitle('Corrigir **checkout** com `cupom`'), 'Corrigir checkout com cupom');
  assert.equal(M.mdTitle('## Painel novo'), 'Painel novo');
  for (const t of ['Calcular 2*3*4 no total', 'Usar <div> no card', '1. Configurar CI', '3) Ajustar X', 'snake_case_nome']) assert.equal(M.mdTitle(t), t, t);
  assert.equal(M.mdTitle('**'), '**', 'só marcação: não fica vazio');
});

test('XSS: texto de agente/issue nunca vira HTML ativo — em nenhum derivado', () => {
  const evil = 'oi <img src=x onerror=alert(1)> <script>alert(2)</script> [x](javascript:alert(3)) "aspas"';
  for (const f of ['mdToHtml', 'mdInline']) { const h = M[f](evil); assert.ok(!/<script|<img|onerror=|javascript:/i.test(h.replace(/&lt;[^&]*&gt;/g, '')), f + ': ' + h); assert.ok(!/href="javascript/i.test(h)); }
  assert.ok(!/<script/.test(M.mdListHtml([evil])));
  assert.ok(!/<script/.test(M.mdPrevHtml('list', evil + '\nb')) && !/<script/.test(M.mdPrevHtml('', evil)));
});

test('mdLooks / mdPrevWants: prévia só quando há o que formatar (campo vazio ou frase simples continua campo)', () => {
  for (const s of ['**a**', '- a', '1. a', '## a', 'x `y`', '[t](https://a.b)', '```\nx\n```', 'um *dois*']) assert.ok(M.mdLooks(s), s);
  for (const s of ['frase simples', '2*3*4', 'snake_case_nome', 'R$ 5,00 - desconto', '']) assert.ok(!M.mdLooks(s), s);
  assert.ok(!M.mdPrevWants('', '  ')); assert.ok(!M.mdPrevWants('', 'log linha 1\n  at foo (x.js:2)'), 'texto puro (log) continua no campo, com as quebras');
  assert.ok(!M.mdPrevWants('inline', 'texto simples')); assert.ok(M.mdPrevWants('inline', 'botão `Pagar`'));
  assert.ok(M.mdPrevWants('list', 'a\nb'), 'lista vira <ul> mesmo sem marcação');
});

test('plParseReply: JSON com ``` DENTRO (código no objetivo) é lido — antes vazava cru no chat', () => {
  const obj = { say: 'Montei:\n\n- **a**', patch: { objective: 'x\n\n```js\ny\n```' }, asking: 'requirements' };
  const r = plParseReply('```json\n' + JSON.stringify(obj) + '\n```');
  assert.deepEqual(r.obj, obj);
  assert.deepEqual(plParseReply('texto antes ' + JSON.stringify(obj) + ' depois').obj, obj, 'JSON sem cerca, cercado de texto');
});

test('plParseReply: JSON seguido de OUTRO bloco de código (exemplo depois) continua lido', () => {
  const r = plParseReply('```json\n{"say":"ok","patch":{"title":"T"}}\n```\n\nExemplo:\n```js\nif(x){y}\n```');
  assert.deepEqual(r.obj, { say: 'ok', patch: { title: 'T' } });
});

test('plParseReply: JSON quebrado → só a fala (nunca {"say":…} cru); texto puro passa inteiro', () => {
  const broken = 'Claro:\n```json\n{"say": "Vou **dividir**:\\n\\n- parte 1", "patch": {"title": "x",}, }\n```';
  const r = plParseReply(broken); assert.equal(r.obj, null); assert.equal(r.say, 'Vou **dividir**:\n\n- parte 1');
  assert.deepEqual(plParseReply('Só texto, **sem** JSON.'), { obj: null, say: 'Só texto, **sem** JSON.' });
  const r2 = plParseReply('```json\n{ quebrado sem say\n```'); assert.equal(r2.obj, null); assert.ok(!/```|\{/.test(r2.say), r2.say);
  const r3 = plParseReply('{"patch":{"title":"x",},}'); assert.equal(r3.obj, null); assert.ok(!/\{|patch/.test(r3.say), 'JSON solto quebrado sem say: ' + r3.say);
  const r4 = plParseReply('Vou dividir assim:\n```json\n{"patch": {"objective":"a\n```js\nb\n```"},}\n```'); assert.equal(r4.say, 'Vou dividir assim:', 'o rabo do JSON não vaza: ' + r4.say);
});

test('plPlanFrom: títulos de etapa e do épico saem sem ** (viram cartão/branch), números e símbolos ficam', () => {
  const plStrs = pl.split('\n').find((l) => l.startsWith('const plStrs='));
  const mk = new Function('plFields', 'mdTitle', [plStrs, 'const PL_PLAN_MAX=20;', fnOf(pl, 'plWaves'), fnOf(pl, 'plSortWaves'), fnOf(pl, 'plPlanFrom')].join('\n') + '\nreturn plPlanFrom;');
  const planFrom = mk({ title: '' }, M.mdTitle);
  const p = planFrom({ epic: 'Checkout **sem** erro', tasks: [{ title: 'Recalcular `total`' }, { title: 'Calcular 2*3*4' }, { title: '3) Ajustar X', after: [0] }] });
  assert.equal(p.epic, 'Checkout sem erro');
  assert.deepEqual(p.tasks.map((t) => t.title).sort(), ['3) Ajustar X', 'Calcular 2*3*4', 'Recalcular total']);
});

test('fiação: os campos e telas do fluxo usam a fonte única (sem esc() cru no texto em markdown)', () => {
  const html = read('index.html');
  for (const id of ['ntObj', 'ntFixObj', 'ntDzObj', 'ntInvObj']) assert.match(html, new RegExp(`id="${id}" data-mdprev`), id + ' com prévia');
  const form = read('js/31-nova-demanda-form.js');
  assert.match(form, /mdPrevSync\(\$id\('ntOverlay'\)\)/); assert.match(form, /const li=a=>\{ const h=mdListHtml\(a\)/); assert.ok(!/<div>• \$\{esc\(x\)\}<\/div>/.test(form));
  assert.match(read('js/30-anexos.js'), /plmsg you chatmsg"><div class="plbub">\$\{mdToHtml\(t\)\}/);
  assert.match(read('js/30-anexos.js'), /data-li="\$\{i\}" data-mdprev="inline"/);
  assert.match(pl, /data-fk="\$\{f\.k\}" data-mdprev rows/); assert.match(pl, /'☐ '\+mdInline\(r\)/); assert.match(pl, /class="ppobj mdlite">\$\{mdToHtml\(x\.objective\)\}/);
  assert.match(pl, /const rep=plParseReply\(r\.text\|\|''\), obj=rep\.obj;/); assert.ok(!/text:r\.text\|\|'\(sem resposta\)'/.test(pl), 'fallback não manda o texto cru');
  for (const [f, re] of [['js/27-entregas.js', /class="en-obj mdlite">\$\{mdToHtml\(t\.objective\)\}/], ['js/45-entrega-time.js', /class="en-obj mdlite">\$\{mdToHtml\(sp\.objective\)\}/],
    ['js/46-epico-time.js', /class="en-obj mdlite">\$\{mdToHtml\(sp\.outcome\)\}/], ['js/43-espaco-times.js', /id="ctObj" data-mdprev/], ['js/43-espaco-times.js', /const obj=mdPlain\(/]]) assert.match(read(f), re, f);
});
