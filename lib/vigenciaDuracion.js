/* Vigencia por DURACIÓN de una boleta: «válida 4 horas», «2 días», «1 semana».
 *
 * Se cuenta desde el PRIMER ingreso de la persona (`tickets.primer_ingreso_at`,
 * 0136), no desde la compra: una boleta que no se usa no se gasta. Es la otra
 * cara de `vigencia_desde/hasta` (0127), que son fechas fijas iguales para
 * todos; las dos pueden convivir y la puerta exige ambas.
 *
 * ── Los días son de calendario, en la hora del evento ──────────────────
 *
 * «2 días» = el día en que entró y el siguiente, hasta la medianoche del
 * recinto. No 48 horas: quien entra a las 4 de la tarde del día 1 con un pase
 * de 2 días espera poder volver el día 2 a las 6, y con bloques de 24 h ya no
 * podría. Las horas sí son horas exactas. Una semana son 7 días de calendario.
 */

const UNIDADES = ['horas', 'dias', 'semanas'];

/* Fecha local (AAAA-MM-DD) de un instante en una zona. */
function fechaLocal(ms, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(ms));
}

/* Cuántos ms va la zona por delante de UTC en ese instante. */
function desfase(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  const comoUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return comoUTC - Math.floor(ms / 1000) * 1000;
}

/* El instante UTC de la medianoche que ABRE `fecha` (AAAA-MM-DD) en `tz`. */
function medianocheDe(fecha, tz) {
  const [y, m, d] = fecha.split('-').map(Number);
  const aprox = Date.UTC(y, m - 1, d);
  // Dos pasadas: el desfase puede cambiar justo en la medianoche (horario de verano).
  let t = aprox - desfase(aprox, tz);
  t = aprox - desfase(t, tz);
  return t;
}

function sumarDias(fecha, n) {
  const [y, m, d] = fecha.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/* ¿Tiene este tipo una duración configurada? */
function tieneDuracion(tipo) {
  return Number(tipo?.vigencia_cantidad) > 0 && UNIDADES.includes(tipo?.vigencia_unidad);
}

/* Cuándo vence, dado el primer ingreso. null si el tipo no tiene duración o
   la persona todavía no ha entrado (entonces aún no corre). */
function venceEl(tipo, primerIngreso, tz = 'America/Bogota') {
  if (!tieneDuracion(tipo) || !primerIngreso) return null;
  const inicio = new Date(primerIngreso).getTime();
  if (!Number.isFinite(inicio)) return null;
  const n = Math.floor(Number(tipo.vigencia_cantidad));
  if (tipo.vigencia_unidad === 'horas') return new Date(inicio + n * 3600 * 1000).toISOString();
  const dias = tipo.vigencia_unidad === 'semanas' ? n * 7 : n;
  const zona = tz || 'America/Bogota';
  return new Date(medianocheDe(sumarDias(fechaLocal(inicio, zona), dias), zona)).toISOString();
}

/* Para la puerta: { vigente, vence_at, motivo }. */
function vigenciaPorDuracion(tipo, primerIngreso, tz, ahora = Date.now()) {
  const vence = venceEl(tipo, primerIngreso, tz);
  if (!vence) return { vigente: true, vence_at: null };
  if (ahora >= new Date(vence).getTime()) {
    return { vigente: false, vence_at: vence, motivo: `Esta boleta venció (${textoDuracion(tipo)} desde su primer ingreso).` };
  }
  return { vigente: true, vence_at: vence };
}

/* «4 horas», «1 día», «2 semanas». */
function textoDuracion(tipo) {
  if (!tieneDuracion(tipo)) return '';
  const n = Math.floor(Number(tipo.vigencia_cantidad));
  const nombre = { horas: ['hora', 'horas'], dias: ['día', 'días'], semanas: ['semana', 'semanas'] }[tipo.vigencia_unidad];
  return `${n} ${n === 1 ? nombre[0] : nombre[1]}`;
}

module.exports = { UNIDADES, tieneDuracion, venceEl, vigenciaPorDuracion, textoDuracion, fechaLocal, medianocheDe, sumarDias };
