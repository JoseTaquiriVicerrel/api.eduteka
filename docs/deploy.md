# Despliegue en producción

Esquema: **Cloudflare → Nginx → Node (API)**, en un VPS, con MongoDB y Redis. Los archivos de ejemplo están en `deploy/`.

```
App ──HTTPS──▶ Cloudflare ──HTTPS──▶ Nginx (443) ──HTTP local──▶ Node (127.0.0.1:3000)
                 │                      │                           │
        CF-Connecting-IP        real_ip + X-Forwarded-For      TRUST_PROXY=1 → req.ip
```

## 1. Requisitos

- **Node 24 LTS** (`.nvmrc`; mínimo `>=22`). Instalar con NodeSource, `nvm` o `fnm`, no con el paquete de la distribución.
- MongoDB (la misma base del monolito, con un **usuario propio de la API** y permisos mínimos) y Redis con contraseña.
- Usuario del sistema sin login: `sudo useradd --system --home /opt/eduteka eduteka`.

## 2. Instalar y actualizar

```bash
cd /opt/eduteka/api
git pull
npm ci --omit=dev          # usa package-lock.json exacto y deja fuera las herramientas de desarrollo
sudo systemctl restart eduteka-api
curl -s https://api.eduteka.pe/api/v1/health      # debe responder status: ok, mongo: up, redis: up
```

## 3. Variables de producción (`.env`, permisos 600, dueño `eduteka`)

```env
NODE_ENV=production
PORT=3000
LISTEN_HOST=127.0.0.1            # solo Nginx puede llegar a Node
TRUST_PROXY=1                    # un salto: Nginx (ver nginx-api.conf)
API_CORS_ORIGINS=                # vacía: solo la usa la app móvil
PUBLIC_API_URL=https://api.eduteka.pe
LOG_LEVEL=info

JWT_SECRET=<48+ caracteres aleatorios, DISTINTO de JWT_PRIVATE_KEY del monolito>
BCRYPT_ROUNDS=12
MONGODB_URI=<usuario propio de la API>
REDIS_HOST=… REDIS_PORT=… REDIS_PASSWORD=…

PAYMENT_YAPE_HOLDER=<titular tal como lo muestra Yape>
PAYMENT_YAPE_NUMBER=…
PAYMENT_REQUIRE_RECEIVER_MATCH=true
PAYMENT_AUTO_APPROVE_MAX_AMOUNT=<soles; 0 = sin límite>
```

Generar un secreto: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.
La lista completa y comentada está en `.env.example`.

## 4. Nginx y Cloudflare

1. `sudo deploy/update-cloudflare-ips.sh` (una vez; luego semanal, p. ej. `/etc/cron.weekly/`).
2. Copiar `deploy/nginx-api.conf` a `/etc/nginx/conf.d/api.eduteka.pe.conf`, poner el certificado y `sudo nginx -t && sudo systemctl reload nginx`.
3. Cloudflare: SSL/TLS **Full (strict)**, *Always Use HTTPS*, HSTS. La API responde `Cache-Control: no-store` salvo `/api/v1/media/*`.
4. Firewall: abrir solo 22, 80 y 443 (`ufw allow 22,80,443/tcp`; el 3000 queda cerrado). Mejor aún: 80/443 solo para los rangos de Cloudflare.

Por qué `TRUST_PROXY=1` y no `2`: Nginx ya resuelve la IP real con `real_ip` y **sobrescribe** `X-Forwarded-For` con ella, así que a Node solo le llega un proxy delante. Si prefieres no usar `real_ip` y dejar `$proxy_add_x_forwarded_for` por defecto, serían dos saltos (`TRUST_PROXY=2`), pero entonces el firewall debe garantizar que nadie llegue al servidor sin pasar por Cloudflare.

Comprobación: `RateLimit-Remaining` debe **bajar** aunque se cambie la cabecera:

```bash
for i in 1 2 3; do curl -si -H "X-Forwarded-For: 9.9.9.$i" https://api.eduteka.pe/api/v1/config | grep -i ratelimit-remaining; done
```

## 5. Servicio (systemd)

`deploy/eduteka-api.service` → `/etc/systemd/system/`. Reinicia solo si se cae, limita los reinicios fallidos, apaga ordenadamente con SIGTERM y deja el disco en solo lectura salvo `ReadWritePaths` (ajústalo a `STORAGE_DIR`, `PAY_CAPTURE_DIR` y `FILES_ROOT_DIR/storage/payment`).

```bash
sudo systemctl enable --now eduteka-api
journalctl -u eduteka-api -f
```

Un solo proceso es suficiente: el rate limit y los bloqueos de login están en Redis. **Redis debe estar siempre arriba**: si cae, `/health` responde 503 y cada proceso cuenta los límites por su cuenta.

## 6. Respaldos

`deploy/backup.sh` guarda Mongo, los comprobantes de pago y los avatares (no la caché de fórmulas, que se regenera).

```cron
30 3 * * *  REMOTE="rclone:b2:eduteka-backups"  /opt/eduteka/api/deploy/backup.sh >> /var/log/eduteka-backup.log 2>&1
```

Sin `REMOTE` el respaldo queda en el mismo disco: no protege de un fallo del servidor. **Prueba una restauración** al menos una vez (`mongorestore --archive=… --gzip`).

## 7. Integración continua

`.github/workflows/ci.yml` corre en cada push y PR: `npm run lint`, `npm test` y `npm audit --omit=dev --audit-level=critical`. Las vulnerabilidades *altas* se revisan a mano porque algunas piden saltos de versión mayores.

## 8. Lista de comprobación antes de abrir al público

- [ ] `/health` → `ok` (mongo y redis arriba).
- [ ] `JWT_SECRET` ≠ `JWT_PRIVATE_KEY`, y claves de Cloudinary/otros que se hayan filtrado, rotadas.
- [ ] `NODE_ENV=production`, `TRUST_PROXY=1`, `LISTEN_HOST=127.0.0.1`, puerto 3000 cerrado.
- [ ] Prueba de `X-Forwarded-For` falso (sección 4).
- [ ] `PAYMENT_YAPE_HOLDER` o `PAYMENT_YAPE_NUMBER` definido; prueba con un comprobante real.
- [ ] Respaldo ejecutado y restauración probada.
- [ ] `npm audit --omit=dev` revisado.
