# Plan para api_eduteka: datos de pago (Yape / Plin) en `GET /config`

## Por qué

La web escribe a mano el número de Yape/Plin en cuatro plantillas (carrito, ficha e inscripción de simulacro, suscripciones)
y usa un QR estático (`/images/qr_yape.jpeg`). La API no entrega nada de esto, así que la app solo podía decir "paga y sube el
comprobante". Pagar a un número desactualizado es dinero perdido, y con el número fijo en la app cambiarlo exigiría publicar
una versión. Se propone una **única fuente**: la configuración de la API, que la app y (después) la web leen.

## Contrato

`GET /config` (público, ya existe) añade `payment_methods`:

```json
{
  "data": {
    "min_version": "1.0.0",
    "latest_version": "1.0.0",
    "payments_enabled": true,
    "maintenance": false,
    "web_url": "https://eduteka.pe",
    "support_whatsapp": null,
    "payment_methods": [
      {
        "id": "yape",
        "label": "Yape",
        "number": "931 988 077",
        "holder": "Nombre del titular",
        "qr_url": "https://eduteka.pe/images/qr_yape.jpeg"
      },
      { "id": "plin", "label": "Plin", "number": "931 988 077", "holder": "Nombre del titular", "qr_url": null }
    ]
  }
}
```

| Campo | Reglas |
|---|---|
| `id` | `yape` o `plin`: el mismo valor que acepta `payment_method` en `/tienda/checkout` y `/suscripciones/:slug/suscribirme`. |
| `label` | Texto para mostrar. |
| `number` | Como se muestra al usuario (con espacios). La app copia solo los dígitos. **Obligatorio**: un método sin número no se envía. |
| `holder` | Titular de la cuenta. Recomendado: quien paga lo comprueba en su app antes de confirmar. `null` si no se quiere mostrar. |
| `qr_url` | URL **absoluta** de la imagen del QR de Yape/Plin del titular, o `null`. |

- Se envía solo lo que está configurado. Sin ningún método, `payment_methods` es `[]` (la app conserva lo último que recibió).
- **No hay transferencia**: no tiene cuenta que mostrar y la app ya no la ofrece. El esquema de `Order` puede seguir aceptándola
  para pedidos antiguos de la web.
- `payments_enabled=false` no oculta los métodos: la app deshabilita pagar, pero muestra el catálogo y los pedidos.

## Configuración (variables de entorno)

```
PAYMENT_YAPE_NUMBER=931 988 077
PAYMENT_YAPE_HOLDER=...
PAYMENT_YAPE_QR_URL=https://eduteka.pe/images/qr_yape.jpeg
PAYMENT_PLIN_NUMBER=931 988 077
PAYMENT_PLIN_HOLDER=...
PAYMENT_PLIN_QR_URL=
```

Se leen en `src/config/settings.js` (`settings.app.paymentMethods`) y `getConfig` (`modules/meta/meta.controller.js`) arma el arreglo,
descartando los que no tengan número. Las URL de QR deben ser `https` (o `http` solo fuera de producción).

## Pruebas (en `test/meta.test.js`)

1. Con las variables definidas, `/config` devuelve `payment_methods` con `id`, `label`, `number`, `holder`, `qr_url`.
2. Sin variables, devuelve `[]` y el resto de `/config` no cambia.
3. Un método sin número no sale; la transferencia no sale aunque se configure.
4. Sigue siendo público y responde incluso en mantenimiento.

## Documento y web

- Añadir `payment_methods` a la fila `GET /config` de `api-eduteka-standalone.md` (§ catálogo/config) y a la sección 6.7.
- Cuando se quiera, las plantillas de la web (`store/cart.hbs`, `simulacrums/*.hbs`, `suscriptions/*.hbs`) pueden leer el mismo
  valor de `settings` en vez del número escrito a mano.

## Lado app (ya hecho)

- `feature/payment`: `PaymentInfoRepository` lee `payment_methods`, lo guarda en DataStore y, sin nada guardado ni respuesta,
  usa los valores de arranque (`PaymentDefaults`, los mismos de la web). Refresca como mucho cada 5 minutos y un fallo no borra
  lo guardado.
- `PaymentHowTo`: "Envía S/ X por Yape al número …" con botón Copiar, titular y QR; se muestra en la tienda, los planes y la
  inscripción a simulacros de pago.
- Transferencia quitada del selector de pago.
