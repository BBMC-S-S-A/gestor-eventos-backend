'use strict';

/* El perfil de quien entra, traído a MySQL si todavía no está.
 *
 * ══ POR QUÉ EXISTE ════════════════════════════════════════════════════════
 *
 * Medido el 20 de noviembre de 2026, con un usuario real al intentar crear su
 * primer evento:
 *
 *     Cannot add or update a child row: a foreign key constraint fails
 *     (gestek_datos.eventos, CONSTRAINT eventos_owner_id_fkey
 *      FOREIGN KEY (owner_id) REFERENCES profiles (id))
 *
 * No era un fallo de esa petición: era el hueco que dejan las dos banderas
 * mientras conviven.
 *
 *     AUTH_PROPIA   apagada  →  la identidad vive en Supabase
 *     DATOS_PROPIOS encendida →  los datos viven en MySQL
 *
 * En Supabase, la fila de `profiles` la crea un disparador de Postgres:
 *
 *     on_auth_user_created  →  handle_new_user()
 *
 * El backend nunca la escribe. Así que cada persona que se registra nace sólo
 * en Supabase, y MySQL no se entera de que existe. Su `owner_id` apunta a un
 * perfil que allí no está, y la clave ajena lo para — haciendo bien su
 * trabajo: avisar en vez de dejar un evento huérfano.
 *
 * Pasó con cuatro personas en las primeras horas, tres de ellas de
 * organizaciones que estaban montando su evento. Y seguiría pasando con cada
 * registro nuevo hasta cerrar la convivencia.
 *
 * ══ LAS TRES COSAS QUE NO PUEDE HACER ═════════════════════════════════════
 *
 * Esto corre en el camino de autenticación, por donde pasa TODA petición con
 * sesión. Tres reglas, y las tres están probadas:
 *
 *   1. **No puede pesar.** Se consulta a MySQL una sola vez por usuario y por
 *      proceso: el `yaEstan` recuerda a quien ya se comprobó. Sin eso, cada
 *      petición de cada pantalla que se refresca sola añadiría un viaje a la
 *      base — que es exactamente el gasto que la memoria de tokens de
 *      `middleware/auth.js` existe para quitar.
 *
 *   2. **No puede pisar datos.** Si el perfil ya está en MySQL, no se toca
 *      NADA. La fila de MySQL es la buena: es donde la aplicación escribe
 *      desde el corte, así que la de Supabase está congelada y más vieja.
 *      Copiarla encima borraría lo que la persona haya cambiado después.
 *
 *   3. **No puede tumbar el login.** Todo va dentro de un try/catch que se
 *      traga el fallo. Si MySQL no contesta, la petición sigue su camino: el
 *      peor caso es que el evento no se deje crear, que es lo que pasa hoy.
 *      Que un fallo al copiar un perfil deje a alguien sin entrar sería
 *      cambiar un problema por uno peor.
 *
 * ══ POR QUÉ LAS DEPENDENCIAS ENTRAN POR PARÁMETRO ═════════════════════════
 *
 * `sincronizar()` no importa nada: recibe de dónde leer y dónde escribir. Eso
 * deja probar las tres reglas de arriba sin Supabase y sin MySQL, que es
 * donde de verdad se puede equivocar uno. El cableado está en
 * `middleware/auth.js`.
 */

/* Las columnas que se copian. No es `SELECT *` a propósito: el día que
   Supabase gane una columna que MySQL no tiene, un `*` haría fallar el INSERT
   entero por una columna que a nadie le importaba. Esta lista es la
   intersección real, y lo que falte se queda en su valor por defecto.

   `created_at` y `updated_at` van explícitas para conservar cuándo se
   registró la persona. Sin ellas, MySQL pondría la hora de la copia y todo el
   mundo parecería haberse registrado el mismo día. */
const COLUMNAS = [
  'id', 'email', 'nombre', 'handle', 'avatar_url', 'telefono',
  'ciudad', 'empresa', 'ocupacion', 'rol', 'puntos', 'nivel',
  'empresa_logo_url', 'bio', 'created_at', 'updated_at',
];

/* Quién ya se comprobó en ESTE proceso. Un Set de ids, no de perfiles: lo
   único que hace falta recordar es «a éste ya lo miré».

   Se vacía al reiniciar, y está bien que así sea: después de un reinicio se
   vuelve a comprobar una vez por usuario, que es barato y además recoge a
   quien se haya registrado mientras tanto. */
const yaEstan = new Set();

/* Tope, por la misma razón que lo tiene la memoria de tokens: un proceso
   largo con mucha gente no debe crecer sin límite. Un id son 36 bytes, así
   que veinte mil son menos de un mega — pero un tope que existe es una
   decisión, y uno que no existe es un descuido. */
const MAX_RECORDADOS = 20000;

function recordar(id) {
  if (yaEstan.size >= MAX_RECORDADOS) {
    /* Un Set conserva el orden de inserción: fuera los más viejos. */
    const sobran = yaEstan.size - MAX_RECORDADOS + 1;
    let i = 0;
    for (const k of yaEstan) { if (i++ >= sobran) break; yaEstan.delete(k); }
  }
  yaEstan.add(id);
}

/* ── El trabajo ───────────────────────────────────────────────────────────
 *
 * `leerDeOrigen(id)` devuelve el perfil de Supabase, o null.
 * `base` es el objeto de `core/db/mysql.js`: `.consultar(sql, params)`.
 *
 * Devuelve qué hizo, para que las pruebas y el log puedan distinguir los
 * casos: 'ya-estaba' | 'copiado' | 'sin-origen' | 'fallo'.
 */
async function sincronizar(id, { base, leerDeOrigen, avisar = () => {} }) {
  if (!id || yaEstan.has(id)) return 'ya-estaba';

  try {
    const hay = await base.consultar(
      'SELECT 1 AS n FROM `profiles` WHERE `id` = ? LIMIT 1', [id]);
    if (hay.length) { recordar(id); return 'ya-estaba'; }

    const perfil = await leerDeOrigen(id);
    if (!perfil) {
      /* Autenticó pero no tiene perfil ni en Supabase. No se inventa uno:
         sin saber su correo ni su nombre, la fila que saldría sería peor que
         ninguna. Tampoco se recuerda, para volver a mirar en la siguiente. */
      avisar(`[perfiles] ${id} autenticó y no tiene perfil en el origen`);
      return 'sin-origen';
    }

    const columnas = COLUMNAS.filter(c => c in perfil);
    await base.consultar(
      `INSERT IGNORE INTO \`profiles\` (${columnas.map(c => `\`${c}\``).join(', ')})
       VALUES (${columnas.map(() => '?').join(', ')})`,
      columnas.map(c => valorParaMysql(perfil[c])));

    recordar(id);
    avisar(`[perfiles] ${id} copiado de Supabase a MySQL (se registró después del corte)`);
    return 'copiado';
  } catch (e) {
    /* La regla 3. No se recuerda, así que la siguiente petición lo reintenta. */
    avisar(`[perfiles] no pude copiar ${id}: ${e.message}`);
    return 'fallo';
  }
}

/* `INSERT IGNORE` y no `ON DUPLICATE KEY UPDATE`: si entre la comprobación y
   el INSERT otra petición de la misma persona ya lo metió —dos pestañas
   abiertas bastan—, lo que se quiere es no hacer nada, no sobreescribir.
   La regla 2 otra vez, ahora contra una carrera. */

/* Mismo criterio que `scripts/volcar-datos.js`: los objetos y arrays van a
   columnas JSON como texto. PostgREST entrega `branding` ya parseado. */
function valorParaMysql(v) {
  if (v !== null && v !== undefined && typeof v === 'object'
      && !(v instanceof Date) && !Buffer.isBuffer(v)) {
    return JSON.stringify(v);
  }
  return v === undefined ? null : v;
}

module.exports = { sincronizar, COLUMNAS, _yaEstan: yaEstan, _MAX_RECORDADOS: MAX_RECORDADOS };
