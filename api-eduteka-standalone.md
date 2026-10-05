# Eduteka API v1 — Especificación autónoma

Backend JSON independiente (Node.js + Express + MongoDB + Redis). Lo consumirá primero la app Android (Kotlin/Compose) y después el sitio web, que dejará de tener lógica de servidor propia y pasará a ser un cliente más de esta API.

**Objetivos**
1. Contrato único y estable para todos los clientes (Android hoy, web después).
2. Compatibilidad de datos: usa el **mismo modelo de datos** (colecciones MongoDB) que ya tiene Eduteka, de modo que la migración sea apuntar la web a la API, sin migrar información.
3. Autónoma: no depende de ninguna sesión, vista ni middleware del sitio actual.

---

## 1. Stack y dependencias

| Capa | Elección |
|---|---|
| Runtime | Node.js ≥ 20 LTS, ESM (`"type":"module"`) |
| HTTP | Express 4 |
| BD | MongoDB + Mongoose 8 (la misma base del monolito; ver §14) |
| Caché / rate limit / colas ligeras | Redis (`redis` de node-redis; cliente en memoria si no hay Redis, `src/config/redis.js`) |
| Validación | TypeBox + Ajv (+ `ajv-formats`, `ajv-errors`) — los esquemas sirven también para generar OpenAPI |
| Auth | `jose` (JWT HS256) + `bcrypt` |
| Subidas | `multer` |
| PDF | `pdf-lib` (generación/composición) |
| Correo | `nodemailer` o `resend` |
| Seguridad | `helmet`, `cors`, `compression` |
| Logs | `pino` + `pino-http` (`request_id`) |
| Tests | `node --test` + `supertest` + `mongodb-memory-server` |
| Docs | OpenAPI 3.1 generado desde los esquemas TypeBox |

## 2. Estructura del proyecto

```
eduteka-api/
├── src/
│   ├── app.js                    # crea la app Express (sin listen, para tests)
│   ├── server.js                 # listen + conexión Mongo/Redis + shutdown ordenado
│   ├── config/                   # env.js (validado), db.js, redis.js, mail.js
│   ├── modules/
│   │   ├── auth/                 # routes, controller, service, schemas
│   │   ├── users/                # perfil, avatar, contraseña
│   │   ├── catalog/              # instituciones, áreas, config
│   │   ├── questions/
│   │   ├── practices/
│   │   ├── exams/
│   │   ├── simulacra/
│   │   ├── progress/
│   │   ├── store/                # productos, carrito/resolver, checkout, pedidos
│   │   ├── subscriptions/
│   │   └── downloads/
│   ├── models/                   # Mongoose (§5)
│   ├── middlewares/              # authenticate, authorize, requireSubscription, validate,
│   │                             # rateLimit, upload, appVersion, errorHandler
│   ├── libs/                     # envelope, ApiError, paginate, tokens, storage, mailer, pdf
│   └── openapi/                  # generación del spec
├── test/
├── storage/                      # archivos privados (fuera de la raíz pública)
├── .env.example
└── package.json
```

Patrón por módulo: `routes → controller (delgado) → service (lógica) → model`. El controlador solo valida, llama al servicio y responde con `ok()/created()/noContent()`. Nunca hay `res.render`.

## 3. Convenciones

| Tema | Decisión |
|---|---|
| Base URL | `/api/v1` |
| Formato | JSON UTF-8; archivos por `multipart/form-data` (subida) o binario (descarga) |
| Auth | `Authorization: Bearer <access_token>`. Sin cookies |
| Campos | `snake_case`. IDs string (UUID). Fechas ISO-8601 UTC |
| `message` | Español (fallback visible). `code` en inglés, estable, parte del contrato |
| Caché | `Cache-Control: no-store` por defecto; los catálogos públicos pueden usar `ETag` |
| Versión de cliente | `X-App-Version` (Android) → si < `APP_MIN_VERSION`, `426 APP_UPDATE_REQUIRED` |
| Trazabilidad | `X-Request-Id` entrante o generado, devuelto en header y en errores |

### 3.1 Envelope

```jsonc
// éxito
{ "data": { }, "meta": { "page": 1, "limit": 20, "total": 134, "has_more": true } }
// error
{ "error": { "code": "VALIDATION_ERROR", "message": "…", "details": [{ "field": "email", "message": "…" }] },
  "request_id": "a3f19c" }
```

### 3.2 Códigos de error

| HTTP | `code` | Uso |
|---|---|---|
| 400 | `BAD_REQUEST` | JSON inválido, petición mal formada |
| 400 | `INVALID_CODE` | Código de verificación/recuperación incorrecto, vencido o con intentos agotados (mismo mensaje en todos los casos) |
| 400 | `INVALID_TOKEN` | `reset_token` inválido, vencido o ya usado |
| 401 | `UNAUTHENTICATED` | Sin token / expirado (el cliente hace refresh) |
| 401 | `INVALID_CREDENTIALS` | Correo o contraseña incorrectos en `/auth/login` (no distingue si el correo existe) |
| 403 | `FORBIDDEN`, `SUBSCRIPTION_REQUIRED`, `INSTITUTION_RESTRICTED`, `EMAIL_NOT_VERIFIED`, `ACCOUNT_DISABLED` | Sin permiso |
| 404 | `NOT_FOUND` | Inexistente (también cuando el recurso es de otro usuario) |
| 409 | `CONFLICT` | Estado incompatible (intento ya finalizado, correo ya registrado) |
| 422 | `VALIDATION_ERROR` | Falla de esquema (`details[]`) |
| 413 | `PAYLOAD_TOO_LARGE` | Cuerpo JSON de más de 100 kB |
| 426 | `APP_UPDATE_REQUIRED` | Cliente obsoleto |
| 429 | `TOO_MANY_REQUESTS` | Rate limit (`Retry-After`) |
| 500 | `INTERNAL_ERROR` | — |
| 503 | `MAINTENANCE` | Modo mantenimiento |
| 503 | `EMAIL_DELIVERY_FAILED` | No se pudo enviar el correo del registro; la cuenta queda creada y se puede reenviar el código |

### 3.3 Paginación
`?page=1&limit=20` (máx. 50). `meta` = `{page, limit, total, has_more}`. Ordenamiento estable por `created_at desc, _id`.

### 3.4 Rate limiting (Redis, ventana fija)
| Bucket | Aplica a | Límite sugerido |
|---|---|---|
| `global` | Todo | 120/min por IP o usuario |
| `auth` | login, register, refresh, recover | 10/min por IP |
| `auth-email` | login, códigos | 5/15 min por correo |
| `write` | respuestas, autoguardado, checkout | 60/min por usuario |

Fallback en memoria si Redis cae. Cada respuesta lleva `RateLimit-Limit/Remaining/Reset`; al excederse, `429` con `Retry-After`. El bucket `auth-email` cuenta registro, reenvío de código y recuperación; el **login cuenta aparte solo sus fallos** por correo (`LOGIN_MAX_FAILURES` en `LOGIN_FAILURE_WINDOW_SECONDS`) y un acierto reinicia el contador. `RATE_LIMIT_GLOBAL` por IP: muchas operadoras móviles comparten IP (CGNAT), ajústalo con datos reales. En login, el rate limit reemplaza al reCAPTCHA (inviable en cliente nativo; en web se puede añadir captcha opcional como header `X-Captcha-Token`).

---

## 4. Autenticación y autorización

**Tokens**
- **access**: JWT HS256 `{uid, rol, typ:'access'}`, 30 min, stateless.
- **refresh**: valor aleatorio de 256 bits; en BD solo su **hash SHA-256** (`RefreshToken{user_id, family_id, token_hash, expires_at, revoked_at, replaced_by, device}`), 60 días, **rotativo**; reutilizar uno ya rotado revoca toda la familia.
- **reset**: JWT `typ:'reset'` con `jti` de un solo uso, 15 min.
- El claim `typ` impide reciclar un token en otro flujo.

**Códigos de 6 dígitos** (verificación 15 min, recuperación 10 min): se guardan como HMAC-SHA256 (atado a propósito + correo) en `token_verify` / `token_recovery_verify`, con vencimiento e intentos en `token_*_expires` / `token_*_attempts`; 5 intentos fallidos invalidan el código. Registro, reenvío y recuperación comparten un enfriamiento de 60 s por correo que se aplica **antes** de mirar si la cuenta existe (no delata correos). Un código de verificación no sirve para recuperar ni al revés. `POST /auth/register` responde `409 CONFLICT` si el correo ya está verificado (excepción consciente a "sin enumeración": la app necesita decirlo); una cuenta sin verificar se sobrescribe y recibe un código nuevo.

**Login:** contraseña incorrecta y correo inexistente responden igual (`401 INVALID_CREDENTIALS`, con un hash de relleno para igualar tiempos). Solo tras acertar la contraseña se informa `EMAIL_NOT_VERIFIED` o `ACCOUNT_DISABLED`. **Suscripción vigente** = `status:'activo'` **y** `end_date` futura (o nula): el estado lo cierra un cron diario del monolito, así que entre el vencimiento y esa corrida `status` sigue diciendo `activo`.

**Refresh:** el uso de un token es atómico; reutilizar uno ya rotado revoca la familia entera. Dos `refresh` simultáneos con el mismo token dejan a la app sin sesión: el cliente debe serializarlos (`Authenticator` de OkHttp con lock).

**Roles:** `User`, `Administrador` (más adelante `Editor`). **Tipo de cuenta:** `Estudiante`, `Profesor`.

**Capacidades** (derivadas, calculadas en servidor y devueltas en `/auth/me`): `TRACK_PROGRESS`, `DOWNLOAD_EXAMS`, `TAKE_SIMULACRUM`, `USE_PRACTICES`, `TEACHER_TOOLS`. Un usuario con `suscription.status = 'activo'` (o rol Administrador) tiene acceso premium.

**Middlewares:** `authenticate` (nunca corta; resuelve el usuario o anónimo) → `authorize(...)` (exige sesión y rol) → `requireSubscription()` (exige plan activo; `INSTITUTION_RESTRICTED` si el plan está limitado a otra institución).

### Endpoints

| Método y ruta | Auth | Body / notas |
|---|---|---|
| `POST /auth/register` | — | `email, password(8-15), username(≥3), departament, account_type, university?, edkNotification?` → crea usuario no verificado y envía código de 6 dígitos |
| `POST /auth/resend-code` | — | `email` |
| `POST /auth/verify-code` | — | `email, code` → tokens + usuario |
| `POST /auth/login` | — | `email, password` → tokens + usuario |
| `POST /auth/refresh` | — | `refresh_token` → nuevo par (rota) |
| `POST /auth/logout` | Bearer | `refresh_token` (revoca su familia) |
| `POST /auth/recover` | — | `email` (respuesta idéntica exista o no el correo) |
| `POST /auth/verify-recovery-code` | — | `email, code` → `reset_token` |
| `POST /auth/reset-password` | — | `reset_token, password` (revoca todos los refresh del usuario) |
| `GET /auth/me` | Bearer | Usuario + `suscription` + `capabilities` |

Respuesta de tokens:
```json
{ "data": { "access_token": "…", "refresh_token": "…", "token_type": "Bearer", "expires_in": 1800, "user": { } } }
```

---

## 5. Modelo de datos

Colecciones compatibles con Eduteka actual. `_id` es string UUID; todas llevan `created_at/updated_at`. Los campos marcados 🔒 **nunca** se serializan a clientes.

### User
`name, username, fullname, dni, email (único, lowercase), 🔒password (select:false), state (activo), rol, account_type, departament, university → Institution, teaching_area → Area, avatar, isVerified, suscription{ status:'activo'|'Finalizado', plan_id, slug, start_date, end_date, restricted_to_institution, institution_id }, suscription_history[], notification (bool), notification_subscription_renovation, notification_subscription_expiration, last_session, 🔒token_verify, 🔒token_recovery_verify, 🔒token_recovery_expires, access_beta_teacher`.

Campos añadidos por la API a `User` (el monolito los ignora): `token_verify_expires`, `token_verify_attempts`, `token_recovery_attempts`, `password_reset_jti`.

### RefreshToken *(nuevo)*
`user_id, family_id, token_hash, expires_at, revoked_at, replaced_by, device{name, platform, app_version}, ip, created_at`. Índices: `token_hash` único; TTL sobre `expires_at`.

### Institution
`name, abrev, description, image, state, subjects[], modalities[], professional_areas{abrev,title,description,careers[]}, departament, province, exams_count, exams_count_by_modality[]`.

### Area
`name, slug (único), count, institutions[]`.

### Question
`topic, area, area_id → Area, slug, difficulty, type, competition, question (HTML/MathJax), images[{url, type: question|option|resolution}], options (objeto {A,B,C,D,E}), options_answers, 🔒rpta (letra correcta), 🔒rpta_text, 🔒resolution (explicación), verified, state, origin ('Oficial'|'Docente'), exam, exam_area, iexam[{id_exam, exam_slug, exam_title, exam_areas}], simulacrums[], dependence (bloque/contexto compartido), total_answers, uid (único)`.
Solo se sirven preguntas `verified:true, state:true, origin != 'Docente'`.

### Practice *(lista de preguntas: `UserQuestionsList`)*
`name, description, user, areas, count_questions, slug, public, verified, favorites, questions[] (ids), suggestion{key,via,series}`.

### PracticeAttempt
`user_id, practice_id, practice_slug, source ('lista'|'area'), area_id, topic, answers{question_id: letra}, time (s), total_questions, questions_correct, questions_incorrect, questions_not_answered`.

### UserAnswer
`user_id, question_id, answer`. Índice `{user_id, question_id}`.

### Exam
`title, description, slug, abrev, type, modality, institution{id,name,abrev}, subjects[], areas (objeto por área), date, state, favorites (contador), verified, image_post, files{por área}, general_items[], unique (área única)`.

### FavoriteExam
`exam_id, user_id, state`. Índice `{exam_id,state}`.

### Simulacrum
`title, description, slug, institution, areas, exam_id, price, start_date, end_date, date_program, duration (min), time, questions (estructura por área), score, score_correct, score_incorrect, score_not_answered, calification_type, general, automatic, finished, for_register, public_results, verified, state, image_post`.

### UserSimulacrum *(inscripción)*
`user_id, simulacrum_id, fullname, area, career, screenshot (comprobante), amount_paid, state, status_reason, finished, public_results, attempt_number, score, score_conversion, official_score, official_score_conversion`.

### SimulacrumAttempt *(archivo de solo lectura de intentos pasados)*
`user_simulacrum_id, user_id, simulacrum_id, attempt_number, area, career, answers{}, start_exam, end_exam, exam_finished, time, score, score_conversion, results, questions_correct, questions_incorrect, questions_not_answered`.

> **El intento vivo NO está aquí sino en `UserSimulacrum`** (`answers`, `start_exam`, `end_exam`, `score`, `attempt_number`…). `reintentar` copia el intento vivo a `SimulacrumAttempt` (índice único `(user_simulacrum_id, attempt_number)` que hace idempotente el doble clic), sube `attempt_number` y limpia los campos del intento. `official_score*` congela el primer intento y es el que usa el ranking. Por eso, en §6.5 el `attempt_id` de `respuestas` y `finalizar` es el **`user_simulacrum_id`**.

### Product
`name, description, slug, price, images[], poster, type, type_file, state (publicado), unique, areas (para exámenes), files[{name, path, area}]`. 🔒`files[].path` nunca sale.

### Order
`user_id, items[{product_id, name, price, quantity, areas[]}], total, discount, payment_method ('transferencia'|'yape'|'plin'|'tarjeta'), payment_proof (ruta privada), status ('pending'|'verified'|'rejected'), status_reason, message`.

### Suscription *(plan)*
`name, slug, duration_days, duration_months, price, description, state, restricted_to_institution`.

### QuestionReport
`question_id, user_id, type ('Pregunta'|'Opción'|'Respuesta'), description (≤500), status ('Pendiente'|'Revisado'|'Resuelto'|'Rechazado'), reviewed_at, adminNote`.

### Download *(bitácora)*
`user_id, source ('store'|'subscription'|'material'), resource_type ('product'|'exam'|'material'), resource_id, resource_slug, resource_name, area, file_name, order_id, ip, user_agent`.

---

## 6. Endpoints

Leyenda: 🌐 público · 🔑 Bearer · 💎 Bearer + suscripción activa.

### 6.1 Meta y catálogo
| | Ruta | Descripción |
|---|---|---|
| 🌐 | `GET /config` | `{min_version, latest_version, payments_enabled, maintenance, web_url, support_whatsapp}` |
| 🌐 | `GET /health` | Mongo + Redis; `503` si falla alguno |
| 🌐 | `GET /instituciones` | Instituciones activas |
| 🌐 | `GET /areas?institution=` | Áreas |

### 6.2 Preguntas
| | Ruta | Descripción |
|---|---|---|
| 🌐 | `GET /preguntas?area=&topic=&difficulty=&institution=&q=&page=` | Listado paginado. **Sin** `rpta`/`resolution` |
| 🌐 | `GET /preguntas/temas?area=` | Temas del área con conteo |
| 🌐 | `GET /preguntas/:id` | Detalle (sin respuesta) |
| 🔑 | `POST /preguntas/:id/responder` | `{selected}` → `{is_correct, correct, explanation}`; guarda `UserAnswer`. Límite diario de respuestas para plan gratuito |
| 🔑 | `POST /preguntas/:id/reportar` | `{type, description}` |

**Notas de implementación (fase 3, verificadas con pruebas):**
- **Qué se sirve:** preguntas oficiales (`origin != 'Docente'`), `verified:true` y **con `rpta`** (una pregunta sin clave no se puede corregir; hay miles verificadas sin ella). **No se exige `state:true`**: el monolito no lo usa para servir y el campo vale `false` por defecto, así que exigirlo podría ocultar casi todo el banco. Confirmar con datos reales.
- `area` acepta el **id o el slug** del área (los dos vienen en `GET /areas`); un área inexistente da `404`. `institution` filtra por `iexam.exam_institution_id`.
- Forma de una pregunta: `{id, question (HTML con imágenes absolutas), options:[{key,text}], area, area_id, topic, difficulty, type, context}`. `context` es el texto de lectura compartido (`dependence`) o `null`. **Nunca** lleva `rpta`, `resolution`, `options_answers` ni `total_answers` (proyección + lista blanca en el serializador + pruebas).
- `q` usa `$text` sobre el índice `topic_text_question_text` (existe en producción, ningún schema lo declara; las pruebas lo crean). Orden: sin `q`, `created_at desc, _id`; con `q`, relevancia.
- `GET /areas` y `/instituciones` son públicos con `Cache-Control: public, max-age=300` y ETag (`304`).
- **Responder** (`POST /preguntas/:id/responder {selected}`): exige sesión y la capacidad `USE_PRACTICES` (las cuentas de docente reciben `403`). Respuesta: `{question_id, selected, is_correct, correct, explanation, community:{total, options:[{key,count,percent}]}}`. Cada usuario cuenta **una vez** por pregunta; cambiar de opción **mueve** el voto. Se usan `$inc` atómicos (no `save()`, que dispararía los hooks del schema y pisaría contadores concurrentes) y no se toca `updated_at`. Una segunda petición idéntica en menos de 2 s da `409` (doble toque).
- **Límite diario** del plan gratuito: `FREE_DAILY_ANSWER_LIMIT` respuestas nuevas por día de Lima (0 = sin límite; **valor pendiente de decidir**). Al agotarlo: `403 SUBSCRIPTION_REQUIRED`. Cambiar una respuesta no consume cupo. Exentos: suscripción vigente y administrador.
- **Reportar** (`POST /preguntas/:id/reportar {type, description}`): `201`; el mismo tipo sobre la misma pregunta no se repite (`409`). Pendiente: registrar la acción en `ActivityLog` (el monolito lo hace en `createReportQuestionController`).

### 6.3 Prácticas
| | Ruta | Descripción |
|---|---|---|
| 🌐 | `GET /practicas-area/temas?area=` | Temas disponibles |
| 🔑 | `GET /practicas-area/preguntas?area=&topic=&count=&difficulty=` | Genera práctica al vuelo (sin respuestas) |
| 🔑 | `POST /practicas-area/finalizar` | `{area, topic, question_ids[], answers, time}` → corrige y guarda `PracticeAttempt` |
| 🌐 | `GET /practicas?area=&q=&page=` | Prácticas/listas publicadas |
| 🔑 | `GET /practicas/:slug` | Detalle y preguntas (sin respuestas) |
| 🔑 | `POST /practicas/:slug/finalizar` | `{answers, time}` → corrección |

Respuesta de corrección:
```json
{ "data": { "attempt_id": "…", "total": 20, "correct": 14, "incorrect": 4, "not_answered": 2, "time": 812,
  "review": [{ "question_id": "…", "selected": "B", "correct": "C", "is_correct": false, "explanation": "…" }] } }
```
**Regla:** durante un intento el servidor nunca entrega la clave; solo la devuelve en la corrección.

**Notas de implementación (fase 4, verificadas con pruebas):**
- **Generar** (`GET /practicas-area/preguntas?area=&topic=&difficulty=&institution=&count=&with_resolution=`): exige sesión y `USE_PRACTICES`. `area` por id o slug. `count` 1-50 (10 por defecto); si hay menos disponibles, devuelve las que hay. Usa `$sample`. `meta`: `{total, requested, quota_remaining}`. Con el límite diario activo, la tanda se **recorta al cupo que queda** y con el cupo agotado responde `403 SUBSCRIPTION_REQUIRED`.
- **Cerrar** (`POST /practicas-area/finalizar`, `POST /practicas/:slug/finalizar`): corrige en el servidor y guarda `PracticeAttempt` (`source:'area'|'lista'`). `answers` = `{question_id: "A" | null}` (`null` = la saltó); `time` opcional. `201` la primera vez.
  - **Idempotente:** reenviar el mismo cierre en 10 min devuelve `200` con el mismo `attempt_id` y no duplica el intento ni los votos. Dos cierres simultáneos: uno gana, el otro recibe `409` y al reintentar obtiene el `200`.
  - Una pregunta que ya no se sirve (desverificada, de otra área) cuenta como no respondida; si **ninguna** se sirve, `422`. Una letra que la pregunta no tiene cuenta como incorrecta y no vota. `answers` con ids que no están en la práctica: `422`.
  - **Comunidad:** el cierre registra las respuestas con la misma regla que `/preguntas/:id/responder` (una vez por usuario y pregunta; cambiar de opción mueve el voto) y **consume el mismo cupo diario**; si las respuestas nuevas no caben en el cupo, `403` y no se guarda nada. Se diferencia del monolito, cuyo cierre por área no registra votos.
- **Prácticas guardadas** (`UserQuestionsList`): `GET /practicas` lista las **públicas** (`public:true`, con `slug`); `q` busca por nombre (texto literal); `area` filtra por el texto del área de las preguntas de la lista, incluidas sus variantes ("QUÍMICA"/"Química"). `GET /practicas/:slug` **exige sesión** (igual que la web; el listado sí es público) y sirve solo las preguntas **practicables** de la lista, en su orden; una lista privada solo la ve su dueño (`404` para el resto).
- Las cuentas de docente no resuelven prácticas (`403`); ver el detalle con respuestas para docentes queda para el módulo de docentes.

### 6.4 Exámenes (catálogo de exámenes resueltos)
| | Ruta | Descripción |
|---|---|---|
| 🌐 | `GET /examenes?institution=&modality=&year=&area=&q=&page=` | Catálogo |
| 🌐 | `GET /examenes/:slug` | Detalle, áreas y preguntas (vista previa gratuita; completo con 💎) |
| 🔑 | `POST /examenes/:id/favorito` | Toggle. Devuelve `{favorite, favorites}` |
| 🔑 | `GET /examenes/favoritos` | Mis favoritos |
| 💎 | `GET /examenes/:slug/pdf?area=` | PDF (§6.8) |

**Notas de implementación (fase 6, verificadas con pruebas):**
- Solo se sirven exámenes `verified:true`. Catálogo (`GET /examenes`): filtros `institution` (id), `modality`, `year` (año de `date`), `area` (id o slug del catálogo; casa con `subjects` sin distinguir mayúsculas) y `q` (título, texto literal); paginado, más reciente primero. Cada examen expone `has_pdf` pero **nunca la ruta del archivo** (`files[].path`): el PDF irá por el endpoint autorizado de la fase 8.
- **Detalle** (`GET /examenes/:slug?area=`): público (como la web). `area` es el **código del cuadernillo** (`A`, `B`, `I`…; sin él, el primero). Devuelve `areas[]` (cuadernillos con `solution`/`verified`), `files[]` (`{area,title}`), `access` y `items[]` en orden: `{kind:'reading', id, title, text}` o `{kind:'question', id, n, question, options[{key,text}], area, topic, type}`. Se omiten los marcadores de conflicto y los ids que ya no están en el banco. Sirve también los exámenes antiguos que llevan las preguntas dentro del cuadernillo.
- **Sin respuestas:** las preguntas salen sin `rpta`/`resolution`. La corrección se pide pregunta a pregunta con `POST /preguntas/:id/responder` (las preguntas de examen son las del banco, así que solo se pueden responder las que están verificadas y tienen clave). **Docentes y administradores** reciben además `correct` y `explanation` (la web les muestra la respuesta marcada) y no tienen vista previa.
- **Vista previa:** la especificación pide vista previa gratuita y examen completo con suscripción, pero la web hoy muestra el examen completo a todos (la suscripción solo protege los PDF). Se implementó como ajuste: `EXAM_PREVIEW_QUESTIONS` (por defecto **0 = completo**). Con N > 0, quien no tenga suscripción vigente ve las primeras N preguntas de cada cuadernillo (y las lecturas que las preceden), y `access` lo indica (`{preview, total_questions, served_questions}`). **Valor pendiente de decidir.**
- **Favoritos:** `POST /examenes/:id/favorito` exige sesión. Sin cuerpo **alterna**; con `{favorite:true|false}` **fija** el estado (reenviar tras un corte de red no lo invierte; es lo que hace la web). El contador se recalcula contando (no sumando deltas) y se escribe en `Exam.favorites`, un campo que no invalida el caché `exams:<slug>` del monolito. Doble toque: `409`. `GET /examenes/favoritos` lista los del usuario, el último marcado primero, sin los desmarcados ni los no publicados. **Diferencia con la web:** allí el favorito funciona sin sesión y solo suma al contador; aquí exige cuenta (la especificación lo pide) para que el contador sea fiable.
- **Caché:** el detalle no se cachea en la API (cada petición lee el examen). El caché `exams:<slug>` de Redis del monolito incluye `rpta` y no se reutiliza. Si el tráfico lo pide, se puede añadir uno propio con clave `exams:<slug>:api:…` para que lo invalide el hook de `exam_schema`.
- **Índice recomendado** (lo crea el dueño del esquema): `favoriteexams` `{ user_id: 1, state: 1 }`; sin él `GET /examenes/favoritos` recorre toda la colección.
- `GET /examenes/:slug/pdf` (💎) queda para la fase 8.

### 6.5 Simulacros
| | Ruta | Descripción |
|---|---|---|
| 🌐 | `GET /simulacros?institution=&q=&page=` | Lista con `status: upcoming\|live\|finished` y `enrolled` si hay sesión |
| 🌐 | `GET /simulacros/:slug` | Detalle, reglas, estructura por área, puntajes |
| 🔑 | `POST /simulacros/:slug/inscribirme` | `{fullname, area, career}` (`dni` obsoleto: se acepta y se ignora, no se guarda) (+ `screenshot` multipart si el simulacro es de pago) |
| 🔑 | `POST /simulacros/:slug/iniciar` | Crea `SimulacrumAttempt`; devuelve `attempt_id`, **`start_exam`, `end_exam` (hora del servidor)**, `server_time`, preguntas sin clave |
| 🔑 | `PUT /simulacros/intentos/:attempt_id/respuestas` | `{answers:{q:"A"}}` autoguardado, idempotente (`write`) |
| 🔑 | `POST /simulacros/intentos/:attempt_id/finalizar` | Cierra y corrige. Si `now > end_exam` corrige con lo guardado |
| 🔑 | `GET /simulacros/:slug/resultados` | Puntaje, `score_conversion`, ranking/percentil, correctas/incorrectas/omitidas |
| 💎 | `GET /simulacros/:slug/solucionario` | Con clave y explicación, solo tras finalizar |
| 🔑 | `POST /simulacros/:slug/reintentar` | Nuevo intento (`attempt_number+1`) si el simulacro lo permite |

**Reglas**
- Temporizador del servidor: la app muestra `end_exam − now` corregido con `server_time`. Sobrevive a rotación y segundo plano.
- Puntaje = `correct·score_correct + incorrect·score_incorrect + not_answered·score_not_answered`; `score_conversion` según `calification_type`.
- Intento finalizado → `409`. Fuera de ventana `start_date..end_date` → `403 FORBIDDEN`. Un intento activo por usuario/simulacro.
- Si `public_results:false`, los resultados se publican al cerrar el simulacro (`finished:true`).

**Notas de implementación (fase 7, verificadas con pruebas):**
- **Modelo:** `attempt_id` = id de la inscripción (`UserSimulacrum`), donde vive el intento vivo (respuestas, `start_exam`/`end_exam`, nota). `SimulacrumAttempt` es el archivo de intentos cerrados (índice único `(inscripción, attempt_number)`). Un reintento archiva el intento y sube `attempt_number`.
- **Estados** (`status` en la ficha): `finished` = cerrado por el administrador o evento (`automatic`) cuya `end_date` pasó; `upcoming` = evento sin empezar; `live` = el resto (los simulacros bajo demanda siempre están abiertos). Filtro `?status=`. `enrollment.state` del postulante: `unregistered | registered | in_progress | finished` (mismo criterio que la ficha de la web).
- **`GET /simulacros`** (público; con sesión añade `enrolled`) y **`GET /simulacros/:slug`** (ficha sin preguntas: `areas[{key, description, careers, questions_count}]`, `ask_area`/`ask_career`, `scoring`, `enrollment`, `server_time`). No hay sockets: en un evento la app consulta la ficha (`status`, `start_date`, `server_time`) hasta que pase a `live`.
- **`POST /simulacros/:slug/inscribirme`** (solo estudiantes): `{fullname, dni, area?, career?}`. Con una sola área se fija sola; con varias, `area` (y `career`, si el área tiene carreras) deben ser válidas. Gratis = verificada al instante. **De pago:** multipart con el comprobante en `screenshot` (o `capture`); PNG/JPG real (se valida por contenido), ≤ 5 MB; queda **pendiente de verificación manual** y avisa por correo al postulante y a `ADMIN_EMAIL`. **Diferencia con la web:** no hay verificación automática del comprobante con IA. Con `APP_PAYMENTS_ENABLED=false` las inscripciones de pago dan `403`. Para que el panel del monolito muestre el comprobante, `PAY_CAPTURE_DIR` debe apuntar a su carpeta `src/public/protected/pay_capture`.
- **`POST /simulacros/:slug/iniciar`**: exige inscripción verificada. El cronometro lo fija el servidor **una sola vez** (`start_exam`, `end_exam = + duración`); volver a llamar devuelve el mismo cronometro y las respuestas guardadas (la app se recupera tras rotar la pantalla o ir a segundo plano). Devuelve `items[]` (lecturas y preguntas numeradas, **sin clave**), `server_time`, `answers`. En un evento fuera de `start_date..end_date` → `403`; cerrado por el administrador → `403` (salvo un reintento ya abierto); intento terminado → `409`; si el tiempo se acabó y nadie lo cerró, se califica con lo guardado y responde `409`.
- **`PUT /simulacros/intentos/:attempt_id/respuestas`** `{answers:{pregunta:"A"|null}, attempt_number?}`: guarda **solo las claves enviadas** (nunca reemplaza el mapa) y `null` quita la respuesta; idempotente. Las preguntas deben ser de ese intento (`422`). Con `attempt_number` distinto del vigente → `409` (una app vieja no pisa un intento nuevo). Se admiten hasta `SIMULACRUM_ANSWER_GRACE_SECONDS` (5) después de `end_exam`; pasado eso `409`.
- **`POST /simulacros/intentos/:attempt_id/finalizar`** `{answers?, attempt_number?}`: cierra y califica una sola vez (dos cierres simultáneos → `200` y `409`). Las respuestas de última hora solo cuentan dentro de la holgura. Devuelve el resumen (`correct, incorrect, not_answered, score, score_conversion`), nunca la clave. Calificación (igual que el monolito): sin prospecto `correctas·score_correct + incorrectas·score_incorrect + omitidas·score_not_answered`; con prospecto `score_question` (fórmula con conversión) o `score_areas_units_academic` (peso por área del examen y área profesional). Las fórmulas del prospecto son texto guardado en la base: se evalúan con mathjs **recortado** (sin `evaluate`, `parse`, `import`, `createUnit`…).
- **Mismas preguntas al servir y al calificar:** una sola lista (banco general o área elegida), completada contra `questions` cuando el snapshot está incompleto (en prospectos manda la del banco). En el monolito el simulacro general se servía desde `general_items` pero se calificaba desde `areas[área].questions`.
- **`GET /simulacros/:slug/resultados`** (cualquier cuenta): `attempt` (solo con el intento cerrado), `by_area`, `attempts` (historial; el primero es el oficial), `ranking`, `can_retry`. **Ranking** con el puntaje congelado del primer intento (`official_score`), posición de competición (empates 1, 2, 2, 4), percentil = % de participantes con menos puntaje, y el top 20 con `fullname`, `area`, `career` y puntajes (**nunca** DNI, correo ni id de usuario; la web también publica el nombre). Es visible si `public_results !== false`; si no, solo para participantes y cuando el administrador cierra el simulacro. Quien no participó y los resultados no son públicos → `404`. Si se acabó el tiempo y nadie cerró el intento, se califica al consultar (se mira el reloj, no la ausencia de nota: un reintento recién abierto no se cierra con cero).
- **`POST /simulacros/:slug/reintentar`** → `201 {attempt_id, attempt_number}`. Sin tope de intentos; exige inscripción verificada, intento anterior cerrado, simulacro publicado y el área aún con preguntas (si no, `409` con el motivo). Vale también en un simulacro cerrado (es práctica; el ranking sigue con el primer intento). Doble toque: un solo intento nuevo.
- **`GET /simulacros/:slug/solucionario`**: con clave, explicación, lo que marcó y si acertó. Solo con el intento propio cerrado (abrir un reintento lo cierra otra vez). **Cambios respecto a la web:** en un **evento en curso** no se abre aunque ya hayas terminado (para que quien termina antes no pase las respuestas a los demás); y `SOLUCIONARIO_REQUIRES_PLAN=true` lo limita a suscriptores (la web solo exige suscripción a los docentes; **decisión pendiente**). Docentes/administradores sin intento propio lo revisan como material (`?area=`), con suscripción.
- `time` del intento = segundos realmente usados (acotado por la duración); el monolito guarda la duración asignada. Los puntajes por área suman `omitidas·score_not_answered` (el monolito los restaba por área y los sumaba en el total).

### 6.6 Perfil, progreso y listas
| | Ruta | Descripción |
|---|---|---|
| 🔑 | `GET /perfil` | Perfil + suscripción (estado, vencimiento, días restantes) |
| 🔑 | `PATCH /perfil` | `username, departament, university, teaching_area, notification` |
| 🔑 | `POST /perfil/avatar` | multipart `avatar` (≤ 2 MB; jpg/png/webp; se reprocesa y redimensiona) |
| 🔑 | `POST /perfil/cambiar-password` | `{current_password, new_password}` (revoca otros refresh) |
| 🔑 | `DELETE /perfil` | Elimina cuenta (requiere `{password}`) |
| 🔑 | `GET /perfil/intentos?type=practica\|simulacro&page=` | Historial unificado |
| 🔑 | `GET /perfil/recursos` | Compras y recursos disponibles |
| 🔑 | `GET /progreso` | Dashboard (abajo) |
| 🔑 | `GET/POST /mis-listas`, `GET/PATCH/DELETE /mis-listas/:id`, `POST /mis-listas/:id/preguntas`, `DELETE /mis-listas/:id/preguntas/:qid` | Listas personales de preguntas |

`GET /progreso` (calculado a partir de `PracticeAttempt`, `SimulacrumAttempt` y `UserAnswer`; cacheado 5 min en Redis):
```json
{ "data": {
  "summary": { "attempts": 42, "questions_answered": 860, "accuracy": 0.71, "study_time": 18400 },
  "by_area": [{ "area": "Matemática", "accuracy": 0.64, "answered": 210 }],
  "weak_topics": [{ "topic": "Trigonometría", "accuracy": 0.41, "answered": 30 }],
  "trend": [{ "date": "2026-09-01", "accuracy": 0.60 }],
  "simulacra": [{ "slug": "…", "score": 14.5, "date": "…" }],
  "recent_attempts": [ ] } }
```
`weak_topics` solo incluye temas con ≥ 10 respuestas.

**Notas de implementación (fase 5, verificadas con pruebas):**
- **`GET /perfil`** = usuario + suscripción (`days_remaining`, `active` calculado con la fecha, no solo con `status`) + `institution` ({id,name,abrev}) + `account_type_change_available`. **`PATCH /perfil`**: `username`, `departament`, `university` (debe existir y estar activa), `teaching_area` (solo profesores; se limpia si deja de serlo), `notification` y `account_type` (**un único cambio**, como la web; después `403`). Campos como `rol`, `state` o `email` se rechazan con `422`.
- **`POST /perfil/cambiar-password`**: una contraseña actual incorrecta da **`422`** (no `401`: un `401` haría que la app intente refrescar el token). Comparte el límite de fallos del login (5 → `429`). Cierra las demás sesiones; si se envía `refresh_token` (el del dispositivo) esa sesión se conserva, si no se cierran todas.
- **`DELETE /perfil`** (`{password}`): **anonimiza** la cuenta en vez de borrar el documento (pedidos, pagos e intentos referencian el `user_id`): `state:false`, correo `deleted+<id>@deleted.invalid` (el correo original queda libre), sin contraseña ni datos personales; revoca las sesiones, borra las listas privadas y deja sin autor las públicas. Un administrador no puede borrarse desde la app. Retrofit: `@HTTP(method = "DELETE", hasBody = true)`.
- **`POST /perfil/avatar`** (multipart, campo `avatar`): solo **PNG o JPG** (como la web; WebP no está soportado por el procesador de imágenes), ≤ 2 MB, entre 64 y 3000 px. La imagen se **recodifica** como JPEG de 256×256 (quita EXIF y contenido ajeno). Se guarda en `STORAGE_DIR/avatars` y se sirve en `GET /api/v1/media/avatars/:file` (público, caché de un año). `User.avatar` guarda la URL absoluta (`PUBLIC_API_URL`). **Decisión:** los avatares de la web viven en el disco del monolito (`/uploads/avatars`); la API no puede escribir allí, así que los suyos se sirven desde la API.
- **`GET /perfil/intentos?type=practica|simulacro&page=&limit=`**: historial unificado, del más reciente al más antiguo, con `label` (área, práctica o simulacro), aciertos y `accuracy` (fracción 0-1 con 3 decimales sobre lo respondido). Los simulacros son los calificados (vivos + archivados sin duplicar).
- **`GET /progreso`** (solo cuentas que practican): se calcula con la misma librería del monolito (`progress_metrics.js`). Forma: `{has_activity, summary:{attempts, questions_answered, accuracy, study_time}, today, week, streak, week_dots, by_area[{area, accuracy, answered, coverage, is_weakest}], weak_topics[], trend[30 días], simulacra[], recent_attempts[]}`. Todos los `accuracy` son fracciones 0-1 con 3 decimales (`null` = sin datos, no 0 %). `weak_topics` exige **≥ 10 respuestas corregibles** por tema. `study_time` (segundos) = tiempo de las prácticas + duración de los simulacros. Cache de 5 min por usuario que se **invalida al registrar respuestas o cerrar una práctica desde la API**; lo que escriba la web se ve al vencer.
- **`/mis-listas`**: GET/POST, GET/PATCH/DELETE `/:id`, POST `/:id/preguntas`, DELETE `/:id/preguntas/:question_id`. Una lista ajena es `404`. Reglas del monolito: **30 preguntas (50 con suscripción vigente)** — pasar de 30 sin plan da `403 SUBSCRIPTION_REQUIRED`; publicar (`PATCH {public:true}`) exige **≥ 10 preguntas**; el slug (nombre + sufijo) cambia al renombrar. Mejoras sobre la web: la propiedad se comprueba siempre (el monolito deja agregar a una lista ajena si se conoce su id) y solo se aceptan preguntas servibles. Límite añadido: 100 listas por usuario. `GET /mis-listas?question_id=` marca en cada lista si ya contiene esa pregunta.
- **Pendiente:** `GET /perfil/recursos` (compras y exámenes de la suscripción) depende de las descargas y la tienda; se hace en la fase 8. `GET /mis-listas/:id/pdf` también (fase 8).

### 6.7 Tienda y suscripciones
> Pago actual: **comprobante manual** (yape / plin / transferencia) que un administrador verifica. `/config.payments_enabled` es un kill-switch remoto; el cliente oculta la tienda si es `false`.

| | Ruta | Descripción |
|---|---|---|
| 🌐 | `GET /productos?type=&q=&page=` | Catálogo (`state:true`) |
| 🌐 | `GET /productos/:slug` | Detalle, imágenes, áreas seleccionables, precio |
| 🌐 | `POST /tienda/carrito/resolver` | `{items:[{product_id, areas?}]}` → líneas, descuentos, total. **El carrito vive en el cliente**; el servidor recalcula precios siempre |
| 🔑 | `POST /tienda/checkout` | multipart: `items` (JSON), `payment_method`, `payment_proof` (imagen ≤ 5 MB) → `Order{status:'pending'}` |
| 🔑 | `GET /pedidos`, `GET /pedidos/:id` | Estado (`pending/verified/rejected`, `status_reason`) |
| 🌐 | `GET /suscripciones`, `GET /suscripciones/:slug` | Planes |
| 🔑 | `POST /suscripciones/:slug/suscribirme` | multipart con comprobante → **`Payment`** pendiente (`transaction_type:'purchase'`, `status:'Pendiente'`; los estados cobrados son `Completo` y `Completado`). Las suscripciones no pasan por `Order` |
| 🔑 | `POST /suscripciones/renovar` | multipart con comprobante |

Al verificar un pedido/suscripción (endpoint de administración, §8) se activa `user.suscription` y se acumula en `suscription_history`.

**Notas de implementación (fase 9, verificadas con pruebas):**
- **Verificación con IA y, si no basta, manual** (como la web; `src/modules/payments/`). El comprobante se lee con Gemini (`monto`, `fecha`, `receptor`, `numero_operacion`, mismo prompt que la web) y se **aprueba solo si todo cuadra**: (1) se lee el número de operación y no figura en ningún `Payment`, `Order` ni `UserSimulacrum` (se compara en sus distintas formas: texto, solo dígitos, número y con cualquier separador); (2) el monto coincide con el esperado con margen de S/ 1, como la web; (3) la fecha no es posterior a hoy ni anterior a `PAYMENT_VOUCHER_MAX_AGE_DAYS` días (hora de Lima). Ante cualquier duda, o si la IA falla o tarda más de `PAYMENT_AI_TIMEOUT_MS`, queda en revisión manual con el motivo en `status_reason` (solo para el administrador; al usuario no se le muestra). Mientras se procesa, el número de operación queda reservado en Redis (dos envíos simultáneos del mismo comprobante no se aprueban los dos). Se aplica igual a **pedidos** (`verified`), **suscripciones** (`Completo` + activación del plan) e **inscripciones a simulacros** (`state:true`); la web no comprobaba la fecha en ninguno ni la reutilización en simulacros. Variables: `GEMINI_API_KEY`, `PAYMENT_AI_PROVIDER` (`gemini` por defecto si hay clave; `none` = todo manual), `PAYMENT_AI_MODEL` (`gemini-2.5-flash`), `PAYMENT_AI_TIMEOUT_MS` (20000), `PAYMENT_VOUCHER_MAX_AGE_DAYS` (3).
- **Activación de suscripciones** (`subscription.activation.js`, port de `suscription-activation.service.js`): `Renovar/Actualizar` encadenan al periodo vigente si le queda tiempo, el ciclo anterior se archiva en `suscription_history` sin duplicar, se reinician los avisos del cron y sale el correo `email_verification_suscription`. El pago nace `Pendiente` y solo pasa a `Completo` cuando el plan quedó activado; si la activación falla, queda pendiente para el administrador.
- **Precios:** `src/libs/store_pricing.js` y `src/libs/product_areas.js` son copias de `public/js/store/pricing.js` y `services/product-areas.service.js` del monolito: el precio es **por área**, los exámenes con 2+ áreas tienen 20 % de descuento y solo se venden las áreas verificadas (si ninguna lo está, todas). Si una cambia, cambiar la otra.
- **`GET /productos`** (`type` exacto, `q` literal sobre el nombre) y **`GET /productos/:slug`** (solo `state:true`; si el slug se repite, el más reciente). Cada producto trae `areas[]` seleccionables `{abrev, label, title, description, checked, locked}`; el detalle añade `description` (HTML con URLs absolutas), `images` y `files[{name, area}]` **sin ruta**.
- **`POST /tienda/carrito/resolver`** (público) **normaliza**: descarta repetidos, devuelve en `unavailable[]` los productos que ya no se venden y cambia áreas inválidas por la preseleccionada; el cliente reemplaza su carrito por la respuesta (`items[{product, unit_price, areas, selectable_areas, subtotal, discount, total}]`, `subtotal`, `discount`, `total`, `currency:'PEN'`).
- **`POST /tienda/checkout`** (multipart: `items` como texto JSON, `payment_method` = `yape|plin`, `payment_proof` PNG/JPG ≤ 5 MB, `expected_total` opcional) es **estricto**: producto retirado → `409`; área inválida, sin áreas en un examen por áreas o producto repetido → `422` con el campo (`items.N.areas`); `expected_total` distinto del total del servidor → `409` (el precio cambió: nunca se registra un pedido que no coincide con lo pagado). Doble envío: candado por usuario y `409` si ya hay un pedido pendiente o verificado con el mismo total en los últimos 5 min. Con la IA, la respuesta `201` puede traer el pedido ya `verified`. Todo se valida **antes** de escribir el comprobante. Respuesta `201` con el pedido; `payment_proof` y `ai_analysis` nunca salen (solo `has_payment_proof`).
- **Comprobantes:** se guardan donde los muestra el panel del monolito: `FILES_ROOT_DIR/storage/payment/store/` (pedidos, ruta `/storage/payment/store/<archivo>`) y `FILES_ROOT_DIR/storage/payment/suscriptions/` (pagos). Sin variables nuevas.
- **`GET /pedidos`** (`?status=`, paginado) y **`GET /pedidos/:id`** (ajeno → `404`). `status_reason` solo se muestra en los rechazados; `message` es la nota del administrador.
- **Suscripciones:** `GET /suscripciones` (por precio, con `per_month`, `best_value` = menor precio mensual entre los planes **no** restringidos, `is_current` con sesión) y `GET /suscripciones/:slug` (solo `state:true`; en planes restringidos, `institutions[]` elegibles = `exams_count ≥ 10`; con sesión, `pending_payment` y `renewal{current_plan, same_plan, running, current_end_date, starts_at}`).
- **`POST /suscripciones/:slug/suscribirme`** y **`POST /suscripciones/renovar`** (multipart: `payment_proof` o `payment_capture`, `payment_method` = `yape|plin`, `institution_id`) crean un `Payment` con el precio congelado: `Completo` con el plan ya activo (la respuesta trae `status:'paid'` y `subscription`) si la IA aprueba, o `Pendiente` (`subscription:null`). **`transaction_type` usa el vocabulario del monolito** (`'Compra'`, `'Renovar'` si repite plan, `'Actualizar'` si cambia), no `'purchase'`: el admin solo encadena el periodo nuevo al vigente con `Renovar/Actualizar`. Un plan restringido exige una institución elegible (`422`); al renovarlo sin elegir, se usa la del plan actual. Con un pago ya en revisión → `409`. `/renovar` paga el plan actual por nombre: sin plan o con el plan retirado → `409`.
- **`GET /suscripciones/estado`** (añadido; la web tiene la misma página): `{state: none|pending|active|expired|rejected, subscription, last_payment{status: pending|paid|rejected, plan, amount, reason}}`. `reason` es `Payment.message` (lo escribe el admin al rechazar); `status_reason` es interno y no sale.
- Correos: al usuario (`api_order_received`, `api_subscription_payment_received`) y, con `ADMIN_EMAIL`, al administrador. Se registran `store.order_created` y `subscription.{purchase,renewal}_requested` en `ActivityLog` con `metadata.via:'api'`.
- `APP_PAYMENTS_ENABLED=false`: el catálogo sigue visible; checkout y pagos → `403`.

### 6.8 Descargas de PDF
| | Ruta | Descripción |
|---|---|---|
| 🔑 | `GET /descargas` | Archivos a los que el usuario tiene derecho: `{id, name, type_file, size, source:'order'\|'exam'\|'list', download_url}` |
| 🔑 | `GET /descargas/pedidos/:order_id/:product_id/:file` | Binario. Exige pedido `verified` del usuario y, si el producto es de examen, que el área esté comprada |
| 💎 | `GET /examenes/:slug/pdf?area=` | PDF del examen |
| 🔑 | `GET /mis-listas/:id/pdf` | PDF de una lista propia (generado con `pdf-lib`) |
| 🔑 | `POST /descargas/:id/enlace` | *(opcional)* URL firmada de 60 s para `DownloadManager` |

- `Content-Type: application/pdf`, `Content-Disposition: attachment`, `Content-Length`, soporte `Range`.
- Los archivos viven en `storage/` **fuera de la raíz estática**; jamás se sirven con `express.static`.
- Cada descarga se registra en `Download`.

---

**Notas de implementación (fase 8, verificadas con pruebas):**
- **Dónde están los archivos:** `files[].path` de productos y exámenes son rutas relativas a la carpeta `src` del monolito (`storage/examenes/…`). La API las resuelve contra `FILES_ROOT_DIR` (en el monolito, su `src`; por defecto, la carpeta que contiene a `STORAGE_DIR`). La ruta se valida con `realpath` contra la raíz: un `../` en el dato o un enlace simbólico que salga de ella → `404`, nunca se lee. **Ninguna ruta de disco sale en ninguna respuesta**; solo `available`, `size` y la URL de descarga.
- **`GET /descargas`** (sesión): por defecto lo **comprado** (pedidos `verified`), con las áreas compradas en los exámenes por áreas; cada elemento `{id, name, type_file, area, size, source:'order', available, download_url}`. `?source=exam` lista los PDF de la **suscripción** (exige plan vigente → `403 SUBSCRIPTION_REQUIRED`), un elemento por archivo, paginado por examen, con filtros `institution`, `modality`, `q`; un plan restringido a una institución solo lista la suya.
- **Descargas:** `GET /descargas/pedidos/:order_id/:product_id/:file` (`:file` = nombre del archivo) y `GET /examenes/:slug/pdf?area=` (💎; sin `area`, el primer cuadernillo con archivo). Respuesta binaria con `Content-Disposition: attachment`, `Content-Length`, `Accept-Ranges: bytes` y soporte de **`Range`** (descargas reanudables, `206`). Permisos: pedido de otro usuario → `404`; propio sin verificar/rechazado → `403`; área no comprada → `403`; examen sin suscripción **vigente** (estado y fecha) → `403`; plan restringido a otra institución → `403 INSTITUTION_RESTRICTED`; administrador sin plan, permitido. Cada descarga **entregada** se registra en `Download` (sin `await`, no la retrasa ni la rompe).
- **Enlaces firmados (opcional del documento, implementado):** `POST /descargas/:id/enlace` (el `id` sale de las listas) devuelve `{url, expires_in:60}`; `GET /descargas/archivo?token=` se canjea **sin Bearer** (para `DownloadManager`) y **vuelve a comprobar** usuario activo y permiso, así que un pedido rechazado o un plan vencido en esos 60 s no descarga. El token es un JWT `typ:'download'`: un access token no sirve como enlace.
- **`GET /perfil/recursos`:** `{orders:[…], subscription:{active, plan_name, end_date, locked_institution, exams_url}}`. Incluye pedidos verificados y pendientes (como la web); los archivos de uno pendiente se muestran con `available:false` y sin enlace.
- **`GET /mis-listas/:id/pdf`:** PDF de **texto** generado con `pdf-lib` (sin navegador). **Limitación:** la web lo genera con Chromium + MathJax; `pdf-lib` no renderiza HTML, así que las fórmulas salen como LaTeX en texto plano, las imágenes como `[imagen]` y los símbolos que la fuente estándar no tiene se transliteran. Sirve para repasar sin conexión; para material con mucha matemática conviene el PDF de la web (o añadir Chromium a la API). `?include_answers=true` añade la clave de respuestas, solo a suscriptores y docentes (si no, el PDF saltaría el cupo diario de respuestas).
- Tamaños: el listado hace un `stat` por archivo (hasta 20 exámenes por página).

## 7. Seguridad

- Validación con TypeBox/Ajv en body, query y params; `additionalProperties:false`.
- bcrypt (coste ≥ 10). Hash y tokens 🔒 nunca se serializan: toda salida pasa por **serializers** con lista blanca de campos.
- Autorización por recurso: toda consulta filtra por el `uid` del token, jamás por un id del body. Recurso ajeno → `404`.
- Refresh tokens hasheados, rotativos, con detección de reutilización.
- Subidas: límites de tamaño, whitelist de MIME + verificación por firma (magic bytes), nombres generados, almacenamiento privado.
- Respuestas de recuperación/registro sin enumeración de usuarios.
- CORS por lista blanca (`API_CORS_ORIGINS`); la app nativa no envía `Origin`. Para la web: mismo Bearer o BFF con cookie `httpOnly` que guarda el refresh.
- `helmet`, HTTPS obligatorio, `trust proxy` configurado, logs sin secretos.
- Registro de auditoría para acciones administrativas.

## 8. Alcance para reemplazar al sitio web

El contrato de §6 cubre lo que necesita **Android**. Para que la web deje su backend actual faltan (fase 2, mismo estilo de recursos, todas con rol `Administrador`/`Editor`):

- **Administración:** verificar/rechazar pedidos y suscripciones, gestión de usuarios, productos, planes, instituciones y áreas, reportes de preguntas.
- **Edición de contenido:** CRUD de preguntas, exámenes, simulacros y prácticas; importación/extracción de exámenes desde PDF/DOCX; figuras; OMR/hojas de respuesta; procesos con IA.
- **Docentes:** banco privado, plantillas y materiales.
- **SEO/públicos:** la web SSR puede consumir esta API desde su servidor y seguir renderizando HTML (recomendado al inicio) o migrar a SPA/Next.js.

**Fórmulas LaTeX como SVG (`?math=svg`, opt-in).** El banco guarda el LaTeX dentro del HTML (`\[…\]`, `\(…\)`, `$$…$$`) y es la fuente de verdad: **no se modifica**. Con `?math=svg` la API sustituye cada fórmula por una imagen en las respuestas de `/preguntas`, `/practicas-area`, `/practicas`, `/examenes`, `/simulacros` y `/mis-listas`; sin el parámetro la respuesta es la de siempre. Plan y decisiones: `docs/api-latex-svg-plan.md`.
- **Qué devuelve:** cada fórmula pasa a `<img class="math" src="{PUBLIC_API_URL}/api/v1/media/math/<hash>.svg" alt="<tex>" data-tex="<tex>" data-display="true|false" data-w="5.9ex" data-h="4.7ex" data-valign="-1.6ex">`. `data-display="true"` = fórmula sola en su párrafo (se centra en su línea); `false` = en línea con el texto (las `\[ \]` que comparten línea con texto o imagen se dibujan en línea con `\displaystyle`). `data-w/h/valign` son medidas en `ex` (1 ex ≈ 0,5 em de la fuente del cliente). `alt`/`data-tex` conservan el LaTeX para accesibilidad y como plan B.
- **Si una fórmula no se puede convertir** (TeX inválido, SVG no seguro, tiempo agotado) se deja su LaTeX original en el HTML y se registra en el log con el id de la pregunta (`math_failed`). La respuesta nunca falla por esto. Cada respuesta dedica como máximo 5 s a convertir fórmulas nuevas; el resto queda en LaTeX y se completa en las siguientes peticiones.
- **Claves tratadas:** solo `question`, `text` y `explanation` (pregunta, opciones, lecturas y explicaciones). Cualquier otro texto no se toca. Una prueba (`test/math_coverage.test.js`) recorre todos los endpoints con LaTeX en cada campo de origen y falla si queda alguno sin convertir: al añadir un campo HTML nuevo hay que sumarlo a `MATH_KEYS` (`src/middlewares/math_response.js`).
- **Validación:** `?math=` con cualquier valor distinto de `svg` da `422`. El middleware quita el parámetro antes de las validaciones de cada módulo (los esquemas de query son estrictos).
- **`GET /media/math/:file`** (🌐): sirve `<hash>.svg` (`image/svg+xml`, `Cache-Control: public, max-age=31536000, immutable`, ETag, CSP `default-src 'none'`). El nombre es un hash del contenido (TeX + modo + versión), así que cada archivo es inmutable. `404` si no existe (el cliente cae a KaTeX). **Queda fuera del rate limit global**: una pantalla pide decenas de SVG a la vez.
- **El SVG:** MathJax 3 (`mathjax-full`), `fontCache: 'none'`, color `currentColor` (el cliente lo tiñe), unidades en px. Se generan en un `worker_threads` con timeout de 2 s por fórmula (el arranque no cuenta) y se guardan en `STORAGE_DIR/math/<hash>.svg` + `<hash>.json` (medidas), con LRU de medidas en memoria. Post-proceso obligatorio: las tablas (`array`, `\hline`) llevan `fill="none"` en línea (MathJax deja ese trazo en una hoja CSS que no viaja con el archivo) y las tildes dentro de `\text{}` se pasan a acentos TeX (si no, MathJax las dibuja como `<text>`, que depende de la fuente del dispositivo). Se rechaza todo SVG con `<script>`, `on*=`, `href` externo, `<text>`, errores o más de 300 KB.
- **Operación:** `STORAGE_DIR` debe estar en un volumen persistente. `npm run math:warm` precalienta el banco (idempotente, `--dry-run`, `--failures=fallidas.csv`, `--strict`); `npm run math:prune` informa de los SVG huérfanos o de versiones anteriores y con `--apply` los borra. Cambiar la versión de MathJax o la plantilla (`MATH_VERSION`) invalida la cache sola: hay que volver a precalentar y luego podar.

## 9. Variables de entorno

```
NODE_ENV=production
PORT=3000
MONGODB_URI=
REDIS_URL=
JWT_SECRET=                # ≥ 32 bytes
JWT_RESET_SECRET=
ACCESS_TTL_SECONDS=1800
REFRESH_TTL_DAYS=60
API_CORS_ORIGINS=https://eduteka.pe,https://www.eduteka.pe
APP_MIN_VERSION=1.0.0
APP_LATEST_VERSION=1.0.0
APP_PAYMENTS_ENABLED=true
APP_MAINTENANCE=false
SUPPORT_WHATSAPP=
MAIL_FROM=
RESEND_API_KEY=            # o SMTP_*
STORAGE_DIR=./storage
PUBLIC_WEB_URL=https://eduteka.pe
```

## 10. Contrato con Android

| App (Kotlin) | API |
|---|---|
| `AuthInterceptor` + `TokenAuthenticator` | Bearer + `/auth/refresh` (una sola reintentada; si falla → logout) |
| `ApiResponse<T>` / `ApiError` (kotlinx.serialization) | Envelope §3.1 |
| Paging 3 | `page/limit` + `meta.has_more` |
| Temporizador de simulacro | `start_exam/end_exam/server_time` |
| Descargas | `DownloadManager` con Bearer o URL firmada → `FileProvider` |
| Arranque | `GET /config` (versión mínima, `payments_enabled`, mantenimiento) |
| Cliente tipado | Generar con `openapi-generator` desde `/api/v1/openapi.json` |

## 11. Fases de implementación

1. **Base:** `app/server`, config validada, envelope, `ApiError`, `validate`, rate limit, logs, health, `/config`, tests de humo.
2. **Auth completa** (registro, verificación, login, refresh rotativo, recuperación) + `me`.
3. **Catálogo y preguntas** (instituciones, áreas, preguntas, responder, reportar).
4. **Prácticas** (por área y guardadas, corrección, `PracticeAttempt`).
5. **Perfil + progreso** (dashboard, avatar, contraseña, historial, listas).
6. **Exámenes** (catálogo, detalle, favoritos).
7. **Simulacros** (inscripción → iniciar → autoguardado → finalizar → resultados/solucionario).
8. **Descargas PDF** (lista + binario autorizado + PDF de listas).
9. **Tienda y suscripciones** (catálogo, resolver carrito, checkout con comprobante, pedidos).
10. **OpenAPI + endurecimiento** (rate limits finos, auditoría, pruebas de carga, backup de `storage/`).
11. **Fase 2:** administración y edición (§8) y migración de la web.

## 12. Estrategia de migración de la web

1. La API se despliega junto al monolito, compartiendo la misma base MongoDB (los modelos son compatibles).
2. Android consume la API desde el día 1.
3. La web migra módulo por módulo: sus controladores SSR pasan a llamar a la API (o el front pasa a SPA) hasta que no quede lógica de negocio en el monolito.
4. Cuando la paridad esté completa, se retira el monolito y la API pasa a ser el único backend.

Durante la convivencia, **una sola fuente de verdad de reglas de negocio**: mover la lógica a los `service` de la API y que el monolito deje de duplicarla.

## 13. Decisiones abiertas

1. **Pagos en Google Play:** ¿comprobante manual dentro de la app o abrir la web para comprar? (`payments_enabled` permite apagarlo sin publicar).
2. **Descarga con Bearer vs URL firmada** (la URL firmada simplifica `DownloadManager`).
3. **Web tras la migración:** ¿SSR consumiendo la API o SPA?
4. **Notificaciones push (FCM):** resultados de simulacro y verificación de pedidos; fuera del MVP.
5. **Almacenamiento de archivos:** disco local vs S3/GCS (recomendado objeto-storage privado con URLs firmadas).

## 14. Convivencia con el monolito (misma base, mismo Redis)

- **La API no crea índices** en colecciones compartidas: `mongoose.set('autoIndex', false)` y `autoCreate: false` en `src/server.js`. El dueño de los índices es el monolito (o un script de migración revisado). `refreshtokens` es propia de la API y pide `autoIndex: true` en su schema (hash único, TTL por `expires_at`, usuario, familia). Nunca llamar a `syncIndexes()`.
- **Estado medido en producción (2026-09-30):** los índices coinciden con los schemas salvo `users.email` único (no existía por duplicados; tras la fusión hay que crearlo con `db.users.createIndex({ email: 1 }, { unique: true, name: 'email_1' })`, idéntico al schema para no chocar con el `autoIndex` del monolito) y el índice de texto `topic_text_question_text` en `questions`, que ningún schema declara. Sin `email_1`, cada login es un escaneo completo de `users`, y el registro depende del control de la aplicación.
- **El cron de suscripciones** (`src/libs/cron.js`) corre solo en el monolito. Si la API lo arrancara, cada usuario recibiría los avisos dos veces.
- **Redis:** claves de la API con prefijo `api:`. El caché `exams:<slug>` del monolito contiene preguntas **con clave**: la API no debe servirlo sin pasar por un serializer.
- **Schemas copiados:** `src/schemas` y `src/models` son copias del monolito. Cualquier cambio de campos o índices debe aplicarse en ambos lados; un campo que falte en una copia se descarta en silencio al guardar (`strict`). Los campos que solo usa la API (`token_verify_expires`, etc.) deben existir también en la copia del monolito si este llega a guardar esos documentos.
- **Dos escritores, sin transacciones:** usar operaciones atómicas (`$set`, `$inc`, `findOneAndUpdate` con condición) en `UserSimulacrum`, `user.suscription` y contadores.
- **`ACTIVITY_LOG_TTL_DAYS`** no debe definirse distinto en la API que en el monolito: Mongoose no modifica un índice TTL existente (`IndexOptionsConflict`).
