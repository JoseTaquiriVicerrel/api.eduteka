# Spec api_eduteka — Punto 1: identificar al cliente web

**Repositorio:** `E:\Trabajo\api_eduteka`
**Origen:** `docs/brief-api-eduteka-cliente-web.md` (repo `eduteka`), sección "1. Identificar al cliente web".
**Alcance:** solo la identificación del cliente. Este punto **no cambia ninguna respuesta** por sí solo. Deja disponible `req.client` (`'web'` o `'app'`) para los puntos siguientes: detalle de examen para el visitante web (2), límite por IP de la web (3) y puente de sesión `web-exchange` (8).

---

## 1. Contexto

La API la consumen dos clientes con reglas de producto distintas:

- **App Android:** ya en producción. Llama con `Authorization: Bearer` cuando hay sesión y con `X-App-Version`. No cambia nada para ella.
- **Web (Next.js, `eduteka/web`):** llama **solo desde su servidor**, nunca desde el navegador. En la web, el visitante sin sesión puede ver preguntas y lecturas (sin respuestas), cosa que la app no permite.

Para aplicar la regla de cada cliente, la API tiene que saber quién llama, y debe ser **imposible** hacerse pasar por la web desde fuera (desde la app, desde el navegador o con curl).

## 2. Contrato

El servidor de Next envía en **todas** sus llamadas:

| Cabecera | Valor |
|---|---|
| `X-Edk-Client` | `web` |
| `X-Edk-Client-Secret` | el valor de `WEB_CLIENT_SECRET` (secreto compartido solo entre el servidor de Next y la API) |

Regla:

- `req.client = 'web'` **solo si** `WEB_CLIENT_SECRET` está configurado, `X-Edk-Client` vale `web` (sin distinguir mayúsculas, tras `trim`) **y** `X-Edk-Client-Secret` coincide exactamente con el secreto (comparación en tiempo constante).
- En **cualquier otro caso**, `req.client = 'app'`. Eso incluye: no hay cabecera, hay cabecera `web` sin secreto, el secreto es erróneo o el secreto no está configurado en la API.
- **Nunca responde con error.** Un intento con secreto inválido se trata como la app, igual que cualquier petición anónima. No se devuelve `401/403`, para no darle a nadie un oráculo con el que probar secretos.

## 3. Implementación

### 3.1 Variable de entorno — `src/config/settings.js`

- Nueva variable **opcional** `WEB_CLIENT_SECRET`, que se lee con el helper `str()` existente.
- Si está definida:
  - debe tener al menos **32 caracteres**; si no, va a `problems` (fallo de arranque, como `JWT_SECRET`);
  - en producción debe ser **distinta** de `JWT_SECRET` y de `JWT_PRIVATE_KEY`; si no, va a `problems`, siguiendo el patrón de la comprobación existente entre `JWT_SECRET` y `JWT_PRIVATE_KEY`.
- Si no está definida, el modo web queda apagado (`req.client` siempre vale `'app'`). En producción basta con un `warnings.push(...)` informativo; no es un error.
- Exponerla como `settings.webClient.secret` (o `null`).
- Añadirla a `.env.example` con un comentario: "Secreto del cliente web (servidor de Next). ≥ 32 caracteres, distinto de JWT_SECRET y JWT_PRIVATE_KEY. Vacío = modo web apagado".

### 3.2 Middleware — `src/middlewares/client.js` (nuevo)

```js
import { settings } from '#Config/settings.js';
import { safeEqual } from '#Libs/tokens.js';

/**
 * Quien llama: 'web' (servidor de Next con el secreto) o 'app' (todo lo demas).
 * Nunca corta la peticion: un secreto invalido es 'app', sin error, para no
 * servir de oraculo. Ver docs/brief-api-eduteka-cliente-web.md (repo eduteka).
 */
export default function identifyClient(req, res, next) {
    const secret = settings.webClient.secret;
    const declared = String(req.get('x-edk-client') ?? '').trim().toLowerCase();
    const presented = req.get('x-edk-client-secret');

    req.client = secret && declared === 'web' && safeEqual(presented, secret) ? 'web' : 'app';

    // El secreto no debe seguir viajando por la peticion (logs, errores, handlers).
    delete req.headers['x-edk-client-secret'];
    return next();
}
```

- Reutilizar `safeEqual` de `src/libs/tokens.js`, que ya usa `timingSafeEqual`.
- `safeEqual(undefined, secret)` devuelve `false` sin lanzar (convierte con `String(a ?? '')`).

### 3.3 Montaje — `src/modules/index.js`, `buildV1Router()`

Montarlo **primero**, antes de `rateLimit('global')`, para que el límite por cliente del punto 3 pueda leer `req.client`:

```js
router.use(identifyClient);
router.use(rateLimit('global', { skip: ... }));   // sin cambios
router.use(appVersion);                            // sin cambios
// ...
```

### 3.4 Logs — `src/libs/logger.js`

Añadir la cabecera secreta a `redact.paths`. Hoy solo se ocultan `authorization`, `cookie` y `set-cookie`, y pino-http registra las cabeceras de la petición antes de que el middleware la borre:

```js
paths: [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-edk-client-secret"]',
    'res.headers["set-cookie"]',
],
```

Revisar también `src/libs/log_redact.js`: si tiene su propia lista de cabeceras sensibles, añadirla ahí.

### 3.5 CORS — `src/app.js`

**No** añadir `X-Edk-Client` ni `X-Edk-Client-Secret` a `allowedHeaders`. La web los manda desde su servidor, no desde el navegador, así que el preflight de un navegador que intente enviarlos debe fallar. Dejar un comentario junto a `allowedHeaders` explicando por qué no están.

## 4. Pruebas

### 4.1 Unitarias — `test/client.test.js` (nuevo)

Probar el middleware con un `req` simulado (`{ headers, get(name) }`) y `settings.webClient.secret` controlado. Seguir el estilo de `bootTestApp` con `WEB_CLIENT_SECRET` o un helper equivalente.

| Caso | Esperado |
|---|---|
| Sin cabeceras | `app` |
| `X-Edk-Client: web` sin secreto | `app` |
| `X-Edk-Client: web` + secreto erróneo | `app` |
| `X-Edk-Client: web` + secreto con un carácter de más o de menos | `app` (largo distinto, sin lanzar) |
| `X-Edk-Client: web` + secreto correcto | `web` |
| `X-Edk-Client: WEB ` (mayúsculas y espacios) + secreto correcto | `web` |
| `X-Edk-Client: app` + secreto correcto | `app` |
| Secreto correcto pero `WEB_CLIENT_SECRET` sin configurar en la API | `app` |
| Tras pasar por el middleware | `req.headers['x-edk-client-secret']` ya no existe |

### 4.2 Integración (con `supertest`)

- Una petición con secreto inválido a cualquier endpoint público (por ejemplo `GET /api/v1/instituciones`) responde **igual** que sin cabeceras: mismo status y mismo cuerpo. Nunca `401/403`.
- La app no cambia: la suite actual pasa entera sin modificaciones.

### 4.3 Configuración

- `WEB_CLIENT_SECRET` con menos de 32 caracteres: el arranque falla con el mensaje en `problems`.
- En producción, `WEB_CLIENT_SECRET` igual a `JWT_SECRET` o a `JWT_PRIVATE_KEY`: el arranque falla.

## 5. Documentación — `api-eduteka-standalone.md`

- **§3 Convenciones:** una fila "Cliente" que explique `X-Edk-Client` y `X-Edk-Client-Secret`, solo de servidor a servidor, y que un secreto inválido equivale a la app.
- **§9 Variables de entorno:** `WEB_CLIENT_SECRET`.

## 6. Criterios de aceptación

- [ ] `req.client` está disponible en todas las rutas de `/api/v1` y vale `'web'` solo con cabecera y secreto válidos.
- [ ] Ninguna respuesta cambia (este punto no aplica reglas todavía).
- [ ] El secreto no aparece en los logs: la cabecera está en `redact` y se borra de `req.headers`.
- [ ] El navegador no puede enviar las cabeceras de cliente (no están en CORS).
- [ ] Validaciones de arranque: largo mínimo y distinto de `JWT_SECRET` y `JWT_PRIVATE_KEY`.
- [ ] Pruebas nuevas en verde y la suite existente intacta.
- [ ] `.env.example` y `api-eduteka-standalone.md` actualizados.

## 7. Despliegue

1. Generar el secreto, por ejemplo con `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.
2. Ponerlo en el `.env` de la API como `WEB_CLIENT_SECRET` y en el `.env` de `eduteka/web` como `EDK_WEB_CLIENT_SECRET`, con el **mismo** valor. Nunca en el repositorio.
3. Rotación: cambiar el valor en los dos lados a la vez. Mientras no coincidan, la web se trata como la app (contenido de visitante igual al de la app y puente de sesión apagado). No hay caída del sitio.

## 8. Fuera de este punto (referencia)

- **Punto 2:** `getExam` sirve los ítems al visitante web (`!user && req.client !== 'web'` → `[]`).
- **Punto 3:** IP real con `X-Forwarded-For` y `TRUST_PROXY` con la dirección de Next; límite propio opcional para `req.client === 'web'`.
- **Punto 8:** `POST /auth/web-exchange` (puente de sesión), que exige `req.client === 'web'`.
