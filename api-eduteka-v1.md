# Eduteka API v1 — Especificación

API JSON para la app Android (Kotlin/Compose). Node.js + Express, **aditiva** al monolito SSR (Handlebars): reutiliza modelos Mongoose, servicios y Redis, sin tocar los routers SSR.

Leyenda de estado: ✅ ya existe en `src/routes/api/v1` · 🔲 pendiente (MVP) · ⏭ fuera del MVP.

> **Nota de montaje:** `src/config/express.js` tiene `expressApp.use('/api/v1', apiV1Router)` y `apiErrorBoundary` **comentados**. Hay que descomentarlos para exponer la API.

---

## 1. Convenciones

| Tema | Decisión |
|---|---|
| Base URL | `/api/v1` |
| Formato | JSON UTF-8. Archivos: `multipart/form-data` (subida) o binario (descarga) |
| Auth | `Authorization: Bearer <access_token>`. Sin cookies, CORS sin credentials |
| Idioma de `message` | Español (fallback visible). El `code` es inglés, estable y parte del contrato |
| IDs | Strings (UUID). Fechas ISO-8601 UTC |
| Caché | `Cache-Control: no-store` en toda la API |
| Versión de app | Header `X-App-Version: 1.4.2`; si < `APP_MIN_VERSION` → `426 APP_UPDATE_REQUIRED` |
| Campos | `snake_case` en JSON |

### 1.1 Envelope

```jsonc
// éxito
{ "data": { }, "meta": { "page": 1, "limit": 20, "total": 134, "has_more": true } }
// error
{ "error": { "code": "VALIDATION_ERROR", "message": "…", "details": [{ "field": "email", "message": "…" }] },
  "request_id": "a3f19c" }
```

### 1.2 Códigos de error

| HTTP | `code` | Uso |
|---|---|---|
| 400 | `BAD_REQUEST` | Petición mal formada / JSON inválido |
| 401 | `UNAUTHENTICATED` | Falta token o expiró (la app hace refresh) |
| 403 | `FORBIDDEN`, `SUBSCRIPTION_REQUIRED`, `INSTITUTION_RESTRICTED` | Sin permiso o sin suscripción |
| 404 | `NOT_FOUND` | Recurso inexistente |
| 409 | `CONFLICT` | Estado incompatible (p. ej. intento ya finalizado) |
| 422 | `VALIDATION_ERROR` | Falla de esquema (`details[]`) |
| 426 | `APP_UPDATE_REQUIRED` | App por debajo de versión mínima |
| 429 | `TOO_MANY_REQUESTS` | Rate limit (`Retry-After`) |
| 500 | `INTERNAL_ERROR` | — |

### 1.3 Paginación

Query `?page=1&limit=20` (límite máx. 50). Respuesta con `meta` (arriba). Se mapea a Paging 3 con `page` como key.

### 1.4 Rate limiting (Redis, ventana fija)

`global` (todas), `auth` (por IP), `auth-email` (por correo), `write` (POST de intentos/respuestas). Fallback en memoria si Redis cae.

---

## 2. Autenticación y tokens

- **access**: JWT HS256 `{uid, rol, typ:'access'}`, 30 min, stateless.
- **refresh**: opaco/rotativo, larga duración, se **rota en cada `/auth/refresh`**; reutilizar uno viejo revoca la familia.
- **reset**: JWT `typ:'reset'`, 1 uso (`jti`).
- El claim `typ` impide reciclar un token de un flujo en otro.
- La app: interceptor añade Bearer; `Authenticator` de OkHttp llama a `/auth/refresh` ante 401 y reintenta una vez.

Respuesta de tokens:

```json
{ "data": { "access_token": "…", "refresh_token": "…", "token_type": "Bearer", "expires_in": 1800, "user": { } } }
```

### Endpoints

| | Método y ruta | Auth | Body / notas |
|---|---|---|---|
| ✅ | `POST /auth/register` | — | `email, password(8-15), username, departament, account_type, university?, edkNotification?` → envía código de 6 dígitos |
| ✅ | `POST /auth/resend-code` | — | `email` |
| ✅ | `POST /auth/verify-code` | — | `email, code` → devuelve tokens |
| ✅ | `POST /auth/login` | — | `email, password` → tokens. Sin reCAPTCHA: lo sustituye el rate limit |
| ✅ | `POST /auth/refresh` | — | `refresh_token` |
| ✅ | `POST /auth/logout` | Bearer | `refresh_token` (revoca) |
| ✅ | `POST /auth/recover` | — | `email` |
| ✅ | `POST /auth/verify-recovery-code` | — | `email, code` → `reset_token` |
| ✅ | `POST /auth/reset-password` | — | `reset_token, password` |
| ✅ | `GET /auth/me` | Bearer | Usuario + `suscription` + capacidades |

---

## 3. Meta y catálogo

| | Ruta | Auth | Descripción |
|---|---|---|---|
| ✅ | `GET /config` | — | `min_version, latest_version, payments_enabled, maintenance, web_url, support_whatsapp`. La app lo lee al arrancar (kill-switch de tienda) |
| ✅ | `GET /health` | — | Mongo + Redis; `503` si alguno cae |
| ✅ | `GET /instituciones` | — | Universidades/instituciones |
| ✅ | `GET /areas?…` | — | Áreas/cursos |

---

## 4. Prácticas

Dos orígenes: **prácticas por área** (generadas al vuelo desde el banco) y **listas/prácticas guardadas**.

| | Ruta | Auth | Descripción |
|---|---|---|---|
| ✅ | `GET /practicas-area/temas?area=` | opcional | Temas disponibles del área |
| ✅ | `GET /practicas-area/preguntas?area=&topic=&count=&difficulty=` | según plan | Genera una práctica. Devuelve preguntas **sin** respuesta correcta |
| ✅ | `POST /practicas-area/…` (2 rutas de escritura) | Bearer | Corrección / finalización y registro de intento (`rateLimit('write')`) |
| 🔲 | `GET /practicas` | opcional | Prácticas publicadas (paginado, `q`, `area`) |
| 🔲 | `GET /practicas/:slug` | opcional | Detalle + preguntas |
| 🔲 | `POST /practicas/:slug/finalizar` | Bearer | `{answers:{[question_id]:"A"}, time}` → corrige y guarda `PracticeAttempt` |

**Regla clave:** el servidor **nunca** envía `correct_answer` ni la explicación en el listado de preguntas de una práctica/examen en curso; los devuelve al corregir (`finalizar`) o en la vista de solución.

Respuesta de corrección:

```json
{ "data": { "attempt_id": "…", "total": 20, "correct": 14, "incorrect": 4, "not_answered": 2, "time": 812,
  "review": [{ "question_id": "…", "selected": "B", "correct": "C", "is_correct": false, "explanation": "…" }] } }
```

---

## 5. Preguntas (banco)

| | Ruta | Auth | Descripción |
|---|---|---|---|
| 🔲 | `GET /preguntas?area=&topic=&difficulty=&q=&page=` | opcional | Listado paginado (enunciado, opciones, imágenes; sin respuesta) |
| 🔲 | `GET /preguntas/:id` | opcional | Detalle |
| 🔲 | `POST /preguntas/:id/responder` | Bearer | `{selected}` → `{is_correct, correct, explanation}`. Registra `UserAnswer` |
| 🔲 | `POST /preguntas/:id/reportar` | Bearer | `{reason, message?}` |
| ⏭ | Comentarios, listas personalizadas, edición | | Uso docente/admin |

---

## 6. Exámenes (archivos de exámenes de admisión)

En la web son **exámenes resueltos** (catálogo por institución, con PDF/solucionario), no intentos cronometrados.

| | Ruta | Auth | Descripción |
|---|---|---|---|
| 🔲 | `GET /examenes?institution=&year=&area=&q=&page=` | opcional | Catálogo paginado |
| 🔲 | `GET /examenes/:slug` | opcional | Detalle: metadatos, áreas, preguntas (según plan) |
| 🔲 | `POST /examenes/:id/favorito` | Bearer | Toggle favorito |
| 🔲 | `GET /examenes/:slug/pdf?area=` | Bearer + plan | Descarga (ver §9) |

---

## 7. Simulacros (con tiempo, inscripción y resultados)

Flujo real de la web: inscribirse → esperar inicio → rendir → finalizar → resultados/solucionario.

| | Ruta | Auth | Descripción |
|---|---|---|---|
| 🔲 | `GET /simulacros?institution=&q=&page=` | opcional | Lista con estado (`upcoming/live/finished`), fechas, `enrolled` |
| 🔲 | `GET /simulacros/:slug` | opcional | Detalle, estructura por área, reglas |
| 🔲 | `POST /simulacros/:slug/inscribirme` | Bearer + plan | `{fullname, area, career}` (`dni` obsoleto: se ignora) (+ captura opcional multipart) |
| 🔲 | `POST /simulacros/:slug/iniciar` | Bearer | Crea `SimulacrumAttempt`; devuelve `attempt_id`, **`start_exam`, `end_exam` (hora del servidor)**, preguntas sin respuesta |
| 🔲 | `PUT /simulacros/intentos/:attempt_id/respuestas` | Bearer | `{answers:{q:"A"}}` autoguardado (idempotente, `rateLimit('write')`) |
| 🔲 | `POST /simulacros/intentos/:attempt_id/finalizar` | Bearer | Cierra y corrige. Si `now > end_exam` corrige con lo guardado |
| 🔲 | `GET /simulacros/:slug/resultados` | Bearer | Puntaje, ranking, `score_conversion`, correctas/incorrectas/omitidas |
| 🔲 | `GET /simulacros/:slug/solucionario` | Bearer + plan | Preguntas con respuesta y explicación (solo tras finalizar) |
| 🔲 | `POST /simulacros/:slug/reintentar` | Bearer | Nuevo intento (`attempt_number+1`) si el simulacro lo permite |

**Reglas:**
- El **temporizador es del servidor**: la app muestra `end_exam - now` (corrigiendo con el offset del header `Date`). Sobrevive a rotaciones y segundo plano.
- Intento ya finalizado → `409 CONFLICT`. Fuera de ventana → `403 FORBIDDEN`.

---

## 8. Perfil, progreso y listas

| | Ruta | Auth | Descripción |
|---|---|---|---|
| ✅ | `GET /perfil/intentos?type=&page=` | Bearer | Historial de intentos (prácticas + simulacros) |
| 🔲 | `GET /perfil` | Bearer | Perfil completo + suscripción (estado, vencimiento, institución) |
| 🔲 | `PATCH /perfil` | Bearer | `username, departament, university, edkNotification` |
| 🔲 | `POST /perfil/avatar` | Bearer | multipart `avatar` (≤ 2 MB, jpg/png/webp) |
| 🔲 | `POST /perfil/cambiar-password` | Bearer | `current_password, new_password` |
| 🔲 | `GET /progreso` | Bearer + capacidad `TRACK_PROGRESS` | Métricas del dashboard (abajo) |
| 🔲 | `GET /perfil/recursos` | Bearer | Compras/recursos del usuario |
| 🔲 | `DELETE /perfil` | Bearer | Eliminación de cuenta (requisito de Google Play) |

`GET /progreso` (reutiliza `progress_stats.service.js` / `buildStudentView`):

```json
{ "data": {
  "summary": { "attempts": 42, "questions_answered": 860, "accuracy": 0.71, "study_time": 18400 },
  "by_area": [{ "area": "Matemática", "accuracy": 0.64, "answered": 210 }],
  "weak_topics": [{ "topic": "Trigonometría", "accuracy": 0.41 }],
  "trend": [{ "date": "2026-09-01", "accuracy": 0.60 }],
  "recent_attempts": [ ] } }
```

---

## 9. Tienda, suscripciones y descargas

> Flujo de pago actual: **comprobante manual** (yape/plin/transferencia) que se sube y se verifica. El pago vía tarjeta no está activo. Google Play puede objetar ventas de contenido digital fuera de su facturación → por eso `payments_enabled` de `/config` es kill-switch remoto y el checkout puede abrirse en la web.

| | Ruta | Auth | Descripción |
|---|---|---|---|
| 🔲 | `GET /productos?type=&q=&page=` | — | Catálogo (`state:true`) |
| 🔲 | `GET /productos/:slug` | — | Detalle, imágenes, áreas seleccionables, precio |
| 🔲 | `POST /tienda/carrito/resolver` | — | `{items:[{product_id, areas?}]}` → líneas y totales (`cartTotals`, descuentos). El **carrito vive en la app**; el servidor solo valida y calcula |
| 🔲 | `POST /tienda/checkout` | Bearer | multipart: `items` (JSON), `payment_method`, `payment_proof` (imagen) → `Order{status:'pending'}` |
| 🔲 | `GET /pedidos` · `GET /pedidos/:id` | Bearer | Mis pedidos y estado (`pending/verified/rejected`, `status_reason`) |
| 🔲 | `GET /suscripciones` · `GET /suscripciones/:slug` | — | Planes |
| 🔲 | `POST /suscripciones/:slug/suscribirme` | Bearer | multipart con comprobante |
| 🔲 | `POST /suscripciones/renovar` | Bearer | multipart con comprobante |

### Descargas de PDF

| | Ruta | Auth | Descripción |
|---|---|---|---|
| 🔲 | `GET /descargas` | Bearer | Lista de archivos a los que el usuario tiene derecho: `{id, name, type_file, size, source: 'order'\|'exam'\|'list', download_url}` |
| 🔲 | `GET /descargas/pedidos/:order_id/:product_id/:file` | Bearer | Binario. Exige pedido `verified` del usuario y área comprada |
| 🔲 | `GET /examenes/:slug/pdf?area=` | Bearer + plan | Binario del examen |
| 🔲 | `GET /listas/:list_id/pdf` | Bearer | PDF de una lista de preguntas propia |

- Respuesta binaria con `Content-Type: application/pdf`, `Content-Disposition: attachment; filename=…`, `Content-Length`, soporte `Range`.
- **Nunca** exponer rutas de `/storage` estáticas. Todo pasa por el controlador que comprueba autorización.
- Cada descarga se registra con `download_log.js`.
- Alternativa opcional: `POST /descargas/:id/enlace` → URL firmada de corta vida (60 s) para usar con `DownloadManager` sin enviar el Bearer.

---

## 10. Seguridad

- Validación de entrada con **TypeBox + Ajv** (`validate(schema, 'body'|'query')`), `additionalProperties:false`.
- Contraseñas con bcrypt; el hash y campos internos nunca se serializan (usar `serializers/*`).
- Refresh tokens hasheados en BD; rotación + detección de reutilización.
- Autorización por recurso: toda consulta filtra por `user_id` del token (nunca del body).
- Subidas con `multer`: límite de tamaño, MIME whitelist, nombres generados (no el original).
- CORS solo para orígenes de `API_CORS_ORIGINS` (la app nativa no envía `Origin`).
- Logs con `request_id`; no registrar tokens, contraseñas ni comprobantes.
- HTTPS obligatorio en producción; `helmet`.

## 11. Estructura del código (extiende lo existente)

```
src/
├── routes/api/v1/         index.js + <recurso>.routes.js
├── controllers/api/v1/    <recurso>.controllers.js   (delgados: validan, llaman servicio, ok()/created())
├── dtos/api/              <recurso>.schemas.js        (TypeBox)
├── serializers/           *.serializer.js             (modelo → JSON público)
├── services/              lógica reutilizada del SSR
├── middlewares/api/       authenticate, authorize, validate, rate_limit, app_version, error_handler
└── libs/api/              envelope, api_error, paginate, urls
```

Cada controlador: `ah(async (req,res)=>…)` (async handler), lanza `ApiError.*`, responde con `ok/created/noContent`. Nunca `res.render` ni `res.json` crudo.

## 12. Contrato con la app Android

| App (Kotlin) | API |
|---|---|
| `AuthInterceptor` + `TokenAuthenticator` | Bearer + `/auth/refresh` |
| `ApiResponse<T>` / `ApiError` (kotlinx.serialization) | Envelope §1.1 |
| Paging 3 `RemoteMediator`/`PagingSource` | `page/limit` + `meta.has_more` |
| Timer de simulacro | `start_exam/end_exam` del servidor |
| Descargas | `DownloadManager` con Bearer o URL firmada → `FileProvider` |
| Arranque | `GET /config` (versión mínima, `payments_enabled`, mantenimiento) |

## 13. Fases de implementación

1. **Montar y verificar lo existente** (descomentar `express.js`, probar auth/práctica/perfil con tests).
2. **Perfil + progreso** (`/perfil`, `/progreso`, avatar, cambio de contraseña, borrar cuenta).
3. **Preguntas + prácticas guardadas**.
4. **Exámenes** (catálogo, detalle, favorito).
5. **Simulacros** (inscripción → iniciar → autoguardado → finalizar → resultados).
6. **Descargas PDF** (lista + binario autorizado).
7. **Tienda** (catálogo, resolver carrito, checkout con comprobante, pedidos, suscripciones).
8. **Endurecimiento**: rate limits, `helmet`, OpenAPI, tests `node --test`, logs.

## 14. Decisiones abiertas

1. **Pagos en Play:** ¿comprobante manual dentro de la app, o abrir la web para comprar? (afecta §9 y el riesgo de política de Google Play).
2. **Documentación OpenAPI:** generarla desde los esquemas TypeBox (que ya son JSON Schema) para tipar el cliente Kotlin.
3. **Descarga con Bearer vs URL firmada:** URL firmada simplifica `DownloadManager`.
4. **Notificaciones push (FCM)** para resultados de simulacro y verificación de pedidos: fuera del MVP.
