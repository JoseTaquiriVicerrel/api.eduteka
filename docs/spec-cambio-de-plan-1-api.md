# Spec — Cambio de plan y cobro de la diferencia (1): API

**Repositorio:** `E:\Trabajo\api_eduteka`. **Contrato:** `spec-cambio-de-plan-0-contrato.md`.
**Estado:** implementado y probado (`npm test`). Este documento describe qué cambió, para revisarlo y desplegarlo.

---

## 1. Archivos

| Archivo | Cambio |
|---|---|
| `src/libs/plan_change.js` | **Nuevo.** Copia de la regla del monolito (`#Libs/plan_change.js`). Si cambia allá, cambiar aquí. |
| `src/modules/subscriptions/subscription.service.js` | `renewalPreview` agrega `upgrade_now`, `new_end_date`, `blocked_message`, `prorated`, `credit` y `remaining_days`. Nuevo `quoteFor(current, plan)`. `getPlan` devuelve `amount_due`. `createPayment` rechaza con `PLAN_CHANGE_BLOCKED`, cobra `quote.amount`, valida el comprobante contra ese monto con el precio completo como alternativa, y guarda `proration`. `serializePayment` expone `proration`. |
| `src/modules/subscriptions/subscription.activation.js` | Las fechas salen de `periodFor`, con `prorated: Boolean(payment.proration)`. |
| `src/modules/payments/voucher.verify.js` | `verifyVoucher(buffer, expected, { alternatives })` devuelve `matchedAmount`. Tienda y simulacros no lo usan: sin cambios para ellos. |
| `src/schemas/payment_schema.js` | Campo opcional `proration`. |
| `src/libs/api_error.js` | `ApiError.planChangeBlocked(message)` → 409 `PLAN_CHANGE_BLOCKED`. |

## 2. Flujo de `POST /suscripciones/:slug/suscribirme`

1. `resolveInstitution` (sin cambios).
2. **Nuevo:** `planChangeBlock(user.suscription, plan, institutionId)` → si bloquea, 409 `PLAN_CHANGE_BLOCKED` antes del lock, del comprobante y de la IA.
3. `transactionType`, el lock, el pago pendiente y `hasQueuedRenewal` (sin cambios).
4. **Nuevo:** `quote = quoteFor(user.suscription, plan)`.
5. `verifyVoucher(capture, quote.amount, { alternatives: quote.proration ? [plan.price] : [] })`.
   Si se aprobó por el precio completo, `quote = { amount: plan.price, proration: null }`: se registra como mejora sin descuento y se suman los días.
6. `registerPayment` guarda `amount: quote.amount` y, si hay descuento, `proration`.
7. La activación (IA o admin) llama a `periodFor` con `prorated` según el pago guardado.

## 3. Compatibilidad

- **Campos nuevos aditivos.** El único cambio de significado es `renewal.starts_at = null` cuando `upgrade_now` es `true`. La app 1.1.1 muestra entonces "—" en la fecha de su texto de cambio de plan: queda impreciso, pero no falla. La corrige la app 1.1.2 (`spec-cambio-de-plan-2-app.md`).
- **App 1.1.1 en una mejora con descuento:** muestra y cobra `price`. El comprobante por el precio completo **se aprueba** (paso 5) y el usuario recibe los días sumados, igual que antes.
- **App 1.1.1 en un cambio bloqueado:** muestra el formulario, y al enviar recibe el 409 con `error.message`, que la app ya muestra con `UiEvent.ShowError`. No se crea pago.
- **Pagos pendientes de antes del despliegue:** no tienen `proration`. Se activan como antes (cambio entre planes generales: desde hoy y sumando días).

## 4. Pruebas

- `test/subscriptions.test.js`:
  - detalle: renovación, mejora entre planes generales, mejora con descuento y bloqueo;
  - pago: 409 `PLAN_CHANGE_BLOCKED` (general → institucional, otra institución, y que con el plan vencido sí se puede);
  - el descuento se guarda en el pago;
  - `amount_due` sin descuento.
- `test/payment_vouchers.test.js`:
  - comprobante por la diferencia: aprobado, plan desde hoy por 6 meses;
  - comprobante por el precio completo: aprobado sin descuento y con los días sumados;
  - monto que no cuadra con ninguno: pendiente, con la diferencia como monto esperado.

## 5. Despliegue

Sin migración ni configuración. Desplegar la API **junto con** el monolito, porque ambos escriben `payments.proration` y las dos webs deben calcular lo mismo. El orden respecto a la app no importa (§3).

## 6. Pendiente (fuera de este spec)

- El panel admin del monolito muestra `amount`, pero no el detalle de `proration`. Si un comprobante con descuento queda en revisión manual y el usuario pagó el precio completo, el admin debe aprobarlo sabiendo que el sistema le aplicará el descuento (plan desde hoy por 6 meses) y no los días sumados. Conviene mostrar `proration` en `payments_verification.hbs`.
