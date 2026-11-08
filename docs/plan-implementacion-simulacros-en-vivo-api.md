# Plan de implementación — Simulacros en vivo (API)

Base: `spec-simulacros-en-vivo-0-contrato.md` y `spec-simulacros-en-vivo-1-api.md`. Cada paso termina con `npm test` verde; los pasos 1–7 son F1 (desplegable sola, aditiva), 8–10 son F2.

Regla de oro: los simulacros **no programados** no cambian (salvo bloqueo de dispositivo y `for_register`). Las pruebas existentes `test/simulacra*.test.js` deben seguir pasando sin tocarlas en cada paso.

---

## F1 — Reglas de ventana y contrato REST

### Paso 1 — Errores y envelope (base de todo)
- `src/libs/api_error.js`: opción `extra` en el constructor; fábricas `registrationClosed`, `notStarted`, `windowEnded`, `attemptFinished`, `attemptActiveElsewhere(holder)`.
- `src/libs/envelope.js`: `errorBody` vuelca `extra` **antes** de `code`/`message`.
- Prueba: forma exacta del cuerpo `{ error: { holder, code, message }, request_id }` sin `details`.
- Riesgo: ninguno; nada lo usa aún.

### Paso 2 — Esquemas y módulo de ventana
- `src/schemas/simulacrum_schema.js`: `register_close_date`, `results_public_at`. `user_simulacrum_schema.js`: `ausent`, `exam_session` (opcionales, sin `default`). Sin índices (`autoIndex` off).
- `src/modules/simulacra/simulacrum.window.js`: port literal de `eduteka/src/libs/simulacrum_window.js` (`PHASES`, `isScheduled`, `getPhase`, `canRegister`, `canStart`, `attemptDeadline`, `resultsAt`, `resultsPublished`, `scheduleView`).
- `canRegister` usa `for_register !== false`.
- Prueba `test/simulacra_window.test.js`: copiar casos de `eduteka/test/simulacrum/window.test.js` (paridad).

### Paso 3 — Estado por fechas (`simulacrum.state.js` + `statusClauses`)
- `simulacrumStatus`, `startWindowViolation` (ahora `{code,message}`), `enrollmentState`: programado ⇒ por fase; sin fechas ⇒ lógica actual.
- `statusClauses` en `simulacrum.service.js` (consulta Mongo con la misma regla por fechas).
- Pruebas: tabla de estados y `?status=` con tres programados en tres fases; un programado con `automatic:false` se comporta igual.

### Paso 4 — Lectura: `schedule`, `server_time`, proyecciones
- `LIGHT_PIPELINE` **y** la proyección de `listSimulacra`: añadir `register_close_date`, `results_public_at`.
- `serializeSummary`: `schedule`, `public_results = resultsPublished(sim)`; `serializeEnrollment`: `absent` (mapeo `ausent` → `absent`); `server_time` en la lista.
- Pruebas: ficha y lista de un programado; `public_results` sin definir ⇒ `results_published:false`.

### Paso 5 — Inscripción
- `enroll`: `for_register === false` bloquea (antes `!== true`); programado y `phase !== registration` ⇒ `REGISTRATION_CLOSED`, antes de crear nada.
- Pruebas: `registration` ⇒ 201; `waiting`/`live` ⇒ 403; `register_close_date > start_date` en `live` ⇒ 403; sin `for_register` definido ⇒ permitido.

### Paso 6 — Iniciar, guardar, finalizar
- `startAttempt` con el **orden** de la spec §3.4: (1) inscripción/verificada/`finished`; (2) intento iniciado y vencido ⇒ calificar + `ATTEMPT_ALREADY_FINISHED`; (3) primera apertura no reintento ⇒ ventana (`NOT_STARTED`/`WINDOW_ENDED`; `FORBIDDEN` solo en no programados); (4) `end_exam = attemptDeadline(...)`; respuesta con `window`.
- Mapa de `409` (spec §3.5): `assertAcceptsAnswers`, `finishAttempt`, `writeAnswers` (releer y decidir), `attempt_number` desfasado queda `CONFLICT`.
- Pruebas: entrada tardía (`shortened`, `end_exam = end_date`), mismo `end_exam` al reabrir, reintento fuera de ventana entra, `WINDOW_ENDED` con `finished:true` del monolito, reabrir vencido califica, `CONFLICT` por falta de duración se conserva.

### Paso 7 — Resultados y solucionario
- `getResults`: programado y `!resultsPublished` ⇒ respuesta diferida (`submission`, `attempt:null`, `ranking.visible:false`, `can_retry:false`); la calificación perezosa sigue antes; no participante ⇒ 404; publicados ⇒ respuesta completa + `results_published`, `absent`.
- `getSolucionario`: programado ⇒ cerrado hasta `resultsPublished` (mensaje nuevo); `automatic` sin fechas conserva su regla; vista previa del docente intacta.
- Pruebas: todas las filas de §6.2 de resultados, `absent`, solucionario antes/después de publicar.
- Docs: `docs/api-eduteka-standalone.md` §6.5 con los 5 códigos.

**Hito F1:** desplegar la API (compatible con apps actuales).

---

## Bloqueo de un solo dispositivo (contrato §4.1)

### Paso 8 — `exam_session`
- `simulacrum.session.js`: port de `eduteka/src/libs/exam_session.js` (+ su prueba). `exam_session` en `RESET_FIELDS` de `simulacrum.attempts.js`.
- Cabecera `X-Exam-Session` (también en `allowedHeaders` de `src/app.js`); `key = ${req.client}:${sid|legacy}`.
- Integrar en `iniciar` (reclama **antes** de fijar el cronómetro; `session` en la respuesta), `respuestas` (no titular ⇒ no se escribe), `finalizar` (solo titular); ruta nueva `POST /simulacros/intentos/:attempt_id/latido` con `rateLimit('write')` y esquema en `simulacrum.schemas.js`.
- Pruebas: toda la sección de dispositivos de §6.2 (carrera con `Promise.all`, retoma a los 61 s, web vs app con el mismo `sid`, `legacy`, reintento limpia la sesión).
- Optimización opcional: fusionar la reclamación con `writeAnswers` en un único `updateOne`.

---

## F2 — Tiempo real

### Paso 9 — Socket
- `npm i socket.io@4`; `npm i -D socket.io-client@4`.
- `settings.js`: bloque `realtime` (`REALTIME_ENABLED`, `REALTIME_PATH`, `REALTIME_MAX_CONNECTIONS_PER_USER`); `.env.example`.
- `realtime/simulacrum.events.js` (bus Redis con `duplicate()`, fallback a memoria, validación `v===1`, reconexión con backoff) y `realtime/simulacrum.realtime.js` (`attachRealtime`: handshake con `verifyAccessToken`, tope de 5 conexiones, `join` validado con TypeBox y límite 20/min, `sim:state`, retransmisión leyendo Mongo con `findLight(..., { requireVisible:false })`).
- `server.js`: `attachRealtime(server)` si está habilitado; `io.close()` antes de `server.close()`. `createApp()` no cambia.
- Pruebas `test/simulacra_realtime.test.js` (§6.3 de la spec).

### Paso 10 — Despliegue y cierre
- `deploy/nginx-api.conf`: `location /api/v1/realtime/` con Upgrade y timeouts largos; `docs/deploy.md`.
- Prueba manual de punta a punta con el monolito (criterio 2 del contrato §12): crear un programado, recibir `sim:close/start/end/results` con ≤ 2 s de tolerancia.
- `npm test` y `npm run lint` completos.

---

## Dependencias entre repositorios

| Pendiente | Dónde | Cuándo |
|---|---|---|
| Publicar señal en Redis | Monolito (`simulacrum_signal.js`) | Hecho |
| Cerrar el solucionario hasta publicar (D7) | Monolito | Antes de que la web SSR use programados |
| App Android (spec 2) | App | Pasos 1–7 de la app se pueden hacer con datos simulados desde F1; el socket necesita el paso 9 |

## Orden de despliegue

1. F1 + bloqueo (pasos 1–8): sin nginx ni monolito.
2. Nginx con el `location` del socket.
3. F2 (paso 9) y monolito publicando la señal, en cualquier orden.

## Riesgos y cómo se cubren

| Riesgo | Mitigación |
|---|---|
| Romper simulacros no programados | Pruebas existentes verdes en cada paso; ramas por fechas solo si `isScheduled` |
| Divergencia con `simulacrum_window.js` del monolito | Prueba de paridad con las mismas tablas de verdad; cambios en ambos en el mismo PR |
| Apps antiguas sin `X-Exam-Session` | `sid = 'legacy'`: se separa web de app; el bloqueo entre dos teléfonos viejos llega con `APP_UPDATE_REQUIRED` |
| Nginx corta WebSocket | Paso 10 antes de activar F2 en producción |
| Redis caído | Modo memoria + polling de 30 s en el cliente; la API sigue aplicando la ventana |
