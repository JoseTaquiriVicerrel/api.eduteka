# Spec — Cambio de plan y cobro de la diferencia (0): contrato compartido

**Repositorios:** monolito `E:\Trabajo\eduteka` (hecho), API `E:\Trabajo\api_eduteka` (hecho), app Android (Kotlin) `C:\Users\Jose Taquiri\AndroidStudioProjects\Eduteka` (implementado, sin publicar).
**Documentos hermanos:** `spec-cambio-de-plan-1-api.md` (API) y `spec-cambio-de-plan-2-app.md` (app).
**Estado:** el monolito (web Express y web Next) y la API ya aplican estas reglas, con pruebas. La app ya lo implementa; falta publicarla en la 1.1.2.

---

## 1. Qué problema resuelve

Al activarse un plan, `user.suscription` se **reemplaza entero**: el acceso del plan nuevo rige desde ese momento. Antes las fechas no lo reflejaban y había tres fallos:

| Caso | Antes | Ahora |
|---|---|---|
| Institucional vigente → plan general (Semestral, Anual) | Se cobraba el precio completo. El acceso general era inmediato, pero el periodo se fechaba "cuando termine el actual". | Se cobra **la diferencia**. El plan nuevo corre **desde hoy** por su duración completa. |
| Plan general vigente → otro plan general (Semestral ↔ Anual) | Acceso inmediato, pero con fecha de inicio futura. | Precio completo. Rige **desde hoy** y los días que quedaban **se suman al final**. |
| Plan general vigente → Institucional, o Institucional vigente → **otra** institución | El usuario perdía ese mismo día el acceso que ya había pagado. | **Se rechaza** mientras el plan actual siga vigente. |
| Renovar el mismo plan vigente | Se encadena al fin actual. | Sin cambios. |
| Cualquier compra con el plan vencido | Desde hoy. | Sin cambios. |

"Vigente" significa `suscription.status === 'activo'` y `end_date` en el futuro.

## 2. Cálculo de la diferencia

Solo aplica de **Institucional vigente → plan general** (`restricted_to_institution` del plan actual `true` y del nuevo `false`).

```
ciclo      = días entre (end_date − duration_months del plan actual) y end_date
quedan     = ceil((end_date − ahora) / 1 día)
valor      = precio_actual × quedan / ciclo
monto      = ceil(precio_nuevo − valor)     // soles enteros: se paga por Yape/Plin
monto      = max(monto, 5)                  // MIN_UPGRADE_CHARGE
monto      = min(monto, precio_nuevo)
credit     = precio_nuevo − monto
```

- El plan actual se busca **por nombre** en el catálogo (`suscriptions.name === user.suscription.name`), porque eso es lo que guarda la suscripción. Si no se encuentra, o no tiene precio ni duración, **no hay descuento**: se cobra el precio completo y se suman los días.
- Si quedan **más días que un ciclo** (hay una renovación ya encadenada), tampoco hay descuento: descontar solo un ciclo haría perder el otro.
- Ejemplo con los planes de producción (Institucional S/ 15, 6 meses y Semestral S/ 30), con 92 de 184 días restantes: valor 7.50 → **paga S/ 23**, `credit` 7. El Semestral corre de hoy a hoy + 6 meses.

El monto lo decide **siempre el servidor**, al mostrar el detalle y otra vez al recibir el pago. El cliente no lo envía.

## 3. Datos (Mongo compartido)

Solo se **agrega** un campo opcional. No hay migración.

| Colección | Campo | Tipo | Significado |
|---|---|---|---|
| `payments` | `amount` | Number | Ya existía. Ahora es **lo cobrado**: la diferencia en una mejora con descuento. |
| | `proration` | `{ from_plan, remaining_days, regular_price, credit, amount }` | Solo en una mejora con descuento. Es la constancia del cálculo. **Su presencia** hace que la activación corra el plan desde hoy por su duración, sin sumar días. |

La activación (`getStartAndEndDateSuscription` en los dos backends) usa `periodFor({ transactionType, current, plan, prorated: Boolean(payment.proration) })`. Por eso la aprobación manual del admin respeta el cálculo sin tocar nada.

## 4. Contrato HTTP (API v1)

### 4.1 `GET /api/v1/suscripciones/:slug` (detalle del plan)

Campos nuevos (todos opcionales para un cliente que no los conozca):

| Campo | Tipo | Cuándo |
|---|---|---|
| `amount_due` | number | Siempre. Lo que se paga ahora: `price` o la diferencia. **Es el monto que se muestra en "Paga S/ …"**. |
| `renewal.upgrade_now` | boolean | El cambio a un plan general rige desde hoy. |
| `renewal.new_end_date` | ISO \| null | Hasta cuándo quedará vigente el plan si se paga ahora. |
| `renewal.blocked_message` | string \| null | El cambio reduciría el acceso vigente: **no se ofrece el pago** y se muestra este texto. |
| `renewal.prorated` | boolean | Mejora con descuento. |
| `renewal.credit` | number | Descuento ya redondeado (0 sin descuento). |
| `renewal.remaining_days` | number \| null | Días del plan actual que se descuentan. |

Cambio de significado: `renewal.starts_at` ahora es `null` cuando `upgrade_now` es `true` (el plan nuevo no espera al actual).

Ejemplo (Institucional vigente, mirando el Semestral):

```json
{
  "slug": "semestral", "name": "Semestral", "price": 30, "amount_due": 23,
  "renewal": {
    "current_plan": "Semestral Institucional", "same_plan": false, "running": true,
    "upgrade_now": true, "prorated": true, "credit": 7, "remaining_days": 92,
    "current_end_date": "2027-02-08T15:00:00.000Z", "starts_at": null,
    "new_end_date": "2027-05-08T15:00:00.000Z", "blocked_message": null
  }
}
```

### 4.2 `POST /api/v1/suscripciones/:slug/suscribirme`

- **Nuevo error 409 `PLAN_CHANGE_BLOCKED`**: es el mismo caso que `renewal.blocked_message`. `error.message` trae el texto listo para mostrar. No se crea pago.
- En una mejora con descuento, el comprobante se valida contra `amount_due`. **También se acepta el precio completo**: si el comprobante coincide con `price` y no con la diferencia, el pago se registra sin descuento (`amount = price`, `proration = null`) y los días se suman. Así no pierde nada quien paga desde una versión de la app que aún muestra `price`.
- La respuesta (`ApiPayment`) trae `amount` (lo cobrado) y el nuevo `proration` (u omitido/`null`).

### 4.3 `GET /api/v1/suscripciones/estado`

Sin cambios de forma: `last_payment.amount` ya es lo cobrado y `last_payment.proration` aparece si hubo descuento.

## 5. Textos (los mismos en la web y la app)

| Caso | Texto |
|---|---|
| Mejora con descuento | Tienes el plan **{actual}** hasta el {fin}. Te descontamos **S/ {credit}** por los {remaining_days} días que te quedan: pagas **S/ {amount_due}** en vez de S/ {price}. Tu plan **{nuevo}** empieza hoy y vence el **{new_end}**. |
| Mejora sin descuento | Tienes el plan **{actual}** hasta el {fin}. Al pagar pasas a **{nuevo}** desde hoy y los días que te quedan se suman: tu plan quedará vigente hasta el **{new_end}**. |
| Bloqueado (general → institucional) | Tu plan actual te da acceso a todas las instituciones hasta el {fin}. Podrás pasar al plan institucional cuando termine, así no pierdes ese acceso. |
| Bloqueado (otra institución) | Tu plan actual es de otra institución y está vigente hasta el {fin}. Podrás cambiar de institución cuando termine. |

Los dos textos de bloqueo los arma el servidor (`blocked_message` y el mensaje del 409). Los otros dos los arma cada cliente con los campos de §4.1.

## 6. Implementación de referencia

- Regla pura: `src/libs/plan_change.js` (monolito) y su copia `src/libs/plan_change.js` (API). Funciones: `runningEnd`, `planChangeBlock`, `planChangeBlockMessage`, `isImmediateUpgrade`, `prorationFor`, `periodFor`, `MIN_UPGRADE_CHARGE`.
- Pruebas: `test/libs/plan_change.test.js`, `test/libs/suscription_activation.test.js` y `test/libs/payment_validation.test.js` (monolito); `test/subscriptions.test.js` y `test/payment_vouchers.test.js` (API).
