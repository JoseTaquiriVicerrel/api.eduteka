# Spec — Simulacros en vivo (2): app Android (Kotlin)

**Repositorio:** `C:\Users\Jose Taquiri\AndroidStudioProjects\Eduteka` (Kotlin 2.2, Jetpack Compose + Material 3, Hilt, Navigation Compose con rutas tipadas, Retrofit 3 + OkHttp 5 + kotlinx.serialization, DataStore, Room; `minSdk 24`, `targetSdk 37`; sabores `directo` y `play`).
**Contrato compartido:** `spec-simulacros-en-vivo-0-contrato.md` (fases, reglas, eventos, errores, decisiones D1–D6).
**API que consume:** `spec-simulacros-en-vivo-1-api.md`.
**Sustituye** a la primera versión de esta spec, que estaba escrita para un proyecto Expo que no se usa.

---

## 1. Punto de partida

La app ya tiene un módulo de simulacros completo para el modo **bajo demanda**: ficha, inscripción (gratis y de pago con comprobante), intento, resultados y solucionario. Esta spec lo **extiende** a simulacros programados; no lo reescribe.

| Pieza que ya existe | Archivo (`app/src/main/java/pe/eduteka/eduteka/…`) | Lo que aporta |
|---|---|---|
| API y repositorio | `feature/simulacrum/data/SimulacrumRepository.kt` (`SimulacrumApi`, `SimulacrumRepositoryImpl`) | `detail`, `enroll`, `start`, `saveAnswers`, `finish`, `retry`, `results`, `solucionario` |
| DTOs y modelos | `feature/simulacrum/data/SimulacrumDtos.kt`, `…/model/SimulacrumModels.kt` | `SimulacrumSummary/Detail`, `Enrollment`, `StartedAttempt`, `SimulacrumResults`, `Ranking` |
| Ficha | `feature/simulacrum/ui/SimulacrumScreen.kt`, `SimulacrumViewModel.kt` | Acciones según el estado; **sondea la ficha cada 30 s** mientras el simulacro está `UPCOMING` (`POLL_MS`) |
| Intento | `feature/simulacrum/ui/AttemptScreen.kt`, `AttemptViewModel.kt` | Una pregunta por pantalla, reloj monótono anclado a `server_time`, autoguardado con reintentos, cierre automático en 0, retomar con `start` idempotente, `BackHandler`, vaciado en `ON_STOP` |
| Resultados | `feature/simulacrum/ui/ResultsScreen.kt`, `ResultsViewModel.kt` | Puntaje, por área, intentos y ranking (`Ranking.visible`) |
| Red | `core/network/NetworkModule.kt`, `AuthInterceptor.kt`, `TokenAuthenticator.kt` | Bearer + refresh transparente, `X-App-Version`, `MockInterceptor` en debug |
| Errores | `core/common/AppError.kt` (`AppError.Api(code, message, details)`, `ApiCodes`), `ApiCall.kt` (`apiCall`) | El `code` estable de la API |
| Navegación y enlaces | `core/navigation/Routes.kt`, `AppNavHost.kt`, `DeepLink.kt` | Rutas `SimulacrumRoute/EnrollRoute/AttemptRoute/ResultsRoute/SolutionRoute`; `PendingDeepLink` sobrevive al login |
| Pruebas | `app/src/test/…` (JUnit 4, MockK, Turbine, coroutines-test) | `AttemptViewModelTest`, `SimulacrumContractTest`, `EnrollViewModelTest`… |

**Lo que falta** (y es el trabajo de esta spec):

1. La app **no conoce el horario** programado (cierre, inicio, fin, resultados), ni la fase.
2. **No hay sala de espera**: la ficha dice "aún no empieza" y se actualiza **por sondeo**.
3. **No hay tiempo real** (ni sockets, ni FCM, ni `WorkManager`).
4. **No hay notificaciones** (el manifiesto no declara `POST_NOTIFICATIONS`, ni canales, ni receptores).
5. Las respuestas pendientes **solo viven en memoria**: si Android mata la app con un envío sin confirmar, se pierden.
6. Un `409` se interpreta como "intento ya cerrado" con `ApiCodes.CONFLICT`; no distingue **otro dispositivo**.
7. No hay **bloqueo de un solo dispositivo** (contrato §4.1) ni cabecera de identidad.
8. `DeepLinks` solo entiende `/suscripciones`.
9. Los resultados no saben de **publicación diferida** ni de **ausentes**.
10. El solucionario no sabe que en un programado **se cierra hasta publicar los resultados** (contrato D7).

---

## 2. Alcance de la v1

Simulacro **programado y gratis** (el de arranque), en los dos sabores:

- `directo`: sin cambios en lo que ya hace (pago con comprobante incluido).
- `play`: los simulacros gratis ya se listan (`isListable`), así que el flujo en vivo funciona igual. **No se usan alarmas exactas** (política de Play, §7).

Incluye: horario visible, **sala de espera** con paso automático al examen, **entrada tarde** explicada, examen resistente a cortes y a un solo dispositivo, **examen enviado**, resultados con publicación diferida, **avisos locales** y **enlace directo** al simulacro. No incluye (D3–D5): push remoto con FCM ni el socket de la web.

---

## 3. Capa de datos

### 3.1 DTOs y modelos

La API habla `snake_case` y `ApiJsonNaming` lo convierte a `camelCase`: basta con añadir los campos. Todo es **aditivo y con valor por defecto**, así que un servidor que aún no los envíe no rompe a la app.

```kotlin
@Serializable
data class ScheduleDto(
    val phase: String = "live",                 // registration | waiting | live | finished
    val registrationOpen: Boolean = false,
    val registerCloseDate: String? = null,       // ISO 8601
    val startDate: String? = null,
    val endDate: String? = null,
    val resultsAt: String? = null,
    val resultsPublished: Boolean = false,
)

@Serializable data class WindowDto(val endDate: String? = null, val allowedSeconds: Int = 0, val durationSeconds: Int = 0, val shortened: Boolean = false)
@Serializable data class SessionDto(val tookOver: Boolean = false, val ttlSeconds: Int = 60, val heartbeatSeconds: Int = 20)
@Serializable data class SubmissionDto(val finishedAt: String? = null, val answered: Int = 0, val total: Int = 0)
@Serializable data class HolderDto(val client: String = "web", val lastSeenAt: String? = null, val retryAfterSeconds: Int = 60)
```

| DTO existente | Campo nuevo |
|---|---|
| `SimulacrumSummaryDto` y `SimulacrumDetailDto` | `schedule: ScheduleDto? = null` |
| `EnrollmentDto` | `absent: Boolean = false` (la API lo expone como `absent`; en Mongo se llama `ausent`, la app no lo ve) |
| `StartedAttemptDto` | `window: WindowDto? = null`, `session: SessionDto? = null` |
| `ResultsDto` | `resultsPublished: Boolean = true`, `resultsAt: String? = null`, `absent: Boolean = false`, `submission: SubmissionDto? = null` |

Modelos de dominio equivalentes (en `SimulacrumModels.kt`):

```kotlin
enum class Phase { REGISTRATION, WAITING, LIVE, FINISHED }

data class Schedule(
    val phase: Phase, val registrationOpen: Boolean,
    val registerClose: Instant?, val start: Instant?, val end: Instant?,
    val resultsAt: Instant?, val resultsPublished: Boolean,
)
```

`Schedule.resultsPublished` es también lo que decide si el **solucionario** está disponible en un programado (D7).

`SimulacrumSummary` gana `schedule: Schedule?` (`null` = bajo demanda). `Enrollment.absent`, `StartedAttempt.window/session`, y `SimulacrumResults` gana `resultsPublished`, `resultsAt`, `absent` y `submission`. **El valor por defecto de `resultsPublished` en `ResultsDto` es `true`** para que un servidor antiguo no deje a nadie esperando resultados que ya existen.

Se actualizan `SimulacrumContractTest` y los mapeadores (`toModel`) con un JSON de ejemplo de cada forma nueva (spec de la API, §3.2).

### 3.2 Endpoint nuevo y cabecera de identidad

```kotlin
// SimulacrumApi
@POST("simulacros/intentos/{attemptId}/latido")
suspend fun heartbeat(@Path("attemptId") attemptId: String): ApiResponse<HeartbeatDto>
```

`SimulacrumRepository` gana `suspend fun heartbeat(attemptId: String): Resource<Heartbeat>`. La API responde `{ ok, heartbeat_seconds, server_time }`:

```kotlin
@Serializable data class HeartbeatDto(val ok: Boolean = true, val heartbeatSeconds: Int = 20, val serverTime: String? = null)
data class Heartbeat(val heartbeatSeconds: Int, val serverTime: Instant?)
```

`serverTime` se pasa a `ServerClock.sync` (§3.4).

**Identidad del dispositivo** (contrato §4.1): un UUID por **instalación**, creado la primera vez y guardado en DataStore.

```kotlin
// core/datastore/InstallIdStorage.kt
@Singleton class InstallIdStorage @Inject constructor(...) { suspend fun get(): String }   // genera y persiste si no existe
```

Un interceptor lo manda en **todas** las llamadas a `/simulacros/*`:

```kotlin
// core/network/ExamSessionInterceptor.kt
class ExamSessionInterceptor(private val installId: () -> String) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        if (request.url.pathSegments.none { it == "simulacros" }) return chain.proceed(request)
        return chain.proceed(request.newBuilder().header("X-Exam-Session", installId()).build())
    }
}
```

Se registra en `provideAuthedClient` junto a `AuthInterceptor`. El UUID se lee **una vez** al crear el interceptor (no por petición): `InstallIdStorage` se resuelve al arrancar `EdutekaApp`. Reinstalar la app genera un id nuevo, lo que es correcto: es "otro dispositivo". **Desinstalar durante un examen** deja el bloqueo vencer solo a los 60 s.

### 3.3 Errores

En `ApiCodes` (`core/common/AppError.kt`), añadir:

```kotlin
const val REGISTRATION_CLOSED = "REGISTRATION_CLOSED"
const val NOT_STARTED = "NOT_STARTED"
const val WINDOW_ENDED = "WINDOW_ENDED"
const val ATTEMPT_ALREADY_FINISHED = "ATTEMPT_ALREADY_FINISHED"
const val ATTEMPT_ACTIVE_ELSEWHERE = "ATTEMPT_ACTIVE_ELSEWHERE"
```

`ATTEMPT_ACTIVE_ELSEWHERE` trae el `holder` en el cuerpo del error. Hoy `AppError.Api` solo conserva `code/message/details`. Ampliar:

```kotlin
data class Api(
    val code: String, val message: String,
    val details: List<FieldError> = emptyList(),
    val holder: ExamHolder? = null,                 // solo en ATTEMPT_ACTIVE_ELSEWHERE
) : AppError

data class ExamHolder(val client: String, val retryAfterSeconds: Int)   // client = "web" | "app"
```

y en `core/network/ApiEnvelope.kt`, el objeto `error` del cuerpo (`ApiErrorBody.error`) admite `holder: HolderDto? = null` **al mismo nivel que `code` y `message`** (así lo emite la API: `error.holder`, ver su spec §4.2); `HttpException.toAppError()` lo copia a `AppError.Api.holder`.

**`CONFLICT` no desaparece.** `AttemptViewModel` hoy usa `ApiCodes.CONFLICT` para dos cosas: `start` ⇒ `alreadyGraded` y `finish` ⇒ `Finished`. La API nueva (su spec §3.4 y §3.5) emite `ATTEMPT_ALREADY_FINISHED` en `iniciar`, `respuestas`, `finalizar` y `latido` cuando el intento ya está cerrado:

| Situación | Código | La app |
|---|---|---|
| `iniciar` de un intento ya cerrado | `ATTEMPT_ALREADY_FINISHED` | va a "enviado", sin error |
| `iniciar` de un intento iniciado cuyo tiempo venció (la API lo califica en ese momento) | `ATTEMPT_ALREADY_FINISHED` | va a "enviado", sin error |
| Guardar / finalizar / latido con el intento cerrado o pasada la holgura | `ATTEMPT_ALREADY_FINISHED` | `Finished` sin error |
| Cierre concurrente en `finalizar` | `ATTEMPT_ALREADY_FINISHED` | `Finished` sin error |
| "Este intento ya no está activo" por `attempt_number` desfasado | **`CONFLICT`** | error normal; no cierra el examen |
| `iniciar`: "no tiene duración", "el área no tiene preguntas", "tu inscripción aún se procesa" | **`CONFLICT`** | error normal, no "ya calificado" |

- Con la API nueva: `alreadyGraded` y `Finished` se activan **solo** con `ATTEMPT_ALREADY_FINISHED`.
- Mientras la API nueva no esté desplegada (`start` sigue dando `CONFLICT` para todo), se conserva el comportamiento actual solo en `start` y `finish`, como respaldo. Al desplegar la API, ese respaldo se retira.

Mensajes para los demás códigos nuevos:
- `REGISTRATION_CLOSED` (al inscribirse): `EnrollViewModel` refresca la ficha y muestra "La inscripción cerró el …".
- `NOT_STARTED` / `WINDOW_ENDED` (al iniciar): ver §6.2.
- `403` del solucionario antes de publicar (mensaje "se habilita cuando se publiquen los resultados"): se muestra el texto de la API como aviso, no como fallo (§6.5).

### 3.4 Reloj del servidor

`AttemptViewModel` ya calcula el tiempo restante con un reloj monótono inyectado y la `server_time` de la respuesta. Se **extrae** a una clase propia para que la sala de espera y la ficha la compartan:

```kotlin
// core/common/ServerClock.kt  (sin dependencias de Android: se prueba con JUnit)
class ServerClock(private val monotonicMs: () -> Long = { System.nanoTime() / 1_000_000 }) {
    fun sync(serverTime: Instant)          // ancla: servidor ↔ reloj monótono
    fun now(): Instant                      // hora del servidor estimada; no cambia si el usuario cambia la hora del teléfono
    fun millisUntil(target: Instant): Long  // nunca negativo
}
```

Se sincroniza con **cada** `server_time` que llegue (ficha, `iniciar`, resultados, eventos del socket). `@Singleton` por Hilt. El cálculo actual de `AttemptViewModel` (`remainingMillis`, `secondsUntil`) pasa a usarla.

---

## 4. Tiempo real

### 4.1 Qué cliente de Socket.IO

El servidor es **Socket.IO** (contrato §7). Dos opciones para Android:

| | Biblioteca oficial `io.socket:socket.io-client` (Java, 2.1.x) | Cliente propio mínimo sobre el `WebSocket` de OkHttp |
|---|---|---|
| A favor | Mantenida; reconexión y *acks* hechos | **Sin dependencia nueva**: usa el OkHttp 5 y kotlinx.serialization que ya hay; se prueba con un `WebSocket` falso; APK más pequeño |
| En contra | Arrastra su propio OkHttp (compilado contra 3.x/4.x): **riesgo de choque con OkHttp 5.5** y reglas de R8 (`isMinifyEnabled = true` en release) | Hay que escribir ~150 líneas del protocolo |

**Recomendación: cliente propio mínimo.** Lo que la app necesita es muy poco (un *namespace*, una conexión con `auth`, un `emit` con *ack*, seis eventos) y el riesgo de la biblioteca (binarios y R8) se paga en el release, que es justo donde no se prueba a diario. Antes de decidir, un **spike de medio día**: si la biblioteca oficial compila y corre en un `assembleDirectoRelease` firmado con R8, también es una opción válida; el resto de la spec no depende de cuál se elija porque ambos se esconden tras la interfaz de §4.2.

Protocolo (Engine.IO v4 + Socket.IO v5, solo WebSocket), para quien implemente el cliente propio:

| Mensaje | Trama de texto |
|---|---|
| Abrir | `wss://api.eduteka.pe/api/v1/realtime/?EIO=4&transport=websocket` |
| Servidor abre | `0{"sid":"…","pingInterval":25000,"pingTimeout":20000,…}` |
| Cliente conecta al *namespace* `/` con el token | `40{"token":"<access_token>"}` |
| Conectado / rechazado | `40{"sid":"…"}` / `44{"message":"UNAUTHENTICATED"}` |
| Ping del servidor → pong del cliente | `2` → `3` (si pasan `pingInterval + pingTimeout` sin `2`, se da por caída la conexión) |
| Evento del servidor | `42["sim:start",{…}]` |
| Evento del cliente con *ack* `n` | `42n["join",{"slug":"…"}]` ← `43n[{"ok":true,…}]` |
| Cierre | `41` |

### 4.2 Interfaz y estado

```kotlin
// core/realtime/LiveSimulacra.kt
sealed interface LiveEvent {
    data class State(val state: LiveState) : LiveEvent
    data class Close(val state: LiveState) : LiveEvent
    data class Start(val state: LiveState) : LiveEvent
    data class End(val state: LiveState) : LiveEvent
    data class Results(val state: LiveState) : LiveEvent
    data class Updated(val state: LiveState) : LiveEvent
}
data class LiveState(val phase: Phase, val serverTime: Instant, val resultsPublished: Boolean, /* + fechas */ )
enum class Connection { Connecting, Online, Offline }

interface LiveSimulacra {
    val connection: StateFlow<Connection>
    /** Abre (si hace falta), se une a la sala y emite los eventos de [slug]. Se cancela al dejar de recolectar. */
    fun observe(slug: String): Flow<LiveEvent>
}
```

Dos implementaciones, elegidas por Hilt según `BuildConfig.USE_MOCK_API`:

- `RealtimeClient` (real): el cliente de §4.1.
- `MockLiveSimulacra` (debug): genera eventos con temporizadores sobre `MockSimulacra`, para poder probar la sala de espera sin servidor (§9).

**Ciclo de vida:**

- Se conecta **solo mientras haga falta**: al recolectar `observe(slug)` desde la sala de espera, el examen y "examen enviado", de un simulacro programado en el que el usuario está inscrito. La ficha y la lista **no** abren socket.
- Se recolecta con `repeatOnLifecycle(Lifecycle.State.STARTED)`: al pasar la app a segundo plano se cierra (Android la mataría de todos modos y no se quiere despertar la radio); al volver, **se reconecta y se vuelve a pedir la ficha** (`load(silent = true)`), que recupera cualquier evento perdido (contrato §7.3).
- Token: el `auth` del `40{…}` es el token vigente de `SessionStorage`. Si el servidor responde `44 UNAUTHENTICATED`, se hace **una** llamada autenticada (p. ej. `detail(slug)`), que activa `TokenAuthenticator`, y se reconecta con el token nuevo; si vuelve a fallar, modo degradado.
- Reintentos: espera creciente de 1 s a 10 s con *jitter*.
- URL: el origen de `BuildConfig.BASE_URL` sin `/api/v1/`.
- **Cliente OkHttp propio para el socket** (`@Named("realtime")` en `NetworkModule`), construido con `provideBaseClient(...).newBuilder()`:
  - `readTimeout(0)` y `pingInterval(20 s)`. El cliente base lee con `readTimeout(20 s)` (`TIMEOUT_SECONDS`) y el servidor manda su ping cada 25 s: una conexión inactiva se cortaría antes del primer ping. (`CallTimeoutInterceptor` no interviene: solo actúa con la cabecera `X-Call-Timeout`.) `pingInterval` además detecta una conexión muerta sin depender del servidor.
  - **Sin** `AuthInterceptor` (el token va en el `40{…}`), sin `TokenAuthenticator`, sin `MathSvgInterceptor` y sin el interceptor simulado de debug (`withMock`), que interceptaría el handshake. Sí `AppVersionInterceptor`.
  - Se confirma en el spike (§4.1): una conexión inactiva 2 min no debe caerse en un `assembleDirectoRelease`.

### 4.3 Modo degradado

El sondeo de 30 s que hoy hace `SimulacrumScreen` (`POLL_MS`) **se elimina como mecanismo normal**. Queda **solo** como respaldo: mientras `connection != Online` y la pantalla es la sala de espera, el examen o "examen enviado", se pide la ficha cada 30 s. Al volver `Online`, se detiene.

---

## 5. Navegación y máquina de estados

### 5.1 Rutas nuevas (`Routes.kt`)

```kotlin
@Serializable data class SimulacrumWaitingRoute(val slug: String, val title: String)     // sala de espera
@Serializable data class SimulacrumSubmittedRoute(val slug: String, val title: String)   // examen enviado
```

Se registran en `AppNavHost` junto a las demás de simulacros, con el mismo patrón que ya usa `SimulacrumAttemptRoute` para pasar de una a otra (`navigate(...) { popUpTo<…> { inclusive = true } }`), de modo que atrás desde el examen lleve a la ficha y no a la sala de espera.

### 5.2 A dónde va cada quien

Una función **pura**, sin Android, decide la pantalla (se prueba con JUnit). **Se evalúan en orden** y la primera fila que coincide gana:

```kotlin
// feature/simulacrum/SimulacrumFlow.kt
enum class Step { DETAIL_CAN_ENROLL, DETAIL_REGISTRATION_CLOSED, DETAIL_ENDED, DETAIL_NOT_TAKEN, DETAIL_PENDING_REVIEW,
                  WAITING, ATTEMPT, SUBMITTED, RESULTS }

fun nextStep(detail: SimulacrumDetail): Step
```

| Inscripción | `schedule.phase` | Intento | `Step` |
|---|---|---|---|
| Inscrito, **reintento abierto** (`attemptNumber > 1` sin cerrar) | cualquiera, incluso `finished` | práctica en curso | `ATTEMPT` (el reintento no depende de la ventana; conserva el bloqueo de un dispositivo) |
| No inscrito | `registration` | — | `DETAIL_CAN_ENROLL` |
| No inscrito | `waiting` / `live` | — | `DETAIL_REGISTRATION_CLOSED` (también durante `live`: nadie se inscribe después de la fecha máxima, D8) |
| No inscrito | `finished` | — | `DETAIL_ENDED` |
| Inscrito, no verificado (pago pendiente) | cualquiera | — | `DETAIL_PENDING_REVIEW` |
| Inscrito | `registration` / `waiting` | — | `WAITING` |
| Inscrito | `live` | sin empezar | `WAITING` (con el botón de entrada habilitado, §6.2) |
| Inscrito | `live` | en curso | `ATTEMPT` |
| Inscrito | `live` | cerrado por el usuario | `SUBMITTED` |
| Inscrito | `finished` | sin empezar (ausente) | `DETAIL_NOT_TAKEN` |
| Inscrito | `finished` | cerrado | `schedule.resultsPublished ? RESULTS : SUBMITTED` |

La inscripción cerrada **no afecta a quien ya está inscrito**: en `live` y sin empezar va siempre a `WAITING` con entrada tardía (D8).

Para simulacros **sin horario** (`schedule == null`) `nextStep` conserva el comportamiento actual de `Actions(...)` en `SimulacrumScreen`.

Transiciones **automáticas** (disparadas por la fase, nunca por un botón):

- **Sala de espera → Examen** cuando llega `Start` (o `phase == LIVE` en la ficha) y el usuario está inscrito.
- **Examen → Enviado** al cerrarse el intento: cronómetro en 0, evento `End`, o `ATTEMPT_ALREADY_FINISHED`.
- **Enviado → Resultados** cuando llega `Results` (o `resultsPublished` en la ficha).

### 5.3 Enlaces y avisos

`DeepLinks` (`core/navigation/DeepLink.kt`) hoy solo entiende `/suscripciones`. Añadir:

```kotlin
data class Simulacrum(val slug: String) : DeepLink      // https://eduteka.pe/simulacros/{slug}
```

`parse` acepta **exactamente un segmento** después de `/simulacros` (`/simulacros/{slug}`); cualquier otra ruta (`/simulacros`, `/simulacros-unmsm`, `/simulacros/{slug}/resultados`…) devuelve `null`.

**En la v1 no se declara ningún `intent-filter` para `/simulacros`.** Un `pathPrefix="/simulacros"` con `autoVerify` capturaría también `/simulacros-unmsm` y `/simulacros/x/resultados`, que la app no sabe abrir, y desde un enlace verificado no hay forma limpia de devolverlos al navegador. Los avisos locales (§7) no lo necesitan: usan un **intent explícito** a `MainActivity` con la URL como `data`, y `MainActivity.onNewIntent` ya la pasa por `DeepLinks.parse` → `PendingDeepLink`. Que un enlace de correo o WhatsApp abra la app queda para más adelante, con `pathAdvancedPattern="/simulacros/[^/]+"` (solo Android 12+) o dejando esas rutas en el navegador.

`PendingDeepLink` ya sobrevive al inicio de sesión, así que quien toca un aviso sin sesión entra después de loguearse. El destino abre `SimulacrumRoute` y **ahí** `nextStep` decide la pantalla.

---

## 6. Pantallas

Los textos nuevos van a `res/values/strings_simulacra.xml` (§8); el estilo usa los componentes de `ui/theme/components` (`EdkCard`, `EdkButton`, `EdkBadge`…).

### 6.1 Ficha (`SimulacrumScreen`)

- En un simulacro programado, el bloque "Cómo funciona" (hoy `sim_when_start`/`sim_when_end`) pasa a **"Horario"** con las cuatro líneas, en hora de Lima: *Inscripciones hasta · Inicio · Fin · Resultados*.
- Mensajes claros por fase: cierre de inscripción ("La inscripción cerró el …"), terminado, "No rendiste este simulacro", pago pendiente.
- El aviso estático `sim_waiting_start` ("Esta pantalla se actualiza sola") se reemplaza por el botón **"Ir a la sala de espera"**.
- Se **elimina** el bucle de sondeo de `POLL_MS` (§4.3). El refresco al volver (`ON_RESUME`) se conserva.
- Texto de la inscripción cerrada: "La inscripción cerró el …. Si ya estás inscrito, puedes entrar tarde con el tiempo que quede."
- El botón **Solucionario** de un programado aparece solo si `schedule.resultsPublished`; mientras tanto se muestra "El solucionario estará disponible cuando se publiquen los resultados." En bajo demanda no cambia.
- Reglas: "Todos rinden en el mismo horario. Si entras tarde tendrás menos tiempo." y "Tu puntaje oficial es el de tu primer intento…". Calificación: con `0` se escribe "no resta puntos" / "no suma ni resta puntos".
- La lista (`SimulacraList`) muestra la fecha de inicio en hora de Lima y, si el usuario está inscrito, "Inscrito".

### 6.2 Sala de espera (`SimulacrumWaitingScreen` + `WaitingViewModel`)

| Elemento | Detalle |
|---|---|
| Aviso fijo | "Estás inscrito. El simulacro inicia el {fecha} (hora de Lima). Mantén esta pantalla abierta: te llevaremos al examen automáticamente." |
| Cuenta regresiva | Días/horas/min/seg grandes con etiquetas visibles; se repinta **cada segundo** con `ServerClock` (no con el reloj del teléfono). Contraste ≥ 4,5:1 en claro y oscuro |
| Botón | Deshabilitado: "Disponible a las 7:00 p. m.". Al llegar a 0 pasa a "Iniciando…" y, si el evento no llevó al examen en 8 s, se pide la ficha y se navega |
| Conexión | Fila discreta: "Conectado: el simulacro abrirá automáticamente" / "Sin conexión. Reintentando…" (según `Connection`) |
| Pantalla encendida | `keepScreenOn` mientras esté visible |
| Recomendaciones | No cerrar la app, conexión y batería, cuánto dura, "tus respuestas se guardan solas" |
| Permiso de avisos | Si falta el permiso de notificaciones (Android 13+), un recordatorio **una sola vez** |

**Entrada tarde.** Si ya está en `LIVE` y no ha iniciado, el botón muestra el tiempo que tendrá: `min(duración, fin − ahora)`. Si es menor que la duración: "Entrar ({n} min restantes: el simulacro termina a las 8:00 p. m.)". La entrada tardía es una regla confirmada (D8): se permite en cualquier momento de `live` con el tiempo que quede. Respuestas de `iniciar`:
- `NOT_STARTED` (reloj atrasado): devuelve a la espera sin error y re-sincroniza `ServerClock`.
- `WINDOW_ENDED`: va a la ficha con "ya terminó".
- `ATTEMPT_ALREADY_FINISHED`: va a "enviado", sin error (el intento ya estaba cerrado o venció y la API lo calificó).
- `CONFLICT`: error normal con el mensaje de la API.

### 6.3 Examen (`AttemptScreen` y `AttemptViewModel`)

Lo que **ya funciona** y se conserva: una pregunta por pantalla, `QuestionNavGrid`, reloj, diálogos de salida y de finalizar con conteo de pendientes, `BackHandler`, `flushNow()` en `ON_STOP`, cierre automático en 0.

Cambios (todos en `AttemptViewModel` salvo el aviso visual):

| # | Cambio | Detalle |
|---|---|---|
| 1 | **Aviso de entrada tarde** | Si `startedAttempt.window?.shortened == true`, banner fijo: "Entraste después del inicio: tu tiempo es de {n} min en lugar de {m} min. El simulacro termina para todos a las {hh:mm}." |
| 2 | **Borrador persistente** | `dirty` (hoy en memoria) se guarda en DataStore bajo `attempt-draft:{attemptId}` cada vez que cambia, y se carga al abrir el intento. Se borra al cerrarse. Cubre que Android mate la app con un envío sin confirmar |
| 3 | **Latido** | Mientras `phase == Taking` y la pantalla está `STARTED`, `repository.heartbeat(attemptId)` cada `session.heartbeatSeconds` (20 s) y de inmediato al volver a primer plano |
| 4 | **Bloqueo** | `ATTEMPT_ACTIVE_ELSEWHERE` en `start`, `saveAnswers`, `finish` o `heartbeat` ⇒ nueva fase `AttemptPhase.Locked` con el `ExamHolder`. La UI muestra `ExamLockedView` (abajo). El envío de respuestas queda **pausado** |
| 5 | **Reintento al estar bloqueado** | `start()` automático a los `retryAfterSeconds + 2` y luego cada 10 s; botón "Intentar de nuevo ahora". Al lograrlo (`session.tookOver == true`) vuelve a `Taking` |
| 6 | **Cola tras el bloqueo** | Si se retoma habiendo estado en `Locked`, **manda el servidor**: el borrador local y `dirty` se descartan y se adoptan las `answers` de `start`. Si se retoma **sin** haber pasado por `Locked` (solo sin red), el borrador se envía normal |
| 7 | **Cerrado por el servidor** | `ATTEMPT_ALREADY_FINISHED` (en `start`/`saveAnswers`/`finish`/`heartbeat`) o evento `End` ⇒ `Finished` sin error ⇒ navega a "enviado". En el latido se trata como éxito. El `CONFLICT` por `attempt_number` desfasado **no** cierra el examen |
| 8 | **Reloj** | `ServerClock` compartido (§3.4) en lugar del cálculo local |
| 9 | **Pantalla encendida** | `keepScreenOn` durante el intento |

`ExamLockedView` (pantalla completa, no permite responder):

> **Tu examen está abierto en otro lugar** · "Tu examen está abierto en {la web | otra instalación de la app}. Solo puedes rendirlo desde un dispositivo a la vez. Cierra el examen allí o espera: lo retomarás aquí **con el mismo tiempo**." · cuenta atrás de reintento · "El tiempo del examen sigue corriendo: {mm:ss}" · botón "Intentar de nuevo ahora".

Indicador de guardado: ya existe `SaveStatus` (`Idle/Saving/Saved/Error`). Verificar que `Saved` se apaga solo a los 2,5 s, que `Error` queda visible hasta el siguiente guardado correcto, y que **no** hay `Snackbar` por cada respuesta.

### 6.4 Examen enviado (`SimulacrumSubmittedScreen`)

"Has finalizado tu examen." · "Tu examen se envió a las {hh:mm}. Respondiste {k} de {t} preguntas." (de `results.submission`) · "Publicaremos los resultados el {fecha} (hora de Lima). Esta pantalla te llevará a ellos en cuanto se publiquen." · "No hace falta que hagas nada más. Puedes cerrar la app: te avisaremos." **Sin puntaje** (D2) y **sin solucionario**: "El solucionario estará disponible cuando se publiquen los resultados." (D7). Muestra la fila de conexión. Si al entrar los resultados ya están publicados, navega a resultados.

### 6.5 Resultados (`ResultsScreen` y `ResultsViewModel`)

- Si `resultsPublished == false`, el `ResultsViewModel` **redirige** a "enviado" (la API ya devuelve `attempt = null` y `ranking.visible = false`; no se muestran filas vacías).
- `absent == true`: "No rendiste este simulacro. Estabas inscrito, pero no abriste el examen durante el horario." y solo el ranking.
- Con los resultados publicados, la pantalla actual sirve: `ResultHeader` ya hace de resumen propio; confirmar que muestra puntaje, puesto "{n} de {m}", correctas/incorrectas/sin responder y tiempo.
- El botón **Ver solucionario** de un programado solo existe con los resultados publicados. Si aun así se llega a `SolutionRoute` y la API responde `403` (publicación revertida o enlace antiguo), se muestra el mensaje de la API y se vuelve a la pantalla anterior, sin pantalla de error genérica.
- "Volver a rendir" lleva la aclaración "Es práctica: no cambia el ranking." (solo con `canRetry`).
- Nombres del ranking: pendiente de la decisión de privacidad (en la web se muestra el nombre completo). Mientras tanto, **nombre y la inicial del apellido**.

---

## 7. Avisos locales

No hay FCM (D4) ni `WorkManager` en el proyecto: se usan **alarmas y notificaciones del sistema**, sin dependencias nuevas.

```kotlin
// core/notifications/SimulacrumReminders.kt
interface SimulacrumReminders {
    fun schedule(simulacrum: ReminderTarget)     // idempotente: cancela por id y vuelve a programar
    fun cancel(simulacrumId: String)
}
data class ReminderTarget(val id: String, val slug: String, val title: String, val start: Instant, val resultsAt: Instant?)
```

| Aviso | Cuándo | Texto |
|---|---|---|
| Previo | `start − 10 min` | "Tu simulacro empieza en 10 minutos. Prepárate." |
| Inicio | `start` | "Tu simulacro empieza ahora. Toca para entrar." |
| Resultados | `resultsAt` | "Ya están los resultados y el solucionario de tu simulacro." |

- **Alarmas:** `AlarmManager.setAndAllowWhileIdle` (inexacta, con tolerancia de minutos). **No** se usa `setExactAndAllowWhileIdle`: requiere `SCHEDULE_EXACT_ALARM`/`USE_EXACT_ALARM`, que Google Play **restringe a apps de alarma o calendario** y que en Android 14 el usuario puede revocar. La precisión al segundo del inicio la da el **socket** con la app abierta; el aviso es solo un recordatorio. Pedir exactitud en el sabor `directo` y no en `play` es una opción futura, no de la v1.
- **Receptor:** `SimulacrumReminderReceiver` (`exported="false"`) publica la notificación con `NotificationManagerCompat`. Canal `simulacros`, importancia alta, creado en `EdutekaApp.onCreate`.
- **Toque:** `PendingIntent` a `MainActivity` (`launchMode="singleTask"`, ya existe) con la URL `https://eduteka.pe/simulacros/{slug}` como `data` (intent **explícito**: no hace falta ningún filtro en el manifiesto); entra por `DeepLinks` y `PendingDeepLink` (§5.3).
- **Permiso:** `POST_NOTIFICATIONS` (Android 13+) se declara en el manifiesto y se **pide al terminar de inscribirse**, con una explicación previa ("Te avisamos cuando empiece, para que no lo pierdas"), no al arrancar. Si lo rechaza, la app sigue y la sala de espera lo recuerda una vez.
- **Cuándo se programan:** al inscribirse y en cada carga de la ficha de un simulacro programado en el que el usuario está inscrito y que no terminó. **Se cancelan** al terminar su intento, al llegar `Updated` (se reprograma con las fechas nuevas), y al cerrar sesión.
- **No se programa nada en el pasado.** Si `start − 10 min` ya pasó, solo "Inicio".
- **Reinicio del teléfono:** las alarmas se pierden. En la v1 se reprograman al abrir la app; un `BOOT_COMPLETED` que las restaure queda como mejora.
- Respetar la preferencia de avisos del perfil (`notification` en `Profile`) y la de telemetría; no se envía nada a Firebase sin el consentimiento que ya existe.

---

## 8. Textos nuevos (`strings_simulacra.xml`)

Tuteo, frases cortas, sin jerga ("Con horario", no "automático"). Hora siempre "(hora de Lima)". Los mismos textos que ya ve el usuario en la web.

| Clave sugerida | Texto |
|---|---|
| `sim_schedule_title` | Horario (hora de Lima) |
| `sim_schedule_close` / `_start` / `_end` / `_results` | Inscripciones hasta: %s · Inicio: %s · Fin: %s · Resultados: %s |
| `sim_registration_closed_on` | La inscripción cerró el %s. Ya no es posible inscribirse en este simulacro. |
| `sim_ended` | Este simulacro ya terminó. |
| `sim_not_taken` | No rendiste este simulacro. |
| `sim_action_waiting_room` | Ir a la sala de espera |
| `sim_wait_enrolled` | Estás inscrito. El simulacro inicia el %s (hora de Lima). Mantén esta pantalla abierta: te llevaremos al examen automáticamente. |
| `sim_wait_button_at` / `sim_wait_button_starting` / `sim_wait_button_enter` | Disponible a las %s · Iniciando… · Entrar al simulacro |
| `sim_wait_button_late` | Entrar (%1$d min restantes: el simulacro termina a las %2$s) |
| `sim_conn_online` / `sim_conn_offline` | Conectado: el simulacro abrirá automáticamente · Sin conexión. Reintentando… |
| `sim_late_banner` | Entraste después del inicio: tu tiempo es de %1$d min en lugar de %2$d min. El simulacro termina para todos a las %3$s. |
| `sim_locked_title` / `_body` | Tu examen está abierto en otro lugar · Tu examen está abierto en %s. Solo puedes rendirlo desde un dispositivo a la vez… |
| `sim_locked_web` / `sim_locked_app` | la web · otra instalación de la app |
| `sim_locked_retry` | Intentar de nuevo ahora |
| `sim_submitted_title` / `_body` | Has finalizado tu examen. · Tu examen se envió a las %1$s. Respondiste %2$d de %3$d preguntas. |
| `sim_results_at` | Publicaremos los resultados el %s (hora de Lima). Esta pantalla te llevará a ellos en cuanto se publiquen. |
| `sim_retry_practice` | Es práctica: no cambia el ranking. |
| `sim_solution_locked` | El solucionario estará disponible cuando se publiquen los resultados. |
| `sim_registration_closed_live` | La inscripción cerró el %s. Si ya estás inscrito, puedes entrar tarde con el tiempo que quede. |
| `sim_notif_pre` / `_start` / `_results` | (textos de §7) |
| `sim_notif_permission_why` | Te avisamos cuando empiece, para que no lo pierdas. |

---

## 9. Modo simulado (debug)

El `MockInterceptor` (`USE_MOCK_API = true` por defecto en debug) responde a `MockSimulacra.kt`. Para desarrollar sin servidor:

- Añadir un simulacro **programado y gratis** con fechas **relativas a "ahora"** (cierre en 1 min, inicio en 2 min, fin en 6 min, resultados en 8 min), y `schedule` en su ficha.
- Responder `POST …/latido` y devolver `session` y `window` en `iniciar`.
- Un interruptor para simular `ATTEMPT_ACTIVE_ELSEWHERE` (con `holder`) y otro para `ATTEMPT_ALREADY_FINISHED`.
- `MockLiveSimulacra` (§4.2) emite `Close`, `Start`, `End` y `Results` con temporizadores coherentes con esas fechas.
- Resultados diferidos: `results_published = false` hasta la hora de publicación.

---

## 10. Dependencias y configuración

- **Ninguna librería nueva** con el cliente propio (§4.1). Si se elige la oficial: `io.socket:socket.io-client` en `libs.versions.toml` + reglas de R8 y prueba del release.
- `AndroidManifest.xml`: `POST_NOTIFICATIONS` y `SimulacrumReminderReceiver`. **Sin** nuevo `intent-filter` en la v1 (§5.3).
- `proguard-rules.pro`: sin cambios con el cliente propio.
- `EdutekaApp`: crear el canal de notificaciones y resolver `InstallIdStorage` al arrancar.
- `AppNavHost`: dos rutas nuevas (§5.1) y el `DeepLink.Simulacrum` (§5.3).
- Mantener `docs/sabor-play.md` al día: los avisos y el socket funcionan en ambos sabores.

---

## 11. Pruebas

Convención del proyecto: **JUnit 4 + MockK + Turbine + coroutines-test**, ViewModels con constructor `internal` que recibe lo inyectable (como `AttemptViewModel`, que ya recibe `nowMs`).

| Prueba | Casos |
|---|---|
| `ServerClockTest` | `now()` sigue al servidor tras `sync`; cambiar el reloj del teléfono no lo mueve; un segundo `sync` re-ancla; `millisUntil` nunca es negativo |
| `SimulacrumFlowTest` | Las 11 filas de §5.2 (incluido el reintento abierto con el simulacro ya terminado), no inscrito en `live` ⇒ `DETAIL_REGISTRATION_CLOSED`, inscrito en `live` sin empezar ⇒ `WAITING`, y el caso sin horario (conserva el comportamiento actual) |
| `EnrollViewModelTest` (ampliar) | `REGISTRATION_CLOSED` ⇒ refresca la ficha y muestra "La inscripción cerró…" |
| `SimulacrumContractTest` (ampliar) | JSON de `schedule`, `window`, `session`, `submission`, `holder` y de un servidor antiguo (sin los campos): defaults correctos, `resultsPublished = true` |
| `AttemptViewModelTest` (ampliar) | `window.shortened` ⇒ banner; el borrador persiste y se recupera; el latido corre cada 20 s y se detiene al salir; `ATTEMPT_ACTIVE_ELSEWHERE` ⇒ `Locked` y pausa el envío; retomar tras `Locked` adopta el servidor y descarta el borrador; retomar sin `Locked` envía el borrador; `ATTEMPT_ALREADY_FINISHED` (en `start`, `saveAnswers`, `finish` y `heartbeat`) ⇒ `Finished` sin error; `CONFLICT` en `start` ("no tiene duración") ⇒ error normal, no "ya calificado"; `CONFLICT` por intento desfasado ⇒ no cierra; `NOT_STARTED` ⇒ vuelve a la espera; `WINDOW_ENDED` ⇒ ficha; evento `End` ⇒ `Finished` |
| `RealtimeClientTest` | Con un `WebSocket` falso: handshake `0…` → `40{token}` → `40`; `2`→`3`; `42["sim:start",…]` ⇒ `LiveEvent.Start`; *ack* de `join`; `44 UNAUTHENTICATED` ⇒ reconexión única con token nuevo; caída por falta de `ping` ⇒ `Offline` |
| `LiveSimulacraDegradedTest` | Con `Offline` se sondea cada 30 s y solo en las tres pantallas; al volver `Online`, no |
| `SimulacrumRemindersTest` | La parte de cálculo: no programa en el pasado; sin "previo" si ya pasó; cancela por id; respeta la preferencia de avisos |
| `DeepLinkTest` (ampliar) | `https://eduteka.pe/simulacros/{slug}` ⇒ `Simulacrum(slug)`; `/simulacros`, `/simulacros-unmsm` y `/simulacros/{slug}/resultados` ⇒ `null`; otro dominio o esquema ⇒ `null` |
| `ResultsViewModelTest` | `resultsPublished = false` ⇒ redirige a "enviado"; `absent` ⇒ aviso y solo ranking; solucionario oculto sin publicar; `403` del solucionario ⇒ mensaje de la API y vuelta atrás |

Correr `./gradlew :app:testDirectoDebugUnitTest :app:testPlayDebugUnitTest` (ambos sabores) y `lint`.

### 11.1 Matriz manual (teléfono real; el emulador no sirve para batería ni alarmas)

| Escenario | Esperado |
|---|---|
| moto g23 (gama media-baja) y un Android 14 | Fluido; avisos llegan |
| Sala de espera con la pantalla apagada y encendida 1 min antes | Reconecta, recupera la ficha y sigue la cuenta atrás |
| App en segundo plano a la hora de inicio | Llega el aviso; al tocarlo abre la espera/examen |
| Matar la app a mitad del examen y reabrir | Mismo intento, mismo tiempo, respuestas intactas (incluidas las del borrador) |
| Modo avión 30 s marcando respuestas | Estado "sin conexión"; al volver, "Guardado", sin pérdidas |
| Cambiar la hora del teléfono +1 h | Cuenta regresiva y cronómetro **no** cambian |
| Llamada entrante durante el examen | El cronómetro sigue; al volver, estado correcto |
| Entrar a los 3 min de una ventana de 5 con duración 3 | Banner "tu tiempo es de 2 min…"; termina a `end_date` |
| Examen abierto en la web; abrirlo en la app | Pantalla de bloqueo con el motivo y el tiempo; no deja responder |
| Cerrar la pestaña web y esperar ~60 s | La app retoma sola: mismo tiempo y respuestas |
| Abrirlo en la app y luego en la web | La web ve el bloqueo; la app sigue |
| App con el examen abierto, teléfono apagado 90 s, abrirlo en la web | La web lo retoma; al volver la app ve el bloqueo y **no pisa respuestas** |
| Socket bloqueado (firewall) | Modo degradado: consulta cada 30 s, el flujo sigue |
| Rotar y cambiar a modo oscuro | Sin pérdida de estado ni respuestas |
| `assembleDirectoRelease` (R8) y `bundlePlayRelease` | El socket conecta en ambos (la prueba que el emulador de debug no cubre) |
| Sesión que expira durante el examen | Refresh transparente (`TokenAuthenticator`); sin perder respuestas |
| Pantalla de inscripción abierta cuando cierra la inscripción | Al enviar: `REGISTRATION_CLOSED`, la ficha se refresca y muestra el cierre |
| Resultados sin publicar: ficha y "enviado" | Sin botón de solucionario y con el aviso; al publicar, aparece |
| Inscrito que abre a mitad de la ventana | Entra con el tiempo restante y el banner de entrada tardía |

---

## 12. Orden de implementación

1. **Datos:** DTOs/modelos nuevos, `ApiCodes`, `AppError.Api.holder`, `heartbeat`, `ExamSessionInterceptor` + `InstallIdStorage`, `ServerClock`. Con sus pruebas de contrato.
2. **`SimulacrumFlow`** (función pura) y rutas nuevas.
3. **Modo simulado** (§9): un programado con fechas relativas.
4. **Ficha y lista** con el horario y los mensajes por fase; quitar el sondeo permanente.
5. **Sala de espera** (con temporizadores locales sobre `ServerClock`, aún sin socket).
6. **`AttemptViewModel`:** borrador persistente, latido, bloqueo, entrada tarde, `ATTEMPT_ALREADY_FINISHED`, `End`.
7. **Enviado y Resultados** con publicación diferida y ausentes.
8. **Tiempo real:** el spike de §4.1, `RealtimeClient`, `LiveSimulacra`, y conectarlo a espera, examen y enviado. Modo degradado.
9. **Avisos locales** y `DeepLink` de `/simulacros`.
10. **Pasada final:** accesibilidad, ambos sabores, release con R8, matriz manual y criterios de aceptación del contrato §12.

El paso 8 necesita **F2 de la API** (socket y señal). Los pasos 1–7 y 9 se pueden hacer contra el modo simulado desde que existe F1 (el 9 solo necesita las fechas de F1: los avisos son locales y el enlace no depende del socket).

## 13. Lista de verificación

- [ ] §3.1 DTOs y modelos con defaults; `SimulacrumContractTest` ampliado.
- [ ] §3.2 `heartbeat`, `ExamSessionInterceptor`, `InstallIdStorage`.
- [ ] §3.3 códigos nuevos y `holder` en `AppError.Api`; tabla `CONFLICT` vs `ATTEMPT_ALREADY_FINISHED`; `REGISTRATION_CLOSED` refresca la ficha.
- [ ] §6.1/§6.4/§6.5 solucionario condicionado a `resultsPublished` en programados y `403` manejado.
- [ ] §3.4 `ServerClock` y su prueba.
- [ ] §4 spike del cliente, `LiveSimulacra` real y simulada, modo degradado.
- [ ] §5 `SimulacrumFlow` con sus 11 filas probadas; rutas nuevas; `DeepLink.Simulacrum`.
- [ ] §6 ficha, sala de espera, examen (los 9 cambios), enviado y resultados.
- [ ] §7 avisos locales idempotentes, permiso con explicación previa, sin alarmas exactas.
- [ ] §9 simulacro programado en el modo simulado.
- [ ] §11 pruebas unitarias en ambos sabores, lint y matriz manual.
- [ ] Criterios de aceptación 1–10 del contrato §12 con un simulacro real.
