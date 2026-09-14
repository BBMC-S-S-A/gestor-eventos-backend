# Quién entra al montaje

**Estado:** implementado. Migraciones `0127` y `0128`.

Cómo se monta el control de acceso de una cuadrilla de montaje, y qué decide
cada casilla. Si sólo vas a leer una cosa, lee «Los seis pasos».

---

## El problema

Los dos días antes del evento llegan cuadrillas a armar los stands y el recinto
se llena de herramienta suelta. No hay forma de distinguir a quien viene a
trabajar de quien pasaba por ahí.

**Lo que NO se hizo:** meterlos en el equipo del evento. `event_members` es
gente con cuenta y permisos del panel — está para operar GESTEK, no para entrar
al recinto. Habría que pedirle correo y contraseña a sesenta montajistas que no
lo van a abrir nunca.

Un montajista no es staff: es **una persona acreditada con una credencial de
alcance limitado**, y esa forma ya existía desde la 0118 (`ticket_puestos`: una
persona dentro de una boleta, con documento y QR propio).

---

## Los seis pasos

1. **Crea un tipo de boleta «Montaje»** en *Comercial → Boletas*, precio 0.
2. En **Avanzado → La credencial**, pon:
   - **Abre desde / Deja de abrir**: los días del montaje. Esto es distinto de
     la fecha límite de venta — una credencial se emite en septiembre y abre
     dos días de noviembre.
   - **Cada persona tiene que ser autorizada**: marcado.
   - **¿Quién autoriza?**: lee más abajo antes de decidir.
   - **No mostrar en la página pública**: marcado.
3. Pon cuántas personas entran por boleta (los puestos) y el modo `anfitrion`.
4. **Emite una boleta por stand** como cortesía, a nombre del expositor.
5. Mándale a cada stand su enlace: **`/acreditar/<código de la boleta>`**. Ahí
   inscribe a su cuadrilla — nombre, documento, teléfono y foto. Sin cuenta.
6. **Autoriza** desde *Asistentes → Quién entra*. Hasta que lo hagas, esas
   personas no tienen credencial.

Opcional pero recomendado: crea una **puerta «Montaje»** en accesos y ponle el
horario y los tipos de boleta que admite. Sin eso, la credencial de montaje
abre cualquier puerta dentro de su vigencia.

---

## Las tres decisiones que importan

### Vigencia — hasta cuándo abre

Sin esto, el montajista del lunes entra gratis el sábado con un QR legítimo y
una firma correcta. Y al revés: la boleta del público abre el galpón el día del
montaje.

Vacío es «sin límite», que es lo que hacen todas las boletas normales.

### Autorización — quién responde por esta persona

Registrarse **no** es estar autorizado. Si lo fuera, quien quiere colarse se
registra y ya está: el control se cumple en la letra y no impide nada.

Con la casilla marcada, el puesto se inscribe pero **no recibe QR** hasta que
alguien lo aprueba. Y aprobar exige documento: sin él la puerta no tiene con
qué comparar.

Cambiar el nombre o el documento de alguien ya aprobado lo devuelve a
pendiente. Es el hueco por donde se cuela quien quiere — inscribir a alguien
presentable, esperar la aprobación, cambiar el nombre.

### ¿Quién autoriza? — el caso de las seis de la mañana

> «El que iba se enfermó. Vino el primo.»

Es el caso que decide si todo esto sirve o se rodea. Si sólo autoriza la
organización y no hay nadie hasta las nueve, las salidas son: el stand no se
monta, el primo entra con el QR del otro, o el guardia lo deja pasar de palabra
y no queda registro de nadie. **La tercera gana siempre.**

Con **«también quien tiene el código de la boleta»**, el stand acredita al
sustituto desde su enlace y queda escrito que él respondió. La cadena no se
rompe, se alarga un eslabón: el evento responde por el stand, el stand por su
cuadrilla.

Sustituir **no** es corregir un nombre: cambia de persona, y la credencial del
que no vino deja de abrir en el acto.

---

## Qué pasa en la puerta

El escáner de siempre (*Asistentes → Escanear*). Al leer una credencial de
montaje, además del sí/no aparece la **ficha**: foto, nombre y documento en
grande. Esa comparación no la hace el software — la hace quien está en la
puerta mirando la cédula.

La ficha sale también en los rechazos, para poder decirle a la persona qué pasa
y a quién preguntar. Los tres motivos posibles:

| Mensaje | Qué pasó |
|---|---|
| «Esta credencial ya venció» | Fuera de la vigencia del tipo |
| «Esta puerta abre el…» | Fuera del horario de esa puerta |
| «Está registrada pero nadie la ha autorizado» | Falta el paso 6 |
| «Credencial vencida: este puesto se transfirió» | Es el QR de quien fue sustituido |

---

## Avisos

Cuando alguien se inscribe y queda pendiente, se avisa a quien tiene permiso
para autorizar. **Un aviso vivo a la vez**: mientras el anterior siga sin leer
no se manda otro, porque cuarenta stands con seis montajistas cada uno son
doscientas cuarenta notificaciones y eso enseña a silenciar la campana.

Por eso el aviso dice «al menos N»: la cifra exacta está en la pantalla.

---

## Lo que todavía no está

- **Un resumen la noche antes.** Hoy el aviso es al inscribirse. Un digest
  programado —«mañana entran 34, te faltan 6 por autorizar»— necesita
  engancharse al cron de recordatorios, que sigue viviendo en Supabase.
- **Registrar la herramienta que entra y sale.** Es lo que más miedo da y lo
  que peor se sostiene: exige inventario por stand y alguien contando cajas.
  Primero conviene rodar quién entra y quién responde.
- **Salida obligatoria al cerrar la jornada.** El vaivén ya existe
  (*Reingreso*), pero nada obliga a usarlo. Con eso, a las ocho de la noche
  habría una lista de quién sigue dentro.

## Datos personales

Un registro con documento y foto de trabajadores de terceros es dato personal y
tiene finalidad y plazo de conservación. La foto vive en una carpeta privada y
sólo se sirve con enlace firmado de quince minutos, pero **la política de
retención hay que definirla**: conviene pasarlo por legal-radar antes de usarlo
en un evento real.
