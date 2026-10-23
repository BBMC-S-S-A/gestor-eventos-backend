# GESTEK — API (gestor-eventos-backend)

API de **GESTEK**, una plataforma de marca blanca para organizar eventos. Cada
organizador monta la página pública de su evento, vende o regala boletas con
QR, controla la puerta (ingreso, reingreso, zonas y aforo), gestiona su equipo,
la agenda, los sub-eventos, torneos, la rueda de networking y los reportes.

Este repositorio es el backend (Express). La interfaz está en
[gestor-eventos-frontend](https://github.com/BBMC-S-S-A/gestor-eventos-frontend).

## En producción

| | URL |
|---|---|
| Web | https://gestekeventost.dpdns.org |
| API | https://api.gestekeventost.dpdns.org (`/health` devuelve el commit desplegado) |

## Uso real

**FESTECH Ibagué** (Alcaldía de Ibagué), del 17 al 19 de septiembre de 2026:

- 4.485 boletas emitidas y 3.334 personas con ingreso registrado en los tres
  días; el día de más asistencia, 1.555.
- Pico de 67 ingresos en 5 minutos por una sola puerta.
- El análisis posterior encontró que los contadores de aforo perdían ventas
  simultáneas (se leían en Node y se escribía el valor + 1). La migración
  `0138` los volvió atómicos (`update … set x = x + n` en una sola sentencia) y
  recalculó lo perdido.

## Arquitectura

```
Navegador (React + Vite, PWA)
   │
   ├──► cPanel / Apache ── sitio estático (gestekeventost.dpdns.org)
   │
   ├──► cPanel / Passenger ── Express 5 · Node 20 (api.gestekeventost.dpdns.org)
   │                            │
   │                            ├──► Supabase Postgres   datos (service role, RLS activo)
   │                            ├──► SMTP / Gmail / Resend   correo
   │                            ├──► Mercado Pago · Wompi    pagos del organizador
   │                            └──► Anthropic · Gemini · Groq   asistente IA
   │
   └──► Supabase directo ── Auth (Google), Storage (3 buckets), Realtime (chat)
```

La API concentra la lógica de negocio y los permisos; el frontend solo habla
directo con Supabase para iniciar sesión, subir archivos y el chat en tiempo
real. El acceso a la base pasa por `lib/supabase.js`, lo que permite cambiar el
motor detrás sin tocar las rutas.

### Antes y ahora

| | Antes | Ahora |
|---|---|---|
| Hosting de la API | Render | cPanel con Passenger (desde **2026-09-17**) |
| Hosting de la web | Vercel | cPanel (desde **2026-09-17**) |
| Build de la web | `npm ci` + `vite build` dentro de cPanel | GitHub Actions construye y publica en la rama `deploy`; cPanel solo copia (desde **2026-09-21**) |
| Base y auth | Supabase | Supabase; **migración a MySQL en cPanel en curso** |

**Migración fuera de Supabase (en curso).** Las bases `gestek_auth` y
`gestek_datos` existen en el MySQL de cPanel y el código ya tiene la capa
propia (`core/db/mysql.js`, `modules/auth`, `modules/archivos`), detrás de las
banderas `AUTH_PROPIA` y `ARCHIVOS_PROPIOS`, **apagadas en producción**. La
regla es que Supabase no se apaga hasta que lo nuevo esté conectado y
comparado (`scripts/comparar-bases.js`). Detalle en `db/CAMINO-A.md`.

## Herramientas e infraestructura

| Área | Herramienta | Notas |
|---|---|---|
| Hosting | cPanel (Passenger) | Despliegue manual con *Git Version Control → Deploy HEAD Commit* (`.cpanel.yml`) |
| Base de datos | Supabase Postgres | RLS, `pg_cron`; 138 migraciones numeradas en `db/migrations/` |
| Base futura | MySQL 8 en cPanel | Esquema y migraciones en `db/esquema/` y `db/migraciones/` |
| Autenticación | Supabase Auth (Google y correo) | Auth propia con JWT lista tras `AUTH_PROPIA` |
| Archivos | Supabase Storage | `avatars`, `event-media`, `form-uploads` |
| Tiempo real | Supabase Realtime | Chat del evento; la asistencia en vivo pasó a sondeo |
| CI | GitHub Actions | `.github/workflows/ci-cd.yml`: `npm ci`, lint y pruebas en push y PR a `main` |
| Monitoreo | Sentry | `@sentry/node`, cargado desde `instrument.js` |
| Anti-bot | Cloudflare Turnstile | En la reserva pública |
| Pagos | Mercado Pago | Cada organizador conecta su propia cuenta; el webhook consulta el estado a MP en vez de creer el cuerpo |
| Pagos | Wompi | Integración lista, claves por organizador |
| Correo | SMTP propio (round-robin entre dos buzones), Gmail OAuth2, Resend | Se usa el primero completo, en ese orden; cola en `email_cola` |
| IA | Anthropic, Gemini, Groq | Asistente del panel; basta una clave (`AGENTE_PROVIDER` fuerza cuál) |
| Notificaciones | web-push (VAPID) | |
| Tareas programadas | node-cron y cron de cPanel | Recordatorios, cola de correo y reporte de aforo por hora |

## Funciones principales

- **Boletas con QR firmado con JWT** (`QR_JWT_SECRET`, que debe ser idéntico
  en todos los entornos o las boletas emitidas dejan de validar).
- **Escáner de puerta** con reingreso, puertas y zonas, y motivo de cada
  rechazo (QR ilegible, boleta no encontrada, de otro evento, operador sin esa
  puerta, entre otros).
- **Padrón previo por cédula:** prellenado del registro a partir de un listado
  cargado por el organizador; la búsqueda en mostrador es por coincidencia
  exacta para no exponer cédulas ajenas.
- **Impresión de escarapelas** y **carné digital** con QR de networking.
- **Registro embebible** en la web del organizador mediante iframe.
- **Mapa por zonas** con aforo y alerta cuando una zona se llena.
- **Reportes de aforo automáticos por hora** e ingresos por franja.
- **GESTEK como proveedor OAuth2 (PKCE S256) y servidor MCP**, para que
  herramientas externas accedan a los datos del organizador con su permiso
  (`routes/oauth.js`, `routes/mcp.js`).
- Equipo y roles por evento, agenda, sub-eventos, torneos con jurado, rueda de
  negocios, vacantes, gamificación y chat.

## Puesta en marcha en local

Requisitos: Node.js 20 o superior.

```bash
npm ci
cp .env.example .env     # completar al menos lo mínimo (abajo)
npm run dev              # http://localhost:3000, con recarga
```

Mínimo para arrancar: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `QR_JWT_SECRET`
y `FRONTEND_URL`. El resto (correo, pagos, IA, Turnstile, VAPID, Sentry) es
opcional: sin su variable, la función queda inerte. Qué falta en el servidor y
qué se rompe sin cada variable está en `DESPLIEGUE.md`.

| Comando | Qué hace |
|---|---|
| `npm run dev` | API con `node --watch` |
| `npm start` | API como en producción |
| `npm test` | Pruebas con `node --test` (1.256 al 2026-10-21) |
| `npm run lint` | ESLint |
| `npm run probar:smtp` | Comprueba la configuración de correo |

## Estructura

```
index.js, app.js       arranque y montaje de rutas (el orden importa)
instrument.js          Sentry
config/                entorno y seguridad (CORS, helmet)
core/                  configuración, conexión MySQL, permisos y censo de rutas
routes/                un archivo por recurso (eventos, tickets, pagos, oauth, mcp…)
modules/               capa nueva por dominio: aforo, archivos, auth, contadores…
lib/                   lógica compartida (correo, QR, aforo, pagos, IA…)
middleware/            autenticación y permisos
db/migrations/         migraciones de Postgres 0001–0138, aplicadas a mano
db/esquema/            esquema exportado para MySQL
db/migraciones/        migraciones del lado MySQL y generadores de usuarios
scripts/               crons, comprobaciones de despliegue y de bases, copia de Storage
test/                  pruebas unitarias y de contrato
deploy/                alternativa con Docker y Caddy
docs/                  seguridad, acreditación, derechos, roadmap
```

## Decisiones y advertencias

- **Fusionar no es desplegar.** El backend se publica a mano en cPanel; hay que
  comprobar contra `/health` (o `scripts/comprobar-despliegue.sh`), no contra
  `main`. Sin el `touch tmp/restart.txt` del `.cpanel.yml`, Passenger sigue
  sirviendo el proceso anterior.
- **Las migraciones se aplican a mano** en el editor SQL de Supabase. El
  registro `supabase_migrations.schema_migrations` no es un inventario: para
  saber qué falta hay que comprobar los objetos en la base.
- **Expand / contract.** Lo que añade va primero a la base y luego al código;
  lo que quita, al revés. Una pantalla nueva tiene que seguir funcionando
  contra la API anterior.
- **Los contadores se suman en la base, no en Node** (migración `0138`).
- **El job `pg_cron` de recordatorios y su Edge Function están muertos**; los
  recordatorios salen por `scripts/cron-recordatorios.js`. No reproducirlos al
  migrar.
- **Sin proveedor de correo configurado, el correo se descarta** sin error;
  revisar con `npm run probar:smtp`.
- Nunca subir volcados con datos personales: `03_datos.sql` está ignorado y se
  regenera con `db/esquema/generar-datos.mjs`.
