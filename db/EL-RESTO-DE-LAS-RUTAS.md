# El resto de las rutas — qué queda, y cómo se hace

Lo último grande de la fase 6: que las rutas dejen de hablarle a Supabase y le
hablen a MySQL. Este documento mide el frente y propone el camino. Escrito el
**27 de octubre de 2026**; todos los números salen de contar el código de hoy,
no de recordarlo.

Lo demás de la fase 6 ya está: el esquema (`008`), los contadores atómicos, las
semillas, el cableado de lo vendido y los arrays. El estado completo, en
`CORTE.md` §10.

---

## 1 · El tamaño, medido

| | |
|---|---|
| Llamadas `.from(...)` | **1.152** |
| Archivos que las contienen | **95** |
| Tablas distintas que tocan | **86** |

> `CORTE.md` decía «43 archivos». Era el número de archivos que *mencionan*
> supabase, no los que consultan. Queda corregido aquí.

### Lo que de verdad se usa de la API

Esto es lo que decide si el camino B de abajo es viable, así que está contado
con cuidado — separando los métodos de supabase-js de los de JavaScript, que
se llaman igual:

| Lectura | | Escritura | |
|---|---|---|---|
| `.select('…')` | 769 | `.update()` | 190 |
| `.eq()` | 1.330 | `.insert()` | 140 |
| `.maybeSingle()` | 378 | `.delete()` | 112 |
| `.order()` | 225 | `.upsert()` | 13 |
| `.single()` | 136 | | |
| `.limit()` | 82 | **Contar** | |
| `.is()` | 65 | `count: 'exact'` | 53 |
| `.or()` | 28 | | |
| `.ilike()` | 28 | **Funciones** | |
| `.not()` | 22 | `.rpc()` distintas | 12 |
| `.in()` | 18 | | |
| `.range()` | 18 | | |
| `.gte()` `.gt()` `.lt()` `.lte()` | 25 | | |
| `.neq()` | 31 | | |
| `.match()` | 6 | | |

> **`.filter(col, op, val)` de supabase: CERO.** Un recuento ingenuo da 200,
> pero las 157 son `Array.prototype.filter`. Se dice porque es justo el tipo
> de número que hace parecer imposible algo que no lo es.

### Las dos cosas que no son mecánicas

**1 · Los 66 `select` con JOIN embebido.** La sintaxis de PostgREST para traer
una tabla relacionada dentro del mismo `select`:

```js
.select('*, autor:profiles!autor_id(id, nombre, avatar_url)')
.select('custom_permissions, rol_detail:event_roles!rol_id(permissions)')
```

Eso es un `LEFT JOIN` con el resultado anidado dentro de cada fila. Es **la
parte cara** de cualquiera de los dos caminos, y la que hay que hacer bien:
una de ellas la usa `lib/acceso.js`, o sea el guardia de los permisos.

**2 · Las 12 funciones (`.rpc`).** Ya tienen sitio decidido y la mayoría,
hecho:

| Función | Dónde va en MySQL | Estado |
|---|---|---|
| `sumar_aforo_vendido`, `sumar_vendidos_tipo` | `modules/contadores/` | ✅ hecho y cableado |
| `aforo_zonas` ×4 | `modules/aforo/consultas.js` | ✅ escrito, sin cablear |
| `canjear_recompensa` | `modules/contadores/` | ✅ escrito, sin cablear |
| `retener_espacio`, `liberar_espacio`, `confirmar_espacio` | pendiente | ⬜ |
| `promocion_consumir` | pendiente | ⬜ |
| `find_pending_reminders` | pendiente | ⬜ |
| `oauth_barrer` | dos `delete`, trivial | ⬜ |
| `generar_recordatorios_inapp` | **está rota** — su tabla ya no existe | borrar |

---

## 2 · Los dos caminos

### Camino A · Reescribir las 1.152 llamadas

Sacar cada consulta a una capa de repositorio por dominio
(`modules/eventos/repositorio.js`, `modules/tickets/…`) y cambiar los 95
archivos.

**A favor:** el SQL queda a la vista, se puede optimizar consulta por consulta,
y no se depende de ningún envoltorio.

**En contra, y pesa mucho:** son 1.152 ediciones a mano. Cada una es una
oportunidad de equivocarse, y el modo de fallo de este proyecto ya lo
conocemos — una consulta mal traducida no revienta, devuelve de más o de
menos. Encima no se puede hacer a medias: `DATOS_PROPIOS` enciende todo a la
vez, así que hasta la última de las 1.152 no se puede probar nada de verdad.

### Camino B · Un adaptador que hable el mismo idioma ← **recomendado**

Implementar el subconjunto medido arriba sobre MySQL, y que `lib/supabase.js`
devuelva el cliente de verdad o el adaptador según `DATOS_PROPIOS`:

```js
module.exports = config.DATOS_PROPIOS
  ? require('../core/db/postgrest.js')   // el adaptador sobre MySQL
  : clienteSupabase;
```

**Las 1.152 llamadas no se tocan.** Siguen escritas igual y empiezan a hablar
con MySQL el día que se mueva la bandera.

**A favor:**

- Una pieza que probar en vez de 1.152 que revisar, y se prueba **contra un
  MySQL de verdad**, sin montar rutas ni servidor.
- El trabajo es acotado y ya está medido: ~20 métodos, los JOIN embebidos y
  el contar.
- Se puede ir construyendo y probando sin que nada cambie en producción,
  porque la bandera sigue apagada.
- Volver atrás es apagar la bandera.

**En contra:**

- Un adaptador **al 95% es peligroso**: lo que no cubra bien devuelve datos
  equivocados en silencio, que es exactamente el fallo que este proyecto
  arrastra. Por eso la regla de abajo no es negociable.
- Hay semántica fina que hay que decidir y escribir: dónde ordena los NULL
  cada motor, si `ilike` casa igual con el cotejo `utf8mb4_0900_as_ci`
  (acento-sensible, mayúscula-insensible), y si `count` cuenta antes o después
  del `limit`.
- `.or()` trae su propia gramática (`and(a.eq.1,b.eq.2)`) y hay que
  interpretarla. Son 28 usos, con cinco formas distintas.

> ### La regla que hace que B sea seguro
>
> **Lo que el adaptador no sepa hacer, revienta.** Nunca devuelve una lista
> parcial, ni ignora un filtro que no entiende, ni adivina.
>
> Un error ruidoso el día de la prueba cuesta diez minutos. Una lista a la que
> le faltan filas el día del evento no se nota hasta que alguien no aparece en
> la puerta.

---

## 3 · El plan, si se toma el camino B

Cada tramo deja algo que se puede probar solo, y ninguno cambia nada mientras
`DATOS_PROPIOS` siga apagada.

| # | Qué | Cómo se comprueba |
|---|---|---|
| 1 | El esqueleto: `from`, `select` de columnas, `eq`, `order`, `limit`, `single`/`maybeSingle`, y el **reventar** ante lo no soportado | Contra MySQL real, tabla por tabla |
| 2 | El resto de filtros: `in`, `is`, `neq`, `not`, `gt/gte/lt/lte`, `ilike`, `match` | Idem, caso por caso |
| 3 | Escrituras: `insert`, `update`, `delete`, `upsert` — y el `JSON.stringify` de las 8 columnas de array | Idem |
| 4 | `count` y `range`, con la semántica escrita | Comparando contra Postgres |
| 5 | **Los 66 JOIN embebidos** | Empezando por el de `lib/acceso.js`, con la prueba de permisos en verde |
| 6 | `.or()` y su gramática | Las cinco formas que hay hoy |
| 7 | Las 12 `.rpc()` que faltan | Una por una |
| 8 | La comparación final: las mismas consultas contra los dos motores | `scripts/comparar-bases.js` ampliado |

---

## 4 · Lo que hay que decidir antes de empezar

1. **¿A o B?** Lo de arriba recomienda B, y la razón de fondo es que 1.152
   ediciones a mano en un sistema cuyo modo de fallo es el silencio no es un
   plan: es una apuesta.
2. **¿Qué se hace con `generar_recordatorios_inapp`?** Está rota desde hace
   tiempo —lee una tabla que ya no existe— y lo que corresponde es borrarla.
   El `drop` está escrito en el comentario de la `0139`.
3. **El cotejo.** `utf8mb4_0900_as_ci` es acento-SENSIBLE: «Bogota» no casa
   con «Bogotá», y en Postgres con `ilike` tampoco. Parece que coinciden, pero
   conviene comprobarlo con datos reales antes de dar por buena la búsqueda
   del mostrador.
