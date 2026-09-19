/* Quién tiene boleta y nunca recibió el correo con ella.
 *
 * Nace de FESTECH: del 13 al 18-sep el correo salió por un camino que no
 * dejaba rastro y con un remitente sin verificar, y se emitieron miles de
 * boletas cuyo correo nadie sabe si llegó. `reintentarFallidos` no alcanza:
 * sólo reencola lo que PASÓ por la cola y falló, y la mayoría nunca pasó.
 *
 * La regla es por código de boleta: una boleta activa con correo cuenta como
 * «ya lo tiene» si en `email_cola` hay un correo de tipo `ticket` con su código
 * enviado, o pendiente de salir. Todo lo demás —fallidos y lo que no dejó
 * rastro— se considera sin correo. Reenviar a alguien que sí lo recibió por el
 * camino sin rastro es el precio de no saberlo, y es mucho menor que dejar sin
 * boleta a quien no la tiene. */

const supabase = require('./supabase.js');

const ACTIVAS = ['emitido', 'pagado', 'usado'];
const YA_LO_TIENE = ['enviado', 'pendiente', 'enviando'];

async function todas(consulta, tam = 1000) {
  const filas = [];
  for (let desde = 0; ; desde += tam) {
    const { data, error } = await consulta().range(desde, desde + tam - 1);
    if (error) throw new Error(error.message);
    filas.push(...(data || []));
    if (!data || data.length < tam) return filas;
  }
}

async function boletasSinCorreo(eventoId) {
  const boletas = await todas(() => supabase
    .from('tickets')
    .select('id, codigo, qr_token, guest_nombre, guest_email, tipo:ticket_types!ticket_type_id(nombre)')
    .eq('evento_id', eventoId)
    .in('estado', ACTIVAS)
    .not('guest_email', 'is', null)
    .order('created_at', { ascending: true }));

  const enCola = await todas(() => supabase
    .from('email_cola')
    .select('ctx')
    .eq('evento_id', eventoId)
    .eq('tipo', 'ticket')
    .in('estado', YA_LO_TIENE));
  const conCorreo = new Set(enCola.map(f => String(f.ctx?.codigo || '').toUpperCase()).filter(Boolean));

  return boletas.filter(b => b.guest_email.includes('@') && !conCorreo.has(String(b.codigo).toUpperCase()));
}

module.exports = { boletasSinCorreo, ACTIVAS, YA_LO_TIENE };
