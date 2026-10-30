# Spec api_eduteka — Punto 8: puente de sesión (`POST /auth/web-exchange`)

**Repositorio:** `E:\Trabajo\api_eduteka`
**Origen:** `docs/brief-api-eduteka-cliente-web.md` (repo `eduteka`), sección 8.
**Depende de:**
- **Punto 1** (identificar al cliente, `req.client`): ya implementado (`src/middlewares/client.js`).
- **Punto 3** (IP real con `TRUST_PROXY`): necesario en producción. Ver §6.

**Estado del otro lado:** la parte de Next y del monolito **ya está hecha y probada contra un mock**. `eduteka/web/proxy.ts` llama a este endpoint, guarda el token en la cookie `edk_at` y lo envía como `Bearer`. Si el endpoint no existe (404), la web funciona como visitante. Al desplegar esto, el puente se activa solo.

---

## 1. Para qué

Mientras el login siga en el monolito (Express), quien inicia sesión en la web tiene una cookie `session` firmada con `JWT_PRIVATE_KEY`. Las páginas de la web que leen de la API necesitan un **access token de la API para ese mismo usuario**: para mostrarle sus respuestas, los porcentajes de la comunidad o, si es docente, la respuesta correcta. Este endpoint cambia una cosa por la otra.

**Restricción:** la API **no** debe conocer `JWT_PRIVATE_KEY`, y el monolito **no** debe conocer `JWT_SECRET`. Por eso la API no verifica la cookie ella misma: **se la pregunta al monolito**, que es quien la emitió.

## 2. Contrato

```
POST /api/v1/auth/web-exchange
X-Edk-Client: web
X-Edk-Client-Secret: <WEB_CLIENT_SECRET>
X-Forwarded-For: <IP del visitante>
Content-Type: application/json

{ "session": "<valor de la cookie `session` del monolito>" }
```

| Caso | Respuesta |
|---|---|
| Cliente distinto de `web` (sin secreto o con secreto erróneo) | `404` (como si la ruta no existiera; el body no se valida) |
| `MONOLITH_URL` sin configurar | `404` (puente apagado) |
| Body inválido (`session` falta, no es string o pasa de 2048 caracteres) | `422` (validación estándar) |
| El monolito dice que la cookie no es una sesión válida (`data: null`), o el usuario no existe o tiene `state: false` | `401`, código de `ApiError.unauthenticated` |
| El monolito no responde, tarda más de 3 s o responde distinto de 2xx | `503`, código nuevo `BRIDGE_UNAVAILABLE` |
| Excede el límite `auth` por IP | `429` (estándar) |
| Sesión válida | `200 { "data": { "access_token": "<jwt>", "token_type": "Bearer", "expires_in": 900 } }` |

- **No** se devuelve refresh token: la web vuelve a llamar al endpoint cuando el token vence, mientras la cookie del monolito siga viva.
- **No** se devuelve el usuario: Next ya lo tiene del monolito.

## 3. Cómo valida la sesión

```
GET {MONOLITH_URL}/api/web/me
Cookie: session=<valor recibido>
Accept: application/json
X-Requested-With: fetch
```

- Endpoint del monolito **ya existente** (`eduteka/src/controllers/web.controllers.js`, `meController`).
- Sin sesión válida responde `{ "data": null }`. Con sesión, `{ "data": { "id": "<uuid>", "rol": "...", ... } }`. Solo se usa `data.id`.
- Puede incluir `Set-Cookie` (renovación deslizante de la cookie): **se ignora**. El navegador la renueva en sus propias visitas.
- Timeout: **3 s** (`AbortSignal.timeout(3000)`).

## 4. Implementación

### 4.1 Configuración — `src/config/settings.js` y `.env.example`

- `MONOLITH_URL`: opcional, URL **interna** del monolito (por ejemplo `http://127.0.0.1:3000`). Sin ella, el endpoint responde `404`. Normalizar quitando la barra final.
- `WEB_BRIDGE_TTL_SECONDS`: `int('WEB_BRIDGE_TTL_SECONDS', 900, { min: 60, max: 1800 })`.
- Exponer como `settings.webClient.monolithUrl` y `settings.webClient.bridgeTtlSeconds`.
- En producción, si hay `WEB_CLIENT_SECRET` pero no `MONOLITH_URL`, un `warnings.push(...)` ("puente de sesión apagado").

### 4.2 Error 503 — `src/libs/api_error.js`

Añadir:

```js
static serviceUnavailable(code = 'SERVICE_UNAVAILABLE', message = 'El servicio no está disponible en este momento. Intenta nuevamente.') {
    // status 503, mismo patrón que los demás estáticos
}
```

El puente lo usa con `'BRIDGE_UNAVAILABLE'`.

### 4.3 Token con TTL propio — `src/libs/tokens.js`

`signAccessToken` usa hoy `settings.jwt.accessTtlSeconds`. Añadir una variante que acepte TTL y un claim de auditoría, **con el mismo `typ: 'access'`** para que `authenticate` lo acepte sin cambios:

```js
export const signBridgeAccessToken = ({ uid, rol }) =>
    sign({ uid, rol: rol ?? 'User', typ: 'access', via: 'web-bridge' }, accessKey, settings.webClient.bridgeTtlSeconds);
```

### 4.4 Esquema — `src/modules/auth/auth.schemas.js`

```js
export const WebExchangeBody = Type.Object({
    session: Type.String({ minLength: 1, maxLength: 2048 }),
}, strict);
```

### 4.5 Ruta — `src/modules/auth/auth.routes.js`

```js
// Solo el servidor de Next (req.client === 'web', ver middlewares/client.js) y
// solo con el puente configurado. Para cualquier otro es una ruta inexistente:
// va ANTES de validate, asi la app no recibe errores de validacion de una ruta
// que no le corresponde.
const webBridgeOnly = (req, res, next) =>
    req.client === 'web' && settings.webClient.monolithUrl ? next() : next(ApiError.notFound());

router.post('/web-exchange', webBridgeOnly, perIp, validate(WebExchangeBody), controller.webExchange);
```

### 4.6 Controlador — `src/modules/auth/auth.controller.js`

```js
export const webExchange = asyncHandler(async (req, res) =>
    ok(res, await auth.webExchange(req.body, auth.requestContext(req))));
```

### 4.7 Servicio — `src/modules/auth/auth.service.js`

```js
/**
 * Puente de sesion de la web (docs del repo eduteka, brief seccion 8): la cookie
 * del monolito se valida en el monolito, no aqui. La API no conoce JWT_PRIVATE_KEY.
 */
export const webExchange = async ({ session }, ctx) => {
    const uid = await monolithSessionUser(session, ctx);
    if (!uid) throw ApiError.unauthenticated('La sesión de la web no es válida.');

    const user = await UserModel.findById(uid, { _id: 1, rol: 1, state: 1 }).lean().exec();
    if (!user || user.state === false) throw ApiError.unauthenticated('La sesión de la web no es válida.');

    return {
        access_token: await signBridgeAccessToken({ uid: user._id, rol: user.rol }),
        token_type: 'Bearer',
        expires_in: settings.webClient.bridgeTtlSeconds,
    };
};

const monolithSessionUser = async (session, ctx) => {
    let response;
    try {
        response = await fetch(`${settings.webClient.monolithUrl}/api/web/me`, {
            headers: {
                Cookie: `session=${session}`,
                Accept: 'application/json',
                'X-Requested-With': 'fetch',
                ...(ctx.ip ? { 'X-Forwarded-For': ctx.ip } : {}),
            },
            signal: AbortSignal.timeout(3000),
        });
    } catch {
        throw ApiError.serviceUnavailable('BRIDGE_UNAVAILABLE');
    }
    if (!response.ok) throw ApiError.serviceUnavailable('BRIDGE_UNAVAILABLE');

    const body = await response.json().catch(() => null);
    return typeof body?.data?.id === 'string' ? body.data.id : null;
};
```

- **Valor de la cookie:** antes de armar la cabecera `Cookie`, rechazar como `422` cualquier `session` con `;`, `,`, espacios o caracteres de control. Un JWT solo usa `[A-Za-z0-9._-]`, así que validar con `/^[A-Za-z0-9._-]+$/` en el esquema (`pattern`) o en el servicio. Así no se puede inyectar otra cookie ni otra cabecera.
- **Logs:** nunca registrar `session` ni el token. El body ya no se loguea, y `authorization` y `x-edk-client-secret` ya están en `redact`.
- **Opcional:** una entrada en el log de actividad (`action: 'web_bridge_exchange'`, `user_id`) para poder auditar.

## 5. Pruebas — `test/web_exchange.test.js` (nuevo)

Usar `bootTestApp({ WEB_CLIENT_SECRET, MONOLITH_URL })` y un **monolito falso**: un `http.createServer` en un puerto libre que responde a `/api/web/me` según la cookie recibida. Por ejemplo, `session=valida` → `{data:{id:<usuario sembrado>}}`, `session=anonima` → `{data:null}`, `session=lenta` → no responde en 4 s, `session=caida` → `500`.

| Caso | Esperado |
|---|---|
| Sin cabeceras de cliente | `404` |
| `X-Edk-Client: web` con secreto erróneo | `404` |
| Cliente web, sin `MONOLITH_URL` | `404` |
| Cliente web, body sin `session` | `422` |
| `session` con `;` o espacio (intento de inyección) | `422`, y el monolito falso **no** recibe la petición |
| `session=anonima` | `401` |
| `session=valida`, pero el usuario tiene `state: false` | `401` |
| `session=caida` | `503`, `error.code === 'BRIDGE_UNAVAILABLE'` |
| `session=lenta` | `503` en ~3 s, sin colgarse |
| `session=valida` | `200`. `token_type` es `Bearer`, `expires_in` vale el TTL y el token, verificado con `verifyAccessToken`, trae `uid` del usuario, `typ: 'access'` y `via: 'web-bridge'` |
| Usar ese token en `GET /api/v1/auth/me` | `200` con el mismo usuario |
| El monolito falso recibe la cookie | Exactamente `Cookie: session=valida` |
| 11 peticiones seguidas desde la misma IP (`RATE_LIMIT_AUTH=10`) | La 11.ª da `429` |
| Suite existente | Sin cambios |

## 6. Seguridad y operación

- **Sin claves compartidas:** la API nunca ve `JWT_PRIVATE_KEY`.
- **El secreto solo no basta:** con `WEB_CLIENT_SECRET` filtrado, sin una cookie válida no se obtiene nada. Con una cookie válida, solo el token de ese usuario.
- **`MONOLITH_URL` debe ser interna:** red privada o `127.0.0.1`, nunca la URL pública. Así la validación no sale a internet ni pasa por Cloudflare o Nginx.
- **Depende del punto 3:** este endpoint aplica el límite `auth` (10/min por defecto) **por IP**. Si `TRUST_PROXY` no incluye la dirección del servidor de Next, `req.ip` será siempre la de Next y **todos** los usuarios compartirán 10 intercambios por minuto: el puente fallará con carga. Configurar `TRUST_PROXY` con Nginx más la dirección de Next (por ejemplo `loopback` si están en el mismo servidor) antes de activarlo en producción.
- **Revocación:** al hacer logout en la web, la cookie `edk_at` se borra. Un token ya emitido sigue valiendo hasta su `exp` (como mucho 15 min). Si se desactiva la cuenta, `authenticate` ya lo rechaza al cargar el usuario.

## 7. Documentación — `api-eduteka-standalone.md`

- **§4 Autenticación:** la fila `POST /auth/web-exchange` (solo cliente web, sin refresh token, cuándo se retira).
- **§9 Variables:** `MONOLITH_URL` y `WEB_BRIDGE_TTL_SECONDS`.
- **§14 Convivencia con el monolito:** la API llama a `GET /api/web/me` del monolito para el puente.

## 8. Criterios de aceptación

- [ ] `POST /api/v1/auth/web-exchange` existe con el contrato de §2. Para la app, y sin `MONOLITH_URL`, responde `404`.
- [ ] La sesión se valida en el monolito (`/api/web/me`) y nunca con `JWT_PRIVATE_KEY`.
- [ ] El token emitido es `typ: 'access'`, `via: 'web-bridge'`, con TTL `WEB_BRIDGE_TTL_SECONDS` y sin refresh token, y funciona en los endpoints existentes con `Bearer`.
- [ ] Un `session` con caracteres fuera de `[A-Za-z0-9._-]` se rechaza antes de llamar al monolito.
- [ ] Timeout de 3 s y `503 BRIDGE_UNAVAILABLE` si el monolito falla.
- [ ] Pruebas de §5 en verde y suite existente intacta.
- [ ] `.env.example` y `api-eduteka-standalone.md` actualizados.

## 9. Verificación con la web (después de implementar)

Con la API en el puerto 4000 (`node web/scripts/dev-api.mjs` desde `eduteka`), Express en el 3000 y Next en el 3100:

1. `MONOLITH_URL=http://localhost:3000` en el `.env` de la API. `WEB_CLIENT_SECRET` y `EDK_WEB_CLIENT_SECRET` ya coinciden.
2. Iniciar sesión en `http://localhost:3100/login` con una cuenta real.
3. Abrir cualquier página de Next (por ejemplo `/simulacros`): debe aparecer la cookie `edk_at` y los logs de la API deben mostrar las llamadas con `Authorization: [oculto]`.
4. Cerrar sesión (`/logout`): `session` y `edk_at` se borran.

## 10. Cuándo se retira

Cuando el login pase a la API y Next guarde sus propios access y refresh tokens, el monolito deja de emitir la cookie `session`. Entonces se borran este endpoint, `MONOLITH_URL`, `WEB_BRIDGE_TTL_SECONDS` y `signBridgeAccessToken`.
