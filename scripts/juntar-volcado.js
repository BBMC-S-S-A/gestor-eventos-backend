#!/usr/bin/env node
'use strict';

/* scripts/juntar-volcado.js — junta los archivos de `volcar-datos.js` en
 * menos bloques, para subirlos a mano por phpMyAdmin.
 *
 *   node scripts/juntar-volcado.js --de volcado/ --a bloques/ --tamano 3
 *
 * ── Por qué ──────────────────────────────────────────────────────────────
 *
 * `volcar-datos.js` escribe un archivo por tabla porque así, cuando algo
 * falla, se sabe exactamente en cuál. Eso está bien para un script que los
 * sube en bucle y mal para una persona: son 62 veces elegir archivo, subir,
 * esperar.
 *
 * Esto los junta respetando el orden. Lo que NO hace es juntarlos a ciegas.
 *
 * ── Lo que hace que un bloque se pueda repetir ───────────────────────────
 *
 * Un pegado simple tiene un problema feo: si el bloque 4 se cae a la mitad,
 * sus tablas quedan con filas a medias. Volver a subirlo choca con
 * «ERROR 1062 Duplicate entry», así que tocaría vaciar la base entera y
 * empezar por el bloque 1 — perdiendo los tres que sí habían entrado.
 *
 * Por eso cada bloque **empieza borrando las tablas que él mismo trae**, en
 * orden inverso al de carga. Repetirlo entonces es limpiarse y volver a
 * entrar. El orden inverso dentro del bloque es por lo de siempre: una tabla
 * no se vacía mientras otra del mismo bloque la apunte.
 *
 * ── Y hasta dónde llega eso, que no es «siempre» ─────────────────────────
 *
 * Un bloque se puede repetir **mientras los POSTERIORES no estén cargados**.
 * Esa es justo la situación de un fallo yendo en orden, que es para lo que
 * existe: se cae el 5, el 6 y el 7 todavía no se han subido, se repite el 5.
 * Probado: bloque 5 cortado a mitad de un INSERT, repetido entero, y después
 * el 6 y el 7 — las 59 tablas cuadran.
 *
 * Lo que NO se puede es repetir un bloque de más atrás con los siguientes ya
 * dentro. El bloque 5 trae `ticket_types` y `tickets` (bloque 6) la apunta,
 * así que su DELETE choca:
 *
 *     ERROR 1451 · Cannot delete or update a parent row
 *
 * Eso no es un fallo del archivo: es la clave ajena avisando de que hay que
 * volver al vaciado completo y empezar por el bloque 1. Y es la forma buena
 * de enterarse — ruidosa y antes de tocar nada, no a medias.
 *
 * Apagar `FOREIGN_KEY_CHECKS` para los DELETE lo haría «funcionar» y dejaría
 * las boletas apuntando a tipos de boleta borrados. Por eso no se hace.
 *
 * ── El corte ─────────────────────────────────────────────────────────────
 *
 * Entre archivos, nunca dentro. Y las partes de una misma tabla
 * (`61_tickets.sql`, `61_tickets_parte2.sql`…) van juntas en el mismo bloque:
 * separarlas haría que el DELETE del bloque siguiente borrara lo que acababa
 * de entrar en el anterior.
 */

const fs = require('node:fs');
const path = require('node:path');

const args  = process.argv.slice(2);
const valor = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const DE     = valor('--de');
const A      = valor('--a');
const TAMANO = Number(valor('--tamano') || 3) * 1024 * 1024;

function salir(m) { console.error(`\n${m}\n`); process.exit(2); }

/* `03_eventos_parte2.sql` -> { orden: 3, tabla: 'eventos' } */
function leerNombre(n) {
  const m = n.match(/^(\d+)_(.+?)(?:_parte\d+)?\.sql$/);
  return m ? { orden: Number(m[1]), tabla: m[2] } : null;
}

function main() {
  if (!DE || !A) salir('Uso: --de <carpeta del volcado> --a <carpeta de salida> [--tamano 3]');
  fs.mkdirSync(A, { recursive: true });

  /* Sólo los de datos. `00_vaciar` y `99_comprobar` se copian aparte: no
     entran en los bloques ni llevan DELETE delante. */
  const datos = fs.readdirSync(DE)
    .filter(n => /^\d+_/.test(n) && n.endsWith('.sql') && !/^(00_|99_)/.test(n))
    .map(n => ({ nombre: n, ...leerNombre(n), bytes: fs.statSync(path.join(DE, n)).size }))
    .filter(f => f.tabla)
    .sort((a, b) => a.orden - b.orden || a.nombre.localeCompare(b.nombre));

  if (!datos.length) salir(`No encontré archivos de datos en ${DE}`);

  /* Agrupar por tabla primero: sus partes no se separan nunca. */
  const porTabla = [];
  for (const f of datos) {
    const ultimo = porTabla[porTabla.length - 1];
    if (ultimo && ultimo.tabla === f.tabla) { ultimo.archivos.push(f); ultimo.bytes += f.bytes; }
    else porTabla.push({ tabla: f.tabla, orden: f.orden, archivos: [f], bytes: f.bytes });
  }

  /* Y ahora las tablas en bloques por tamaño. */
  const bloques = [];
  for (const t of porTabla) {
    const ultimo = bloques[bloques.length - 1];
    if (ultimo && ultimo.bytes + t.bytes <= TAMANO) { ultimo.tablas.push(t); ultimo.bytes += t.bytes; }
    else bloques.push({ tablas: [t], bytes: t.bytes });
  }

  const anchura = String(bloques.length).length;
  bloques.forEach((b, i) => {
    const n = String(i + 1).padStart(anchura, '0');
    const tablas = b.tablas.map(t => t.tabla);

    const cabecera =
      `/* BLOQUE ${i + 1} de ${bloques.length} — ${tablas.length} tablas\n` +
      ` *\n` +
      ` * SI SE CAE A LA MITAD, VUELVA A SUBIR ESTE MISMO ARCHIVO. Empieza\n` +
      ` * borrando sus propias tablas, así que se limpia solo. No hay que vaciar\n` +
      ` * la base ni volver al bloque 1.\n` +
      ` *\n` +
      ` * Eso vale mientras los bloques POSTERIORES no estén subidos, que es el\n` +
      ` * caso de un fallo yendo en orden. Si ya subió los de después y necesita\n` +
      ` * repetir éste, el DELETE chocará con «ERROR 1451 Cannot delete a parent\n` +
      ` * row»: ahí toca el vaciado completo y empezar por el bloque 1.\n` +
      ` *\n` +
      ` * Súbalo DESPUÉS del ${i === 0 ? 'vaciado inicial' : `bloque ${i}`} y ANTES del ` +
      `${i + 1 === bloques.length ? 'archivo de comprobación' : `bloque ${i + 2}`}.\n` +
      ` *\n` +
      ` * Si sale «Table '...' doesn't exist», no es este archivo: es que no está\n` +
      ` * seleccionada la base. Clic en ella en el panel de la izquierda y repita.\n` +
      ` * Falla en la primera línea y no alcanza a escribir nada.\n` +
      ` *\n` +
      tablas.map(t => ` *   · ${t}`).join('\n') + '\n */\n\n' +
      `SET NAMES utf8mb4;\n` +
      `SET time_zone = '+00:00';\n\n` +
      `/* Las suyas, en orden inverso: una tabla no se vacía mientras otra de\n` +
      `   este mismo bloque la apunte. */\n` +
      [...tablas].reverse().map(t => `DELETE FROM \`${t}\`;`).join('\n') + '\n\n';

    /* Los INSERT, con su propia cabecera quitada: ya la lleva el bloque. */
    const cuerpo = b.tablas.flatMap(t => t.archivos).map(f => {
      const txt = fs.readFileSync(path.join(DE, f.nombre), 'utf8');
      const sinCabecera = txt.replace(/^(?:--[^\n]*\n|SET [^\n]*\n|\s*\n)+/, '');
      return `/* ── ${f.nombre} ── */\n${sinCabecera.trimEnd()}\n`;
    }).join('\n');

    const salida = path.join(A, `bloque-${n}.sql`);
    fs.writeFileSync(salida, cabecera + cuerpo);
    console.log(`  bloque-${n}.sql  ${String(tablas.length).padStart(2)} tablas  ` +
                `${(fs.statSync(salida).size / 1024 / 1024).toFixed(1)} MB`);
  });

  for (const n of ['00_vaciar.sql', '99_comprobar.sql']) {
    if (fs.existsSync(path.join(DE, n))) fs.copyFileSync(path.join(DE, n), path.join(A, n));
  }

  console.log(`\n${bloques.length} bloques en ${A}/`);
}

main();
