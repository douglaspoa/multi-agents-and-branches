// Helper (não é teste): lê o símbolo Starfork de verdade de 10-core.js, entre // @starfork-inicio e // @starfork-fim.
// Usado por carregamento.test.mjs e identidade.test.mjs — um jeito só de recortar.
import { readFileSync } from 'node:fs';
export function loadStarfork() {
  const core = readFileSync(new URL('../src/js/10-core.js', import.meta.url), 'utf8');
  const i = core.indexOf('// @starfork-inicio'), j = core.indexOf('// @starfork-fim', i);
  if (i < 0 || j < 0) throw new Error('marcadores @starfork-inicio/@starfork-fim não encontrados em 10-core.js');
  return new Function('const IC = {};\n' + core.slice(i, j) + '\nreturn IC;')();
}
