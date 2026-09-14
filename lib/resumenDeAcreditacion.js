'use strict';

/* «Mañana entran 34, y te faltan 6 por autorizar.»
 *
 * ── Por qué no basta con avisar al inscribirse ───────────────────────────
 *
 * `avisoDeAcreditacion.js` avisa cuando alguien se inscribe. Es lo correcto y
 * no alcanza, porque las dos cosas que se olvidan pasan DESPUÉS del aviso:
 *
 *   · el aviso llegó el martes, se leyó, y el jueves hay seis más;
 *   · o llegó, no se leyó, y nadie volvió a insistir porque la regla es un
 *     aviso vivo a la vez.
 *
 * En los dos casos el final es el mismo: la cuadrilla en la puerta a las seis
 * de la mañana con la mitad sin autorizar. Lo que falta es que alguien
 * pregunte la víspera, y eso no lo hace una persona ocupada — lo hace un cron.
 *
 * ── Cuándo ───────────────────────────────────────────────────────────────
 *
 * Cuando falta menos de un día para que la credencial empiece a abrir
 * (`vigencia_desde`). No es la fecha del evento: el montaje empieza dos días
 * antes, y avisar la víspera del evento sería avisar cuando ya pasó.
 *
 * Va enganchado al ciclo de quince minutos que ya existe
 * (`scripts/cron-recordatorios.js`), no a un planificador dentro del proceso:
 * en cPanel, Passenger duerme la aplicación cuando nadie la usa y un
 * planificador dormido no corre — que es justo de madrugada, que es cuando
 * esto tiene que salir.
 */

const HORA = 3600 * 1000;

/* Cuánto antes se avisa, y con cuánta tolerancia.
 *
 * La ventana es ancha —de 24 a 12 horas antes— y eso es a propósito: el cron
 * corre cada quince minutos, así que una ventana estrecha se saltaría el aviso
 * entero si esa vuelta falla o el servidor está dormido. Como sólo se manda
 * uno por evento, sobrarle horas no cuesta nada; faltarle, sí. */
const DESDE_H = 24;
const HASTA_H = 12;

/* ── La decisión, sin base de datos ─────────────────────────────────────── */

/* ¿A cuáles de estos tipos de credencial les toca el resumen ahora?
 *
 * Un tipo sin `vigencia_desde` no entra nunca: no tiene víspera que calcular.
 * Es lo que pasa con una boleta normal, y con una credencial a la que nadie le
 * puso fechas — ahí el aviso al inscribirse es todo lo que hay. */
function aQuienTocaResumen(tipos = [], ahora = Date.now()) {
  const t = typeof ahora === 'number' ? ahora : new Date(ahora).getTime();

  return (tipos || []).filter(tipo => {
    if (!tipo?.vigencia_desde) return false;
    const abre = new Date(tipo.vigencia_desde).getTime();
    if (!Number.isFinite(abre)) return false;
    const faltan = abre - t;
    return faltan <= DESDE_H * HORA && faltan > HASTA_H * HORA;
  });
}

/* Qué dice el resumen.
 *
 * El número que importa es el que FALTA, no el total: «34 acreditados» se lee
 * como una tarea hecha, y «te faltan 6» es lo único que hace que alguien abra
 * la pantalla. Por eso va primero y por eso, cuando no falta ninguno, el
 * resumen no se manda — un aviso que dice «todo bien» enseña a ignorar los que
 * dicen otra cosa. */
function textoDelResumen({ pendientes, total, nombreDelTipo, cuando }) {
  const dia = cuando
    ? new Date(cuando).toLocaleString('es-CO', { day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' })
    : null;
  return {
    titulo: `Te faltan ${pendientes} por autorizar`,
    cuerpo: `${nombreDelTipo || 'La credencial'} empieza a abrir ${dia ? `el ${dia}` : 'pronto'}. `
          + `Hay ${total} personas inscritas y ${pendientes} sin autorizar: esas no entran.`,
  };
}

/* ── El ciclo ───────────────────────────────────────────────────────────── */

/* Una pasada. Nunca lanza hacia fuera: la llama el mismo cron que manda los
 * recordatorios de los eventos, y perder ese ciclo por esto sería cambiar un
 * problema pequeño por uno grande. */
async function correrResumenDeAcreditacion({ ahora = Date.now() } = {}) {
  const supabase = require('./supabase.js');
  const { aQuienLeImporta } = require('./aQuienLeImporta.js');
  const { notificarVarios } = require('./notificar.js');
  const { AVISADOS } = require('./avisoDeAcreditacion.js');

  const resultado = { mirados: 0, avisados: 0, saltados: 0 };

  try {
    /* Sólo los tipos que exigen autorización y tienen fecha de apertura. La
       consulta se acota aquí y no en memoria porque en una base con miles de
       tipos de boleta traerlos todos para descartar el 99 % es un viaje que no
       hay que hacer cada quince minutos. */
    const { data: tipos, error } = await supabase
      .from('ticket_types')
      .select('id, evento_id, nombre, vigencia_desde')
      .eq('requiere_autorizacion', true)
      .not('vigencia_desde', 'is', null);

    /* Sin la 0127 aplicada, la columna no existe y el select falla. No es un
       error que haya que gritar cada quince minutos: es un servidor al día que
       todavía no tiene la migración. */
    if (error) {
      if (/vigencia_desde|requiere_autorizacion/.test(error.message || '')) return resultado;
      throw new Error(error.message);
    }

    const tocan = aQuienTocaResumen(tipos, ahora);
    resultado.mirados = tocan.length;

    for (const tipo of tocan) {
      try {
        const cuenta = await contarDelTipo(tipo.id, tipo.evento_id);
        /* Nadie pendiente: no se manda nada. Un aviso que dice «todo bien»
           enseña a ignorar los que dicen otra cosa. */
        if (!cuenta.pendientes) { resultado.saltados++; continue; }

        /* Que no salga dos veces. El cron corre cada quince minutos dentro de
           una ventana de doce horas, así que sin esto serían cuarenta y ocho
           avisos iguales — la forma más rápida de que el equipo silencie la
           campana justo la noche que importa.
           Se mira contra las notificaciones ya creadas y no contra una tabla
           nueva: el dato ya está escrito ahí, y una tabla de control que hay
           que mantener de acuerdo con otra acaba desacordada. */
        if (await yaSeMando(tipo.evento_id, ahora)) { resultado.saltados++; continue; }

        const { data: ev } = await supabase
          .from('eventos').select('owner_id').eq('id', tipo.evento_id).maybeSingle();

        const gente = await aQuienLeImporta(tipo.evento_id, AVISADOS, { ownerId: ev?.owner_id })
          .catch(() => (ev?.owner_id ? [ev.owner_id] : []));
        if (!gente.length) { resultado.saltados++; continue; }

        const { titulo, cuerpo } = textoDelResumen({
          pendientes: cuenta.pendientes, total: cuenta.total,
          nombreDelTipo: tipo.nombre, cuando: tipo.vigencia_desde,
        });

        await notificarVarios(gente, {
          tipo: TIPO_RESUMEN,
          titulo, cuerpo,
          link: `/eventos/${tipo.evento_id}?s=asistentes&t=acreditados`,
          eventoId: tipo.evento_id,
        });
        resultado.avisados++;
      } catch (e) {
        /* Un evento que falla no se lleva por delante a los demás: en una
           feria hay varios tipos de credencial y uno roto no puede dejar sin
           aviso a los otros. */
        console.warn(`[resumenAcreditacion] evento ${tipo.evento_id}: ${e.message}`);
      }
    }
  } catch (e) {
    console.warn('[resumenAcreditacion] el ciclo falló:', e.message);
  }

  return resultado;
}

/* Marca el resumen aparte del aviso de inscripción: son dos cosas distintas y
   el «un aviso vivo a la vez» de uno no puede callar al otro. */
const TIPO_RESUMEN = 'acreditacion_resumen';

async function yaSeMando(eventoId, ahora) {
  const supabase = require('./supabase.js');
  const desde = new Date((typeof ahora === 'number' ? ahora : Date.now()) - DESDE_H * HORA).toISOString();

  const { data, error } = await supabase
    .from('notificaciones')
    .select('id')
    .eq('evento_id', eventoId).eq('tipo', TIPO_RESUMEN)
    .gte('created_at', desde)
    .limit(1);

  /* Si no se puede comprobar, se manda. Un resumen repetido es molesto; uno
     que falta es la cuadrilla fuera. */
  if (error) return false;
  return (data || []).length > 0;
}

/* Cuántos hay inscritos y cuántos sin autorizar en las boletas de ESTE tipo. */
async function contarDelTipo(tipoId, eventoId) {
  const supabase = require('./supabase.js');

  const { data: boletas } = await supabase
    .from('tickets').select('id').eq('evento_id', eventoId).eq('ticket_type_id', tipoId);
  const ids = (boletas || []).map(b => b.id);
  if (!ids.length) return { total: 0, pendientes: 0 };

  const base = () => supabase
    .from('ticket_puestos').select('id', { count: 'exact', head: true })
    .in('ticket_id', ids)
    /* Un puesto vacío no cuenta: todavía no hay a quién autorizar, y contarlo
       haría que el resumen dijera que faltan seis cuando faltan dos. */
    .not('nombre', 'is', null);

  const { count: total } = await base();
  const { count: pendientes } = await base().is('autorizado_at', null);

  return { total: total || 0, pendientes: pendientes || 0 };
}

module.exports = {
  correrResumenDeAcreditacion, aQuienTocaResumen, textoDelResumen,
  TIPO_RESUMEN, DESDE_H, HASTA_H,
};
