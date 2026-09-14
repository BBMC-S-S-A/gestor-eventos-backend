'use strict';

/* modules/archivos/index.js — la única puerta del módulo.
 *
 * Lo que se exporta:
 *
 *   rutas      el Router, para montar en `/archivos`
 *   servicio   subir, borrar, listar y barrer, para el cron y los scripts
 *   urlDe      la URL pública de una ruta guardada, para los demás módulos
 *
 * `almacen`, `repositorio` y `tipos` no salen de aquí: quien los necesite, lo
 * pide por la puerta.
 */

const { crearServicio } = require('./servicio.js');
const { crearRutas } = require('./rutas.js');
const repositorio = require('./repositorio.js');
const almacen = require('./almacen.js');
const firmas = require('./firmas.js');
const auth = require('../auth');
const config = require('../../core/config');

const servicio = crearServicio({ repo: repositorio, almacen });

const rutas = crearRutas({
  servicio,
  repo          : repositorio,
  /* La identidad la pone el módulo de auth: aquí no se verifica ningún token.
     Es la regla de que nadie entra por la ventana de otro módulo. */
  sesionOpcional: auth.sesionOpcional,
  exigirSesion  : auth.exigirSesion,
});

const urlDe = (ruta) => `${config.ARCHIVOS_URL_BASE}/${ruta}`;

/* La URL con caducidad de un archivo PRIVADO, para quien tenga derecho a verlo.
 *
 * Sale por la puerta del módulo —y no firmando por libre desde otra ruta—
 * porque el secreto y la vida del enlace son de aquí: dos sitios firmando es
 * como acaban existiendo dos caducidades distintas para lo mismo.
 *
 * Quince minutos: lo que dura mirar una foto en la puerta, no lo que dura un
 * enlace olvidado en un chat. */
const enlaceFirmado = (ruta, opciones = {}) => {
  if (!ruta) return null;
  const { expira, firma } = firmas.firmarRuta(ruta, opciones);
  const p = new URLSearchParams({ ruta, expira: String(expira), firma });
  return `${config.ARCHIVOS_URL_BASE}/privado?${p.toString()}`;
};

module.exports = { rutas, servicio, urlDe, enlaceFirmado, comprobarAlmacen: almacen.comprobar };
