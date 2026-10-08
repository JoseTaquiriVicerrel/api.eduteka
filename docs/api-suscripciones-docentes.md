# Eduteka API v1 — Suscripciones y cuenta de Profesor

Contrato acotado de la API para dos temas: **suscripciones** (planes, compra y renovación con comprobante, estado, vigencia, topes) y la **cuenta de Profesor** (qué puede hacer y qué le exige el plan). Es un extracto autónomo de `api-eduteka-standalone.md` (raíz del repo); ante cualquier diferencia manda ese documento.

Stack: Node.js + Express, MongoDB (Mongoose), Redis. Base URL `/api/v1`. Auth `Authorization: Bearer <access_token>`.

Leyenda: 🌐 público · 🔑 con sesión · 💎 con sesión y plan activo · 🛡 solo `Administrador`.

---

## 1. Convenciones mínimas

**Envelope**
```jsonc
{ "data": { }, "meta": { "page": 1, "limit": 20, "total": 134, "has_more": true } }       // éxito
{ "error": { "code": "VALIDATION_ERROR", "message": "…", "details": [{ "field": "price", "message": "…" }] },
  "request_id": "a3f19c" }                                                                  // error
```
Campos en `snake_case`, fechas ISO-8601 UTC, `message` en español (se muestra tal cual si el cliente no conoce el `code`), `code` en inglés y estable.

**Errores usados en este contrato**

| HTTP | `code` | Cuándo |
|---|---|---|
| 401 | `UNAUTHENTICATED` | Falta sesión o expiró |
| 403 | `CAPABILITY_REQUIRED` | La cuenta no tiene la capacidad (p. ej. un Profesor intenta rendir un simulacro) |
| 403 | `SUBSCRIPTION_REQUIRED` | El contenido exige plan activo |
| 403 | `INSTITUTION_RESTRICTED` | El plan está limitado a otra institución |
| 404 | `NOT_FOUND` | Inexistente, **o plan de otra audiencia** (no se revela que existe) |
| 403 | `FORBIDDEN` | `payments_enabled` está en `false`: `suscribirme` no crea pagos (§9) |
| 409 | `PAYMENT_PENDING` | Ya hay un pago en revisión |
| 409 | `CONFLICT` | Slug de plan repetido |
| 422 | `VALIDATION_ERROR` | Falla de validación (`details[]`) |
| 429 | `TOO_MANY_REQUESTS` | Rate limit o tope de plan alcanzado (con `quota`) |

---

## 2. Tipos de cuenta y capacidades

`account_type`: `Estudiante` o `Profesor`. Un profesor es `rol:"User"` + `account_type:"Profesor"`. Un visitante o una cuenta sin `account_type` válido se trata como Estudiante. El tipo se elige al registrarse y solo puede cambiarse **una vez** (y solo en la web).

Registro del Profesor: además de los campos comunes pide `teaching_area` (curso que enseña), obligatorio si `account_type = 'Profesor'`.

**Capacidades** (las calcula el servidor; se devuelven en `GET /auth/me` y `GET /perfil` como `capabilities[]`; el servidor las exige igualmente)

| Capacidad | Estudiante | Profesor | Administrador |
|---|:-:|:-:|:-:|
| `answer_questions` | ✅ | ❌ | ✅ |
| `take_practice` | ✅ | ❌ | ✅ |
| `take_simulacrum` (inscribirse y rendir) | ✅ | ❌ | ✅ |
| `track_progress` (dashboard) | ✅ | ❌ | ✅ |
| `view_answers_directly` | ❌ | ✅ | ❌ |
| `buy_materials`, `download_materials` | ✅ | ✅ | ✅ |
| `create_practice`, `manage_questions`, `manage_materials`, `manage_templates` | ❌ | ✅ *(solo web)* | ✅ *(solo web)* |

Una capacidad faltante responde `403 CAPABILITY_REQUIRED` con un `message` listo para mostrar (p. ej. «Las cuentas de docente no responden preguntas: ven la respuesta directamente.»).

Middlewares: `authenticate` (nunca corta) → `authorize` → `requireCapability(cap)` → `requireSubscription()`.

---

## 3. Modelo de datos

### Suscription *(plan)*
| Campo | Tipo | Notas |
|---|---|---|
| `name` | string | **No se edita** una vez creado (§8) |
| `slug` | string | Único; URL pública `/suscripciones/:slug`. `^[a-z0-9]+(-[a-z0-9]+)*$` |
| `price` | number ≥ 0 | Soles |
| `duration_months` | entero > 0 | Opcional |
| `description` | string | |
| `state` | boolean | `false` = no se ofrece (no se borra) |
| `restricted_to_institution` | boolean | Plan institucional: exige institución con ≥ 10 exámenes |
| `audience` | `'Estudiante'` \| `'Profesor'` \| `'Todos'` | Por defecto `Todos`; los planes anteriores al campo son `Todos` |
| `benefits` | string[] | ≤ 12 líneas de ≤ 120 caracteres; vacío = texto por defecto del cliente |
| `limits` | `{ list_questions?, materials?, templates? }` | Enteros positivos, todos opcionales |

### User.suscription *(copia al activar)*
`{ status: 'activo' | 'Finalizado', name, start_date, end_date, restricted_to_institution?, institution_id?, audience?, limits? }`

Al activar un plan, `audience` y `limits` se **copian** aquí, de modo que resolver un tope no consulta el plan. Un proceso diario pasa `status` a `Finalizado` al vencer. El tipo de usuario también guarda `suscription_history[]` (ciclos anteriores).

### Payment *(pago de suscripción)*
`user_id, subscription_id, institution_id?, amount, payment_method ('yape'|'plin'), payment_capture (ruta privada del comprobante), status ('Pendiente'|'Completo' (aprobado por la IA)|'Completado' (aprobado por el administrador)|'Cancelado'), status_reason, message (motivo del rechazo), transaction_type ('Compra'|'Renovar'|'Actualizar'), ai_analysis, created_at`.

---

## 4. Reglas de planes

### 4.1 Audiencia y visibilidad
- **Con sesión**, cada tipo de cuenta ve **solo** los planes de su audiencia más los `Todos`. Un plan de otra audiencia responde `404` al consultarlo y al intentar comprarlo (el slug no revela que existe). Se valida en el servidor, no solo en el catálogo.
- **Visitante sin sesión:** ve ambos tipos, agrupados en dos pestañas (Estudiante, Profesor); un plan `Todos` sale en ambas. Puede abrir el detalle de cualquier plan. Al pagar ya hay sesión y se vuelve a validar.
- **Administrador:** como cualquier cuenta con sesión, ve solo los planes de su `account_type`. Revisar todos los planes se hace en el panel del monolito.
- El «mejor precio por mes» se calcula **dentro de cada pestaña**, y nunca entre planes institucionales y generales.

### 4.2 Topes del plan (`limits`)

| Tope | Base sin plan | Base con plan activo | Qué limita | Si se excede |
|---|---:|---:|---|---|
| `list_questions` | 30 | 50 | Preguntas por lista o práctica | Sin plan activo: `403 SUBSCRIPTION_REQUIRED` (el cliente ofrece suscribirse). Con plan: `422 VALIDATION_ERROR` («…como máximo N preguntas») |
| `materials` | 20 | 20 | Materiales activos (se crean en la web) | `429` con `quota{limit, used, remaining}` |
| `templates` | 10 | 10 | Plantillas propias (se crean en la web) | `429` con `quota{limit, used, remaining}` |

**Resolución** (función única `limitsFor(user)`): con plan activo (o rol Administrador) manda `suscription.limits.<tope>` si es un entero positivo; si no, el valor base. Sin plan activo, siempre el base «sin plan». Un valor inválido (0, negativo, decimal, texto) se ignora, nunca bloquea. El Administrador está exento de materiales y plantillas.

### 4.3 Vigencia y renovación
- `Compra` (sin plan previo), `Renovar` (mismo plan) y `Actualizar` (otro plan): lo deduce el servidor.
- En renovación o cambio, el nuevo periodo se **encadena** al vigente: empieza cuando termine el actual si todavía corre; si ya venció, empieza hoy. No se pierden los días que quedaban.
- Un plan desactivado deja de ofrecerse, pero quien ya lo tiene conserva su periodo.
- **Los cambios de `audience` o `limits` de un plan no son retroactivos**: rigen para compras y renovaciones nuevas; quien ya lo tiene conserva los suyos hasta renovar.

### 4.4 Un pago en revisión a la vez
Mientras exista un `Payment` en `Pendiente` del usuario, `POST /suscripciones/:slug/suscribirme` responde `409 PAYMENT_PENDING`.

---

## 5. Endpoints de suscripciones

### 5.1 Catálogo y detalle

| | Ruta | Descripción |
|---|---|---|
| 🌐 | `GET /suscripciones` | Planes activos agrupados |
| 🌐 | `GET /suscripciones/:slug` | Detalle del plan |
| 🔑 | `GET /suscripciones/estado` | Estado del último pago y de la suscripción |
| 🔑 | `GET /perfil` | Incluye `suscription` y `plan_limits` |
| 🌐 | `GET /config` | `payments_enabled`, `support_whatsapp`, `web_url` |

**`GET /suscripciones`**
```json
{ "data": {
  "tabs": ["Estudiante", "Profesor"],
  "default_tab": "Estudiante",
  "plans": null,
  "student": [ { "id": "…", "slug": "semestral", "name": "Semestral", "price": 30, "duration_months": 6,
                 "per_month": 5.0, "audience": "Todos", "restricted_to_institution": false,
                 "benefits": [], "best_value": false, "is_current": false } ],
  "teacher": [ { "slug": "docente-anual", "name": "Docente Anual", "price": 90, "duration_months": 12,
                 "per_month": 7.5, "audience": "Profesor", "benefits": ["Exámenes en PDF para tus clases"],
                 "best_value": true, "is_current": false } ] } }
```
- **Con sesión (la app, y la web con sesión)**, `tabs` trae **un solo** tipo (el de la cuenta), el otro grupo viene vacío y `plans` repite la lista de ese tipo: la app pinta `plans` sin elegir grupo. Esto incluye al administrador.
- **Visitante sin sesión (la web):** recibe ambos grupos y `tabs: ['Estudiante','Profesor']` para dibujar dos pestañas; `plans` es `null`.
- `default_tab` = `Profesor` si la cuenta es docente, si no `Estudiante`.
- `is_current` compara por `name` con el plan del usuario.

**`GET /suscripciones/:slug`** — el plan va aplanado, con su audiencia y beneficios
```json
{ "data": {
  "id": "…", "slug": "docente-anual", "name": "Docente Anual", "price": 90, "currency": "PEN",
  "duration_months": 12, "per_month": 7.5, "best_value": false, "is_current": false,
  "audience": "Profesor", "benefits": ["Exámenes en PDF para tus clases"], "restricted_to_institution": false,
  "renewal": { "current_plan": "Docente semestral", "same_plan": false, "running": true,
               "current_end_date": "2027-03-12T00:00:00.000Z", "starts_at": "2027-03-12T00:00:00.000Z" },
  "institutions": null, "min_exams_institution": null, "pending_payment": null } }
```
`renewal` solo con sesión y plan previo; `institutions` y `min_exams_institution` solo si el plan es institucional (únicamente instituciones con ≥ 10 exámenes); `pending_payment` solo si hay un pago en revisión. Los datos para pagar (teléfono, titular, QR de Yape y Plin) y el WhatsApp de soporte **no** van aquí: salen de `GET /config` (`payment_methods`, `support_whatsapp`), siempre del servidor.

**`GET /suscripciones/estado`** → `{ state, subscription, last_payment }`, con `state` ∈ `none` | `pending` | `active` | `rejected` | `expired`. Siempre `200`: `none` es quien nunca tuvo plan ni pago. `last_payment` trae `status` (`paid` | `pending` | `rejected`), `plan`, `amount`, `reason` (motivo del rechazo), `transaction_type` y `created_at`.

| `state` | Cuándo |
|---|---|
| `active` | Pago pagado y suscripción `activo` (o sin pago pero con plan activo) |
| `pending` | Último pago `Pendiente` |
| `rejected` | Último pago `Cancelado` (con `reason`) |
| `expired` | Pago pagado pero la suscripción ya está `Finalizado` |
| `none` | Sin pagos ni plan |

**`GET /perfil` (parte de suscripción)**
```json
{ "data": { "suscription": { "status": "activo", "active": true, "name": "Docente Anual", "audience": "Profesor",
                              "end_date": "2027-03-12T00:00:00Z", "days_remaining": 164, "restricted_to_institution": false,
                              "can_renew": true },
            "plan_limits": { "list_questions": 80, "materials": 60, "templates": 20 },
            "capabilities": ["view_answers_directly", "create_practice", "manage_questions", "manage_materials", "manage_templates", "buy_materials", "download_materials"] } }
```
`can_renew` (también en la `subscription` de `GET /suscripciones/estado` y en la del pago aprobado): `false` cuando ya hay una renovación aprobada que todavía no empieza, es decir, `start_date` del ciclo vigente es futura (la renovación se encadena al final del ciclo anterior). Solo se permite una renovación a la vez: el cliente oculta «Renovar» con `false`. Además el servidor lo hace cumplir: `suscribirme` con `can_renew: false` responde `409 RENEWAL_ALREADY_QUEUED` (antes de leer el comprobante), para Renovar y para Actualizar.

### 5.2 Compra y renovación

| | Ruta | Descripción |
|---|---|---|
| 🔑 | `POST /suscripciones/:slug/suscribirme` | Compra o renovación. **Es el único endpoint**: renovar es pagar otra vez el plan; el tipo (`Compra`/`Renovar`/`Actualizar`) lo deduce el servidor |

`multipart/form-data`:

| Campo | Notas |
|---|---|
| `payment_proof` (alias `payment_capture`) | Obligatorio. `image/jpeg` o `image/png`, hasta 5 MB. El cliente comprime antes de subir |
| `payment_method` | `yape` \| `plin` (por defecto `yape`) |
| `institution_id` | Id de institución. Obligatoria si el plan es institucional (al renovar uno que ya tiene institución, se reutiliza) |

Cabecera `Idempotency-Key` (8–128 caracteres `A-Za-z0-9_-`, p. ej. un UUID por intento): un reintento con la misma clave devuelve el resultado del primero y **no crea otro pago**. La clave vale 24 h y es por usuario y plan. Una clave inválida responde `422`.

**Resultado (201)**: el pago serializado `{ id, status, plan, amount, currency, payment_method, transaction_type, institution_id, reason, created_at, subscription }`.

| `status` | Qué pasó |
|---|---|
| `paid` | El comprobante se reconoció y el monto coincide con el precio: el plan queda **activo al instante** (`subscription` viene con el plan ya activo) y se envía el correo de confirmación |
| `pending` | Queda en revisión manual (`subscription: null`); se avisa al administrador y al usuario por correo cuando se resuelva |

**Errores**

| HTTP / `code` | Situación |
|---|---|
| 422 `VALIDATION_ERROR` | Falta `payment_proof` («Sube la captura de tu pago para continuar.») |
| 422 `VALIDATION_ERROR` | Institución no elegible («La suscripción institucional solo está disponible para instituciones con 10 o más exámenes.») |
| 409 `PAYMENT_PENDING` | Ya hay un pago en revisión |
| 409 `RENEWAL_ALREADY_QUEUED` | Ya hay una renovación aprobada que todavía no empieza: solo se admite una a la vez (`can_renew: false`) |
| 409 `CONFLICT` | Otro envío del mismo usuario sigue procesándose |
| 404 `NOT_FOUND` | Plan inexistente o de otra audiencia |
| 403 `FORBIDDEN` | `payments_enabled` está en `false` |
| 401 `UNAUTHENTICATED` | Sin sesión |

Si el pago es `paid`, el servidor actualiza `user.suscription` (con `audience` y `limits` copiados) y `GET /auth/me` ya devuelve el estado nuevo.

> `POST /suscripciones/renovar` **fue eliminado**: es equivalente a `suscribirme` sobre el plan actual. Un cliente que aún lo llame recibe `404`.

---

## 6. Cuenta de Profesor: qué puede hacer

El Profesor **consulta y descarga**; no responde, no rinde simulacros ni mide progreso. Crear contenido (preguntas, listas, materiales, plantillas) es solo web.

### 6.1 Matriz de funciones

| Función | Sin plan | Con plan activo | Endpoint | Notas |
|---|:-:|:-:|---|---|
| Registro, login, perfil | ✅ | ✅ | `/auth/*`, `/perfil` | Registro pide `teaching_area` |
| Preguntas del banco | ✅ | ✅ | `GET /preguntas`, `GET /preguntas/:id` | Con `correct`, `explanation` y `answers_visible:true` |
| Responder una pregunta | ❌ | ❌ | `POST /preguntas/:id/responder` | `403 CAPABILITY_REQUIRED` |
| Reportar una pregunta | ✅ | ✅ | `POST /preguntas/:id/reportar` | |
| Prácticas | ✅ | ✅ | `GET /practicas`, `/practicas/:slug`, `/practicas-area/preguntas` | Resueltas; no genera intentos |
| Finalizar una práctica | ❌ | ❌ | `POST …/finalizar` | `403 CAPABILITY_REQUIRED` |
| Exámenes: catálogo y ficha | ✅ | ✅ | `GET /examenes`, `/examenes/:slug` | Favoritos con `POST /examenes/:id/favorito` |
| Exámenes: PDF | 🔒 | ✅ | `GET /examenes/:slug/pdf?area=` | `403 SUBSCRIPTION_REQUIRED` sin plan |
| Simulacros: lista, ficha y resultados | ✅ | ✅ | `GET /simulacros`, `/simulacros/:slug`, `/simulacros/:slug/resultados` | |
| Simulacros: solucionario | 🔒 | ✅ | `GET /simulacros/:slug/solucionario?area=` | Sin intento propio (`teacher_preview:true`); sin plan: `403 SUBSCRIPTION_REQUIRED` |
| Simulacros: inscribirse, iniciar, responder, finalizar, reintentar | ❌ | ❌ | `POST /simulacros/…` | `403 CAPABILITY_REQUIRED` |
| Dashboard de progreso e historial | ❌ | ❌ | `GET /progreso`, `/perfil/intentos` | `403 CAPABILITY_REQUIRED` |
| Tienda: catálogo, carrito, checkout | ✅ | ✅ | `/productos`, `/tienda/*` | Con comprobante |
| Mis pedidos y descargas | ✅ | ✅ | `GET /pedidos`, `/descargas` | Pedidos `verified` |
| Mis materiales (creados en la web) | ✅ | ✅ | `GET /mis-materiales`, `/mis-materiales/:id/descargar` | Solo el dueño |
| Mis listas (creadas en la web) | ✅ | ✅ | `GET /mis-listas`, `/mis-listas/:id`, `/mis-listas/:id/pdf` | Solo lectura |
| Mi plan: ver, comprar, renovar | ✅ | ✅ | §5 | Solo planes `Profesor` y `Todos` |
| Crear/editar preguntas, listas, materiales, plantillas | ❌ | ❌ | — | **Solo web** |

### 6.2 Comportamiento de datos para el Profesor
- Si el solicitante tiene `view_answers_directly`, `GET /preguntas`, `GET /preguntas/:id`, `GET /practicas/:slug` y `GET /practicas-area/preguntas` incluyen `correct` y `explanation` y la bandera `answers_visible:true`. Para estudiantes y visitantes, esos campos **nunca** viajan durante un intento.
- Nunca se sirven preguntas `origin:'Docente'` (bancos privados) en endpoints públicos: solo al docente dueño y solo en la web.
- Un Profesor no genera `PracticeAttempt` ni `SimulacrumAttempt`.

### 6.3 Qué le da el plan docente
1. **Exámenes en PDF** (de todas las instituciones, o de una si el plan es institucional).
2. **Solucionario de todos los simulacros**.
3. **Listas y prácticas más largas** (`list_questions`).
4. **Topes propios** de materiales y plantillas cuando el plan los define.

Las herramientas de creación de la web (banco propio, materiales, plantillas) las tiene **toda cuenta Profesor, con o sin plan**, con los topes base. El plan no las desbloquea: solo puede **ampliar los topes**.

### 6.4 Materiales descargables

| | Ruta | Descripción |
|---|---|---|
| 🔑 | `GET /mis-materiales?page=&limit=` | Materiales que el usuario generó en la web (**implementado**): `{id, title, type_file, active, size, available, created_at, download_url}`. Se listan todos, también los desactivados (`active:false`); los borradores sin archivo no. `meta.quota = {limit, used, active, remaining}`: `used` cuenta también los desactivados |
| 🔑 | `GET /mis-materiales/:id/descargar` | Binario (**implementado**). Solo el dueño (`created_by == uid`); el material de otro, un borrador o un archivo que falta responden `404`. Registra `Download{source:'material'}` |
| 🔑 Profesor | `GET /docente/resumen` | Tablero informativo (**implementado**): `{questions:{count}, practices:{count, max_questions}, materials:{count, active, limit}, templates:{count, limit}}`. Cuenta solo lo propio; `403` si no es Profesor |
| 🔑 | `GET /descargas` | Archivos a los que tiene derecho: `{id, name, type_file, size, source:'order'\|'exam'\|'list'\|'material', download_url}` |
| 🔑 | `GET /descargas/pedidos/:order_id/:product_id/:file` | Binario. Exige pedido `verified` del usuario |

Los archivos viven fuera de la raíz estática; todo pasa por el controlador que autoriza. Respuesta con `Content-Disposition: attachment`, `Content-Length` y soporte `Range`.

---

## 7. Respuestas por contenido que exige plan

| Recurso | Sin plan | Con plan |
|---|---|---|
| `GET /examenes/:slug/pdf` | `403 SUBSCRIPTION_REQUIRED` | Binario |
| `GET /simulacros/:slug/solucionario` (Profesor) | `403 SUBSCRIPTION_REQUIRED` | Solucionario del área |
| Lista o práctica con más de 30 preguntas | `403 SUBSCRIPTION_REQUIRED` | Hasta `list_questions`; pasarse da `422 VALIDATION_ERROR` |
| Plan restringido a institución A, contenido de la institución B | — | `403 INSTITUTION_RESTRICTED` |

`SUBSCRIPTION_REQUIRED` incluye en `error.details` `{ back_slug }` cuando existe una vista pública a la que volver (p. ej. la ficha del simulacro), para que el cliente no mande al usuario a un listado ajeno.

---

## 8. Administración de planes 🛡

| Ruta | Descripción |
|---|---|
| `GET /admin/planes?q=&page=` | Lista paginada; `q` busca por nombre o slug (texto escapado). Fila: `id, name, slug, price, duration_months, audience, state, created_at` |
| `GET /admin/planes/:id` | Plan completo para editar |
| `POST /admin/planes` | Crea |
| `PATCH /admin/planes/:id` | Edita |
| `POST /admin/planes/:id/activar` · `/desactivar` | Cambia solo `state` |

Campos del formulario: `name, slug, description, price, duration_months, restricted_to_institution, state, audience, benefits` (texto, una línea por beneficio) y `limit_list_questions, limit_materials, limit_templates`.

**Reglas**
- **Validación:** `name` obligatorio; `slug` con formato `^[a-z0-9]+(-[a-z0-9]+)*$` y **único** (`409 CONFLICT`); `price` número ≥ 0; `duration_months` entero > 0 (opcional).
- **El `name` no se edita:** cada suscriptor lo guarda en `user.suscription.name` y de él dependen «plan actual» y la renovación (se busca el plan por ese nombre).
- **No se borra un plan: se desactiva** (`state:false`); los pagos y las suscripciones lo referencian.
- **`limits` se reemplaza entero:** vaciar un tope lo quita (vuelve al base).
- Cada operación genera registro de actividad (`subscription.plan_created` / `subscription.plan_updated`; la edición guarda el valor anterior y el nuevo de `price`, `audience` y `limits`).
- Tras cualquier cambio se invalida la caché del plan institucional promocionado en los exámenes, que **ignora** los planes con `audience:'Profesor'`.

**Verificación de pagos** 🛡 (revisión manual de los `Pendiente`): al aprobar, se activa `user.suscription` (copiando `audience` y `limits`), se archiva el ciclo anterior en `suscription_history`, se envía correo y queda registro de actividad; al rechazar, el pago pasa a `Cancelado` con `message` (motivo) y se avisa por correo.

---

## 9. Seguridad

- **La audiencia, los topes y la vigencia los decide siempre el servidor.** El cliente no calcula fechas ni topes.
- Autorización por recurso: toda consulta filtra por el `uid` del token (nunca por un id del body). Recurso ajeno → `404`.
- El comprobante es privado: se guarda fuera de la raíz estática, con nombre generado, validación de tipo por firma (magic bytes) y límite de tamaño; **nunca** se registra en logs ni se sirve por URL pública.
- Rate limit: `auth` en login/registro; `write` (60/min por usuario) en `suscribirme`.
- Tokens: access JWT 30 min; refresh rotativo con hash en BD.
- La respuesta de recuperación de cuenta y de registro no permite enumerar usuarios.
- Interruptor remoto `payments_enabled` (`GET /config`): con `false`, el cliente oculta la compra **y el servidor rechaza** `suscribirme` con `403 FORBIDDEN` (también a la web, que debe leer `/config`). Así una app antigua o una llamada directa no pueden saltarse el apagado. Lo mismo rige para el checkout de la tienda.

---

## 10. Criterios de aceptación (API)

1. `GET /suscripciones` sin sesión devuelve `tabs:['Estudiante','Profesor']` y `plans:null`; con sesión de docente, `tabs:['Profesor']`, `student:[]` y `plans` = los de docente; con sesión de estudiante (o administrador), `tabs:['Estudiante']`, `teacher:[]` y `plans` = los de estudiante.
2. Un plan `Todos` está en ambos grupos; un plan `Profesor` solo en `teacher`.
3. Una cuenta de estudiante recibe `404` al abrir o comprar un plan `Profesor` (y viceversa), también escribiendo el slug.
4. `suscribirme` con un pago `Pendiente` previo responde `409 PAYMENT_PENDING` y no crea otro pago.
5. Dos envíos con la misma `Idempotency-Key` crean un solo pago.
6. Un pago reconocido activa el plan: `GET /auth/me` ya refleja `suscription`, `plan_limits` y `capabilities`.
7. Un plan institucional rechaza (`422`) una institución con menos de 10 exámenes.
8. Renovar con plan vigente encadena el nuevo periodo al final del actual y archiva el ciclo anterior.
9. Con plan vencido (`Finalizado`) los topes vuelven a los base.
10. Un Profesor recibe `view_answers_directly` y respuestas visibles en preguntas y prácticas; `403 CAPABILITY_REQUIRED` al responder, rendir un simulacro o pedir progreso.
11. Un Profesor sin plan recibe `403 SUBSCRIPTION_REQUIRED` en el solucionario de un simulacro y en el PDF de un examen, y `200` en la lista, la ficha y los resultados.
12. Un Profesor con plan abre el solucionario de un simulacro sin tener intento (`teacher_preview:true`).
13. `GET /mis-materiales/:id/descargar` responde `404` si el material es de otro usuario.
14. Editar un plan no cambia su `name`; un `slug` repetido responde `409`; desactivarlo no afecta a quien ya lo tiene.
15. Cambiar `limits` de un plan no altera los de quien ya está suscrito hasta que renueve.
16. Ningún log ni respuesta contiene la ruta del comprobante, hashes de contraseña o tokens.

---

## 11. Decisiones

**Tomadas**
1. **`payments_enabled` bloquea en el servidor** (§9): `403 FORBIDDEN` en `suscribirme`.
2. **`/suscripciones/renovar` eliminado**: renovar es `suscribirme` sobre el plan actual.
3. **La administración de planes y la verificación de pagos siguen en el monolito.** §8 es el contrato que esta API heredará cuando se migre el admin; hoy no hay rutas `/admin/*` aquí. Lo que el administrador active a mano debe copiar `audience` y `limits` igual que `activateSubscription` (misma regla en ambos lados).

**Abiertas**
1. **Solucionario del Profesor por área:** si no se indica `area`, hoy cae a la primera área (no hay `422`). ¿Se mantiene?
2. **Notificaciones push (FCM)** al resolver un pago `Pendiente`: hoy solo hay correo; el cliente sondea `GET /suscripciones/estado`.
3. **Planes por institución para docentes:** hoy un plan institucional docente es posible (`audience:'Profesor'` + `restricted_to_institution`), pero la promo de exámenes lo ignora.
