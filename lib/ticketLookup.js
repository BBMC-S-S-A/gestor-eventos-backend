/* Helpers compartidos para resolver una boleta (escarapela) por su QR firmado
   o su código corto, y generar códigos de canje. Los usan el escáner de staff
   (routes/interacciones.js) y el panel del expositor (routes/expositor.js). */

const supabase = require('./supabase.js');
const { verifyTicketQR } = require('./qr.js');

/* Resuelve el ticket de un asistente por qr_token firmado o por código corto,
   siempre acotado al evento indicado. */
async function resolverTicket(eventoId, { qr_token, codigo }) {
  const SEL = 'id, evento_id, codigo, guest_nombre, user_id, estado, ticket_type_id, tipo:ticket_types!ticket_type_id(nombre)';
  if (qr_token) {
    const r = verifyTicketQR(qr_token);
    if (!r.ok) throw new Error('QR inválido.');
    if (r.evento_id !== eventoId) throw new Error('Este QR es de otro evento.');

    /* Si el QR es de un PUESTO, su credencial rota — al transferirlo se firma
       de nuevo. Verificar la firma no puede notar eso: el token viejo lleva
       una firma nuestra igual de buena y los QR no caducan. Hay que comparar
       con lo que guarda la base, o quien vendió su puesto sigue sumando puntos
       y canjeando en los stands con el QR que ya no es suyo.
       Lo mismo que hace la puerta en `lib/puertaDePuestos.js`. */
    if (r.puesto_id) {
      const { comprobado, fila } = await tokenVigenteDelPuesto(r.puesto_id);
      if (comprobado) {
        if (!fila) throw new Error('Este QR apunta a un puesto que ya no existe.');
        if (fila.qr_token !== qr_token) {
          throw new Error('Este QR ya no sirve: el puesto se transfirió y tiene un código nuevo.');
        }
      }
    }

    const { data } = await supabase.from('tickets').select(SEL).eq('id', r.ticket_id).maybeSingle();
    return data;
  }
  const { data } = await supabase.from('tickets').select(SEL)
    .eq('codigo', String(codigo || '').toUpperCase().trim()).eq('evento_id', eventoId).maybeSingle();
  return data;
}

/* El token que la base tiene HOY para ese puesto.
 *
 * Hay que separar dos cosas que se parecen y significan lo contrario:
 *
 *   `comprobado: false`  no se pudo mirar —sin la 0118 aplicada no hay tabla—.
 *                        Se sigue como antes: una migración que falta no puede
 *                        dejar sin escanear a un evento entero.
 *   `fila: null`         se miró y ese puesto NO existe. Eso sí es un QR que no
 *                        vale: apunta a algo borrado.
 *
 * Con un `null` para las dos, un puesto borrado pasaba por la puerta.
 */
async function tokenVigenteDelPuesto(puestoId) {
  try {
    const { data, error } = await supabase
      .from('ticket_puestos').select('id, qr_token').eq('id', puestoId).maybeSingle();
    if (error) return { comprobado: false, fila: null };
    return { comprobado: true, fila: data || null };
  } catch { return { comprobado: false, fila: null }; }
}

function codigoCanje() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 8; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

module.exports = { resolverTicket, codigoCanje };
