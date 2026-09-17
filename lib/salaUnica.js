/* Entrar en una sala saca de la anterior.
 *
 * ── El problema que resuelve ─────────────────────────────────────────────
 *
 * El aforo de una zona sólo bajaba si alguien escaneaba AL SALIR. Y la gente
 * no sale escaneando: se levanta y se va a la charla de al lado. Así que el
 * número de la sala A se quedaba clavado toda la jornada, subiendo con cada
 * persona que entraba y sin bajar nunca. Al final del día el tablero decía que
 * había 600 personas en un salón de 120, que es un número que nadie usa para
 * nada — y el aforo existe justamente para decidir si se cierra una puerta.
 *
 * ── La regla ─────────────────────────────────────────────────────────────
 *
 * Una persona está en UNA sala a la vez. Cuando entra en la B, se le escribe
 * la salida de la A.
 *
 * Es una suposición sobre el mundo, no una verdad: alguien puede dejar la
 * chaqueta en un sitio y asomarse a otro. Se asume igualmente porque el error
 * que comete es pequeño y momentáneo —una persona contada donde ya no está,
 * hasta que escanee en cualquier parte— mientras que el error de no asumirlo
 * era permanente y crecía toda la jornada.
 *
 * Lo que NO hace, a propósito:
 *
 * · No toca el recinto general (las filas sin zona). Entrar a una sala no es
 *   salir del evento; es justo lo contrario.
 * · No se aplica a las salidas. Salir de la B no dice nada sobre la A.
 * · No inventa entradas. Si no consta que estuviera en ninguna sala, no
 *   escribe nada.
 *
 * ── Por qué queda escrito como un movimiento y no como un ajuste ─────────
 *
 * Porque el reporte tiene que poder distinguirlo. `origen: 'auto'` y una nota
 * que dice de dónde salió: quien mire el histórico de una persona verá que esa
 * salida no la escaneó nadie, la dedujo el sistema. Un ajuste silencioso del
 * contador habría dado el mismo número y ninguna forma de auditarlo.
 */
const supabase = require('./supabase.js');

/* La clave de una zona en los movimientos.
 *
 * Los anteriores a la 0079 sólo guardaron el NOMBRE, así que una misma sala
 * puede aparecer con `zona_id` en las filas nuevas y sólo con `zona` en las
 * viejas. Se agrupa por lo que haya, con el id por delante. */
const claveDeZona = (fila) => fila.zona_id || fila.zona || null;

/* En qué salas consta que está esta persona ahora mismo.
 *
 * "Ahora mismo" = su ÚLTIMO movimiento en esa sala fue una entrada. Se mira
 * fila a fila y no con un `group by` porque el volumen por boleta es de unas
 * pocas decenas, y porque aquí el orden importa más que la agregación. */
function salasOcupadas(movimientos = []) {
  const ultimo = new Map();
  /* De más antiguo a más nuevo: la última escritura de cada clave gana. */
  for (const m of [...movimientos].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))) {
    const clave = claveDeZona(m);
    if (!clave) continue;                       // el recinto general no cuenta
    ultimo.set(clave, m);
  }
  return [...ultimo.values()].filter(m => m.tipo === 'entrada');
}

/* Escribe las salidas que tocan al entrar en `zonaNueva`.
 *
 * `puestoId` acota a UNA persona de una boleta compartida (0125): en una mesa
 * de cuatro, que uno se mueva de sala no saca a los otros tres. Sin puesto
 * —una boleta de una persona, que son casi todas— se mira la boleta entera.
 *
 * Devuelve las salidas escritas. No lanza: esto es un efecto secundario del
 * movimiento que ya se registró, y un fallo aquí no puede tumbar el escaneo de
 * la puerta que sí funcionó. Se avisa por consola y se sigue.
 */
async function salirDeLasOtrasSalas({ ticketId, eventoId, zonaNueva, puestoId = null, operadorId = null }) {
  if (!ticketId || !eventoId || !zonaNueva?.id) return { salidas: [] };

  let q = supabase.from('ticket_movimientos')
    .select('tipo, zona, zona_id, created_at')
    .eq('ticket_id', ticketId)
    .not('zona_id', 'is', null);
  /* Con puesto, sólo lo suyo. Sin puesto, sólo las filas que tampoco lo
     llevan: si no, en una mesa el movimiento de un compañero se leería como
     propio y lo sacaría de una sala donde nunca estuvo. */
  q = puestoId ? q.eq('puesto_id', puestoId) : q.is('puesto_id', null);

  const { data, error } = await q.order('created_at', { ascending: true }).limit(500);
  if (error) {
    console.warn('[sala-unica] no se pudo leer dónde estaba:', error.message);
    return { salidas: [], error: error.message };
  }

  /* Las filas viejas sin `zona_id` no entran en la consulta de arriba, así que
     una sala en la que sólo conste por nombre no se cierra. Es deliberado:
     cerrar por nombre podría confundir dos salas que se llamaron igual en
     momentos distintos, y escribir una salida de más es peor que no escribirla
     —deja a una persona fuera de un aforo en el que sí está—. */
  const fuera = salasOcupadas(data || [])
    .filter(m => claveDeZona(m) !== zonaNueva.id && claveDeZona(m) !== zonaNueva.nombre);

  if (!fuera.length) return { salidas: [] };

  const filas = fuera.map(m => ({
    ticket_id: ticketId,
    evento_id: eventoId,
    tipo: 'salida',
    cantidad: 1,
    origen: 'auto',
    zona: m.zona || null,
    zona_id: m.zona_id || null,
    puesto_id: puestoId || null,
    operador_id: operadorId || null,
    nota: `Salida automática al entrar en «${zonaNueva.nombre || zonaNueva.id}».`,
  }));

  const { data: escritas, error: eIns } = await supabase
    .from('ticket_movimientos').insert(filas).select('id, zona, zona_id');
  if (eIns) {
    /* Sin la 0125, `puesto_id` no existe. Se reintenta sin esa clave antes que
       dejar el aforo mal: la salida importa más que saber de quién fue. */
    if (/puesto_id/.test(eIns.message || '')) {
      const sinPuesto = filas.map((f) => { const r = { ...f }; delete r.puesto_id; return r; });
      const reintento = await supabase.from('ticket_movimientos').insert(sinPuesto).select('id, zona, zona_id');
      if (!reintento.error) return { salidas: reintento.data || [] };
      console.warn('[sala-unica] no se pudo escribir la salida:', reintento.error.message);
      return { salidas: [], error: reintento.error.message };
    }
    console.warn('[sala-unica] no se pudo escribir la salida:', eIns.message);
    return { salidas: [], error: eIns.message };
  }
  return { salidas: escritas || [] };
}

module.exports = { salirDeLasOtrasSalas, salasOcupadas, claveDeZona };
