# Spec — Cambio de plan y cobro de la diferencia (2): app Android (Kotlin)

**Repositorio:** `C:\Users\Jose Taquiri\AndroidStudioProjects\Eduteka`. **Contrato:** `spec-cambio-de-plan-0-contrato.md` (§4 HTTP y §5 textos).
**Estado:** implementado en la app, sin publicar: DTOs y mapeo, `Renewal.notice`, `PlanDetail.amountDue` / `isBlocked`, `ApiCodes.PLAN_CHANGE_BLOCKED` con recarga, aviso y bloqueo en `PlanScreen`, textos y modo simulado. `testDirectoDebugUnitTest` en verde. Falta la matriz manual (§6.1) y publicar la 1.1.2. No se hizo la segunda cuenta demo con Institucional (opcional, §5).
**Versión objetivo:** 1.1.2.

---

## 1. Punto de partida (1.1.1 contra la API nueva)

| Situación | Qué hace hoy | Qué tiene que hacer |
|---|---|---|
| Institucional vigente mirando Semestral/Anual | "Paga S/ 30" y "el nuevo periodo empieza el —, cuando termine el actual" (`startsAt` llega `null`). Si paga S/ 30, la API lo aprueba y suma los días. | Mostrar `amount_due` (p. ej. S/ 23), el descuento y "empieza hoy y vence el …". |
| Plan general vigente mirando otro general | "empieza el —, cuando termine el actual". | "Al pagar pasas a … desde hoy y los días que te quedan se suman: vigente hasta el …". |
| Plan general vigente mirando el Institucional | Muestra el formulario. Al enviar recibe 409 `PLAN_CHANGE_BLOCKED` y muestra el mensaje con `ShowError`. | No mostrar el formulario: mostrar `blocked_message` y "Ver otros planes". |

## 2. Capa de datos

### 2.1 DTOs (`feature/subscription/data/SubscriptionRepository.kt`)

El JSON usa `JsonNamingStrategy.SnakeCase` (`core/common/ApiCall.kt`), así que los nombres en camelCase se mapean solos. Todos los campos son opcionales con valor por defecto, para no romper con una API anterior ni con el modo simulado.

```kotlin
// PlanDto: solo llega en el detalle
val amountDue: Double? = null,

@Serializable
data class RenewalDto(
    val currentPlan: String? = null,
    val samePlan: Boolean = false,
    val running: Boolean = false,
    val currentEndDate: String? = null,
    val startsAt: String? = null,
    // Nuevos (spec-cambio-de-plan-0 §4.1):
    val upgradeNow: Boolean = false,
    val newEndDate: String? = null,
    val blockedMessage: String? = null,
    val prorated: Boolean = false,
    val credit: Double = 0.0,
    val remainingDays: Int? = null,
)

@Serializable
data class ProrationDto(
    val fromPlan: String? = null,
    val remainingDays: Int = 0,
    val regularPrice: Double = 0.0,
    val credit: Double = 0.0,
    val amount: Double = 0.0,
)
// PaymentDto:
val proration: ProrationDto? = null,
```

### 2.2 Modelos (`feature/subscription/model/SubscriptionModels.kt`)

```kotlin
data class Renewal(
    val currentPlan: String,
    val samePlan: Boolean,
    val running: Boolean,
    val currentEndDate: String?,
    val startsAt: String?,
    val upgradeNow: Boolean = false,
    val newEndDate: String? = null,
    /** El cambio reduciría el acceso vigente: no se ofrece el pago. Texto listo del servidor. */
    val blockedMessage: String? = null,
    val prorated: Boolean = false,
    val credit: Double = 0.0,
    val remainingDays: Int? = null,
)

data class PlanDetail(
    // …campos actuales…
    /** Lo que se paga ahora: el precio o la diferencia. Es lo que se muestra en «Paga S/ …». */
    val amountDue: Double,
)
```

En `PlanDto.toDetail()`: `amountDue = amountDue ?? price`, y el mapeo de los campos nuevos de `Renewal`.

`SubscriptionPayment` puede ignorar `proration` en la v1. `amount` ya es lo cobrado, así que `plan_pending_body` muestra el monto correcto sin cambios.

### 2.3 Errores (`core/common/AppError.kt`)

```kotlin
const val PLAN_CHANGE_BLOCKED = "PLAN_CHANGE_BLOCKED"
```

En `PlanViewModel.subscribe()`, ante `PLAN_CHANGE_BLOCKED`: mostrar el mensaje (como hoy con `ShowError`) **y** volver a pedir el plan (`load()`), igual que con `CONFLICT`. Así la pantalla pasa al estado bloqueado con el `blocked_message` del servidor. Sirve para el caso en que el plan cambie entre que se abrió la pantalla y se envió el pago.

## 3. Pantalla del detalle (`feature/subscription/ui/PlanScreen.kt`)

### 3.1 Aviso de renovación o cambio

Reemplazar el `when` actual (línea ~177) respetando este orden:

```kotlin
val text = when {
    renewal.blockedMessage != null -> renewal.blockedMessage
    renewal.samePlan && renewal.running -> stringResource(R.string.plan_renewal_running_same, renewal.currentPlan, Format.shortDate(renewal.startsAt))
    renewal.prorated -> stringResource(
        R.string.plan_change_prorated,
        renewal.currentPlan, Format.shortDate(renewal.currentEndDate),
        Format.money(renewal.credit), renewal.remainingDays ?: 0,
        Format.money(detail.amountDue), Format.money(plan.price),
        plan.name, Format.shortDate(renewal.newEndDate),
    )
    renewal.upgradeNow -> stringResource(
        R.string.plan_change_now,
        renewal.currentPlan, Format.shortDate(renewal.currentEndDate), plan.name, Format.shortDate(renewal.newEndDate),
    )
    renewal.running -> stringResource(R.string.plan_renewal_running_other, renewal.currentPlan, Format.shortDate(renewal.startsAt))
    else -> stringResource(R.string.plan_renewal_expired, renewal.currentPlan)
}
```

Con `blockedMessage`, la tarjeta usa `tintAmber` en vez de `tintGreen`.

### 3.2 Formulario de pago

- Con `renewal?.blockedMessage != null`: **no** se muestran instituciones, método, comprobante ni botón. Se muestra la tarjeta del §3.1 y un botón secundario «Ver otros planes» que vuelve a `PlansScreen`. Es el mismo patrón que el `return@Column` del pago pendiente.
- `Receipt(state, detail.amountDue, …)` en lugar de `plan.price`. Así cambian «Paga S/ …» (`plan_pay_title`) y el monto de `PaymentHowTo`.
- El encabezado del plan (`"${Format.money(plan.price)} · ${plan.duration()}"`) **sigue mostrando el precio de lista**. El descuento se explica en el aviso del §3.1.

### 3.3 Analítica

Si la pantalla envía `view_item`, `begin_checkout` o `purchase`, el `value` debe ser `amountDue`, igual que en la web.

## 4. Textos nuevos (`res/values/strings_subscription.xml`)

```xml
<string name="plan_change_prorated">Tienes el plan %1$s hasta el %2$s. Te descontamos %3$s por los %4$d días que te quedan: pagas %5$s en vez de %6$s. Tu plan %7$s empieza hoy y vence el %8$s.</string>
<string name="plan_change_now">Tienes el plan %1$s hasta el %2$s. Al pagar pasas a %3$s desde hoy y los días que te quedan se suman: tu plan quedará vigente hasta el %4$s.</string>
<string name="plan_change_blocked_title">Aún no puedes cambiar a este plan</string>
<string name="plan_change_other_plans">Ver otros planes</string>
```

`plan_renewal_running_other` queda solo para el caso que la API ya no genera (cambio vigente sin `upgradeNow` ni bloqueo). Se puede conservar por compatibilidad.

## 5. Modo simulado (`core/network/MockSubscriptions.kt`)

- **Detalle:** agregar `amount_due` y los campos nuevos de `renewal`. La cuenta demo tiene el plan `DEMO_PLAN`:
  - **mismo plan:** como hoy, con `upgrade_now = false`, `prorated = false` y `new_end_date = demoEnd + duración`;
  - **plan general distinto:** `upgrade_now = true`, `starts_at = null` y `new_end_date = demoEnd + duración`;
  - **plan institucional:** `blocked_message` con el texto de bloqueo del contrato §5.
- **Opcional:** una segunda cuenta demo con Institucional vigente, para ver `prorated = true`, con el cálculo del contrato §2 y precios de la demo.
- **`subscribe`:** responder 409 `PLAN_CHANGE_BLOCKED` en el caso de bloqueo, y usar `amount_due` como `amount` del pago.

## 6. Pruebas (`app/src/test/.../feature/subscription/SubscriptionTest.kt`)

1. El detalle mapea `amount_due`. Si no viene, `amountDue == price`.
2. El detalle mapea `upgrade_now`, `new_end_date`, `blocked_message`, `prorated`, `credit` y `remaining_days`.
3. El `when` del aviso elige el texto correcto en los 6 casos (bloqueado, renovar vigente, con descuento, mejora sin descuento, cambio vigente, vencido). Conviene extraerlo a una función pura (`renewalMessageKind(renewal)`) para probarlo sin Compose.
4. Con `blockedMessage` no se ofrece el formulario. En `PlanViewModel`, `canSubmit` debe ser `false`.
5. Un 409 `PLAN_CHANGE_BLOCKED` al enviar recarga el plan (como `CONFLICT`).
6. Modo simulado: la cuenta demo mirando el Institucional recibe el bloqueo, y al enviar recibe el 409.

### 6.1 Matriz manual (contra staging, con cuentas de prueba)

| Cuenta | Plan que abre | Esperado |
|---|---|---|
| Institucional con ~3 meses restantes | Semestral | «Paga S/ 23» (con los precios de producción), aviso de descuento con la fecha de hoy + 6 meses. Al pagar S/ 23 → aprobado y plan general. |
| Institucional con ~3 meses restantes | Semestral, pagando S/ 30 | Aprobado sin descuento, vigente hasta el fin actual + 6 meses. |
| Semestral vigente | Anual | «Paga S/ 50», aviso «desde hoy … se suman». |
| Semestral vigente | Institucional | Tarjeta ámbar con el bloqueo, sin formulario. |
| Institucional de UNI vigente | Institucional (elige UNSM) | Tras enviar: mensaje de otra institución y recarga. |
| Sin plan | Cualquiera | Como hoy: «Paga S/ {precio}». |

## 7. Orden de implementación

1. DTOs, modelos y mapeo (§2.1–2.2), con las pruebas 1 y 2.
2. `ApiCodes.PLAN_CHANGE_BLOCKED` y la recarga en el ViewModel (§2.3), con la prueba 5.
3. Aviso y formulario (§3), con las pruebas 3 y 4.
4. Textos (§4).
5. Modo simulado (§5), con la prueba 6.
6. Matriz manual (§6.1) y publicar la 1.1.2.

## 8. Lista de verificación

- [ ] «Paga S/ …» usa `amountDue`.
- [ ] Ningún texto muestra «—» como fecha en un cambio de plan vigente.
- [ ] Con `blockedMessage` no hay formulario ni botón de pago.
- [ ] 409 `PLAN_CHANGE_BLOCKED` → mensaje y recarga.
- [ ] El modo simulado cubre bloqueo, mejora sin descuento y (opcional) mejora con descuento.
- [ ] `./gradlew testDebugUnitTest` en verde.
