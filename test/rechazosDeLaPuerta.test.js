const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'clientes.js'), 'utf8');

/* Las llamadas a `anotarRechazo`, con el motivo de cada una. Desde que la
   función va por argumentos con nombre —hizo falta para los rechazos que NO
   tienen boleta, como un QR ilegible— el motivo se lee así y no por posición. */
const motivosAnotados = () =>
  (SRC.match(/anotarRechazo\(\{[^}]*motivo:\s*'?[a-z_.]+'?/g) || [])
    .map(m => m.match(/motivo:\s*'?([a-z_.]+)/)[1]);

test('los dos «ya fue usada» de la puerta dejan constancia', () => {
  const avisos = SRC.split("error: 'Esta boleta ya fue usada.'").length - 1;
  const anotados = motivosAnotados().filter(m => m === 'ya_usada_hoy').length;
  assert.equal(anotados, avisos, 'un camino que rechaza sin anotarlo vuelve a esconder los repetidos');
});

test('anotar un rechazo no hace esperar a la puerta', () => {
  const f = SRC.slice(SRC.indexOf('function anotarRechazo'), SRC.indexOf('function anotarRechazo') + 600);
  assert.doesNotMatch(f, /await /, 'la puerta contesta en el acto; la constancia va detrás');
  assert.match(f, /from\('puerta_rechazos'\)/, 'va a su tabla, no a ticket_movimientos (el aforo la lee)');
});

test('una boleta vencida también deja constancia, con su motivo', () => {
  assert.ok(motivosAnotados().includes('vencida'));
});

test('los rechazos SIN boleta también se anotan', () => {
  /* Éstos son los que más tiempo cuestan en la fila —hay que teclear,
     preguntar y volver a intentar— y son justo los que no se podían anotar
     cuando la función pedía un `ticket` por delante. Si vuelven a caerse, el
     informe de la puerta enseña una fila tranquila en el rato en que la gente
     estuvo parada. */
  const motivos = motivosAnotados();
  for (const m of ['qr_invalido', 'no_encontrada', 'otro_evento', 'puerta_no_asignada']) {
    assert.ok(motivos.includes(m), `el rechazo «${m}» dejó de anotarse`);
  }
});

test('un rechazo sin boleta no inventa una', () => {
  /* `ticket_id` queda en nulo, que es lo honesto: no se sabe quién era. La
     función lo pone por defecto, así que basta con que esas llamadas no pasen
     un `ticketId` cualquiera para salir del paso. */
  const sinBoleta = SRC.match(/anotarRechazo\(\{ eventoId, motivo: '(?:qr_invalido|no_encontrada|puerta_no_asignada)'[^}]*\}\)/g) || [];
  assert.equal(sinBoleta.length, 3, 'cambió la forma de los rechazos sin boleta');
  for (const llamada of sinBoleta) {
    assert.doesNotMatch(llamada, /ticketId/, 'un rechazo sin boleta no puede atarse a ninguna');
  }
});

test('el informe de rechazos existe, pide permiso y es UNO solo', () => {
  /* Anotarlos y no poder mirarlos es lo que pasó en FESTECH: 159 rechazos
     guardados que nadie podía ver. Y son datos personales —dicen quién
     intentó entrar y cuándo—, así que la ruta pide lo mismo que la lista de
     clientes, no el permiso de estar en la puerta. */
  const rutas = SRC.match(/router\.get\('\/:eventoId\/puerta\/rechazos', exige\(PERMS_CLIENTES\)/g) || [];

  /* UNA. Llegaron a existir dos con el mismo path, cada una con su forma de
     respuesta, y Express se queda con la primera sin avisar: la segunda era
     código muerto y la pantalla que esperaba SU forma se rompía al pintar.
     Un `git merge` no lo ve —los dos bloques están lejos en el archivo— y los
     tests tampoco lo veían. Ahora sí. */
  assert.equal(rutas.length, 1, 'hay dos rutas con el mismo path: Express se queda con la primera');
});
