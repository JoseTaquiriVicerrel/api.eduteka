# Prueba de punta a punta — simulacros en vivo (API + monolito)

Verifica el criterio 2 del contrato §12: el cliente recibe `sim:close`, `sim:start`, `sim:end` y `sim:results` **en el instante exacto** (tolerancia ≤ 2 s), sin consultar nada. Es manual: necesita los dos procesos y un Redis compartido.

## Requisitos

- Redis local, **el mismo** para los dos procesos (`REDIS_HOST`/`REDIS_PORT` iguales en los dos `.env`).
- Monolito (`E:\Trabajo\eduteka`) y API (`E:\Trabajo\api_eduteka`) apuntando a la **misma base** de Mongo.
- API con `REALTIME_ENABLED=true` (por defecto). En el arranque **no** debe aparecer `Sin Redis: la API no recibira avisos…`.
- El monolito publica la señal en `edk:simulacrum:events` (`src/libs/simulacrum_signal.js`).

## Pasos

1. **Levantar** los dos procesos (`npm start`/`npm run dev` en cada repo).
2. **Crear el simulacro** desde el admin del monolito, gratis, con las fechas relativas a ahora:

   | Campo | Valor |
   |---|---|
   | Cierre de inscripciones | ahora + 3 min |
   | Inicio | ahora + 4 min |
   | Fin | ahora + 9 min |
   | Duración | 3 min |
   | Resultados (`results_public_at`) | ahora + 11 min |

   Anota el `slug`.
3. **Estudiante:** en la API, `POST /api/v1/auth/login` con una cuenta de estudiante y guarda el `access_token` (dura 30 min). Inscríbelo **antes** de las 3 min: `POST /api/v1/simulacros/<slug>/inscribirme` con `{ "fullname": "…" }`.
4. **Escuchar el socket** con el token real:

   ```bash
   node scripts/realtime_watch.mjs http://127.0.0.1:3000 <slug> <access_token>
   ```

   Debe imprimir `conectado`, `en la sala de <slug>` y un `sim:state` con `phase=registration`.
5. **Esperar** sin tocar nada. Resultado esperado:

   | Evento | Cuándo | `phase` | `results_published` | Desfase aceptable |
   |---|---|---|---|---|
   | `sim:close` | +3 min | `waiting` | `false` | ≤ 2 s |
   | `sim:start` | +4 min | `live` | `false` | ≤ 2 s |
   | `sim:end` | +9 min | `finished` | `false` | ≤ 2 s |
   | `sim:results` | +11 min | `finished` | `true` | ≤ 2 s |

   El script imprime el desfase contra la hora programada de cada evento.
6. **Comprobaciones adicionales** (mientras corre):
   - Tras `sim:start`: `POST /simulacros/<slug>/iniciar` → 200; un segundo estudiante no inscrito recibe `REGISTRATION_CLOSED` al inscribirse (después de `sim:close`).
   - Tras `sim:end`: el intento abierto queda calificado y `GET /simulacros/<slug>/resultados` responde `results_published: false`, sin puntaje.
   - Tras `sim:results`: `GET …/resultados` trae `attempt`, `ranking` y `results_published: true`; `GET …/solucionario` responde 200.
   - En la base: el inscrito que nunca abrió el examen tiene `ausent: true`.
7. **Cambiar fechas** desde el admin con el simulacro aún no terminado: debe llegar `sim:updated` con las fechas nuevas.
8. **Degradación:** parar Redis y volver a levantarlo. El socket sigue conectado y, al reconectar la API, llega un `sim:state` nuevo. Con Redis caído, la API sigue aplicando la ventana (`iniciar` → `NOT_STARTED`/`WINDOW_ENDED`), solo faltan los avisos.

## Si algo no llega

| Síntoma | Causa probable |
|---|---|
| `connect_error: UNAUTHENTICATED` | Token vencido (30 min) o de otro entorno |
| `join rechazado: NOT_FOUND` | El estudiante no está inscrito en ese `slug` |
| Conecta y recibe `sim:state` pero ningún hito | Los dos procesos no comparten Redis, o el log de la API dice `Sin Redis…` |
| Funciona local y no en producción | Falta el `location /api/v1/realtime/` de Nginx (`docs/deploy.md` 4.2) |
| Los hitos llegan con segundos de retraso | Mira primero el reloj del servidor del monolito (el planificador usa temporizadores) |

## Resultado

Anota fecha, desfases medidos y entorno en el PR o en `docs/`. Con los cuatro desfases ≤ 2 s queda cumplido el criterio 2 del contrato; los criterios 5–8 se cubren con esta misma corrida y los de la app, con su matriz manual.
