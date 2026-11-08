# Spec — Simulacros en vivo (0): contrato compartido

**Repositorios:** monolito `E:\Trabajo\eduteka` (hecho), API `E:\Trabajo\api_eduteka`, app Android (Kotlin) `C:\Users\Jose Taquiri\AndroidStudioProjects\Eduteka`.
**Documentos hermanos:** `spec-simulacros-en-vivo-1-api.md` (API) y `spec-simulacros-en-vivo-2-app.md` (app).
**Estado:** el monolito ya implementa todo lo de este documento y está probado de punta a punta (commits `990235ad` y `8a167b31`). La API y la app **no**: este contrato es lo que tienen que cumplir para comportarse igual.

---

## 1. Qué es un simulacro en vivo

Un simulacro **programado** tiene una ventana común: todos lo rinden entre `start_date` y `end_date`, la inscripción se cierra a `register_close_date`, y el servidor avisa a los clientes en el instante exacto de cada cambio, sin que ellos consulten.

> **Programado ⇔ `start_date` y `end_date` están ambos definidos.** El flag `automatic` es histórico (lo marcaba el viejo servidor EdkSocket) y **no** decide nada. Un simulacro sin esas dos fechas se sigue comportando como "bajo demanda".

El caso de uso de arranque es **gratis** (`price` vacío o 0 ⇒ la inscripción queda aprobada en el acto). El pago ya existe en la API y no cambia.

## 2. Modelo de datos (Mongo compartido)

Los tres proyectos leen y escriben las mismas colecciones. Solo se **agregan** campos opcionales; no hay migración.

| Colección | Campo | Tipo | Significado |
|---|---|---|---|
| `simulacrums` | `register_close_date` | Date | Cierre de inscripciones. Vacío ⇒ se cierra en `start_date`. |
| | `start_date` / `end_date` | Date | Ventana común. |
| | `results_public_at` | Date | Publicación programada de resultados (posterior a `end_date`). Vacío ⇒ al terminar la ventana. |
| | `public_results` | Boolean | Resultados publicados. En un programado lo pone el servidor al publicar. |
| | `finished` | Boolean | El simulacro está cerrado (lo pone el servidor al terminar la ventana, o el admin a mano). |
| | `for_register` | Boolean | Interruptor manual del admin. `false` bloquea la inscripción aunque la ventana esté abierta. |
| `usersimulacrums` | `ausent` | Boolean | Inscrito aprobado que nunca abrió el examen. Lo marca el cierre de la ventana. |
| | `start_exam` / `end_exam` | Date | Cronómetro **del intento**. `end_exam` nunca pasa de `end_date`. |
| | `exam_session` | `{ id, client, claimed_at, last_seen_at }` | Bloqueo del examen en curso a un solo dispositivo (§4.1). |

Los demás campos (`state`, `finished`, `attempt_number`, `answers`, `official_score`…) no cambian.

## 3. Fases

`phase` es el estado del simulacro respecto a la hora. Se calcula siempre en el servidor con la misma función en los tres proyectos.

| `phase` | Cuándo (hora `t` del servidor) |
|---|---|
| `finished` | `finished === true`, **o** `t ≥ end_date` |
| `live` | `start_date ≤ t < end_date` |
| `registration` | `t < close` y `for_register !== false`, con `close = register_close_date ?? start_date` |
| `waiting` | cualquier otro caso anterior al inicio (inscripción cerrada, aún no empieza) |

Se evalúan en ese orden. Tabla de verdad para `close=18:00`, `start=19:00`, `end=21:00`:

| `t` | 17:59:59 | 18:00:00 | 18:59:59 | 19:00:00 | 20:59:59 | 21:00:00 |
|---|---|---|---|---|---|---|
| `phase` | registration | waiting | waiting | live | live | finished |

**Compatibilidad con el campo `status` de la API:** `upcoming` = `registration` o `waiting`; `live` = `live`; `finished` = `finished`.

Referencia ejecutable: `src/libs/simulacrum_window.js` y `test/simulacrum/window.test.js` del monolito. **Los tres proyectos deben pasar esos mismos casos.**

## 4. Reglas que decide el servidor

Ningún cliente decide nada por su cuenta: el reloj del dispositivo solo sirve para **dibujar** la cuenta regresiva.

| Regla | Condición | Respuesta si no se cumple |
|---|---|---|
| Inscribirse | programado: `phase === registration`. Además `for_register !== false`, `verified`, y que no esté `finished` | `403 REGISTRATION_CLOSED` |
| Iniciar el intento oficial | programado: `phase === live` | antes: `403 NOT_STARTED`; después: `403 WINDOW_ENDED` |
| Límite del intento | `end_exam = min(start_exam + duration, end_date)` | — |
| Guardar respuestas | hasta `end_exam + 5 s` de holgura (`SIMULACRUM_ANSWER_GRACE_SECONDS`) | `409` |
| Finalizar | siempre se puede cerrar el propio intento abierto; si pasó el límite se califica con lo guardado | — |
| Reintento (práctica) | ya cerrado el intento anterior; **no** exige ventana ni cuenta para el ranking | — |

**Inscripción:** nadie se inscribe después de la fecha máxima de inscripción (`close`), ni durante la ventana en vivo aunque `register_close_date` sea posterior al inicio (la fase `live` tiene prioridad). **Entrada tardía:** quien ya está inscrito puede abrir el examen en cualquier momento de la fase `live` y rinde con el tiempo que quede. *(Decisiones D7 y D8.)*

Entrar tarde **acorta** el intento. Con duración de 3 min y una ventana de 5 min: quien abre a los 2 min tiene `min(3, 5−2) = 3` min (completo); quien abre a los 3 min tiene `min(3, 2) = 2` min; quien abre a los 4 min, `1` min. El cliente tiene que decírselo antes y después de entrar (ver spec de la app, §6.2 y §6.3).

### 4.1 Un solo dispositivo a la vez en el examen

Quien está rindiendo desde la web **no puede abrir ese mismo examen desde la app, ni al revés** (ni desde un segundo navegador). Aplica **solo al examen en curso**: la ficha, la sala de espera y los resultados se ven desde cualquier dispositivo. *(Decisión D6, confirmada. Ya implementado en el monolito: `src/libs/exam_session.js`.)*

**Mecanismo: un arrendamiento (lease) en la propia inscripción**, que es el intento vivo y la comparten el monolito y la API. Como vive en Mongo, funciona entre procesos sin Redis y es atómico.

| Pieza | Detalle |
|---|---|
| Identidad del dispositivo | `id = "<client>:<sid>"`. `client` ∈ `web` \| `app`. `sid`: en la web, la cookie `edk_exam_sid` (una por navegador); en la app, un UUID por instalación |
| Quién lo reclama | Quien abre/inicia el examen. Si nadie lo tiene, o el titular dejó de dar señales, pasa a quien lo pide |
| Renovación | Cada respuesta, el cierre y un **latido cada 20 s** (`heartbeat_seconds`) |
| Vencimiento | **60 s** sin señales (`ttl_seconds`). Entonces cualquier otro dispositivo puede retomarlo |
| Mismo dispositivo | Recargar o reabrir la app entra **de inmediato** (el `id` coincide) |
| Qué se retoma | **El mismo intento**: el cronómetro no se reinicia y las respuestas se conservan |

| Operación | ¿Pasa por el bloqueo? |
|---|---|
| Abrir el examen (`/proceso`, `POST /iniciar`) | Sí: reclama; si lo tiene otro ⇒ `409` |
| Guardar respuestas | Sí: renueva; no titular ⇒ `409` y la respuesta **no** se guarda |
| Finalizar | Sí: solo el titular |
| Latido | Sí: renueva; no titular ⇒ `409` (así el titular que perdió la red se entera pronto) |
| Cierre de la ventana, calificación perezosa, ausentes | **No**: son del servidor |
| Ficha, sala de espera, resultados, solucionario | **No** |
| Reintento (práctica) | Empieza un intento nuevo: `exam_session` se borra |

Respuesta de rechazo: `409 ATTEMPT_ACTIVE_ELSEWHERE` con los datos del titular para poder explicarlo y reintentar:

```json
{ "error": { "code": "ATTEMPT_ACTIVE_ELSEWHERE",
             "message": "Tu examen está abierto en la app de Eduteka.",
             "holder": { "client": "app", "last_seen_at": "2026-11-10T19:00:12.000Z", "retry_after_seconds": 48 } } }
```

**Respuestas pendientes de quien pierde el bloqueo.** Un dispositivo que recibe el `409` **pausa** su envío y reintenta retomar el examen. Si lo retoma habiendo visto antes el `409` (otro dispositivo lo tuvo mientras tanto), **manda el estado del servidor** y su cola local se descarta, para no pisar lo que se respondió en el otro. Si lo retoma sin haber visto nunca un `409` (solo estuvo sin red y nadie más entró), envía su cola con normalidad.

## 5. Cierre de la ventana (lo hace el monolito)

Al llegar `end_date`, **una sola vez y de forma idempotente**:

1. Marca `ausent: true` a los inscritos aprobados, en intento 1, sin `start_exam` y sin terminar.
2. Califica los intentos abiertos con concurrencia limitada (5), reintenta una vez los que fallen; el que siga fallando queda abierto y se califica de forma perezosa cuando su dueño pida el resultado.
3. Marca `finished: true` en el simulacro.
4. Si `resultsDue`, publica los resultados (`public_results: true`, también en cada inscripción).
5. Avisa por el canal de eventos (§7).

La publicación es **a `end_date`** salvo que haya `results_public_at` posterior: entonces hay un hito aparte y se avisa con `results`.

## 6. Resultados

Para un programado, los resultados son **de todos o de nadie**: hasta que se publican, **ni el puntaje propio ni el ranking** se muestran. Antes de publicar, un participante que ya terminó solo ve que su examen quedó registrado.

```jsonc
// GET /simulacros/:slug/resultados  — antes de publicar (programado)
{
  "enrolled": true,
  "results_published": false,
  "results_at": "2026-11-10T22:00:00.000Z",
  "submission": { "finished_at": "2026-11-10T19:48:00.000Z", "answered": 2, "total": 60 },
  "attempt": null,
  "ranking": { "visible": false },
  "absent": false
}
```

Después de publicar, la respuesta es la actual (`attempt`, `by_area`, `ranking`, `attempts`…) más `results_published: true` y `absent`. Un ausente ve `absent: true`, `attempt: null` y el ranking.

**Solucionario:** en un programado tampoco se ve hasta que los resultados estén publicados (ver las respuestas correctas permitiría calcular el puntaje propio). Antes de publicar: `403`. *(Decisión D7.)*

Simulacros no programados: **sin cambios** (regla histórica: `public_results !== false` ⇒ públicos).

## 7. Eventos en tiempo real

### 7.1 Cadena

```
monolito (dueño de los temporizadores y de las escrituras)
   │  1. hito vence → escribe en Mongo (cierra, califica, publica)
   │  2. emite a SUS sockets (SSR) y
   └─ 3. publica una SEÑAL en Redis  ──►  API (suscriptor)
                                              └─ lee el estado de Mongo y emite a SUS sockets (app / web Next)
```

La señal **no lleva datos de negocio**: solo dice "pasó X en el simulacro Y". El receptor lee la verdad de la base. Así no hay dos fuentes de estado y un mensaje duplicado o tardío es inofensivo.

**Canal Redis:** `edk:simulacrum:events`. **Mensaje:**

```json
{ "v": 1, "type": "start", "simulacrum_id": "b2875ee8-…", "slug": "simulacro-beca-18-2023", "emitted_at": "2026-11-10T19:00:00.017Z" }
```

`type` ∈ `close` · `start` · `end` · `results` · `updated` (el admin cambió fechas).

### 7.2 Eventos del socket de la API (servidor → cliente)

Sala `simulacrum:<id>`. Todas las fechas en **ISO 8601** (como el resto de la API); `server_time` también.

```jsonc
// Cuerpo común a todos los eventos
{
  "slug": "simulacro-beca-18-2023",
  "simulacrum_id": "b2875ee8-…",
  "phase": "live",                       // registration | waiting | live | finished
  "server_time": "2026-11-10T19:00:00.021Z",
  "register_close_date": "…", "start_date": "…", "end_date": "…",
  "results_at": "…",
  "results_published": false
}
```

| Evento | Cuándo | Qué debe hacer el cliente |
|---|---|---|
| `sim:state` | Al unirse a la sala y tras reconectar | Reemplazar su estado; es la verdad actual |
| `sim:close` | Se cerró la inscripción | Actualizar la UI (el botón de inscripción ya no aplica) |
| `sim:start` | Abrió la ventana | Pasar de la sala de espera al examen |
| `sim:end` | Terminó la ventana; los intentos abiertos ya están calificados | Cerrar el examen y pedir el resultado/estado |
| `sim:results` | Se publicaron los resultados | Pasar de "esperando resultados" a resultados |
| `sim:updated` | El admin cambió fechas | Volver a pedir la ficha y reprogramar avisos locales |

**Cliente → servidor:** `join { slug }` con *ack* `{ ok, state }`. Solo se admite a quien tiene inscripción en ese simulacro.

### 7.3 Reglas de robustez

- **El evento es un aviso, el `phase` es la verdad.** Los manejadores deben ser idempotentes y decidir por `phase`, no por el orden en que llegan los eventos.
- **Nunca se confía en que llegue un evento.** Al reconectar, el servidor manda `sim:state`; al volver la app a primer plano, el cliente vuelve a pedir la ficha. Con eso se recupera cualquier evento perdido.
- **Degradación:** si el socket no está disponible, el cliente pide `GET /simulacros/:slug` cada 30 s **solo mientras esté desconectado** (y solo en la sala de espera o el examen). Es el único polling permitido.
- **Si el monolito está caído:** los endpoints de la API siguen aplicando la ventana (el servidor es la autoridad), el intento se puede finalizar y se califica de forma perezosa. Solo faltan los avisos y el cierre masivo.

## 8. Códigos de error nuevos

Estables, en inglés, no se renombran (convención de `api_error.js`).

| Código | HTTP | Cuándo |
|---|---|---|
| `REGISTRATION_CLOSED` | 403 | Inscripción fuera de la ventana de inscripción |
| `NOT_STARTED` | 403 | Iniciar antes de `start_date` |
| `WINDOW_ENDED` | 403 | Iniciar después de `end_date` |
| `ATTEMPT_ACTIVE_ELSEWHERE` | 409 | El examen está abierto en otro dispositivo (§4.1). Lleva `holder`. **No es terminal:** el cliente reintenta; no borra nada |
| `ATTEMPT_ALREADY_FINISHED` | 409 | Iniciar, guardar, finalizar o latido de un intento ya cerrado (p. ej. lo cerró el servidor al terminar la ventana). **El cliente lo trata como éxito:** va a ver su estado, no muestra error |

## 9. Decisiones tomadas y abiertas

| # | Decisión | Estado |
|---|---|---|
| D1 | **Dueño de los temporizadores y de las escrituras de cierre: el monolito.** Es dueño de los crons y de los índices de la base, el admin que edita las fechas vive ahí, y su planificador ya está hecho y probado. La API solo retransmite. | Recomendada; alternativa en §9.1 |
| D2 | **Resultados propios ocultos hasta publicar** en programados (§6). | **Confirmada** |
| D3 | **Simulacros de pago:** la app (sabor `directo`, con comprobante) y la API **ya los soportan** y no cambian. El simulacro de arranque es gratis, así que la v1 en vivo se valida con ese. Un pago pendiente de revisión no inscribe del todo: quien no esté verificado al empezar no puede entrar hasta que se apruebe (mientras la ventana siga abierta). | Abierta |
| D4 | **Notificaciones push remotas: fuera de la v1.** La v1 usa notificaciones locales programadas en el dispositivo (sin infraestructura). | Abierta |
| D6 | **Un solo dispositivo a la vez** (web o app) en el **examen en curso**, con liberación automática a los 60 s sin señales (§4.1). | **Confirmada** |
| D7 | **Solucionario cerrado hasta publicar los resultados** en programados (§6). | **Confirmada** |
| D8 | **Inscripción cerrada tras la fecha máxima; entrada tardía al examen permitida** con el tiempo restante (§4). | **Confirmada** |
| D5 | **Web Next en vivo** comparte este socket; necesita un token de acceso en el navegador (vía `/bff`). Queda fuera de estas specs. | Abierta |

### 9.1 Alternativa descartada: la API es dueña de los temporizadores

Haría que la API no dependa del monolito para los simulacros, pero obliga a **duplicar** el planificador, la calificación masiva y la publicación (con dos calificadores distintos escribiendo sobre las mismas filas), y el cambio de fechas desde el admin tendría que avisar a la API de todos modos. Con una sola instancia de cada proyecto no compensa. Si el monolito se retira del todo, el planificador se mueve a la API tal cual (es un módulo con dos dependencias: Mongo y el bus).

## 10. Desalineaciones encontradas en el código actual

Descubiertas al escribir esta spec; se corrigen en las fases de §11.

1. **API:** `simulacrumStatus`, `statusClauses` y `startWindowViolation` deciden por `automatic`. Un simulacro con fechas pero sin ese check se comporta como "bajo demanda": no aplica la ventana. *(API §3)*
2. **API:** `enroll` solo mira `for_register`; no conoce el cierre de inscripciones. *(API §3)*
3. **API:** `startAttempt` fija `end_exam = ahora + duración` sin acotar a `end_date`. *(API §3)*
4. **API:** `public_results !== false` hace públicos los resultados de un simulacro recién creado (campo sin definir), también **durante** la ventana. En programados debe ser `=== true`. *(API §3)*
5. **Monolito:** `/resultados` deja ver el puntaje propio y el ranking a un participante aunque los resultados de un programado no estén publicados. Hay que aplicar §6 (D2). Es un cambio en `simulacrumResultsController`. **Hecho** (`resultsGate` en `src/libs/simulacrum_window.js`). **Pendiente en el monolito:** cerrar también el solucionario hasta publicar los resultados (D7).
6. **Infraestructura:** `deploy/nginx-api.conf` hace `proxy_set_header Connection ""`, lo que rompe WebSocket. Hace falta un `location` para el socket. *(API §7)*
7. **API:** `startAttempt` evalúa la ventana antes que el vencimiento del intento y deja `FORBIDDEN` (no `WINDOW_ENDED`) cuando el monolito ya marcó `finished`; `enroll` bloquea con `for_register !== true`. *(API §3.3, §3.4)*

## 11. Orden de implementación

| Fase | Qué | Dónde | Depende de |
|---|---|---|---|
| **F1** | Reglas de ventana y contrato REST (`schedule`, errores, resultados diferidos) | API + monolito (§10.5) | — |
| **F2** | Retransmisión en vivo: publicar señal, suscribirse y emitir por socket; nginx | monolito + API | F1 |
| **F3** | Pantallas de la app (ficha, sala de espera, examen, resultados) con el socket y las notificaciones locales | app | F1, F2 |
| **F4** | (Opcional) push remoto | monolito + API + app | F3 |

La app puede avanzar en paralelo desde que existe F1 con datos simulados; el socket entra en F2.

## 12. Criterios de aceptación de extremo a extremo

Con un simulacro gratis programado (cierre +3 min, inicio +4 min, fin +9 min, duración 3 min, resultados +11 min) y un estudiante **en la app**:

1. Se inscribe antes del cierre; después del cierre otro estudiante recibe `REGISTRATION_CLOSED`.
2. Queda en la sala de espera; a `start_date` la app pasa **sola** al examen (≤ 2 s), sin que nadie toque nada y sin consultas periódicas (verificable en el tráfico).
3. Matar la app en medio del examen y reabrirla: vuelve al mismo intento con el mismo tiempo restante.
4. Cortar la red 30 s durante el examen y marcar respuestas: no se pierde ninguna al volver.
5. Al vencer su cronómetro, el intento se cierra y se califica solo; la app muestra "Examen enviado" y la hora de publicación.
6. Un segundo estudiante que **no abrió** el examen queda `ausent: true` a `end_date`.
7. A la hora de publicar, la app pasa sola a resultados con el puntaje y el puesto.
8. Un estudiante que entra tarde ve el aviso con su tiempo reducido, y su intento termina a `end_date`.
9. Con el socket bloqueado, la app sigue funcionando (modo degradado de §7.3) y se recupera al volver la conexión.
10. Con el examen abierto en la web, la app no puede abrirlo ni responder (ve el bloqueo con el motivo y el tiempo); cerrando la pestaña web, la app lo retoma a los ~60 s **con el mismo tiempo y las mismas respuestas**. Y al revés.
