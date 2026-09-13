'use strict';

/* ¿Esta credencial abre esta puerta, ahora?
 *
 * ── Por qué está todo junto ──────────────────────────────────────────────
 *
 * Son cuatro preguntas distintas —¿el QR es de los buenos?, ¿la credencial
 * está vigente?, ¿esta persona está autorizada?, ¿la puerta está abierta a
 * esta hora?— y las cuatro se contestan en el mismo instante, con la persona
 * delante. Repartidas por las rutas acabarían contestándose distinto en cada
 * una: el control de ingreso diría que sí y la puerta del montaje que no, o al
 * revés, que es peor.
 *
 * Aquí no se toca la base. Todo recibe datos y devuelve datos, para que las
 * reglas se puedan probar sin credenciales. Lo que escribe vive en `routes/`.
 *
 * Migración 0127.
 */

/* ── 1 · Los QR que ya se repartieron ───────────────────────────────────
 *
 * Una boleta se reenvía: el correo se perdió, la persona lo pide otra vez, y
 * cada envío firma un token nuevo. Todos llevan el mismo `tid`, así que en la
 * puerta de la BOLETA todos valen — y así tiene que ser: quien imprimió el
 * primer correo entra con él.
 *
 * En un PUESTO eso deja de cumplirse, y por una razón buena: transferirlo rota
 * su credencial y la anterior tiene que morir, o la reventa es un cambio de
 * nombre. Pero comparar el token presentado con el guardado no distingue las
 * dos cosas y mata también el reenvío legítimo.
 *
 * La generación lo hace explícito: reenviar firma otro token de la MISMA
 * generación —y los dos abren—, transferir sube el número y todo lo anterior
 * muere de golpe.
 *
 * `null` o ausente es la generación 0: es lo que llevan los QR firmados antes
 * de la 0127, y es la que tienen todos los puestos que ya existen. Por eso
 * nada hay que reemitir. */
function credencialAlDia({ genDelToken = 0, puesto = null } = {}) {
  const actual = Number(puesto?.credencial_gen) || 0;
  return (Number(genDelToken) || 0) === actual;
}

/* ── 2 · Hasta cuándo abre ───────────────────────────────────────────────
 *
 * La credencial de montaje deja de valer cuando arranca el evento, y la del
 * público no abre el galpón el día del montaje. Sin esto, el montajista del
 * lunes entra gratis el sábado — con un QR legítimo y una firma correcta.
 *
 * Nulo es «sin límite», que es lo que hacen hoy todas las boletas: aplicar la
 * 0127 no cambia el comportamiento de ninguna. */
function vigenciaDelTipo(tipo, ahora = Date.now()) {
  const t = typeof ahora === 'number' ? ahora : new Date(ahora).getTime();
  const desde = tipo?.vigencia_desde ? new Date(tipo.vigencia_desde).getTime() : null;
  const hasta = tipo?.vigencia_hasta ? new Date(tipo.vigencia_hasta).getTime() : null;

  if (desde != null && t < desde) {
    return { vigente: false, motivo: `Esta credencial todavía no abre (empieza el ${cuando(desde)}).` };
  }
  if (hasta != null && t > hasta) {
    return { vigente: false, motivo: `Esta credencial ya venció (terminó el ${cuando(hasta)}).` };
  }
  return { vigente: true, motivo: null };
}

/* ── 3 · Quién responde por esta persona ─────────────────────────────────
 *
 * Registrarse no es estar autorizado. Si lo fuera, quien quiere colarse se
 * registra y ya está: el control se cumple en la letra y no impide nada.
 *
 * Sólo se exige en los tipos que lo piden (`requiere_autorizacion`), que hoy
 * no es ninguno. Una boleta normal no pasa por aquí. */
function autorizacionDelPuesto({ tipo, puesto }) {
  if (!tipo?.requiere_autorizacion) return { ok: true, motivo: null };
  /* Sin puesto no hay a quién autorizar: es una credencial de boleta en un
     tipo que exige acreditar personas. Se para, porque dejarla pasar sería
     justo el agujero — una boleta de montaje sin nombre abriendo la puerta. */
  if (!puesto) return { ok: false, motivo: 'Esta credencial tiene que estar a nombre de una persona.' };
  if (!puesto.autorizado_at) {
    return { ok: false, motivo: 'Esta persona está registrada pero nadie la ha autorizado todavía.' };
  }
  return { ok: true, motivo: null };
}

/* ── 4 · La puerta que abre a sus horas ──────────────────────────────────
 *
 * Vive en `zonas.reglas.horario`, que la 0098 ya dejó anunciado en su propio
 * comentario. Es del sitio y no de la boleta: la misma credencial de expositor
 * abre su stand toda la semana y el galpón sólo durante el montaje. */
function puertaAbierta(puerta, ahora = Date.now()) {
  const h = puerta?.reglas?.horario || puerta?.horario;
  if (!h) return { abierta: true, motivo: null };

  const t = typeof ahora === 'number' ? ahora : new Date(ahora).getTime();
  const desde = h.desde ? new Date(h.desde).getTime() : null;
  const hasta = h.hasta ? new Date(h.hasta).getTime() : null;

  if (desde != null && t < desde) {
    return { abierta: false, motivo: `${puerta.nombre || 'Esta puerta'} abre el ${cuando(desde)}.` };
  }
  if (hasta != null && t > hasta) {
    return { abierta: false, motivo: `${puerta.nombre || 'Esta puerta'} cerró el ${cuando(hasta)}.` };
  }
  return { abierta: true, motivo: null };
}

/* ── El veredicto, de una sola pieza ─────────────────────────────────────
 *
 * Las cuatro juntas y en un orden que no es casual: primero lo que es culpa
 * del sistema o de la configuración (la credencial vencida, la puerta cerrada)
 * y después lo que es culpa de la persona (no está autorizada). Con cien
 * personas esperando, el primer mensaje que sale es el que se lee, y decirle
 * «no estás autorizado» a alguien cuya credencial simplemente venció manda a
 * discutir por lo que no es.
 *
 * Devuelve `{ ok, motivo }`. Nada de esto lanza: en una puerta, una excepción
 * es una fila parada. */
function puedeAbrir({ tipo = null, puesto = null, puerta = null, genDelToken = 0, ahora = Date.now() } = {}) {
  const vig = vigenciaDelTipo(tipo, ahora);
  if (!vig.vigente) return { ok: false, motivo: vig.motivo, causa: 'vigencia' };

  const horario = puertaAbierta(puerta, ahora);
  if (!horario.abierta) return { ok: false, motivo: horario.motivo, causa: 'horario' };

  /* La generación se mira sólo cuando el QR es de un puesto. Un QR de boleta
     no tiene generación que comparar, y ahí todos los reenvíos valen. */
  if (puesto && !credencialAlDia({ genDelToken, puesto })) {
    return { ok: false, motivo: 'Credencial vencida: este puesto se transfirió.', causa: 'transferido' };
  }

  const aut = autorizacionDelPuesto({ tipo, puesto });
  if (!aut.ok) return { ok: false, motivo: aut.motivo, causa: 'sin_autorizar' };

  return { ok: true, motivo: null, causa: null };
}

/* ── Lo que la puerta necesita VER ───────────────────────────────────────
 *
 * La comprobación de verdad en un montaje no la hace el software: la hace
 * quien está en la puerta mirando la cédula. Si el escáner sólo enseña un
 * nombre, no hay nada que comparar y el QR reenviado por WhatsApp abre igual.
 *
 * Va aquí y no en la ruta para que las dos puertas —la del evento y la del
 * montaje— enseñen lo mismo. */
function fichaDeLaPuerta({ puesto, ticket }) {
  return {
    nombre    : puesto?.nombre || ticket?.guest_nombre || null,
    documento : puesto?.documento || null,
    foto_url  : puesto?.foto_url || null,
    telefono  : puesto?.telefono || null,
    /* Quién respondió por esta persona. Es lo que se pregunta cuando algo
       desaparece, y tenerlo en la pantalla del escaneo evita ir a buscarlo. */
    autorizado_por: puesto?.autorizado_por || null,
  };
}

function cuando(ms) {
  return new Date(ms).toLocaleString('es-CO', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

module.exports = {
  credencialAlDia, vigenciaDelTipo, autorizacionDelPuesto, puertaAbierta,
  puedeAbrir, fichaDeLaPuerta,
};
