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

### Camino B · Un adaptador que hable el mismo idioma ← **ELEGIDO**

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

| # | Qué | Cómo se comprueba | |
|---|---|---|---|
| 1 | El esqueleto: `from`, `select` de columnas, `eq`, `order`, `limit`, `single`/`maybeSingle`, y el **reventar** ante lo no soportado | Contra MySQL real, tabla por tabla | ✅ |
| 2 | El resto de filtros: `in`, `is`, `neq`, `not`, `gt/gte/lt/lte`, `ilike`, `match` | Idem, caso por caso | ⬜ |
| 3 | Escrituras: `insert`, `update`, `delete`, `upsert` — y el `JSON.stringify` de las 8 columnas de array | Idem | ⬜ |
| 4 | `count` y `range`, con la semántica escrita | Comparando contra Postgres | ⬜ |
| 5 | **Los 66 JOIN embebidos** | Empezando por el de `lib/acceso.js`, con la prueba de permisos en verde | ⬜ |
| 6 | `.or()` y su gramática | Las cinco formas que hay hoy | ⬜ |
| 7 | Las 12 `.rpc()` que faltan | Una por una | ⬜ |
| 8 | La comparación final: las mismas consultas contra los dos motores | `scripts/comparar-bases.js` ampliado | ⬜ |

---

## 4 · Lo que hay que decidir antes de empezar

1. ~~**¿A o B?**~~ **DECIDIDO: B**, el 27 de octubre de 2026. La razón de
   fondo es que 1.152 ediciones a mano en un sistema cuyo modo de fallo es el
   silencio no es un plan: es una apuesta.
2. **¿Qué se hace con `generar_recordatorios_inapp`?** Está rota desde hace
   tiempo —lee una tabla que ya no existe— y lo que corresponde es borrarla.
   El `drop` está escrito en el comentario de la `0139`.
3. **El cotejo.** `utf8mb4_0900_as_ci` es acento-SENSIBLE: «Bogota» no casa
   con «Bogotá», y en Postgres con `ilike` tampoco. Parece que coinciden, pero
   conviene comprobarlo con datos reales antes de dar por buena la búsqueda
   del mostrador. Entra en el tramo 2, con `ilike`.

---

## 5 · Lo que lleva hecho el adaptador

**`core/db/postgrest.js`** — tramo 1, escrito el 27 de octubre de 2026.

Cubre `from`, `select` de columnas, `eq` (incluido `eq(col, null)` → `IS NULL`),
`order`, `limit`, `single` y `maybeSingle`. Todo lo demás **lanza**, con un
mensaje que dice a qué tramo pertenece.

### Las tres decisiones que no se ven en la firma

**1 · Lo no soportado LANZA, no devuelve `{ error }`.** Muchas de las 1.152
están escritas `const { data } = await …`, tirando el error. Un error devuelto
sería una lista vacía en silencio, que es el modo de fallo que el adaptador
existe para evitar. Los errores de SQL de verdad SÍ vuelven como `{ error }`,
porque es lo que hace supabase-js hoy.

**2 · El orden de los NULL.** Es la trampa fina, y no da error: ordena, y
ordena distinto. Medido el 27-oct con una tabla de tres filas, una con la
fecha a NULL:

| | ASC | DESC |
|---|---|---|
| Postgres 17.6 (Supabase, producción) | `1,3,2` | `2,3,1` |
| MySQL 8.0.46 a pelo | `2,1,3` ❌ | `3,1,2` ❌ |
| MySQL con el adaptador | `1,3,2` ✅ | `2,3,1` ✅ |

Está cambiado **en los dos sentidos**. Se arregla ordenando primero por
`(col IS NULL)`. Sin eso, cualquier lista ordenada por una columna que admita
NULL sale con los sin-valor donde no van — y nadie lo reporta como fallo.

**3 · `single()` pide `LIMIT 2`.** No es optimización: tiene que distinguir
«una» de «más de una», y con dos filas ya se sabe. Si quien llama puso su
propio `limit`, manda el suyo.

### Cómo se prueba

| Archivo | Qué | Corre |
|---|---|---|
| `test/postgrest.compila.test.js` | el SQL que se genera (`compilar()` es pura) | siempre, también en el CI |
| `test/postgrest.contraMysql.test.js` | que ese SQL hace lo que se cree | `MYSQL_PRUEBAS=1 npm test` |

La parte de integración está tras bandera porque el CI no tiene MySQL, y una
prueba que falla todos los días acaba borrada. Levanta su propia base, la llena
y la borra; no toca ninguna del proyecto.

### Lo que NO está cableado todavía

`lib/supabase.js` **sigue devolviendo el cliente de Supabase siempre.** El
cambio de la cabecera de este documento —

```js
module.exports = config.DATOS_PROPIOS ? require('../core/db/postgrest.js') : clienteSupabase;
```

— se hace al final, cuando los ocho tramos estén. Cablearlo ahora no rompería
nada (la bandera está apagada), pero dejaría escrito que el adaptador está
listo cuando le faltan siete tramos.
