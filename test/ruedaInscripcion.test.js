const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'eventos.publicos.js'), 'utf8');
const ruta = SRC.slice(SRC.indexOf("router.post('/slug/:slug/rueda/inscribir'"), SRC.indexOf("/* GET /eventos/publicos/slug/:slug */"));

test('inscribirse en la rueda pide el código de la boleta DE ESE evento', () => {
  assert.ok(ruta.length > 100, 'no está la ruta de inscripción');
  assert.match(ruta, /\.eq\('codigo', cod\)\.eq\('evento_id', evento\.id\)/,
    'sin acotar al evento, un código de otro evento inscribiría a alguien donde no tiene boleta');
  assert.match(ruta, /authLimiter/, 'sin límite, se pueden probar códigos a ciegas');
});

test('el papel sólo puede ser comprador o vendedor, y no se cambia reinscribiéndose', () => {
  assert.match(ruta, /\['comprador', 'vendedor'\]\.includes\(rol\)/);
  assert.match(ruta, /if \(ya\) return res\.json\(\{ ya: true/);
});

test('lo que escribe la persona no toca zona, estado ni evento', () => {
  const m = ruta.match(/const CAMPOS_INSCRIPCION = \[([^\]]+)\]/) || SRC.match(/const CAMPOS_INSCRIPCION = \[([^\]]+)\]/);
  for (const prohibido of ['zona_id', 'evento_id', 'ticket_id', 'activo', 'estado_ficha', 'rol', 'cuota_puntos']) {
    assert.ok(!m[1].includes(`'${prohibido}'`), `${prohibido} no puede venir del formulario público`);
  }
});
