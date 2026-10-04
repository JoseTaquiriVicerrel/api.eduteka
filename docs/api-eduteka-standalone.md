# Eduteka API v1 — Especificación autónoma

Backend JSON independiente (Node.js + Express + MongoDB + Redis). Lo consumirá primero la app Android (Kotlin/Compose) y después el sitio web, que dejará de tener lógica de servidor propia y pasará a ser un cliente más de esta API.

**Dos tipos de cuenta.** La plataforma sirve a **Estudiantes** (practican, rinden simulacros, miden su progreso) y **Profesores** (consultan el banco con las respuestas a la vista y usan materiales). La API aplica las diferencias en el servidor (§4.2), no solo en la app.

**Alcance de la app Android (MVP) por tipo de cuenta**

| Función | Estudiante | Profesor |
|---|---|---|
| Auth, perfil, suscripción | ✅ | ✅ |
| Preguntas | Responde y recibe corrección | **Ve la respuesta y la explicación directamente** (no responde) |
| Prácticas | Resuelve y se corrige | **Las ve resueltas** (no las resuelve) |
| Exámenes (catálogo y PDF) | ✅ | ✅ |
| Simulacros | ✅ | ❌ (solo estudiantes) |
| Dashboard de progreso | ✅ | ❌ |
| Tienda: comprar y descargar materiales | ✅ | ✅ (función principal) |
| Mis materiales / descargas | ✅ | ✅ |
| **Crear** preguntas, listas/prácticas, materiales o plantillas | ❌ | ❌ **solo en la web por ahora** |

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
| BD | MongoDB + Mongoose 6/7 |
| Caché / rate limit / colas ligeras | Redis |
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
| 401 | `UNAUTHENTICATED` | Sin token / expirado (el cliente hace refresh) |
| 403 | `FORBIDDEN`, `CAPABILITY_REQUIRED`, `SUBSCRIPTION_REQUIRED`, `INSTITUTION_RESTRICTED`, `EMAIL_NOT_VERIFIED`, `ACCOUNT_DISABLED` | Sin permiso |
| 404 | `NOT_FOUND` | Inexistente (también cuando el recurso es de otro usuario) |
| 409 | `CONFLICT` | Estado incompatible (intento ya finalizado, correo ya registrado) |
| 422 | `VALIDATION_ERROR` | Falla de esquema (`details[]`) |
| 426 | `APP_UPDATE_REQUIRED` | Cliente obsoleto |
| 429 | `TOO_MANY_REQUESTS` | Rate limit (`Retry-After`) |
| 500 | `INTERNAL_ERROR` | — |
| 503 | `MAINTENANCE` | Modo mantenimiento |

### 3.3 Paginación
`?page=1&limit=20` (máx. 50). `meta` = `{page, limit, total, has_more}`. Ordenamiento estable por `created_at desc, _id`.

### 3.4 Rate limiting (Redis, ventana fija)
| Bucket | Aplica a | Límite sugerido |
|---|---|---|
| `global` | Todo | 120/min por IP o usuario |
| `auth` | login, register, refresh, recover | 10/min por IP |
| `auth-email` | login, códigos | 5/15 min por correo |
| `write` | respuestas, autoguardado, checkout | 60/min por usuario |

Fallback en memoria si Redis cae. En login, el rate limit reemplaza al reCAPTCHA (inviable en cliente nativo; en web se puede añadir captcha opcional como header `X-Captcha-Token`).

---

## 4. Autenticación y autorización

**Tokens**
- **access**: JWT HS256 `{uid, rol, typ:'access'}`, 30 min, stateless.
- **refresh**: valor aleatorio de 256 bits; en BD solo su **hash SHA-256** (`RefreshToken{user_id, family_id, token_hash, expires_at, revoked_at, replaced_by, device}`), 60 días, **rotativo**; reutilizar uno ya rotado revoca toda la familia.
- **reset**: JWT `typ:'reset'` con `jti` de un solo uso, 15 min.
- El claim `typ` impide reciclar un token en otro flujo.

**Roles:** `User`, `Administrador` (más adelante `Editor`). **Tipo de cuenta** (`account_type`): `Estudiante`, `Profesor`. Un profesor es `rol:"User"` + `account_type:"Profesor"`. Un usuario anónimo o una cuenta sin `account_type` válido se trata como Estudiante. El tipo de cuenta se elige al registrarse y solo puede cambiarse **una vez** (`account_type_changed_at`).

### 4.1 Plan (suscripción)
`user.suscription.status = 'activo'` (o rol Administrador) da acceso premium. Hay planes **exclusivos por tipo de cuenta**, con precio, beneficios y topes propios:

- Cada plan tiene `audience`: `Estudiante`, `Profesor` o `Todos` (los planes anteriores al campo son `Todos`).
- **Quien tiene sesión ve solo los planes de su tipo de cuenta** (más los `Todos`), sin pestañas. Si una cuenta del otro tipo intenta abrir el detalle o pagar escribiendo el slug, responde `404 NOT_FOUND`: la regla se aplica en el servidor, no solo en la interfaz.
- **El visitante sin sesión ve ambos tipos**, en dos pestañas (Estudiante y Profesor), porque aún no eligió tipo de cuenta. Un plan `Todos` aparece en ambas. El «mejor precio por mes» se calcula dentro de cada pestaña. Puede abrir el detalle de cualquier plan y el registro se abre con el tipo de cuenta del plan elegido (`Profesor` para un plan docente).
- **El administrador** ve todo, con pestañas, para poder revisarlos.
- Cada plan puede traer `benefits[]` (textos para la tarjeta, editables desde el admin) y `limits` (topes propios). Lo que el plan no define cae al **tope base**.

| Tope (`limits`) | Base sin plan | Base con plan activo | Qué limita |
|---|---:|---:|---|
| `list_questions` | 30 | 50 | Preguntas por lista o práctica |
| `materials` | 20 | 20 | Materiales activos (se crean en la web) |
| `templates` | 10 | 10 | Plantillas propias (se crean en la web) |

Al activar el plan, `audience` y `limits` se **copian** a `user.suscription` (como `name` o `end_date`), de modo que resolver el tope no requiere consultar el plan. Si la suscripción vence (`status` ≠ `activo`) vuelven los topes base. `GET /perfil` y `GET /auth/me` devuelven `suscription` y `plan_limits` ya resueltos para que la app los muestre.

**Dónde se exige cada tope** (siempre en el servidor, con el tope resuelto del usuario):

| Tope | Se aplica en | Si se excede |
|---|---|---|
| `list_questions` | Crear/guardar una lista o práctica y agregar preguntas a una lista | `422 VALIDATION_ERROR` («La lista de preguntas debe tener como máximo N preguntas») |
| `materials` | Crear un material y reactivar uno desactivado (cuentan los activos; el administrador está exento) | `429 TOO_MANY_REQUESTS` con `quota{limit, used, remaining}` |
| `templates` | Subir una plantilla propia (el administrador está exento) | `429 TOO_MANY_REQUESTS` con `quota{limit, used, remaining}` |

Los topes de materiales y plantillas aplican a acciones que hoy son solo web; la app únicamente los **muestra** (`plan_limits`).

**Resolución del tope** (función única `limitsFor(user)`): con suscripción activa (o rol Administrador) manda `suscription.limits.<tope>` si existe y es un entero positivo; si no, el valor base de la tabla. Sin suscripción activa rige siempre el valor base «sin plan». Valores no válidos (0, negativos, decimales, texto) se ignoran, nunca bloquean.

### 4.2 Capacidades por tipo de cuenta
Se calculan en el servidor y se devuelven en `GET /auth/me` y `GET /perfil` como `capabilities[]`. El cliente decide la UI con ellas; el servidor las **exige** igualmente.

| Capacidad | Estudiante | Profesor | Administrador |
|---|:-:|:-:|:-:|
| `answer_questions` (responder preguntas) | ✅ | ❌ | ✅ |
| `take_practice` (resolver prácticas) | ✅ | ❌ | ✅ |
| `take_simulacrum` (inscribirse y rendir) | ✅ | ❌ | ✅ |
| `track_progress` (dashboard) | ✅ | ❌ | ✅ |
| `view_answers_directly` (clave y explicación visibles) | ❌ | ✅ | ❌ |
| `buy_materials` / `download_materials` | ✅ | ✅ | ✅ |
| `create_practice`, `manage_questions`, `manage_materials`, `manage_templates` | ❌ | ✅ *(solo web)* | ✅ *(solo web)* |

Una capacidad faltante responde `403 CAPABILITY_REQUIRED` con un `message` para mostrar tal cual (p. ej. «Las cuentas de docente no responden preguntas: ven la respuesta directamente.»).

**Middlewares:** `authenticate` (nunca corta; resuelve el usuario o anónimo) → `authorize(...)` (exige sesión y rol) → `requireCapability(cap)` (exige capacidad según tipo de cuenta) → `requireSubscription()` (exige plan activo; `INSTITUTION_RESTRICTED` si el plan está limitado a otra institución).

**Comportamiento de datos según capacidad** (el mismo endpoint sirve a ambos):
- Si el solicitante tiene `view_answers_directly`, `GET /preguntas`, `GET /preguntas/:id`, `GET /practicas/:slug` y `GET /practicas-area/preguntas` incluyen `correct` y `explanation` en cada pregunta y la bandera `answers_visible: true`.
- Para el resto, esos campos **nunca** se incluyen durante el intento.
- Nunca se sirven preguntas `origin:'Docente'` (bancos privados) en endpoints públicos: solo al docente dueño y solo en la web.

### Endpoints

| Método y ruta | Auth | Body / notas |
|---|---|---|
| `POST /auth/register` | — | `email, password(8-15), username(≥3), departament, account_type ('Estudiante'\|'Profesor'), university?, teaching_area? (obligatorio si Profesor), edkNotification?` → crea usuario no verificado y envía código de 6 dígitos |
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
`name, username, fullname, dni, email (único, lowercase), 🔒password (select:false), state (activo), rol, account_type, departament, university → Institution, teaching_area → Area, avatar, isVerified, suscription{ status:'activo'|'Finalizado', name, start_date, end_date, restricted_to_institution, institution_id, audience, limits{} }, suscription_history[], notification (bool), notification_subscription_renovation, notification_subscription_expiration, last_session, 🔒token_verify, 🔒token_recovery_verify, 🔒token_recovery_expires, access_beta_teacher`.

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
`user_id, simulacrum_id, dni, fullname, area, career, screenshot (comprobante), amount_paid, state, status_reason, finished, public_results, attempt_number, score, score_conversion, official_score, official_score_conversion`.

### SimulacrumAttempt
`user_simulacrum_id, user_id, simulacrum_id, attempt_number, area, career, answers{}, start_exam, end_exam, exam_finished, time, score, score_conversion, results, questions_correct, questions_incorrect, questions_not_answered`.

### Material *(generado por un profesor en la web)*
`title, created_by (user_id), state, step, bank, questions[], template, fields{}, aditional, file_path (🔒 ruta privada del archivo generado)`. En la app es **solo lectura/descarga**: se crea y edita únicamente en la web.

### Template *(plantilla de material)*
`name, scope ('oficial'|'docente'), created_by, public, state, poster_template, 🔒file_template, mappings{}, custom_tags[]`. **Fuera de la API de la app**; solo existe como dato para la web.

### Product
`name, description, slug, price, images[], poster, type, type_file, state (publicado), unique, areas (para exámenes), files[{name, path, area}]`. 🔒`files[].path` nunca sale.

### Order
`user_id, items[{product_id, name, price, quantity, areas[]}], total, discount, payment_method ('transferencia'|'yape'|'plin'|'tarjeta'), payment_proof (ruta privada), status ('pending'|'verified'|'rejected'), status_reason, message`.

### Suscription *(plan)*
`name, slug, duration_days, duration_months, price, description, state, restricted_to_institution, audience ('Estudiante'|'Profesor'|'Todos', default 'Todos'), benefits[] (≤12 líneas de ≤120 caracteres), limits{ list_questions, materials, templates }` (enteros positivos, todos opcionales).

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
| 🌐 | `GET /preguntas?area=&topic=&difficulty=&institution=&q=&page=` | Listado paginado. Estudiante/anónimo: **sin** clave ni explicación. Profesor (`view_answers_directly`): con `correct`, `explanation` y `answers_visible:true` |
| 🌐 | `GET /preguntas/temas?area=` | Temas del área con conteo |
| 🌐 | `GET /preguntas/:id` | Detalle (misma regla de visibilidad de la clave) |
| 🔑 `answer_questions` | `POST /preguntas/:id/responder` | `{selected}` → `{is_correct, correct, explanation}`; guarda `UserAnswer`. Límite diario para plan gratuito. Profesor → `403 CAPABILITY_REQUIRED` |
| 🔑 | `POST /preguntas/:id/reportar` | `{type, description}` (estudiantes y profesores) |

### 6.3 Prácticas
| | Ruta | Descripción |
|---|---|---|
| 🌐 | `GET /practicas-area/temas?area=` | Temas disponibles |
| 🔑 | `GET /practicas-area/preguntas?area=&topic=&count=&difficulty=` | Genera práctica al vuelo. Estudiante: sin respuestas. Profesor: con respuestas (`answers_visible:true`) |
| 🔑 `take_practice` | `POST /practicas-area/finalizar` | `{area, topic, question_ids[], answers, time}` → corrige y guarda `PracticeAttempt` |
| 🌐 | `GET /practicas?area=&q=&page=` | Prácticas/listas publicadas |
| 🌐 | `GET /practicas/:slug` | Detalle y preguntas (con respuestas solo si `view_answers_directly`) |
| 🔑 `take_practice` | `POST /practicas/:slug/finalizar` | `{answers, time}` → corrección |

Respuesta de corrección:
```json
{ "data": { "attempt_id": "…", "total": 20, "correct": 14, "incorrect": 4, "not_answered": 2, "time": 812,
  "review": [{ "question_id": "…", "selected": "B", "correct": "C", "is_correct": false, "explanation": "…" }] } }
```
**Regla:** al estudiante el servidor nunca le entrega la clave durante un intento; solo la devuelve en la corrección. El profesor no tiene intentos: ve la práctica resuelta y no genera `PracticeAttempt`.

> Crear/editar prácticas y listas (`create_practice`) y subir preguntas propias **no existen en la API de la app**: son solo web (§8).

### 6.4 Exámenes (catálogo de exámenes resueltos)
| | Ruta | Descripción |
|---|---|---|
| 🌐 | `GET /examenes?institution=&modality=&year=&area=&q=&page=` | Catálogo |
| 🌐 | `GET /examenes/:slug` | Detalle, áreas y preguntas (vista previa gratuita; completo con 💎) |
| 🔑 | `POST /examenes/:id/favorito` | Toggle. Devuelve `{favorite, favorites}` |
| 🔑 | `GET /examenes/favoritos` | Mis favoritos |
| 💎 | `GET /examenes/:slug/pdf?area=` | PDF (§6.8) |

### 6.5 Simulacros
> Solo estudiantes (`take_simulacrum`). Todo endpoint de esta sección responde `403 CAPABILITY_REQUIRED` a una cuenta de Profesor; la app no muestra la sección.

| | Ruta | Descripción |
|---|---|---|
| 🌐 | `GET /simulacros?institution=&q=&page=` | Lista con `status: upcoming\|live\|finished` y `enrolled` si hay sesión |
| 🌐 | `GET /simulacros/:slug` | Detalle, reglas, estructura por área, puntajes |
| 🔑 | `POST /simulacros/:slug/inscribirme` | `{fullname, dni, area, career}` (+ `screenshot` multipart si el simulacro es de pago) |
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

### 6.6 Perfil, progreso y listas
| | Ruta | Descripción |
|---|---|---|
| 🔑 | `GET /perfil` | Perfil + suscripción (estado, vencimiento, días restantes) + `plan_limits{list_questions, materials, templates}` resueltos |
| 🔑 | `PATCH /perfil` | `username, departament, university, notification`; `teaching_area` solo si Profesor. Cambio de `account_type` (una sola vez) se mantiene **solo en la web** |
| 🔑 | `POST /perfil/avatar` | multipart `avatar` (≤ 2 MB; jpg/png/webp; se reprocesa y redimensiona) |
| 🔑 | `POST /perfil/cambiar-password` | `{current_password, new_password}` (revoca otros refresh) |
| 🔑 | `DELETE /perfil` | Elimina cuenta (requiere `{password}`) |
| 🔑 `track_progress` | `GET /perfil/intentos?type=practica\|simulacro&page=` | Historial unificado (estudiante) |
| 🔑 | `GET /perfil/recursos` | Compras y recursos disponibles |
| 🔑 `track_progress` | `GET /progreso` | Dashboard (abajo). Profesor → `403 CAPABILITY_REQUIRED`; la app oculta la pestaña |
| 🔑 | `GET /mis-listas`, `GET /mis-listas/:id` | **Solo lectura** de listas propias (creadas en la web). Crear/editar/eliminar listas = solo web |

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

### 6.7 Tienda y suscripciones
> La compra y descarga de materiales es la **función principal para ambos tipos de cuenta** (Estudiante y Profesor); no requiere capacidad especial, solo sesión.
>
> Pago actual: **comprobante manual** (yape / plin / transferencia) que un administrador verifica. `/config.payments_enabled` es un kill-switch remoto; el cliente oculta la tienda si es `false`.

| | Ruta | Descripción |
|---|---|---|
| 🌐 | `GET /productos?type=&q=&page=` | Catálogo (`state:true`) |
| 🌐 | `GET /productos/:slug` | Detalle, imágenes, áreas seleccionables, precio |
| 🌐 | `POST /tienda/carrito/resolver` | `{items:[{product_id, areas?}]}` → líneas, descuentos, total. **El carrito vive en el cliente**; el servidor recalcula precios siempre |
| 🔑 | `POST /tienda/checkout` | multipart: `items` (JSON), `payment_method`, `payment_proof` (imagen ≤ 5 MB) → `Order{status:'pending'}` |
| 🔑 | `GET /pedidos`, `GET /pedidos/:id` | Estado (`pending/verified/rejected`, `status_reason`) |
| 🌐 | `GET /suscripciones` | Planes activos agrupados: `{ student: [...], teacher: [...], tabs: ['Estudiante','Profesor'] \| [<solo el suyo>], default_tab }`. Con sesión, `tabs` trae solo el tipo de la cuenta y el otro grupo viene vacío; visitante y administrador reciben ambos. Un plan `Todos` está en ambos grupos. Cada plan incluye `audience`, `benefits[]`, `limits`, `price`, `duration_months`, `per_month` e `is_current` |
| 🌐 | `GET /suscripciones/:slug` | Detalle. `404` si hay sesión y el plan es de otra audiencia; un visitante lo ve siempre |
| 🔑 | `POST /suscripciones/:slug/suscribirme` | multipart con comprobante → orden pendiente |
| 🔑 | `POST /suscripciones/renovar` | multipart con comprobante |

Al verificar un pedido/suscripción (endpoint de administración, §8) se activa `user.suscription` y se acumula en `suscription_history`.

### 6.8 Descargas de PDF
| | Ruta | Descripción |
|---|---|---|
| 🔑 | `GET /descargas` | Archivos a los que el usuario tiene derecho: `{id, name, type_file, size, source:'order'\|'exam'\|'list', download_url}` |
| 🔑 | `GET /descargas/pedidos/:order_id/:product_id/:file` | Binario. Exige pedido `verified` del usuario y, si el producto es de examen, que el área esté comprada |
| 💎 | `GET /examenes/:slug/pdf?area=` | PDF del examen |
| 🔑 | `GET /mis-listas/:id/pdf` | PDF de una lista propia (generado con `pdf-lib`) |
| 🔑 | `GET /mis-materiales?page=` | Materiales **generados por el usuario en la web** (principalmente Profesor): `{id, title, created_at, download_url}` |
| 🔑 | `GET /mis-materiales/:id/descargar` | Binario del material (solo el dueño, `created_by == uid`). `Download{source:'material'}` |
| 🔑 | `POST /descargas/:id/enlace` | *(opcional)* URL firmada de 60 s para `DownloadManager` |

- `Content-Type: application/pdf`, `Content-Disposition: attachment`, `Content-Length`, soporte `Range`.
- Los archivos viven en `storage/` **fuera de la raíz estática**; jamás se sirven con `express.static`.
- Cada descarga se registra en `Download`.

---

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

### 8.0 Solo web (explícitamente fuera de la app)
La app Android **no** ofrece, y por tanto la API v1 de la app no expone, estas acciones (siguen en el sitio web actual, y se migrarán a esta API en la fase 2):

| Acción | Quién |
|---|---|
| Crear, editar, importar y eliminar **preguntas propias** (banco `origin:'Docente'`) | Profesor |
| Crear y editar **listas de preguntas / prácticas** | Profesor (y estudiantes sus listas personales) |
| Crear y editar **materiales** (flujo por pasos y generación del archivo) | Profesor |
| Crear y administrar **plantillas** (oficiales y de docente) | Profesor / Administrador |
| Cambiar el tipo de cuenta (Estudiante ↔ Profesor) | Usuario |

Mientras tanto, la app **consume** lo que se creó en la web: listas (`/mis-listas`, solo lectura), materiales (`/mis-materiales`) y compras (`/pedidos`, `/descargas`). Cuando se decida llevarlo a la app, se añadirán endpoints `POST/PATCH/DELETE` bajo los mismos recursos con `requireCapability('manage_*')`, sin romper el contrato actual.

### 8.1 Resto de la fase 2

El contrato de §6 cubre lo que necesita **Android**. Para que la web deje su backend actual faltan (fase 2, mismo estilo de recursos, todas con rol `Administrador`/`Editor`):

- **Administración:** verificar/rechazar pedidos y suscripciones, gestión de usuarios, productos, planes, instituciones y áreas, reportes de preguntas.
- **Edición de contenido:** CRUD de preguntas, exámenes, simulacros y prácticas; importación/extracción de exámenes desde PDF/DOCX; figuras; OMR/hojas de respuesta; procesos con IA.
- **Docentes:** banco privado, plantillas y materiales.
- **SEO/públicos:** la web SSR puede consumir esta API desde su servidor y seguir renderizando HTML (recomendado al inicio) o migrar a SPA/Next.js.

### 8.2 Administración de planes (ya implementada en el monolito)
Rol `Administrador`. Es el contrato que esta API debe heredar al migrar el admin; las rutas del monolito se indican entre paréntesis.

| Método y ruta | Descripción |
|---|---|
| `GET /admin/planes?q=&page=` | Lista paginada, busca por nombre o slug (`POST /suscripciones/fetch-all`). Cada fila: `id, name, slug, price, duration_months, audience, state, created_at` |
| `GET /admin/planes/:id` | Plan completo para editar (`GET /suscripcion/edit/:id`) |
| `POST /admin/planes` | Crea (`POST /suscripcion/add`) |
| `PATCH /admin/planes/:id` | Edita (`POST /suscripcion/edit/:id`) |
| `POST /admin/planes/:id/activar` · `/desactivar` | Cambia solo `state` (`GET /suscripcion/active/:id` y `/delete/:id`) |

Campos del formulario: `name, slug, description, price, duration_months, restricted_to_institution, state, audience, benefits` (texto, una línea por beneficio) y `limit_list_questions, limit_materials, limit_templates`.

**Reglas**
- **Validación** (crear y editar): `name` obligatorio; `slug` solo minúsculas, números y guiones (`^[a-z0-9]+(-[a-z0-9]+)*$`) y **único** (`409 CONFLICT` si ya existe); `price` número ≥ 0; `duration_months` entero > 0 (puede omitirse).
- **El `name` no se edita.** Cada suscriptor guarda el nombre del plan que compró en `user.suscription.name` y de él dependen «Tu plan actual» y la renovación (se busca el plan por ese nombre). Cambiarlo dejaría suscriptores huérfanos.
- **No se borra un plan: se desactiva** (`state:false`). Los pagos y las suscripciones lo referencian. Un plan inactivo deja de ofrecerse, pero quien ya lo tiene conserva su periodo.
- **`limits` se reemplaza entero:** vaciar un tope en el formulario lo quita del plan (vuelve al tope base). `benefits` admite hasta 12 líneas de 120 caracteres.
- **Los cambios no son retroactivos.** `audience` y `limits` se copian al usuario al activar el plan, así que una edición rige para compras y renovaciones nuevas; quien ya lo tiene conserva los suyos hasta renovar.
- Crear, editar, activar y desactivar generan un registro de actividad (`subscription.plan_created` / `subscription.plan_updated`); la edición guarda el valor anterior y el nuevo de `price`, `audience` y `limits`.
- Tras cualquier cambio se invalida la caché del plan institucional promocionado en los exámenes (esa promo ignora los planes con `audience:'Profesor'`).

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
| UI por tipo de cuenta | `capabilities[]` de `/auth/me`: la navegación se arma con ellas (sin `take_simulacrum` no hay pestaña Simulacros; sin `track_progress` no hay Dashboard; con `view_answers_directly` las preguntas y prácticas se muestran resueltas y sin botón «Responder») |
| Pantallas Profesor | Inicio (materiales y exámenes recientes) · Estudiar (preguntas y prácticas con respuestas) · Exámenes · Tienda · Perfil (mis materiales, descargas, plan) |
| Pantalla de planes | `GET /suscripciones`: se pintan solo los grupos de `tabs`. Con sesión llega un único tipo (sin pestañas); un visitante recibe ambos y se muestran dos pestañas con `default_tab` abierta. Cada tarjeta usa `benefits[]` si trae, o el texto por defecto |
| Pantallas Estudiante | Dashboard · Estudiar (preguntas, prácticas) · Evaluar (exámenes, simulacros) · Tienda · Perfil (descargas, plan) |
| Cliente tipado | Generar con `openapi-generator` desde `/api/v1/openapi.json` |

## 11. Fases de implementación

1. **Base:** `app/server`, config validada, envelope, `ApiError`, `validate`, rate limit, logs, health, `/config`, tests de humo.
2. **Auth completa** (registro, verificación, login, refresh rotativo, recuperación) + `me`.
3. **Catálogo y preguntas** (instituciones, áreas, preguntas, responder, reportar) + **matriz de capacidades** y `requireCapability` (§4.2) desde el inicio.
4. **Prácticas** (por área y guardadas, corrección, `PracticeAttempt`).
5. **Perfil + progreso** (dashboard solo estudiante, avatar, contraseña, historial, listas en solo lectura).
6. **Exámenes** (catálogo, detalle, favoritos).
7. **Simulacros** (solo estudiante: inscripción → iniciar → autoguardado → finalizar → resultados/solucionario).
8. **Descargas PDF y materiales** (lista + binario autorizado + PDF de listas + `/mis-materiales`).
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

### Decisiones ya tomadas
- **Materiales del Profesor en la app:** puede descargar los materiales que creó en la web (`/mis-materiales`). Crearlos sigue siendo solo web.
- **Planes por tipo de cuenta:** existen planes exclusivos para docentes, con precio, beneficios y topes distintos. **Con sesión, cada tipo de cuenta ve solo los suyos; el visitante sin sesión ve ambos en dos pestañas.** Se implementó **primero en el monolito** (`audience`, `benefits`, `limits` en el esquema del plan, edición en el admin) y esta API lo hereda con el mismo modelo de datos.
- **Edición de planes:** se edita desde el admin (excepto el nombre); los planes no se borran, se desactivan (§8.2).
