const test = require('node:test');
const assert = require('node:assert');
const { memoriaCorta } = require('../lib/memoriaCorta.js');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'eventos.publicos.js'), 'utf8');

test('la memoria corta caduca y tiene tope', () => {
  const m = memoriaCorta({ ms: 50, max: 2 });
  m.guardar('a', 1); m.guardar('b', 2); m.guardar('c', 3);
  assert.equal(m.leer('a'), undefined, 'al pasar el tope se va el más viejo');
  assert.equal(m.leer('c'), 3);
});

test('con sesión nunca se sirve de memoria', () => {
  const f = SRC.slice(SRC.indexOf('function recordarParaAnonimos'), SRC.indexOf('const paginaPublica'));
  assert.match(f, /if \(req\.headers\.authorization\) return next\(\);/,
    'con sesión (el organizador previsualizando) tiene que leerse fresco');
  assert.match(f, /res\.statusCode === 200/, 'un error no se puede quedar guardado');
});

test('la página del evento sólo se guarda publicada o cancelada, nunca en borrador', () => {
  const r = SRC.slice(SRC.indexOf("router.get('/slug/:slug', recordarParaAnonimos"), SRC.indexOf("router.get('/slug/:slug', recordarParaAnonimos") + 300);
  assert.match(r, /\['publicado', 'cancelado'\]\.includes\(cuerpo\?\.evento\?\.estado\)/);
});
