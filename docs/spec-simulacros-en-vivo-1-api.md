# Spec — Simulacros en vivo (1): api_eduteka

**Repositorio:** `E:\Trabajo\api_eduteka` (Node ≥ 22, Express 4, Mongoose 8, `ajv`/TypeBox, `redis` 5, pruebas con `node --test` + `supertest` + `mongodb-memory-server`).
**Contrato compartido:** `spec-simulacros-en-vivo-0-contrato.md` (léelo primero: fases, reglas, eventos, errores, decisiones D1–D5).
**Lo consume:** la app (`spec-...-2-app.md`) y la web Next (`web/` del monolito, que ya llama a `/simulacros`).

---

## 1. Punto de partida

El módulo `src/modules/simulacra/` ya implementa el ciclo completo de rendir un simulacro **bajo demanda**: ficha, inscripción, iniciar, autoguardar, finalizar, resultados, solucionario y reintentos.

| Pieza que ya existe | Archivo |
|---|---|
| Rutas y esquemas TypeBox | `simulacrum.routes.js`, `simulacrum.schemas.js` |
| Estado puro (`simulacrumStatus`, `enrollmentState`, `startWindowViolation`, `attemptExpired`) | `simulacrum.state.js` |
| Servicio (835 líneas): listado, ficha, `enroll`, `startAttempt`, `saveAnswers`, `finishAttempt`, `getResults`, `retry` | `simulacrum.service.js` |
| Calificación pura `gradeAttempt` (tres formas de puntuar) | `simulacrum.grading.js` |
| Cronómetro del servidor y holgura de guardado | `start`: `start_exam/end_exam`; `SIMULACRUM_ANSWER_GRACE_SECONDS` = 5 |
| Pruebas | `test/simulacra*.test.js` (4 archivos) |

**Lo que no existe:** ninguna noción de cierre de inscripciones, de publicación programada ni de ausentes; ninguna comunicación en tiempo real (no hay `socket.io` ni `ws`); y las reglas de ventana dependen del flag `automatic` (ver §3.1).

Hay una restricción de arquitectura que condiciona esta spec: **la API comparte base con el monolito y no crea índices** (`mongoose.set('autoIndex', false)` en `server.js`). No se agregan índices ni migraciones aquí; los campos nuevos son opcionales.

---

## 2. Esquemas y módulo de ventana

### 2.1 Esquemas (`src/schemas/`)

Agregar los campos de contrato §2 a `simulacrum_schema.js` y `user_simulacrum_schema.js` (`register_close_date`, `results_public_at`, `ausent`). Son opcionales y sin `default`, para no escribir nada que no existiera.

`LIGHT_PIPELINE` en `simulacrum.service.js` hace un `$project` explícito: **hay que añadir** a esa lista `register_close_date`, `results_public_at` (`start_date`, `end_date`, `finished`, `public_results`, `for_register` ya están).

**Hay una segunda proyección:** `listSimulacra` no usa `LIGHT_PIPELINE`, hace un `find` con su propia proyección (`simulacrum.service.js`, ~línea 155). Añadir ahí los mismos dos campos; sin ellos `schedule` en la lista saldría mal (p. ej. `waiting` en lugar de `registration`).

**Nombre del campo:** en Mongo es `ausent` (como en el monolito); la API lo expone como `absent`. El mapeo se hace en un solo sitio (`serializeEnrollment` / resultados).

### 2.2 `src/modules/simulacra/simulacrum.window.js` (nuevo)

Port **literal** de `eduteka/src/libs/simulacrum_window.js` (funciones puras, sin Mongo). Misma firma y mismos nombres para que los dos repositorios se mantengan paralelos:

```js
export const PHASES = Object.freeze({ REGISTRATION: 'registration', WAITING: 'waiting', LIVE: 'live', FINISHED: 'finished' });

export const isScheduled   = (sim) => /* start_date y end_date definidos y válidos */;
export const getPhase      = (sim, now = new Date()) => /* contrato §3 */;
export const canRegister   = (sim, now) => /* for_register !== false && !finished && (sin programar || phase === registration) */;
export const canStart      = (sim, now) => getPhase(sim, now) === PHASES.LIVE;
export const attemptDeadline = (sim, startedAt, durationMin) => /* min(start + duración, end_date) */;
export const resultsAt     = (sim) => sim.results_public_at ?? sim.end_date;
export const resultsPublished = (sim) => (isScheduled(sim) ? sim.public_results === true : sim.public_results !== false);
export const scheduleView  = (sim, now) => /* §4.1; null si no está programado */;
```

`resultsPublished` es la corrección del punto 4 de §10 del contrato: en programados `=== true`, en el resto se mantiene la regla histórica.

**Prueba de paridad:** copiar los casos de `eduteka/test/simulacrum/window.test.js` a `test/simulacra_window.test.js` (mismas tablas de verdad: bordes de fase, `attemptDeadline`, `getPhase` con `finished`, etc.). Si una de las dos copias cambia, la otra debe cambiar en el mismo PR.

---

## 3. Cambios por endpoint

### 3.1 Reglas de ventana por fechas, no por `automatic`

| Función (`simulacrum.state.js` / servicio) | Hoy | Cambia a |
|---|---|---|
| `simulacrumStatus` | `if (!automatic) return 'live'` | Programado ⇒ por fase (`registration`/`waiting` → `upcoming`, `live`, `finished`). Sin fechas conserva la lógica actual (incluida la de `automatic` sin fechas ⇒ `upcoming`) |
| `statusClauses` (filtro `?status=`) | por `automatic` y `start_date`/`end_date` | Misma regla en la consulta: `finished`: `finished` **o** `end_date < ahora`; `live`: `start_date ≤ ahora < end_date`; `upcoming`: `start_date > ahora`; los no programados no cambian |
| `startWindowViolation` | solo si `automatic` | Programado ⇒ `{ code: 'NOT_STARTED' \| 'WINDOW_ENDED', message }`; sin programar ⇒ `null`, **salvo** un evento `automatic` sin fechas completas, que sigue bloqueado (`NOT_STARTED` sin `start_date`, `WINDOW_ENDED` pasado `end_date`) para no quedar `upcoming` en la lista pero iniciable. Mensajes sin cambio ("El simulacro todavía no ha comenzado." / "El simulacro ya cerró.") |
| `enrollmentState` | `automatic` ⇒ `in_progress` aun antes del inicio | Programado ⇒ `registered` hasta `live`, luego `in_progress` si empezó; `finished` si cerró |

### 3.2 `GET /simulacros` y `GET /simulacros/:slug`

Campo **aditivo** `schedule` en cada simulacro (lista y ficha) y `server_time` en la lista (como `meta.server_time`, porque `data` es un arreglo; la ficha ya lo trae en `data`). Las apps antiguas lo ignoran.

```jsonc
"schedule": {                       // null si no está programado
  "phase": "registration",          // registration | waiting | live | finished
  "registration_open": true,
  "register_close_date": "2026-11-10T18:00:00.000Z",
  "start_date": "2026-11-10T19:00:00.000Z",
  "end_date": "2026-11-10T21:00:00.000Z",
  "results_at": "2026-11-10T22:00:00.000Z",
  "results_published": false
}
```

`status`, `start_date`, `end_date`, `for_register` y `public_results` siguen saliendo igual (compatibilidad). `public_results` serializa `resultsPublished(sim)`.

La ficha agrega en `enrollment`: `absent: boolean`.

### 3.3 `POST /simulacros/:slug/inscribirme`

Antes de crear nada: si programado y `phase !== registration` ⇒ `403 REGISTRATION_CLOSED` ("La inscripción a este simulacro ya cerró."). El resto no cambia (idempotencia por `setNX`, área/carrera, pago).

- **Nadie se inscribe después de la fecha máxima de inscripción** (`register_close_date`, o `start_date` si no hay). Tampoco durante la ventana en vivo, aunque `register_close_date` sea posterior al inicio.
- **Cambio de comportamiento a documentar:** hoy `enroll` bloquea con `for_register !== true` (un simulacro sin el campo no admite inscripción). Pasa a `for_register === false` (el esquema tiene `default: true` y el serializador ya usa `!== false`). Para no programados, el interruptor sigue siendo el único control.
- Quien **ya está inscrito** puede llegar tarde al examen (§3.4): la inscripción cerrada no afecta a los inscritos.

### 3.4 `POST /simulacros/:slug/iniciar`

**Orden de las comprobaciones en `startAttempt`** (importa; hoy está al revés en dos puntos):

1. Sin inscripción ⇒ `404`; no verificada ⇒ `403`; `enrollment.finished` ⇒ `ATTEMPT_ALREADY_FINISHED`.
2. Si el intento **ya tiene `start_exam`** y `attemptExpired` ⇒ calificar y `ATTEMPT_ALREADY_FINISHED`. Esto va **antes** de cualquier ventana: quien empezó a las 19:50 y reabre a las 21:05 (con el cierre masivo caído) recibe "ya terminó" y queda calificado, no `WINDOW_ENDED`.
3. Si el intento **no tiene `start_exam`** (primera apertura) y no es reintento ⇒ aplicar la ventana: programado ⇒ `startWindowViolation` (`NOT_STARTED` / `WINDOW_ENDED`). El `FORBIDDEN` "El simulacro ya cerró." (`finished === true` manual) **solo se usa en no programados**; en programados manda la fase, porque el monolito pone `finished: true` al terminar la ventana y debe salir `WINDOW_ENDED`.
4. Un intento ya iniciado y vigente se reabre sin volver a evaluar la ventana de inicio.

- `startWindowViolation` (3.1) devuelve los códigos `NOT_STARTED` / `WINDOW_ENDED`. **Un reintento abierto sigue entrando** (práctica): no se aplica ventana.
- Un **reintento** (práctica) tampoco tiene tope: `end_exam = ahora + duración`, sin pasar por `attemptDeadline`, y `window` es `null`. Los `non-programados` no cambian: el orden nuevo solo mueve el vencimiento antes del `FORBIDDEN` de `finished` manual.
- **Entrar tarde está permitido** (decisión confirmada): quien abre durante `live` rinde con el tiempo que queda (`end_exam = min(inicio + duración, end_date)`), igual que los demás; el cliente le avisa (`window.shortened`).
- `end_exam = attemptDeadline(simulacrum, now, duration)` en lugar de `now + duración`.
- La respuesta agrega:

```jsonc
"window": {
  "end_date": "…",
  "allowed_seconds": 120,          // end_exam - start_exam
  "duration_seconds": 180,         // duración nominal
  "shortened": true                // allowed < duration: el cliente muestra el aviso de entrada tarde
}
```

`window` es `null` para no programados y para reintentos.

- Un intento ya iniciado (`start_exam` fijado) **se devuelve igual**, con su `end_exam` original (reabrir la app no reinicia el cronómetro; ya es así).
- **Intento ya cerrado:** hoy `startAttempt` lanza `ApiError.conflict` (`CONFLICT`) para "Ya terminaste este intento" y para "El tiempo de este intento terminó; ya fue calificado". Esos **dos** casos pasan a `ApiError.attemptFinished()` (`409 ATTEMPT_ALREADY_FINISHED`, mismo estado HTTP). El resto de los `409` de `iniciar` ("no tiene una duración configurada", "el área no tiene preguntas", "tu inscripción aún se está procesando") **siguen siendo `CONFLICT`**: los clientes no deben confundirlos con "ya calificado".

### 3.5 `PUT /simulacros/intentos/:attempt_id/respuestas` y `POST …/finalizar`

Sin cambios de forma. Solo:

- Si el intento ya está cerrado (porque el servidor lo cerró al terminar la ventana o lo cerró el propio usuario desde otro dispositivo) ⇒ `409` con `code: "ATTEMPT_ALREADY_FINISHED"` en ambos. Hoy es un `409 CONFLICT` genérico con mensaje: se **mantiene el estado HTTP** y solo se afina el `code`, así que ninguna prueba ni cliente existente se rompe por el estado.

Mapa exacto de los `409` de `simulacrum.service.js`:

| Caso (mensaje actual) | Pasa a |
|---|---|
| `assertAcceptsAnswers`: "Este intento ya terminó." (`finished`) | `ATTEMPT_ALREADY_FINISHED` |
| `assertAcceptsAnswers`: "El tiempo de este intento terminó…" (pasada la holgura) | `ATTEMPT_ALREADY_FINISHED` |
| `finishAttempt`: "Ya finalizaste este intento." (`finished` al entrar y `!graded` tras `gradeAndClose`, es decir, cierre concurrente) | `ATTEMPT_ALREADY_FINISHED` |
| `writeAnswers`: `matchedCount === 0` ("ya no está activo") | `ATTEMPT_ALREADY_FINISHED` si al releer el intento `finished === true`; si no, `CONFLICT` |
| "Este intento ya no está activo." por `attemptNumber` desfasado (cliente con el intento anterior) | **`CONFLICT`** (no es "ya terminó") |
| "Todavía no iniciaste este intento." | `CONFLICT` |
- `finalizar` sigue aceptando `answers` (respuestas de última hora, dentro de la holgura) para que el cliente pueda mandar su mapa local completo.

### 3.6 `GET /simulacros/:slug/resultados`

Para **no programados**: sin cambios.

Para **programados con resultados sin publicar** (`!resultsPublished`), contrato §6:

```jsonc
{
  "simulacrum": { "id": "…", "slug": "…", "title": "…", "status": "finished" },
  "enrolled": true,
  "absent": false,
  "results_published": false,
  "results_at": "…",
  "submission": { "finished_at": "…", "answered": 2, "total": 60 },   // null si no terminó
  "attempt": null, "by_area": [], "attempts": [],
  "ranking": { "visible": false },
  "can_retry": false, "retry_blocked_reason": "…",
  "server_time": "…"
}
```

- `submission.answered/total` salen del intento cerrado (`correct + incorrect` y `correct + incorrect + not_answered`).
- La calificación perezosa (`attemptExpired` / `backfillScore`) **se sigue ejecutando** antes de responder: aunque no se publique el puntaje, el intento queda cerrado y calificado.
- Un **no participante** sigue recibiendo `404` si no están publicados (regla actual `!enrollment && !publicResults`).
- Publicados: la respuesta actual más `results_published: true` y `absent`.
- `can_retry` es `false` mientras no estén publicados (no tiene sentido ofrecer práctica antes del resultado oficial).

**Solucionario (decisión confirmada):** en un programado **no se ve hasta que los resultados estén publicados**. Ver las respuestas correctas permite calcular el puntaje propio, lo que rompería el "de todos o de nadie" (contrato §6). `getSolucionario` hoy cierra el solucionario con `simulacrum.automatic && status !== 'finished'` (→ `403`). Pasa a:

```js
if (isScheduled(simulacrum)) {
    if (!resultsPublished(simulacrum)) throw ApiError.forbidden('El solucionario se habilita cuando se publiquen los resultados.');
    if (getPhase(simulacrum, now) !== PHASES.FINISHED) throw ApiError.forbidden('El solucionario se habilita cuando cierre el simulacro.');
} else if (simulacrum.automatic && status !== 'finished') {
    throw ApiError.forbidden('El solucionario se habilita cuando cierre el simulacro.');
}
```

(Ambas condiciones en programados: un `public_results: true` puesto a mano durante la ventana no abre el solucionario mientras alguien aún rinde.)

Los `automatic` sin fechas conservan su regla actual. Se aplica **a todos, también a la vista previa del docente** (decisión confirmada): sin intento propio no hay puntaje que calcular, pero un docente podría pasar las respuestas a un estudiante que aún rinde, y el cierre solo dura hasta la publicación. La comprobación va **antes** de la puerta de suscripción del docente y de la de "intento abierto". El mensaje es nuevo: actualizar el texto que usan los clientes si lo comparan. El monolito ya lo aplica así (`solutionOpen`, con prueba real: estudiante, docente, publicado a mano con la ventana abierta y no programado).

### 3.7 Un solo dispositivo a la vez (contrato §4.1)

**Código:** `src/modules/simulacra/simulacrum.session.js`, port de `eduteka/src/libs/exam_session.js` (mismo algoritmo y constantes: `EXAM_SESSION_TTL_SECONDS = 60`, `EXAM_HEARTBEAT_SECONDS = 20`; `claimExamSession(model, enrollmentId, key, client, now)` con sus dos actualizaciones atómicas, renovar y tomar). Copiar también `test/simulacrum/exam_session.test.js`. Agregar `exam_session` al esquema `user_simulacrum_schema.js` y a `RESET_FIELDS` de `simulacrum.attempts.js` (el reintento empieza limpio).

**Identidad:** `key = "${req.client}:${sid}"`.
- `req.client` (`web` | `app`) ya lo resuelve `middlewares/client.js`.
- `sid` llega en la cabecera `X-Exam-Session` (UUID). Si falta (apps anteriores a este cambio), `sid = 'legacy'`: sigue separando web de app, que es lo que se pide; dos teléfonos con la app antigua no se bloquean entre sí hasta que se fuerce la versión (`APP_UPDATE_REQUIRED`).
- Web Next: su servidor lee la cookie `edk_exam_sid` del navegador (el **mismo nombre** que usa el monolito, para que la web SSR y la web Next compartan identidad `web:<sid>`) y la reenvía como `X-Exam-Session`.
- Agregar `X-Exam-Session` a `allowedHeaders` del CORS (`app.js`), para quien llame desde un navegador.

| Endpoint | Cambio |
|---|---|
| `POST /simulacros/:slug/iniciar` | Reclama **antes** de fijar el cronómetro. Otro titular ⇒ `409 ATTEMPT_ACTIVE_ELSEWHERE` (con `holder`). La respuesta agrega `session: { took_over, ttl_seconds: 60, heartbeat_seconds: 20 }` |
| `PUT /simulacros/intentos/:attempt_id/respuestas` | Reclama/renueva antes de escribir. No titular ⇒ `409` y **no se escribe nada** |
| `POST /simulacros/intentos/:attempt_id/finalizar` | Solo el titular; igual |
| `POST /simulacros/intentos/:attempt_id/latido` **(nuevo)** | Renueva. `200 { ok: true, heartbeat_seconds, server_time }`. No titular ⇒ `409 ATTEMPT_ACTIVE_ELSEWHERE`. Intento ya cerrado ⇒ `409 ATTEMPT_ALREADY_FINISHED` (el cliente lo trata como éxito). `rateLimit('write')` con holgura para 1 latido/20 s |
| Ficha, resultados, solucionario, reintentar | No usan el bloqueo |

El cierre masivo del monolito (`closeWindow`) y la calificación perezosa **no** miran el bloqueo.

**Divergencia deliberada del monolito:** en `claimExamSession`, si al fallar los pasos 1 y 2 el titular actual es la **misma** `key` (dos reclamos simultáneos del mismo dispositivo: doble toque, reintento de red), el resultado es `{ ok: true, took_over: false }` y no un rechazo contra sí mismo. Portar el mismo arreglo a `eduteka/src/libs/exam_session.js`.

**`sid` inválido:** `deviceOf(req)` solo acepta `[A-Za-z0-9_-]{8,64}`; cualquier otra cosa se trata como `legacy`. El `latido` valida con `assertAcceptsAnswers` (cerrado o pasada la holgura ⇒ `ATTEMPT_ALREADY_FINISHED`) antes de reclamar.

**Alcance:** el bloqueo aplica a **todos** los simulacros (programados o no) en `iniciar`, `respuestas`, `finalizar` y `latido`; es el único cambio que toca a los no programados (ver §8).

**Coste:** `claimExamSession` hace una escritura propia además de `writeAnswers`. En el autoguardado, fusionar ambas en un único `updateOne` (filtro por `exam_session.id` titular o vencido + `$set` de `last_seen_at` y de las respuestas) es una optimización permitida, siempre que "no titular ⇒ no se escribe nada" se mantenga.

---

## 4. Serialización: `scheduleView` y errores

### 4.1 `scheduleView(sim, now)`

Devuelve el objeto de §3.2 (ya en ISO). `registration_open = phase === registration`.

### 4.2 Errores nuevos (`src/libs/api_error.js`)

```js
static registrationClosed(message = 'La inscripción a este simulacro ya cerró.') { return new ApiError(403, 'REGISTRATION_CLOSED', message); }
static notStarted(message = 'El simulacro todavía no ha comenzado.')           { return new ApiError(403, 'NOT_STARTED', message); }
static windowEnded(message = 'El simulacro ya terminó.')                         { return new ApiError(403, 'WINDOW_ENDED', message); }
static attemptFinished(message = 'Este intento ya terminó.')                     { return new ApiError(409, 'ATTEMPT_ALREADY_FINISHED', message); }
static attemptActiveElsewhere(holder, message = 'Tu examen está abierto en otro dispositivo.') { return new ApiError(409, 'ATTEMPT_ACTIVE_ELSEWHERE', message, { extra: { holder } }); }   // sale como `error.holder` (ver «Campos extra»)
```

**Campos extra del error.** Hoy `ApiError` solo guarda `{ details, headers }` y `errorBody` solo emite `code`, `message` y `details`, así que un `holder` pasado como opción **se perdería**. Para que llegue como `error.holder` (lo que fija el contrato §4.1 y lo que lee la app):

```js
// src/libs/api_error.js
constructor(status, code, message, { details, headers, extra } = {}) { /* … */ this.extra = extra; }   // extra: objeto plano, se vuelca al nivel de code/message

// src/libs/envelope.js
export const errorBody = (req, { code, message, details, extra }) => {
    const error = { ...extra, code, message };      // extra primero: nunca pisa code ni message
    if (details) error.details = details;
    return { error, request_id: req.id };
};
```

(`extra` se expande **antes** de `code` y `message`, para que nunca los pise.) El manejador de errores (`middlewares/error_handler.js`) ya pasa el `ApiError` a `errorBody`; solo hay que asegurarse de que el objeto que recibe incluya `extra`. Una prueba fija la forma exacta del cuerpo. (`errorBody` ya recibe el `ApiError` completo desde el manejador; solo hay que añadir `extra` al constructor y a `errorBody`.)

Documentar los **cinco** códigos en `docs/api-eduteka-standalone.md` §6.5 y en la tabla de códigos del contrato. `ApiError.forbidden('El simulacro ya cerró.')` queda solo para el `finished === true` manual de un simulacro **no programado** (§3.4).

---

## 5. Tiempo real

### 5.1 Dependencia y archivos

`npm i socket.io@4` (mismo mayor que el monolito, para que cliente y servidor coincidan).

```
src/modules/simulacra/realtime/
  simulacrum.events.js      # bus: suscribirse a la señal (Redis | memoria)
  simulacrum.realtime.js    # attachRealtime(httpServer): socket.io, auth, salas, retransmisión
src/config/settings.js      # realtime: { enabled, path, ... } (§5.5)
test/simulacra_realtime.test.js
```

### 5.2 `simulacrum.events.js` — el bus

Interfaz mínima, para poder probar sin Redis:

```js
export const subscribe = (handler) => unsubscribe;   // handler({ v, type, simulacrum_id, slug, emitted_at })
export const publishLocal = (message) => void;       // solo para pruebas y modo memoria
```

- Producción: `redisClient.duplicate()` (conexión **aparte**, una conexión en modo suscriptor no puede hacer otros comandos), `subscribe('edk:simulacrum:events', …)`.
- Parsea el JSON y descarta lo que no cumpla `v === 1` y `type ∈ {close,start,end,results,updated}`. Nunca lanza: un mensaje corrupto se registra y se ignora.
- Redis caído al arrancar o en memoria (`redisClient.isMemoryFallback`): usa un `EventEmitter` local. Es lo que usan las pruebas y el modo desarrollo sin Redis; en ese modo **el monolito no puede avisar a la API** y los clientes caen al modo degradado de contrato §7.3 (se registra una advertencia de arranque).
- Si la conexión Redis se corta, reconecta con backoff y vuelve a suscribirse; al reconectar emite a todas las salas un `sim:state` por simulacro con sala activa, para cubrir lo perdido.

### 5.3 `simulacrum.realtime.js` — el servidor de sockets

```js
export function attachRealtime(httpServer) {
  const io = new Server(httpServer, {
    path: settings.realtime.path,                 // '/api/v1/realtime'
    serveClient: false,                           // el cliente lo trae la app
    cors: { origin: (origin, cb) => cb(null, !origin || settings.corsOrigins.includes(origin)) },
    transports: ['websocket', 'polling'],
    maxHttpBufferSize: 10_000,                    // solo viajan mensajes minúsculos
  });
  …
  return io;
}
```

**Autenticación en el handshake** (mismo criterio que `middlewares/authenticate.js`, que es del ciclo HTTP y no sirve tal cual):

```js
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (typeof token !== 'string') return next(new Error('UNAUTHENTICATED'));
  try {
    const { uid } = await verifyAccessToken(token);                       // #Libs/tokens.js
    const user = await UserModel.findById(uid, AUTH_USER_FIELDS).lean();
    if (!user || user.state === false) return next(new Error('UNAUTHENTICATED'));
    socket.data.user = user;
    return next();
  } catch { return next(new Error('UNAUTHENTICATED')); }
});
```

- El token de acceso dura 30 min (`ACCESS_TTL_SECONDS`). Se verifica **en la conexión y en cada `join`**; una conexión ya abierta no se corta cuando el token vence (solo recibe avisos públicos de su sala). Al reconectar, el cliente usa el token renovado (`auth` como función en el cliente; ver app §3.3).
- Tope de **5 conexiones por usuario**; la sexta cierra la más antigua.

**`join`** (TypeBox para validar `{ slug: string(1..200) }`):

1. Cargar el simulacro por slug (ficha ligera) y la inscripción del usuario. Sin simulacro o sin inscripción ⇒ ack `{ ok: false, code: 'NOT_FOUND' }` (mismo código para los dos casos: no revelar si existe).
2. `socket.join('simulacrum:' + id)`.
3. Ack `{ ok: true, state }` y emitir `sim:state` (cuerpo de contrato §7.2, construido con `scheduleView` + `server_time`).
4. Límite: 20 `join` por minuto por socket.

**Implementado así (difiere en detalle del esbozo de abajo):** la retransmisión y el `join` no usan `findLight` (su `$project` calcula conteos de preguntas); cargan el simulacro con un `findOne`/`findById` y una proyección mínima (solo fechas y flags), y la retransmisión busca por `simulacrum_id` de la señal (más robusto que el `slug`, que puede cambiar). Solo se lee Mongo si la sala tiene sockets. `subscribe` envuelve al manejador: un error nunca tumba el bus. Exporta además `onResync` (tras reconectar a Redis) y `closeBus` (apagado). Tras `io.close()` se cancelan las suscripciones.

**Retransmisión:** al recibir una señal del bus:

```js
subscribe(async (msg) => {
  const sim = await findLight(msg.slug, { requireVisible: false }).catch(() => null);
  if (!sim) return;
  io.to(`simulacrum:${sim._id}`).emit(`sim:${msg.type}`, buildState(sim, new Date()));
});
```

El estado se **lee de Mongo en ese momento** (contrato §7.1): no se reenvía nada de la señal. `type: 'updated'` emite `sim:updated`.

### 5.4 Arranque y apagado (`src/server.js`)

```js
const server = settings.listenHost ? createApp().listen(settings.port, settings.listenHost, onListening) : createApp().listen(settings.port, onListening);
const io = settings.realtime.enabled ? attachRealtime(server) : null;
// shutdown: io?.close() antes de server.close(), para que no cuelgue el cierre con sockets abiertos
```

`createApp()` **no** cambia (las pruebas con `supertest` siguen sin abrir puertos). Las pruebas de sockets crean su propio `http.createServer(ctx.app)` y llaman a `attachRealtime`.

### 5.5 `settings.js`

| Variable | Default | Uso |
|---|---|---|
| `REALTIME_ENABLED` | `true` | Apagar el socket sin tocar código |
| `REALTIME_PATH` | `/api/v1/realtime` | Ruta del handshake |
| `REALTIME_MAX_CONNECTIONS_PER_USER` | `5` | §5.3 |

### 5.6 Cambio en el monolito (publicar la señal)

> **Hecho en el monolito:** `src/libs/simulacrum_signal.js` (construcción y publicación de la señal, con su prueba) y las llamadas en `simulacrum_realtime.js`. Queda por hacer solo la parte de la API (suscriptor y socket).

En `eduteka/src/libs/simulacrum_realtime.js`, **después** de cada emisión local (y de las escrituras en Mongo) añadir la publicación. Es lo único que cambia del monolito para F2:

```js
const CHANNEL = 'edk:simulacrum:events';
const publishSignal = (type, sim) => redisClient.publish?.(CHANNEL, JSON.stringify({
  v: 1, type, simulacrum_id: String(sim._id), slug: sim.slug, emitted_at: new Date().toISOString(),
})).catch((error) => console.error('[simulacrum_realtime] publish', error));
```

Se llama en `fire()` (`close`, `start`, `end`, `results`), en `reconcile()` (cuando cierra o publica) y en `notifyUpdated()` (`updated`). El cliente de Redis en memoria del monolito **no** implementa `publish`: el `?.` lo deja como no-op en desarrollo sin Redis. **Nunca** debe bloquear ni hacer fallar el hito si Redis falla (solo se registra).

Prueba (monolito): con un `redisClient` falso, `fire(id, 'start')` publica exactamente una señal con el JSON esperado; con `publish` ausente, no lanza.

---

## 6. Pruebas

Convención del repo: un archivo por tema, `bootTestApp`, helpers de `test/helpers/seed.js` (`seedSimulacra` ya existe; agregar un simulacro programado con fechas relativas a `Date.now()`).

### 6.1 `test/simulacra_window.test.js` (unitaria, sin base)

Paridad con el monolito: bordes de fase, `canRegister`, `canStart`, `attemptDeadline`, `resultsPublished`, `scheduleView`.

### 6.2 `test/simulacra_scheduled.test.js` (HTTP)

| Caso | Esperado |
|---|---|
| Ficha de un programado | `schedule.phase`, fechas ISO, `results_published:false`; `status` coherente |
| `?status=upcoming/live/finished` con tres programados en tres fases | cada uno aparece solo en su filtro |
| Inscribirse en `registration` | `201` |
| Inscribirse en `waiting` o `live` | `403 REGISTRATION_CLOSED` |
| Inscribirse con `for_register:false` dentro de la ventana | `403` |
| Iniciar antes del inicio | `403 NOT_STARTED` |
| Iniciar después del fin | `403 WINDOW_ENDED` |
| Iniciar entrando tarde (ventana 5 min, duración 3, a los 3 min) | `end_exam = end_date`, `window.shortened:true`, `allowed_seconds ≈ 120` |
| Iniciar de nuevo el mismo intento | mismo `end_exam` |
| Un reintento abierto después del fin | entra (no aplica ventana) |
| Guardar respuestas dentro de la holgura | `200`; pasada la holgura: `409` |
| Finalizar un intento ya cerrado por el servidor | `409 ATTEMPT_ALREADY_FINISHED` |
| Un programado con `automatic:false` y fechas | se comporta igual que con `automatic:true` (punto 1 de §10 del contrato) |
| `public_results` sin definir en un programado | `results_published:false` (punto 4) |
| Resultados sin publicar, participante que terminó | `attempt:null`, `ranking.visible:false`, `submission` correcto |
| Resultados sin publicar, no participante | `404` |
| Resultados publicados | respuesta completa + `results_published:true` |
| Inscrito aprobado que nunca inició, tras cierre | `absent:true` en la ficha y en resultados |
| Solucionario de un programado con la ventana en curso, intento ya cerrado | `403` "se habilita cuando se publiquen los resultados" |
| Solucionario de un programado tras terminar la ventana, resultados sin publicar | `403` (igual) |
| Lo mismo para un docente con plan activo (vista previa) | `403` (el cierre va antes de la suscripción) |
| `public_results: true` puesto a mano con la ventana aún en curso | `403` |
| Solucionario de un programado con resultados publicados | `200` |
| Iniciar un programado ya terminado con `finished:true` puesto por el monolito, intento nuevo | `403 WINDOW_ENDED` (no `FORBIDDEN`) |
| Reabrir un intento iniciado cuyo `end_exam` pasó, sin cierre masivo | `409 ATTEMPT_ALREADY_FINISHED` y el intento queda calificado |
| Guardar tras `finished` / tras la holgura / con `attempt_number` desfasado | `ATTEMPT_ALREADY_FINISHED` / `ATTEMPT_ALREADY_FINISHED` / `CONFLICT` |
| Inscripción con `register_close_date` posterior a `start_date`, en `live` | `403 REGISTRATION_CLOSED` |
| Inscrito que abre a mitad de la ventana (entrada tardía) | `200`, `shortened:true`, `end_exam = end_date` |
| Lista de simulacros: `schedule` con `register_close_date` | `phase:'registration'` (proyección del listado incluye los campos) |
| Simulacro sin `for_register` definido | inscripción permitida |
| Dos dispositivos: A inicia, B inicia | B: `409 ATTEMPT_ACTIVE_ELSEWHERE` con `holder.client` y `retry_after_seconds` |
| B guarda respuestas mientras A es titular | `409`; el mapa de respuestas **no cambia** |
| Latido de A / latido de B | `200` / `409` |
| Titular vencido (`last_seen_at` hace 61 s), B inicia | `200`; **mismo** `end_exam` y mismas respuestas; `session.took_over: true`; A ya no puede escribir |
| A reabre desde el mismo dispositivo | `200` inmediato (mismo `X-Exam-Session`) |
| Entre clientes: `client=web` con `sid=x` frente a `client=app` con `sid=x` | Se bloquean (la identidad incluye el cliente) |
| Sin cabecera `X-Exam-Session` | `sid = 'legacy'`; web y app siguen bloqueándose |
| Dos `iniciar` simultáneos de dos dispositivos (`Promise.all`) | Exactamente uno `200` y el otro `409` |
| Finalizar por un no titular / por el titular | `409` / `200` |
| Latido con el intento ya cerrado | `409 ATTEMPT_ALREADY_FINISHED` |
| Reintentar | `exam_session` limpio en el intento nuevo |
| `iniciar` de un intento ya cerrado / con el tiempo vencido | `409 ATTEMPT_ALREADY_FINISHED` |
| `iniciar` sin duración configurada | `409 CONFLICT` (no se confunde con "ya terminó") |
| Cuerpo del `409 ATTEMPT_ACTIVE_ELSEWHERE` | `{ error: { code, message, holder: { client, last_seen_at, retry_after_seconds } }, request_id }`; sin `details` |
| **No programados** | las pruebas existentes de `simulacra*.test.js` pasan sin tocar. **Excepción:** las que inscribían en un evento con fechas ya en vivo o terminado (`evento-vivo`, `evento-cerrado`) se inscriben ahora "antes" (moviendo la ventana al futuro y restaurándola), porque con fechas completas el simulacro es programado y nadie se inscribe pasada la fecha máxima (D8) |

### 6.3 `test/simulacra_realtime.test.js`

Servidor real: `http.createServer(ctx.app)` + `attachRealtime`, cliente `socket.io-client` (devDependency).

| Caso | Esperado |
|---|---|
| Conexión sin token / con token inválido | `connect_error` `UNAUTHENTICATED` |
| `join` de un inscrito | ack `ok` + `sim:state` con `phase` correcta |
| `join` de un no inscrito o de un slug inexistente | ack `NOT_FOUND` (igual para los dos) |
| `publishLocal({type:'start'})` | los de la sala reciben `sim:start`; uno fuera de la sala, nada |
| `type:'end'` leído de Mongo | el estado llega con `phase:'finished'` y `results_published` real |
| Mensaje del bus malformado | se ignora, no tumba el proceso |
| Sexta conexión del mismo usuario | la primera se cierra |
| `REALTIME_ENABLED=false` | `attachRealtime` no se llama; `GET /simulacros` funciona |

### 6.4 Prueba de punta a punta con el monolito (manual, en `docs/`)

Con Redis local y los dos procesos arriba: crear un programado desde el admin (inicio +2 min) → conectar un cliente `socket.io-client` a la API con un token real → recibir `sim:close`, `sim:start`, `sim:end`, `sim:results` en el segundo exacto (tolerancia ≤ 2 s). Es el criterio 2 de contrato §12.

---

## 7. Despliegue

### 7.1 Nginx (`deploy/nginx-api.conf`)

El `location /` actual envía `Connection ""` y corta WebSocket. Agregar **antes** de `location /`:

```nginx
# Socket.IO: necesita Upgrade y una lectura larga (las conexiones duran minutos u horas).
location /api/v1/realtime/ {
    proxy_pass http://eduteka_api;
    proxy_http_version 1.1;
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection "upgrade";

    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-For   $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;

    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

- **Cloudflare** admite WebSocket por defecto en todos los planes; confirmar que el modo de SSL sea *Full (strict)* (ya lo es según la cabecera del archivo).
- La web Next llama **directo a Node** (`EDK_API_URL=http://127.0.0.1:3000`, sin pasar por Nginx), así que sus conexiones de servidor no necesitan este bloque; el **navegador** sí pasa por `api.eduteka.pe`.

### 7.2 Una sola instancia

Con una instancia de la API no hace falta *sticky sessions* ni el adaptador de Redis de Socket.IO: toda la sala vive en un proceso. Si algún día hay varias instancias, cada una se suscribe al mismo canal y emite a **sus** sockets (ya funciona así por diseño); solo falta configurar *sticky sessions* en el balanceador para el *polling* de Socket.IO. No requiere cambios de código.

### 7.3 Orden de despliegue

1. API con F1 (esquemas, reglas, endpoints): no requiere nada más y **es compatible** con las apps actuales (cambios aditivos).
2. Nginx con el `location` del socket.
3. API con F2 (`attachRealtime`) y monolito publicando la señal. Cualquiera de los dos puede ir primero: sin suscriptor la señal se pierde sin daño; sin publicador no hay avisos pero todo lo demás funciona.

---

## 8. Compatibilidad

- Todo cambio de respuesta es **aditivo** (`schedule`, `window`, `absent`, `submission`, `results_published`, `results_at`). Las apps y la web que ya consumen la API siguen funcionando.
- Las respuestas de error ganan códigos más específicos con el **mismo estado HTTP** (`403` para ventana, `409` para intento cerrado).
- `automatic` se sigue enviando; deja de usarse para decidir.
- Los simulacros **no programados** se comportan como hoy, con dos excepciones: el bloqueo de un solo dispositivo (§3.7) y que `enroll` pasa de `for_register !== true` a `=== false` (§3.3).

## 9. Lista de verificación

- [ ] §2: campos en esquemas, en `LIGHT_PIPELINE` **y** en la proyección de `listSimulacra`; `simulacrum.window.js` con su prueba de paridad.
- [ ] §3.1: `simulacrumStatus`, `statusClauses`, `startWindowViolation`, `enrollmentState` por fechas.
- [ ] §3.2–3.6: `schedule`, `REGISTRATION_CLOSED`, `window` en `iniciar`, `end_exam` acotado, resultados diferidos, solucionario.
- [ ] §3.7: `simulacrum.session.js`, `exam_session` en esquema y `RESET_FIELDS`, cabecera `X-Exam-Session` (también en CORS), `latido`, `session` en `iniciar`.
- [ ] §4.2: `extra` en `ApiError` y `errorBody` (`error.holder`); `start` emite `ATTEMPT_ALREADY_FINISHED` solo en sus dos casos de "ya cerrado".
- [ ] §4.2: códigos nuevos y `docs/api-eduteka-standalone.md` §6.5 actualizada.
- [ ] §5: `socket.io`, bus, `attachRealtime`, `settings`, `server.js` (arranque y apagado).
- [ ] §5.6: monolito publica la señal.
- [ ] §6: las tres suites verdes; `npm test` y `npm run lint` completos.
- [ ] §7: nginx, despliegue en el orden indicado.
