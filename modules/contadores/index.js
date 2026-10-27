'use strict';

/* Los cuatro sitios donde la base de datos hoy CUENTA por nosotros.
 *
 * Tres son disparadores y una función de Supabase (§1 a §3). El cuarto (§4)
 * son las dos sumas de la migración 0138 —lo vendido de un evento y de cada
 * tipo de boleta—, que no nacieron como disparador sino como el arreglo de un
 * fallo medido en producción. Ése se lee aparte: es el único de los cuatro
 * que ya perdió datos de verdad.
 *
 * Paso 4 de la fase 6 (ver db/migraciones/NOTAS-ESQUEMA.md): en MySQL no hay
 * disparadores que reproduzcan esto, así que se va al código. Y aquí está el
 * riesgo entero de esa fase.
 *
 * ── Por qué esto no es una traducción mecánica ────────────────────────────
 *
 * En Postgres, `fn_verificar_cuota_stand` corre DENTRO de la transacción del
 * INSERT que lo dispara. Eso le da dos cosas gratis que se pierden al sacarlo:
 *
 *   1. Atomicidad. Leer el total y escribir la fila nueva es una sola
 *      operación; nadie puede colarse en medio.
 *   2. Rollback. Si el disparador falla, el INSERT no ocurre.
 *
 * Traducido ingenuamente —leer con una consulta, comprobar en JavaScript,
 * escribir con otra— aparece la carrera clásica: dos escaneos simultáneos leen
 * los mismos 480 puntos, los dos calculan que caben 20 más, y el stand reparte
 * 520 de una cuota de 500. Con una fila de cola en un stand el día del evento,
 * eso pasa.
 *
 * Por eso todo lo de aquí va en una transacción con `SELECT ... FOR UPDATE`
 * sobre la fila que se está contando. El bloqueo es lo que serializa a los dos
 * escaneos; sin él, la transacción sola no basta (MySQL en REPEATABLE READ deja
 * que los dos lean lo mismo).
 *
 * ── Estado ────────────────────────────────────────────────────────────────
 *
 * Esto se usará cuando los datos vivan en MySQL. Hoy la plataforma sigue sobre
 * Supabase y los disparadores siguen ahí haciendo su trabajo: este módulo no
 * se llama desde ninguna ruta todavía, a propósito. Se escribe ahora porque es
 * la parte que hay que pensar, no la que hay que teclear, y porque las pruebas
 * de abajo se pueden correr sin base.
 */

const { bd } = require('../../core/db/mysql.js');

/* ── 1 · La cuota de puntos de un stand ───────────────────────────────────
 *
 * Original: `private.fn_verificar_cuota_stand`, disparador BEFORE INSERT OR
 * UPDATE sobre `ticket_interacciones`.
 *
 * Un expositor tiene una bolsa de puntos (`cuota_puntos`) y no puede repartir
 * más. El disparador suma lo ya otorgado y compara.
 *
 * Diferencia deliberada con el original: aquí se INSERTA dentro de la misma
 * transacción en la que se comprueba. El disparador podía permitirse comprobar
 * y dejar que el INSERT siguiera su curso porque era el mismo; nosotros
 * tenemos que hacer las dos cosas juntas o no vale de nada.
 */
async function registrarInteraccionConCuota(fila) {
  const puntos = Number(fila.puntos) || 0;

  /* Sin expositor o sin puntos positivos no hay cuota que gastar: es la misma
     salida temprana del disparador, y evita abrir una transacción para nada. */
  if (!fila.expositor_id || puntos <= 0) {
    const r = await bd('datos').consultar('INSERT INTO ticket_interacciones SET ?', [fila]);
    return { id: r.insertId, cuota: null };
  }

  return bd('datos').transaccion(async (cx) => {
    /* FOR UPDATE sobre el EXPOSITOR y no sobre las interacciones: es la fila
       que representa la bolsa, existe siempre y es una sola. Bloquear el
       conjunto de interacciones sería bloquear un rango que crece. */
    const expo = await cx.unaFila(
      'SELECT id, cuota_puntos FROM networking_expositores WHERE id = ? FOR UPDATE',
      [fila.expositor_id],
    );
    if (!expo) throw new Error('Ese stand no existe.');

    /* Cuota nula = sin tope. Igual que en el disparador. */
    if (expo.cuota_puntos == null) {
      const r = await cx.consultar('INSERT INTO ticket_interacciones SET ?', [fila]);
      return { id: r.insertId, cuota: null };
    }

    const { otorgados } = await cx.unaFila(
      `SELECT COALESCE(SUM(CASE WHEN puntos > 0 THEN puntos ELSE 0 END), 0) AS otorgados
         FROM ticket_interacciones WHERE expositor_id = ?`,
      [fila.expositor_id],
    );

    const restantes = Math.max(0, expo.cuota_puntos - otorgados);
    if (otorgados + puntos > expo.cuota_puntos) {
      /* El mensaje conserva el formato del original —cuánto lleva, de cuánto y
         cuánto queda— porque es lo que lee quien está en el stand con la fila
         esperando, y "cuota agotada" a secas no le dice si puede dar 5. */
      const e = new Error(
        `CUOTA_STAND_AGOTADA: este stand ya repartió ${otorgados} de sus ${expo.cuota_puntos} puntos; le quedan ${restantes}.`,
      );
      e.code = 'CUOTA_STAND_AGOTADA';
      e.restantes = restantes;
      throw e;
    }

    const r = await cx.consultar('INSERT INTO ticket_interacciones SET ?', [fila]);
    return { id: r.insertId, cuota: { otorgados: otorgados + puntos, tope: expo.cuota_puntos } };
  });
}

/* ── 2 · Los inscritos de un sub-evento ───────────────────────────────────
 *
 * Original: `private.fn_sync_inscritos_sesion`, disparador sobre
 * `sesion_inscripciones`. Recalcula `agenda_sessions.inscritos` contando las
 * inscripciones no canceladas.
 *
 * Se RECUENTA en vez de sumar uno. Es más caro y es correcto: un contador que
 * se incrementa se desincroniza para siempre a la primera fila que se borre
 * por fuera —una limpieza, una migración, un DELETE manual—, y nadie se entera
 * hasta que un taller dice 30 inscritos y hay 28. El original también recuenta.
 */
async function sincronizarInscritos(cx, sessionId) {
  if (!sessionId) return null;
  const { n } = await cx.unaFila(
    `SELECT COUNT(*) AS n FROM sesion_inscripciones
      WHERE session_id = ? AND estado <> 'cancelada'`,
    [sessionId],
  );
  await cx.consultar('UPDATE agenda_sessions SET inscritos = ? WHERE id = ?', [n, sessionId]);
  return n;
}

/* Inscribir con cupo. Esto NO estaba en el disparador —el cupo se comprobaba
   en el código, antes de insertar— y por eso tenía la carrera: dos personas
   veían el mismo "queda 1" y las dos entraban. Al traerlo aquí se arregla de
   paso, que es la ventaja de mover los contadores al código en vez de
   reescribir el disparador tal cual. */
async function inscribirEnSesion(fila) {
  return bd('datos').transaccion(async (cx) => {
    const sesion = await cx.unaFila(
      'SELECT id, cupo, inscritos FROM agenda_sessions WHERE id = ? FOR UPDATE',
      [fila.session_id],
    );
    if (!sesion) throw new Error('Ese sub-evento no existe.');

    if (sesion.cupo != null) {
      const { n } = await cx.unaFila(
        `SELECT COUNT(*) AS n FROM sesion_inscripciones
          WHERE session_id = ? AND estado <> 'cancelada'`,
        [fila.session_id],
      );
      if (n >= sesion.cupo) {
        const e = new Error('Este sub-evento ya llenó su cupo.');
        e.code = 'CUPO_LLENO';
        throw e;
      }
    }

    const r = await cx.consultar('INSERT INTO sesion_inscripciones SET ?', [fila]);
    const inscritos = await sincronizarInscritos(cx, fila.session_id);
    return { id: r.insertId, inscritos };
  });
}

/* Cambiar el estado de una inscripción (cancelar, reactivar, marcar asistió).
   Recalcula el contador dentro de la misma transacción: si se hiciera después,
   una cancelación y una inscripción simultáneas podrían dejar el número de la
   primera. */
async function cambiarEstadoInscripcion(inscripcionId, estado, extra = {}) {
  return bd('datos').transaccion(async (cx) => {
    const insc = await cx.unaFila(
      'SELECT id, session_id FROM sesion_inscripciones WHERE id = ? FOR UPDATE',
      [inscripcionId],
    );
    if (!insc) throw new Error('Esa inscripción no existe.');
    await cx.consultar('UPDATE sesion_inscripciones SET ? WHERE id = ?', [{ estado, ...extra }, inscripcionId]);
    const inscritos = await sincronizarInscritos(cx, insc.session_id);
    return { inscritos };
  });
}

/* ── 3 · Canjear una recompensa ───────────────────────────────────────────
 *
 * Original: `public.canjear_recompensa(p_user, p_recompensa)`, que el backend
 * llama por RPC.
 *
 * Es la más delicada de las tres. Hace cuatro cosas que tienen que ocurrir
 * todas o ninguna: comprobar el stock, comprobar el saldo, descontar los
 * puntos y crear el canje. Partido en cuatro consultas sueltas se puede
 * canjear dos veces la misma recompensa con el saldo de una.
 *
 * El original ya bloqueaba la recompensa con FOR UPDATE. Aquí se bloquea
 * ADEMÁS el saldo, que el original no hacía: dos canjes de recompensas
 * DISTINTAS por la misma persona no chocaban en la fila de la recompensa, y
 * podían descontar los dos del mismo saldo. Es un fallo del original que se
 * arregla al traerlo, no una diferencia gratuita.
 */
async function canjearRecompensa(userId, recompensaId) {
  return bd('datos').transaccion(async (cx) => {
    const rec = await cx.unaFila(
      'SELECT * FROM recompensas WHERE id = ? FOR UPDATE',
      [recompensaId],
    );
    if (!rec) throw new Error('Recompensa no encontrada.');
    if (!rec.activo) throw new Error('Recompensa no disponible.');
    if (rec.stock != null && rec.canjeados >= rec.stock) throw new Error('Recompensa agotada.');

    /* El saldo, bloqueado. Ver arriba por qué esto no estaba en el original. */
    const bal = await cx.unaFila(
      `SELECT id, puntos FROM puntos_balance
        WHERE user_id = ? AND organizador_id = ? AND audiencia = ? FOR UPDATE`,
      [userId, rec.organizador_id, rec.audiencia],
    );
    const saldo = bal?.puntos ?? 0;
    if (saldo < rec.costo_puntos) {
      const e = new Error(`Puntos insuficientes (tienes ${saldo}, necesitas ${rec.costo_puntos}).`);
      e.code = 'PUNTOS_INSUFICIENTES';
      throw e;
    }

    /* Si nunca hubo saldo (`bal` es undefined), la validación de arriba sólo
       pudo pasar con `costo_puntos === 0` — un premio gratis. En ese caso no
       hay fila que descontar ni falta hacerla: 0 puntos menos 0 sigue siendo
       0. Sin este `if`, `bal.id` sobre un `bal` undefined tronaba justo en
       ese caso, el único donde alguien sin saldo previo podía canjear algo. */
    if (bal) {
      await cx.consultar(
        'UPDATE puntos_balance SET puntos = puntos - ?, updated_at = NOW(6) WHERE id = ?',
        [rec.costo_puntos, bal.id],
      );
    }
    await cx.consultar('UPDATE recompensas SET canjeados = canjeados + 1 WHERE id = ?', [recompensaId]);

    const codigo = codigoCanje();
    await cx.consultar('INSERT INTO canjes SET ?', [{
      user_id: userId, organizador_id: rec.organizador_id, recompensa_id: recompensaId,
      audiencia: rec.audiencia, titulo: rec.titulo, costo_puntos: rec.costo_puntos, codigo,
    }]);

    return { codigo, saldo_restante: saldo - rec.costo_puntos };
  });
}

/* ── 4 · Lo vendido: el aforo del evento y las unidades de cada tipo ──────
 *
 * Original: `public.sumar_aforo_vendido(p_evento, p_delta)` y
 * `public.sumar_vendidos_tipo(p_tipo, p_delta)`, de la migración 0138.
 *
 * ── Por qué estas dos existen, que no es por gusto ───────────────────────
 *
 * Porque ya se perdieron ventas de verdad. Hasta la 0138 el backend leía el
 * contador, le sumaba uno en Node y escribía el resultado. Dos compras a la
 * vez leían el mismo número y la segunda escribía encima de la primera: el
 * aforo decía 100 cuando se habían vendido 101. Se encontró analizando
 * FESTECH —4.485 boletas, pico de 67 ingresos en cinco minutos— y la 0138 lo
 * arregló metiendo la suma DENTRO de una sola sentencia, además de recalcular
 * lo que ya se había perdido.
 *
 * O sea que esto no es un contador más: es el que ya falló. Traerlo a MySQL
 * leyendo y escribiendo desde JavaScript sería volver exactamente al estado
 * anterior a la 0138, con el agravante de que esta vez ya sabemos cómo acaba.
 *
 * ── Por qué aquí NO hace falta `SELECT ... FOR UPDATE` ───────────────────
 *
 * Y es la diferencia con los tres contadores de arriba, así que conviene
 * dejarla escrita en vez de copiar el patrón por costumbre.
 *
 * Aquéllos tienen que LEER algo para DECIDIR —¿queda cuota?, ¿queda cupo?,
 * ¿alcanza el saldo?—, y entre la lectura y la escritura cabe otra sesión. El
 * bloqueo es lo que cierra ese hueco.
 *
 * Aquí no se decide nada: se suma. `UPDATE … SET x = GREATEST(0, COALESCE(x,0) + ?)`
 * es UNA sentencia, y InnoDB toma el bloqueo exclusivo de la fila mientras la
 * ejecuta. Dos sumas simultáneas se serializan solas. Un `FOR UPDATE` delante
 * no añadiría ninguna garantía y sí un viaje más por cada boleta vendida.
 *
 * Es la misma forma del original, que también es una sola sentencia.
 *
 * ── Y entonces para qué la transacción ───────────────────────────────────
 *
 * Para poder devolver el valor nuevo. MySQL no tiene `RETURNING`, así que hay
 * que leerlo con un `SELECT` aparte — y ese `SELECT` sólo dice la verdad si va
 * dentro de la misma transacción que el `UPDATE`: el bloqueo exclusivo sigue
 * puesto hasta el commit, así que nadie pudo tocar la fila en medio, y una
 * transacción siempre ve sus propias escrituras.
 *
 * Fuera de la transacción, el valor leído sería el de después de la suma de
 * OTRO, y un contador que informa mal es peor que uno que no informa.
 *
 * Hoy ninguna de las diez llamadas del código usa lo que devuelve —todas son
 * `await supabase.rpc(...)` a secas—, así que esto es para quien venga.
 */

/* `GREATEST(0, …)` es del original: el contador nunca baja de cero. Importa en
   los reembolsos, que son los únicos que pasan un delta negativo
   (`routes/pagos.js`); sin esto, devolver dos boletas de un evento con una
   vendida dejaría el aforo en -1 y esa resta no se recupera sola. */
const SUMAS = {
  aforo: { tabla: 'eventos',      col: 'aforo_vendido', que: 'evento' },
  tipo : { tabla: 'ticket_types', col: 'vendidos',      que: 'tipo de boleta' },
};

async function sumar(cual, id, delta) {
  const { tabla, col, que } = SUMAS[cual];

  if (!id) throw new Error(`Falta el ${que} al que sumarle ${col}.`);

  /* El original recibe un `int`. Un decimal colado aquí —un `personas` mal
     calculado, un `delta` que llegó como texto— no reventaría: dejaría el
     contador con coma y el aforo dejaría de cuadrar sin que nada lo diga, que
     es el modo de fallo que este módulo entero existe para no tener. */
  if (!Number.isInteger(delta)) {
    throw new Error(`El delta de ${col} tiene que ser un entero; llegó ${JSON.stringify(delta)}.`);
  }

  return bd('datos').transaccion(async (cx) => {
    const r = await cx.consultar(
      `UPDATE ${tabla} SET ${col} = GREATEST(0, COALESCE(${col}, 0) + ?) WHERE id = ?`,
      [delta, id],
    );

    const fila = await cx.unaFila(`SELECT ${col} AS valor FROM ${tabla} WHERE id = ?`, [id]);

    /* Diferencia deliberada con el original: en Postgres, sumarle a un id que
       no existe no hace nada y devuelve NULL, en silencio. Aquí revienta.
       Un contador que no se actualizó porque el id estaba mal es justo lo que
       nadie va a notar hasta que el aforo no cuadre el día del evento, y para
       entonces no hay forma de saber cuántas veces pasó.

       Se mira la fila y no `affectedRows`: MySQL cuenta ahí las filas que
       CAMBIARON, no las que casaron, así que una suma que deja el mismo valor
       —un delta 0, o un GREATEST que ya estaba en 0— devuelve 0 con la fila
       existiendo perfectamente. */
    if (!fila) throw new Error(`No existe el ${que} ${id}: ${col} no se actualizó.`);

    return { valor: Number(fila.valor), cambio: r?.affectedRows ?? null };
  });
}

/* Las dos puertas, con el nombre de lo que cuentan y no del cómo. */
const sumarAforoVendido = (eventoId, delta) => sumar('aforo', eventoId, delta);
const sumarVendidosTipo = (tipoId,   delta) => sumar('tipo',  tipoId,   delta);

/* Diez caracteres en mayúsculas, como el original —`upper(substr(uuid,1,10))`—
   porque los códigos ya emitidos tienen esa forma y se leen en voz alta en un
   mostrador. Sin I, O, 0 ni 1: son las que se confunden al dictarlos. */
function codigoCanje() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 10; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

module.exports = {
  registrarInteraccionConCuota,
  sincronizarInscritos,
  inscribirEnSesion,
  cambiarEstadoInscripcion,
  canjearRecompensa,
  sumarAforoVendido,
  sumarVendidosTipo,
  codigoCanje,
};
