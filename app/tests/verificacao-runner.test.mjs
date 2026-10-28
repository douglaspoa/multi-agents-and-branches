// 28/10 · "bun run lint" exit 127 travava a aprovação em loop: ferramenta ausente = "não rodou" (não teste vermelho),
// aprovar pede só confirmação, "usar npm" grava a escolha do projeto, o comando de cada checagem mostra de onde vem
// e o "pedir pro agente corrigir" faz o Starfork rodar de novo sozinho quando o agente termina.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };
const pr = read('js/21-pull-request.js'), en = read('js/27-entregas.js'), vf = read('js/83-verificacao.js'), prefs = read('js/12-chat-prefs-daily.js');

function gateCtx() {
  const ls = {};
  const asked = [];
  const c = {
    ls, asked, logged: [],
    lsGet: (k) => ls[k] ?? '', lsSet: (k, v) => { ls[k] = v; },
    invoke: async (cmd, a) => { if (cmd === 'checks_override_log') c.logged.push(a); if (cmd === 'task_fingerprint') return { fingerprint: 'fp1', head: 'h', dirty: false }; return null; },
    askYes: async (q) => { asked.push(q); return c.answer; }, answer: true,
    humanErr: (e) => ({ msg: String(e) }), toast: () => {}, showErr: () => {}, esc: (s) => String(s), $id: () => null,
    window: {}, Promise, JSON, Date, Object, Set, String,
  };
  vm.createContext(c);
  vm.runInContext(cut(pr, 'const chkCfg={};', '// "aprovar mesmo assim": exige motivo') + '\nthis.chkCfg=chkCfg; this.chkFpC=chkFpC; this.chkGate=chkGate; this.chkCanApprove=chkCanApprove; this.chkCanApproveOrConfirm=chkCanApproveOrConfirm; this.chkMissingConfirm=chkMissingConfirm; this.chkBlockWhy=chkBlockWhy; this.chkMissText=chkMissText;', c);
  return c;
}
const LINT = { id: 'npm:lint', label: 'Linter', cmd: 'bun run lint', on: true };
const TEST = { id: 'npm:test', label: 'Testes', cmd: 'bun run test', on: true };
function seed(c, results) {
  c.chkCfg.t1 = { at: Date.now(), data: { effective: [LINT, TEST], cfg: {} } };
  c.chkFpC.t1 = { at: Date.now(), fp: { fingerprint: 'fp1', head: 'h', dirty: false } };
  c.ls['chk:t1'] = JSON.stringify({ fp: 'fp1', cfgSig: 'npm:lint=bun run lint|npm:test=bun run test', results });
}

test('exit 127 da ferramenta (bun não instalado) é "não rodou", não "falhou" — e aprovar pede só uma confirmação', async () => {
  const c = gateCtx();
  seed(c, [
    { id: 'npm:lint', label: 'Linter', cmd: 'bun run lint', ok: false, exitCode: 127, notFound: 'bun' },
    { id: 'npm:test', label: 'Testes', cmd: 'bun run test', ok: false, exitCode: 127, notFound: 'bun' },
  ]);
  const g = c.chkGate({ id: 't1' });
  assert.equal(g.st, 'missing');
  assert.equal(c.chkCanApprove(g), false, 'não é verde');
  assert.equal(c.chkCanApproveOrConfirm(g), true, 'mas o botão fica clicável');
  assert.match(c.chkMissText(g), /Linter, Testes não rodaram: bun não está instalado neste computador/);
  assert.match(c.chkBlockWhy(g), /só uma confirmação/);
  // recusou: nada muda
  c.answer = false;
  assert.equal(await c.chkMissingConfirm({ id: 't1' }, g), false);
  assert.equal(c.ls['chkOv:t1'], undefined);
  // confirmou: vira "liberada" com o motivo automático (sem digitar nada) e fica registrado
  c.answer = true;
  assert.equal(await c.chkMissingConfirm({ id: 't1' }, g), true);
  assert.equal(c.asked.length, 2);
  const g2 = c.chkGate({ id: 't1' });
  assert.equal(g2.st, 'override');
  assert.equal(g2.was, 'missing');
  assert.match(g2.ov.reason, /não rodou — bun não está instalado/);
  assert.equal(c.chkCanApprove(g2), true);
  assert.deepEqual(c.logged[0].failing, ['Linter', 'Testes']);
});

test('falha de verdade continua bloqueando (com motivo); misturada com "não rodou", vale a falha', () => {
  const c = gateCtx();
  seed(c, [
    { id: 'npm:lint', label: 'Linter', cmd: 'bun run lint', ok: false, exitCode: 1 },
    { id: 'npm:test', label: 'Testes', cmd: 'bun run test', ok: false, exitCode: 127, notFound: 'bun' },
  ]);
  const g = c.chkGate({ id: 't1' });
  assert.equal(g.st, 'fail');
  assert.equal(g.bad.length, 1);
  assert.equal(g.miss.length, 1);
  assert.equal(c.chkCanApproveOrConfirm(g), false);
  seed(c, [{ id: 'npm:lint', label: 'Linter', cmd: 'bun run lint', ok: true, exitCode: 0 }, { id: 'npm:test', label: 'Testes', cmd: 'bun run test', ok: true, exitCode: 0 }]);
  assert.equal(c.chkGate({ id: 't1' }).st, 'pass');
});

test('trocar o comando (usar npm / editar em checagens) deixa o resultado do bun desatualizado → a próxima rodada usa o novo', () => {
  const c = gateCtx();
  seed(c, [{ id: 'npm:lint', label: 'Linter', cmd: 'bun run lint', ok: false, exitCode: 127, notFound: 'bun' }]);
  c.chkCfg.t1.data.effective = [{ ...LINT, cmd: 'npm run lint --silent' }, { ...TEST, cmd: 'npm run test --silent' }];
  assert.equal(c.chkGate({ id: 't1' }).st, 'stale');
  // e o "usar npm" grava a escolha do projeto e roda de novo
  const use = cut(pr, 'async function chkUsePm(t, pm){', '\n}\n');
  assert.match(use, /checks_save',\{ cfg:Object\.assign\(\{\}, cur, \{ pm \}\) \}/);
  assert.match(use, /await chkRun\(t\)/);
});

test('Entrega: "não rodou" mostra usar npm/pnpm (o que existe) + instalar bun, sem "pedir pro agente corrigir" nem motivo longo', () => {
  const h = cut(en, 'function enNaoRodouHtml(g, pmi){', '\n}\n');
  assert.match(h, /\(\(pmi&&pmi\.available\)\|\|\[\]\)\.filter\(p=>!tools\.includes\(p\)\)/);
  assert.match(h, /data-vfpm=/);
  assert.match(h, /id="vfInstall"/);
  assert.match(en, /\$\{g\.st==='fail'\?`<button class="btn sm" id="vfFix"/, '"pedir pro agente corrigir" só com falha de verdade');
  assert.match(en, /!okConfirm && !\['running','loading'\]\.includes\(g\.st\)\?`<button class="btn sm ghost" id="vfOverride"/, 'sem "aprovar mesmo assim…" no "não rodou"');
  assert.match(en, /missing:\['não rodou','warn'\]/);
  // cada checagem diz de onde vem o comando e tem "editar"
  assert.match(en, /<span class="vf-src" title="\$\{escA\(enChkSrcTip\(c\)\)\}">\$\{esc\(enChkSrc\(c\)\)\} · <a class="lnk" data-encfg="1">editar<\/a><\/span>/);
});

test('editor de checagens: comando detectado editável e gerenciador por projeto (valem na próxima rodada)', () => {
  assert.match(prefs, /data-ckcmd="\$\{escA\(x\.id\)\}" value="\$\{escA\(cfg\.cmd\[x\.id\]\|\|x\.cmd\)\}"/);
  assert.match(prefs, /data-ckpm/);
  assert.match(prefs, /if\(v && v!==det\) cfg\.cmd\[id\]=v; else delete cfg\.cmd\[id\];/);
  assert.match(prefs, /if\(el\.value\) cfg\.pm=el\.value; else delete cfg\.pm;/);
});

test('aprovar: toda porta passa pela confirmação do "não rodou" (approveGate → chkApproveClick)', () => {
  const click = cut(pr, 'async function chkApproveClick(t){', '\n}\n');
  assert.match(click, /if\(g\.st==='missing'\)\{ if\(!await chkMissingConfirm\(t, g\)\) return; return prPrepOpen/);
  assert.match(pr, /await chkApproveClick\(t\);/);
  assert.match(pr, /window\.chkMissingConfirm=chkMissingConfirm/);
  // modal "Preparando o PR": "seguir sem essa checagem"
  assert.match(pr, /f\.textContent='seguir sem essa checagem'/);
  // corpo do PR: o que não rodou aparece como "não rodou", não como ✕
  assert.match(pr, /não rodou \(\$\{x\.notFound\} não está instalado neste computador\)/);
});

test('"pedir pro agente corrigir": comando exato + o Starfork roda de novo sozinho quando o agente termina com código novo', () => {
  const c = { Set, String };
  vm.createContext(c);
  vm.runInContext(cut(vf, '// @verif-puro-inicio', '// @verif-puro-fim') + '\nthis.verifFixText=verifFixText; this.verifFixDue=verifFixDue;', c);
  const msg = c.verifFixText([{ label: 'Linter', cmd: 'npm run lint --silent', exitCode: 1, log: 'erro em a.js' }]);
  assert.match(msg, /EXATAMENTE os comandos/);
  assert.match(msg, /Não troque por outro comando por fora/);
  assert.match(msg, /### Linter — `npm run lint --silent` \(exit 1\)/);
  const now = 1_000_000;
  const arm = { fp: 'v1', at: now - 1000 };
  assert.equal(c.verifFixDue(arm, 'running', 'v2', now), 'wait', 'agente trabalhando');
  assert.equal(c.verifFixDue(arm, 'review', 'v1', now), 'wait', 'terminou sem mudar o código: não roda à toa');
  assert.equal(c.verifFixDue(arm, 'review', 'v2', now), 'run');
  assert.equal(c.verifFixDue(arm, 'delivered', 'v2', now), 'run');
  assert.equal(c.verifFixDue({ fp: 'v1', at: 0 }, 'review', 'v2', 13 * 3600e3), 'drop', 'pedido velho expira');
  assert.equal(c.verifFixDue(null, 'review', 'v2', now), 'drop');
  assert.match(en, /verifFixArm\(t\.id, \(f&&f\.fp&&f\.fp\.fingerprint\)\|\|''\)/);
  assert.match(vf, /tickLoop\('verifFixTick', verifFixTick/);
});
