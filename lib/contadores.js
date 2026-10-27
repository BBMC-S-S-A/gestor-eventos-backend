'use strict';

/* Lo vendido: el aforo del evento y las unidades de cada tipo de boleta.
 *
 * Este archivo es la costura. Las trece llamadas que hay repartidas por
 * `routes/` y `lib/` entran aquí, y aquí se decide si el contador lo suma
 * Postgres —con las funciones de la 0138— o MySQL —con `modules/contadores/`.
 * Lo decide `DATOS_PROPIOS`, y mientras esté apagado no cambia nada.
 *
 * ── Por qué una costura y no cambiar las trece llamadas el día del corte ──
 *
 * Porque el día del corte no se puede estar buscando trece sitios. Están en
 * cinco archivos (`confirmarTicket`, `agente`, `eventos.publicos`, `clientes`,
 * `pagos`), varios dentro de ramas que sólo corren al pagar o al reembolsar, y
 * olvidarse de uno no da error: da un contador que miente. Que es exactamente
 * lo que ya pasó.
 *
 * ── Lo que esto arregla de paso, y es lo que más vale ─────────────────────
 *
 * Hoy las trece llamadas son `await supabase.rpc(...)` a secas: **ninguna mira
 * el resultado y ninguna mira el error**. Y `supabase.rpc` no lanza — devuelve
 * `{ data, error }`. Así que si la suma falla, no pasa absolutamente nada
 * visible: la venta sigue, la boleta se emite, y el aforo se queda corto para
 * siempre sin una sola línea en ningún log.
 *
 * Es la misma familia de fallo que la 0138 y que el correo que «se evaporaba»:
 * algo que no funciona y no se queja. Aquí se queja.
 *
 * ── Por qué AVISA en vez de reventar ──────────────────────────────────────
 *
 * `modules/contadores/` sí lanza cuando el id no existe, y está bien que lo
 * haga: es la pieza de abajo y su trabajo es decir la verdad. Pero la política
 * la decide esta costura, y aquí la respuesta correcta es otra.
 *
 * Varias de las trece están dentro del webhook de pagos. Si una suma fallida
 * tumbara la petición, Mercado Pago recibiría un error, reintentaría, y un
 * problema de contador se convertiría en un problema de cobro. El contador
 * importa; la venta importa más.
 *
 * Así que se registra con todo el detalle y se sigue. Un contador desajustado
 * se recalcula después —la propia 0138 trae el `update` que lo hace—; una
 * venta perdida, no.
 */

const config = require('../core/config');

/* Los dos contadores, con el nombre de su función en cada motor. `rpc` es la
   de Postgres (0138) y `metodo` la de MySQL (modules/contadores/). */
const CONTADORES = {
  aforo: { rpc: 'sumar_aforo_vendido', param: 'p_evento', metodo: 'sumarAforoVendido', que: 'el aforo del evento' },
  tipo : { rpc: 'sumar_vendidos_tipo',  param: 'p_tipo',   metodo: 'sumarVendidosTipo', que: 'lo vendido del tipo de boleta' },
};

async function sumar(cual, id, delta) {
  const { rpc, param, metodo, que } = CONTADORES[cual];

  /* Sumar cero es no hacer nada, y llega de verdad: `routes/clientes.js` pasa
     un `delta` calculado que puede dar 0 cuando se edita una boleta sin
     cambiarle el tipo. Salir aquí evita un viaje a la base por nada. */
  if (delta === 0) return;

  try {
    if (config.DATOS_PROPIOS) {
      /* Se pide aquí dentro y no arriba: con la bandera apagada —que es
         siempre, hasta el corte— este `require` no corre, así que no se abre
         ninguna conexión a MySQL ni se carga el módulo. Es lo mismo que hace
         `index.js` con la identidad y con los archivos. */
      const contadores = require('../modules/contadores');
      await contadores[metodo](id, delta);
      return;
    }

    const supabase = require('./supabase.js');
    const { error } = await supabase.rpc(rpc, { [param]: id, p_delta: delta });
    if (error) throw new Error(error.message || JSON.stringify(error));
  } catch (e) {
    /* Con nombre, id y delta: sin los tres no se puede recalcular después, que
       es lo único que se puede hacer cuando esto falla. */
    console.error(
      `[contadores] NO se pudo sumar ${delta >= 0 ? '+' : ''}${delta} a ${que} ${id}: ${e.message}`,
    );
  }
}

/* El aforo del evento: cuántas PERSONAS lleva vendidas. No es lo mismo que
   boletas — una mesa de cuatro suma cuatro. Quien llama ya trae ese número. */
const sumarAforoVendido = (eventoId, delta) => sumar('aforo', eventoId, delta);

/* Las unidades vendidas de un tipo de boleta. Aquí sí es una por boleta. */
const sumarVendidosTipo = (tipoId, delta) => sumar('tipo', tipoId, delta);

module.exports = { sumarAforoVendido, sumarVendidosTipo };
