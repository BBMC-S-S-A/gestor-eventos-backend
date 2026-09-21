/* Resumen de los rechazos de la puerta de un día (`puerta_rechazos`, 0135).
 *
 * Lo que quiere saber quien organiza no es la lista cruda sino tres cosas:
 * cuántos, a qué hora se amontonaron, y si fueron escaneos dobles sin mala fe
 * (el mismo QR dos veces en el mismo minuto: la persona ya pasó) o una boleta
 * que vuelve horas después — que es como se ve una boleta prestada. */

const DOBLE_MS = 2 * 60 * 1000;

function horaLocal(iso, tz) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date(iso)));
}

function resumirRechazos(filas, tz = 'America/Bogota') {
  const porMotivo = {};
  const porHora = {};
  const porBoleta = new Map();
  let dobles = 0;
  let tardios = 0;

  for (const f of filas) {
    porMotivo[f.motivo] = (porMotivo[f.motivo] || 0) + 1;
    const h = horaLocal(f.created_at, tz);
    porHora[h] = (porHora[h] || 0) + 1;
    if (f.motivo === 'ya_usada_hoy' && f.entro_at) {
      const dif = new Date(f.created_at) - new Date(f.entro_at);
      if (dif <= DOBLE_MS) dobles++; else tardios++;
    }
    if (f.ticket_id) {
      const b = porBoleta.get(f.ticket_id) || { ticket_id: f.ticket_id, veces: 0, nombre: f.ticket?.guest_nombre || null, codigo: f.ticket?.codigo || null, tipo: f.ticket?.tipo?.nombre || null, ultimo: f.created_at, entro_at: f.entro_at || null };
      b.veces++;
      if (f.created_at > b.ultimo) b.ultimo = f.created_at;
      porBoleta.set(f.ticket_id, b);
    }
  }

  const insistentes = [...porBoleta.values()]
    .filter(b => b.veces >= 2)
    .sort((a, b) => b.veces - a.veces)
    .slice(0, 20);

  const ultimos = filas.slice(0, 30).map(f => ({
    id: f.id, motivo: f.motivo, created_at: f.created_at, entro_at: f.entro_at,
    nombre: f.ticket?.guest_nombre || null, codigo: f.ticket?.codigo || null, tipo: f.ticket?.tipo?.nombre || null,
  }));

  return {
    total: filas.length,
    por_motivo: porMotivo,
    por_hora: Object.entries(porHora).map(([hora, n]) => ({ hora: Number(hora), n })).sort((a, b) => a.hora - b.hora),
    dobles,
    tardios,
    insistentes,
    ultimos,
  };
}

module.exports = { resumirRechazos, DOBLE_MS };
