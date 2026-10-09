# Verificación de comprobantes de pago

Cubre la tienda, las suscripciones y la inscripción a simulacros de pago. Nunca rechaza: ante cualquier duda el pago queda **pendiente** con el motivo (solo lo ve el administrador en su panel) y una persona decide.

## Cuándo se aprueba solo

Todas las reglas deben cumplirse (`src/modules/payments/voucher.verify.js`):

| # | Regla | Motivo si falla |
|---|---|---|
| 1 | La IA lee el número de operación y no figura en otro pago, pedido o inscripción | `No se pudo leer el número de operación` / `El comprobante ya fue usado…` |
| 2 | El monto coincide con el esperado (margen de S/ 1) | `Monto no coincide: esperado X vs encontrado Y` |
| 3 | La fecha es de hoy o de los últimos `PAYMENT_VOUCHER_MAX_AGE_DAYS` días (hora de Lima) | `El comprobante es del…` |
| 4 | **El destinatario es el titular o el número de Yape/Plin configurado** | `El destinatario del comprobante (…) no coincide con el titular de pago` / `No se pudo leer el destinatario del pago` |
| 5 | **El importe no supera `PAYMENT_AUTO_APPROVE_MAX_AMOUNT`** | `Monto alto (S/ X): requiere revisión manual…` |

Las reglas 4 y 5 son nuevas. Se evalúan al final, así que si falla algo anterior, ese es el motivo que se registra.

### Destinatario (regla 4)

Sin esta regla, un comprobante **real** pagado a otra persona (con monto y fecha correctos y un número de operación nuevo) activaba un plan o un pedido.

- Se compara el nombre que lee la IA (`receptor`) con `PAYMENT_YAPE_HOLDER` / `PAYMENT_PLIN_HOLDER`, o los dígitos visibles con el final de `PAYMENT_*_NUMBER`.
- Tolera tildes, mayúsculas, otro orden y abreviaturas, porque Yape/Plin suelen mostrar el nombre recortado (`Jose M. Taquiri V.`). Exige al menos una palabra completa de 3 o más letras en común: solo iniciales no bastan.
- Un número con 3 o más dígitos visibles (`*** *** 077`) también sirve.
- Sin titular ni número configurados no hay contra qué comparar y la regla no se aplica. **Configura al menos `PAYMENT_YAPE_HOLDER` o `PAYMENT_YAPE_NUMBER` en producción.**
- Limitación: dos personas con nombre y apellido iguales o muy parecidos al titular pasarían la regla. Por eso conviene combinarla con el límite de monto.
- El nombre leído sale de una imagen que sube el usuario: antes de guardarlo como motivo se limpia de marcado y caracteres de control para que no llegue como HTML al panel del administrador.

### Monto alto (regla 5)

Una imagen editada con el titular y el monto correctos es indistinguible de una real. Para acotar el daño, ningún pago por encima del límite se aprueba solo.

- `PAYMENT_AUTO_APPROVE_MAX_AMOUNT` en soles; `0` (valor por defecto) = sin límite.
- Elige el valor según tus precios: debe quedar por encima de tu plan o producto más caro que quieras aprobar sin revisión, y por debajo de lo que no.

## Variables

```env
PAYMENT_YAPE_HOLDER=Nombre del titular       # tal como lo muestra Yape
PAYMENT_YAPE_NUMBER=931 988 077
PAYMENT_REQUIRE_RECEIVER_MATCH=true           # por defecto true
PAYMENT_AUTO_APPROVE_MAX_AMOUNT=0             # soles; 0 = sin límite
```

## Privacidad: qué se envía a Google

La lectura automática usa la API de Gemini (Google). Para el responsable del tratamiento y la política de privacidad:

- **Qué se envía:** la imagen del comprobante (captura de Yape/Plin o transferencia). Puede mostrar el nombre del pagador, el destinatario, el monto, la fecha y el número de operación.
- **Qué NO se envía:** el correo, el identificador ni ningún otro dato de la cuenta; solo la imagen y la instrucción de lectura.
- **Metadatos:** antes de enviarla se eliminan de la copia los metadatos opcionales (EXIF con GPS y modelo del teléfono, IPTC, comentarios, texto incrustado en PNG). La imagen no se recodifica. El archivo que se guarda para el administrador es el original.
- **Qué se guarda aquí:** la lectura (`ai_analysis`: monto, fecha, receptor, número de operación) y la imagen original, para que el administrador pueda revisarla. No se registra el contenido de la imagen en los logs.
- **Cómo desactivarlo:** `PAYMENT_AI_PROVIDER=none` (o no definir `GEMINI_API_KEY`). Todos los pagos pasan a revisión manual y no sale ninguna imagen.
- **Pendiente de tu lado (no es código):**
  1. Declarar este envío en la política de privacidad, indicando a Google como encargado/proveedor y la finalidad (verificar el pago).
  2. Revisar las condiciones de tratamiento de datos de la cuenta de Google AI usada y si está en el plan que excluye el uso de los datos para entrenamiento. Confírmalo en los términos vigentes de Google: no lo asumas.
  3. Valorar si hace falta informar al usuario en la pantalla de pago.
