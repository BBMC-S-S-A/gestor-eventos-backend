'use strict';

/* scripts/lib/volcado.js — convertir filas en archivos `.sql` que se pegan
 * en phpMyAdmin.
 *
 * ── Por qué existe ───────────────────────────────────────────────────────
 *
 * `migrar-datos.js` escribe directo en MySQL, y es lo que se quiere cuando se
 * puede llegar a la base. Desde fuera del servidor no se puede: el MySQL del
 * cPanel sólo escucha en el 3306, y ese puerto no sale de ninguna parte salvo
 * del propio servidor.
 *
 * La vía que sí existe es phpMyAdmin, que es HTTPS y pide archivos. Así que
 * las mismas filas, en vez de ir por el cable, se escriben como `INSERT` y
 * alguien los sube.
 *
 * ── Lo que este archivo NO hace, a propósito ─────────────────────────────
 *
 * No habla con nada. Filas dentro, texto fuera. Eso es lo que permite probarlo
 * sin Supabase y sin MySQL — y la parte que de verdad puede estar mal no es
 * ninguna conexión, sino el escapado, el orden y el troceo.
 *
 * ── Las tres cosas que pueden salir mal en silencio ──────────────────────
 *
 *   1. **El escapado.** Un apóstrofo en «O'Hara» parte la sentencia; una barra
 *      invertida se come el carácter siguiente. Se delega en `mysql2.escape`,
 *      que es el mismo código que usa el driver cuando `migrar-datos.js`
 *      escribe directo. Dos caminos, un solo escapado.
 *
 *   2. **El orden dentro de una tabla.** Tres tablas se apuntan a sí mismas
 *      (`espacios.parent_id`, `chat_channels.parent_id`,
 *      `torneo_categorias.padre_id`). PostgREST devuelve las filas en el orden
 *      que le da la gana, así que una hija puede venir antes que su padre — y
 *      con las claves ajenas encendidas eso es un `ERROR 1452` a mitad de
 *      archivo, con medio cargue hecho. `ordenarPorPadre()` las acomoda.
 *
 *   3. **El tamaño.** phpMyAdmin tiene un límite de subida, y pegar diez mega
 *      en el cuadro de texto no funciona en ningún navegador. Se trocea.
 */

const mysql = require('mysql2');

/* ── Un valor ────────────────────────────────────────────────────────────
 *
 * Mismo criterio que `valorParaMysql()` en `migrar-datos.js`: los objetos y
 * arrays van a columnas JSON como texto, y todo lo demás tal cual.
 *
 * `mysql2.escape` ya devuelve el valor ENTRECOMILLADO y escapado, `NULL`
 * incluido — no hay que añadirle comillas por fuera. Y `undefined` también le
 * sale `NULL`, así que no hace falta convertirlo antes: aquí había un
 * `v === undefined ? null : v` que no cambiaba nada, y lo delató una mutación
 * que nadie atrapó. */
function literal(v) {
  if (v !== null && v !== undefined
      && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v)) {
    return mysql.escape(JSON.stringify(v));
  }
  return mysql.escape(v);
}

/* ── Un INSERT ───────────────────────────────────────────────────────────
 *
 * Varias filas por sentencia: una a una son 38.000 sentencias y phpMyAdmin se
 * arrastra. El `;\n` final lo pone quien lo acumula.
 *
 * Una columna que la fila no trae llega aquí como `undefined`, y `literal()`
 * la escribe `NULL` — que es lo que se quiere. Había un `?? null` por delante
 * que hacía el mismo trabajo dos veces. */
function sentenciaInsert(tabla, columnas, filas) {
  if (!filas.length) return null;
  const lista = columnas.map(c => `\`${c}\``).join(', ');
  const tuplas = filas.map(f => `(${columnas.map(c => literal(f[c])).join(', ')})`);
  return `INSERT INTO \`${tabla}\` (${lista}) VALUES\n${tuplas.join(',\n')};`;
}

/* ── El orden dentro de una tabla que se apunta a sí misma ───────────────
 *
 * Los padres primero. Una fila cuyo padre no esté en el lote sale al
 * principio: o el padre ya está en la base, o falta de verdad — y entonces se
 * quiere el `ERROR 1452`, que es la clave ajena diciendo que hay una huérfana.
 * Taparlo aquí sería cargar datos rotos en silencio.
 *
 * Un ciclo (A padre de B y B padre de A) no se puede ordenar, pero tampoco
 * puede colgar el proceso: `viendo` lo corta y las dos filas salen igual, en
 * el orden que queden. La clave ajena tendrá la última palabra.
 *
 * Aquí había además un barrido final «por si un ciclo dejó alguna fuera». No
 * puede dejar ninguna: cada fila entra por `poner(f, new Set())`, así que
 * `viendo` está vacío al entrar y siempre se llega a colocarla. Ese bucle no
 * se ejecutaba nunca, y se vio porque borrarlo no rompía ninguna prueba. */
function ordenarPorPadre(filas, pk, padre) {
  const porId = new Map(filas.map(f => [f[pk], f]));
  const puestas = new Set();
  const salida = [];

  const poner = (f, viendo) => {
    const id = f[pk];
    if (puestas.has(id)) return;
    if (viendo.has(id)) return;            // ciclo: se corta aquí
    viendo.add(id);
    const p = f[padre];
    if (p !== null && p !== undefined && porId.has(p)) poner(porId.get(p), viendo);
    viendo.delete(id);
    if (!puestas.has(id)) { puestas.add(id); salida.push(f); }
  };

  for (const f of filas) poner(f, new Set());
  return salida;
}

/* ── El troceador ────────────────────────────────────────────────────────
 *
 * Acumula sentencias y corta al pasarse del tamaño. Corta ENTRE sentencias,
 * nunca dentro: un archivo que termina a mitad de un `INSERT` es un archivo
 * que no se puede subir y que además no lo parece.
 *
 * `cabecera` se repite en cada trozo. Lo que vale para uno vale para todos,
 * porque el que sube no controla en qué orden los abre. */
class Troceador {
  constructor({ limite, cabecera = () => '', escribir }) {
    this.limite = limite;
    this.cabecera = cabecera;
    this.escribir = escribir;
    this.parte = 0;
    this.buffer = [];
    this.bytes = 0;
  }

  añadir(sentencia) {
    if (!sentencia) return;
    const n = Buffer.byteLength(sentencia, 'utf8') + 1;
    /* Sin guarda de «hay algo acumulado»: `cerrar()` ya sale solo si el buffer
       está vacío, que es el caso de una sentencia más grande que el límite.
       Comprobarlo dos veces no cambiaba nada y lo delató una mutación. */
    if (this.bytes + n > this.limite) this.cerrar();
    this.buffer.push(sentencia);
    this.bytes += n;
  }

  cerrar() {
    if (!this.buffer.length) return;
    this.parte += 1;
    this.escribir(this.parte, this.cabecera(this.parte) + this.buffer.join('\n') + '\n');
    this.buffer = [];
    this.bytes = 0;
  }
}

module.exports = { literal, sentenciaInsert, ordenarPorPadre, Troceador };
