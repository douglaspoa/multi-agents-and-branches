// Publica o Constellation-portable.zip no canal de releases (bucket privado).
// Credenciais do OWNER via env: CONSTELLATION_EMAIL / CONSTELLATION_PASSWORD.
// Uso: node scripts/publish-release.mjs [notas da versão]
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const U = 'https://fivoakrhazlzcdoocgbg.supabase.co';
const K = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZpdm9ha3JoYXpsemNkb29jZ2JnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgwMjcxOTcsImV4cCI6MjEwMzYwMzE5N30.NXr1RjGqhcYHfMU050PRBcBraXsAYw-4FUVyoo3RC8U';
const email = process.env.CONSTELLATION_EMAIL, pass = process.env.CONSTELLATION_PASSWORD;
if (!email || !pass) { console.error('defina CONSTELLATION_EMAIL e CONSTELLATION_PASSWORD (conta owner)'); process.exit(1); }

const login = await fetch(`${U}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: K, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pass }) }).then(r => r.json());
if (!login.access_token) { console.error('login falhou:', login.msg || login.error_description); process.exit(1); }
const H = { apikey: K, Authorization: 'Bearer ' + login.access_token };

const zipPath = fileURLToPath(new URL('../dist/Constellation-portable.zip', import.meta.url));
const binPath = fileURLToPath(new URL('../dist/Constellation-portable.app/Contents/MacOS/Constellation', import.meta.url));
const buildMs = Math.floor(statSync(binPath).mtimeMs);
const zip = readFileSync(zipPath);

const up = await fetch(`${U}/storage/v1/object/releases/Constellation-portable.zip`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/zip', 'x-upsert': 'true' }, body: zip });
if (!up.ok) { console.error('upload do zip falhou:', await up.text()); process.exit(1); }

const d = new Date(buildMs);
const version = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const meta = { buildMs, version, file: 'Constellation-portable.zip', size: zip.length, notes: process.argv.slice(2).join(' ') || 'Melhorias e correções.', publishedAt: new Date().toISOString() };
const mj = await fetch(`${U}/storage/v1/object/releases/latest.json`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', 'x-upsert': 'true' }, body: JSON.stringify(meta) });
if (!mj.ok) { console.error('latest.json falhou:', await mj.text()); process.exit(1); }
console.log(`✔ release publicada: build ${version} · ${(zip.length / 1048576).toFixed(1)} MB — os apps mostram "⬆ atualizar" em até 6h (ou no próximo boot).`);
