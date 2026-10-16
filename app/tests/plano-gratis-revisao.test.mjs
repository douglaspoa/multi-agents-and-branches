// PLANO GRÁTIS — revisão adversarial da F1: um teste por correção.
// `node --test app/tests/plano-gratis-revisao.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const cut = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, 'trecho não encontrado: ' + from); return src.slice(a, b); };
const onb = read('js/44-onboarding.js');

test('1 · nova senha da recuperação: não herda o "voltar" do entrar, salva → pós-login, voltar → sai da sessão do código', () => {
  assert.match(onb, /if\(ct==='recovery'\)\{ auShow\('newpass',\{ backTo:null, recovering:true \}\); return; \}/);
  const np = cut(onb, 'function auRenderNewpass(', '\n// Tela "pronto"');
  assert.match(np, /if\(au\.backTo && !au\.recovering\)\{/, 'o backTo só vale fora da recuperação (trocar senha em Ajustes)');
  assert.match(np, /au\.recovering=false; au\.backTo=null; await auAfterSession\(\);/);
  assert.match(cut(onb, "bindClick('auBack',", '\n'), /if\(au\.step==='newpass' && au\.recovering\)\{ au\.recovering=false; sbLogout\(\); \}/);
  assert.match(read('js/67-ajustes.js'), /auShow\('newpass', \{ backTo:\(\)=>ajustesOpen\('perfil'\), recovering:false \}\)/);
});

test('7 · userRepoSync: a trava repoSyncBusy roda (estava engolida pelo comentário da guarda do Grátis)', () => {
  const fn = cut(read('js/41-assinatura-chaves.js'), 'async function userRepoSync(){', '\n  try{');
  assert.match(fn, /\n  repoSyncBusy=true;$/, 'a trava fica na própria linha');
  assert.doesNotMatch(fn, /\/\/[^\n]*repoSyncBusy=true/);
  // a varredura do atrap-fabrica agora pega atribuição solta no fim do comentário
  assert.match(readFileSync(new URL('./atrap-fabrica.test.mjs', import.meta.url), 'utf8'), /\(true\|false\|null\|\\d\+\|'\[\^'\]\*'\|\\\[\\\]\|\\\{\\\}\);\\s\*\$/);
});

test('2 · sair/sessão caída zera billingOn e billingKnown (Enterprise que entra depois não cai no local)', () => {
  const nuvem = read('js/40-nuvem-conta.js');
  for (const fn of ['function sbLogout(){', 'function sbSessionEnded(reason){'])
    assert.match(cut(nuvem, fn, '\n}'), /billingOn=false; billingKnown=false;/, fn);
  // efeito: com billingOn=false, billingActive() é true → logado = nuvem até o billingSync decidir
  const ba = new Function('let billingOn=true, myBilling=null;' + cut(read('js/41-assinatura-chaves.js'), 'function billingActive(){', '\n') + ' const a=!!billingActive(); billingOn=false; return [a, !!billingActive()];')();
  assert.deepEqual(ba, [false, true]);
});

test('8 · epicAutoStart é tick com parte local (rascunhos do "Iniciar épico" rodam no Grátis)', () => {
  const ep = read('js/46-epico-time.js');
  assert.match(ep, /tickLoop\('epicAutoStart', epicAutoStartTick, \(\)=>epAutoIdle\?60000:20000, 3000, \{ local:true \}\);/);
  assert.match(cut(ep, 'async function epicAutoStartTick(){', '\n  epAutoBusy=true;'), /epAutoLocalTick\(\);[\s\S]*!cloudScopeOk\(\)\) return;/, 'a parte de nuvem continua guardada');
});

// as funções de chave do 41 num vm: llm.env, arquivo à parte (stash) e cofre falsos
function loadChaves({ owner = '', vault = [], env = '', stash = '', local = false, uid = 'u1', ask = () => true } = {}) {
  const ls = { 'sb:llmEnvOwner': owner }, asks = [], posts = [];
  const st = { env, stash, vault: vault.map((r) => ({ ...r })) };
  const ctx = {
    lsGet: (k) => (k in ls ? ls[k] : null), lsSet: (k, v) => { ls[k] = String(v); }, toast: () => {},
    SB: { sess: () => ({ user: { id: uid, email: 'a@x' } }) }, cloudUserId: () => uid,
    cloudAllowed: () => !local, isLocalSpace: () => local,
    invoke: async (c, a) => {
      if (c === 'read_llm_env') return st.env; if (c === 'write_llm_env') { st.env = a.content; return null; }
      if (c === 'read_llm_env_stash') return st.stash; if (c === 'write_llm_env_stash') { st.stash = a.content; return null; }
      return null;
    },
    sbGet: async () => st.vault.map((r) => ({ ...r })),
    sbFetch: async (path, o) => {
      if (o && o.method === 'POST') { const b = JSON.parse(o.body); (Array.isArray(b) ? b : [b]).forEach((r) => { st.vault = st.vault.filter((x) => x.name !== r.name).concat([{ name: r.name, value: r.value }]); posts.push(r.name); }); }
      if (o && o.method === 'DELETE') { const n = decodeURIComponent(path.split('name=eq.')[1]); st.vault = st.vault.filter((x) => x.name !== n); }
      return null;
    },
    askYes: async (q) => { asks.push(q); return ask(q); },
  };
  vm.createContext(ctx);
  const src = read('js/41-assinatura-chaves.js');
  vm.runInContext('let secretsCache=null;\n' + cut(src, '// @puro-chaves-dono-inicio', '// "Chaves de modelo" saiu da Conta'), ctx);
  return { ctx, st, ls, asks, posts };
}

test('3 · gravar no espaço local marca o dono "-" mesmo se o arquivo era espelho da conta (a volta à nuvem pergunta, não apaga)', async () => {
  const C = loadChaves({ owner: 'u1', env: 'OPENAI_API_KEY=sk-cofre\n', vault: [{ name: 'OPENAI_API_KEY', value: 'sk-cofre' }], local: true });
  await C.ctx.secretSet('DEEPSEEK_API_KEY', 'sk-novo');
  assert.equal(C.ls['sb:llmEnvOwner'], '-');
  C.ctx.cloudAllowed = () => true; C.ctx.isLocalSpace = () => false;
  await C.ctx.secretsSync();
  assert.equal(C.asks.length, 1, 'adopt-local perguntou'); assert.match(C.asks[0], /DEEPSEEK_API_KEY/);
  assert.match(C.st.env, /DEEPSEEK_API_KEY=sk-novo/, 'a chave nova não foi apagada pelo espelho');
  // arquivo de OUTRA conta continua sendo limpo antes de gravar (PR #130)
  const D = loadChaves({ owner: 'u-outra', env: 'X_KEY_OUTRA=1\n', local: true });
  await D.ctx.secretSet('MINHA_KEY', 'v');
  assert.equal(D.st.env, 'MINHA_KEY=v\n');
});

test('4 · remover uma chave mantida só neste computador tira da lista antes do sync (não volta)', async () => {
  const C = loadChaves({ owner: 'u1', env: 'LOCAL_ONLY_KEY=abc\n', vault: [] });
  C.ls['sf:keysKeepLocal:u1'] = JSON.stringify(['LOCAL_ONLY_KEY']);
  await C.ctx.secretDel('LOCAL_ONLY_KEY');
  assert.equal(C.ls['sf:keysKeepLocal:u1'], '[]');
  assert.doesNotMatch(C.st.env, /LOCAL_ONLY_KEY/);
});

test('5 · mesmo nome no cofre: a pergunta avisa, o valor do computador vai pro arquivo à parte e volta no logout', async () => {
  const C = loadChaves({ owner: '-', env: 'DEEPSEEK_API_KEY=sk-pc\nGROQ_API_KEY=sk-g\n', vault: [{ name: 'DEEPSEEK_API_KEY', value: 'sk-conta' }], ask: () => false });
  await C.ctx.secretsSync();
  assert.equal(C.asks.length, 1); assert.match(C.asks[0], /já tem DEEPSEEK_API_KEY: a deste computador será substituída/);
  assert.equal(C.st.stash, 'DEEPSEEK_API_KEY=sk-pc\n', 'guardada à parte (arquivo 600 pelo Rust), nada em localStorage');
  assert.ok(!Object.values(C.ls).some((v) => /sk-pc/.test(v)), 'nenhum segredo no localStorage');
  assert.match(C.st.env, /DEEPSEEK_API_KEY=sk-conta/); assert.match(C.st.env, /GROQ_API_KEY=sk-g/, 'recusou: GROQ fica só aqui');
  assert.deepEqual(C.posts, [], 'recusou: nada subiu');
  await C.ctx.secretsForget();
  assert.equal(C.ls['sb:llmEnvOwner'], '-');
  assert.match(C.st.env, /DEEPSEEK_API_KEY=sk-pc/, 'a do computador voltou'); assert.match(C.st.env, /GROQ_API_KEY=sk-g/);
  assert.doesNotMatch(C.st.env, /sk-conta/, 'a da conta saiu do computador'); assert.equal(C.st.stash, '');
  // pura: só conflita valor DIFERENTE; a junção não duplica nome
  assert.deepEqual([...C.ctx.secretsConflicts('A_KEY=1\nB_KEY=2\n', [{ name: 'A_KEY', value: '1' }, { name: 'B_KEY', value: '9' }])], ['B_KEY=2']);
  assert.deepEqual([...C.ctx.secretsMergeLines(['A_KEY=1'], ['A_KEY=2', 'C_KEY=3'])], ['A_KEY=2', 'C_KEY=3']);
  assert.match(readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8'), /fn write_llm_env_stash\(content: String\)[\s\S]*from_mode\(0o600\)/);
});

test('11 · adopt-local: uma pergunta por conta — syncs concorrentes não empilham e a resposta é reusada', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const C = loadChaves({ owner: '-', env: 'GROQ_API_KEY=sk-g\n', vault: [], ask: () => gate });
  const a = C.ctx.secretsSync(), b = C.ctx.secretsSync(), c = C.ctx.secretsSync();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(C.asks.length, 1, 'só uma pergunta aberta');
  release(true); await Promise.all([a, b, c]);
  assert.deepEqual(C.posts, ['GROQ_API_KEY'], 'subiu uma vez');
  C.ls['sb:llmEnvOwner'] = '-'; C.st.env += 'OUTRA_API_KEY=x\n';
  await C.ctx.secretsSync();
  assert.equal(C.asks.length, 1, 'já respondida: não pergunta de novo nesta sessão');
  // recusou antes: os nomes mantidos só aqui não são perguntados de novo
  const D = loadChaves({ owner: '-', env: 'GROQ_API_KEY=sk-g\n', vault: [], ask: () => false });
  D.ls['sf:keysKeepLocal:u1'] = JSON.stringify(['GROQ_API_KEY']);
  await D.ctx.secretsSync();
  assert.equal(D.asks.length, 0);
});

test('6 · updater público: comando Rust sem URL, --max-time, tamanho do manifesto, codesign e o mesmo time do app em execução', () => {
  const rs = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  const pub = cut(rs, 'fn apply_update_public(size: u64) -> Result<bool, String> {', '\n}\n');
  assert.doesNotMatch(cut(rs, '#[tauri::command(async)]\nfn apply_update_public', '{'), /url/i, 'nenhum parâmetro de URL');
  assert.match(rs, /const UPD_PUB_ZIP: &str = "https:\/\/github\.com\/douglaspoa\/multi-agents-and-branches\/releases\/latest\/download\/Starfork-portable\.zip";/);
  assert.match(pub, /update_download\(&tmp, UPD_PUB_ZIP\)/);
  assert.match(cut(rs, 'fn update_download(', '\n}\n'), /"--max-time", "900"/, 'download com teto (vale pro apply_update com sessão também)');
  assert.ok(pub.indexOf('update_pub_size(zip_len, size)') < pub.indexOf('update_extract('), 'confere o tamanho antes de descompactar');
  assert.match(pub, /\["--verify", "--deep", "--strict"\]/);
  assert.match(pub, /codesign_team\(&new_app\), codesign_team\(&cur_app\)/, 'time lido do bundle em execução, nunca fixo');
  assert.doesNotMatch(pub, /TeamIdentifier=|"[A-Z0-9]{10}"/, 'nenhum time fixo no código');
  assert.ok(pub.indexOf('update_pub_check(') < pub.indexOf('update_swap_relaunch('), 'só troca o app depois das checagens');
  assert.match(pub, /web_log\(format!\("\[atualização pública\] abortada: \{why\}"\)\);[\s\S]*Ok\(false\)/, 'falhou: silêncio + log');
  // apply_update (com sessão) só ganhou o --max-time: mesmo fluxo de download → extrair → trocar
  assert.match(cut(rs, 'fn apply_update(url: String) -> Result<(), String> {', '\n}\n'), /update_download\(&tmp, &url\)\?;\n    let new_app = update_extract\(&tmp, &zip\)\?;\n    update_swap_relaunch\(&tmp, &new_app\)/);
  assert.match(rs, /update_manifest_public,\n\s+apply_update_public,/);
  const upd = read('js/11-ambiente-updater.js');
  assert.match(upd, /const trocou=await invoke\('apply_update_public'/);
  assert.match(upd, /if\(!trocou\)\{ updInfo=null;[^\n]*return; \}/, 'abortou: o botão volta sem toast de erro');
});
