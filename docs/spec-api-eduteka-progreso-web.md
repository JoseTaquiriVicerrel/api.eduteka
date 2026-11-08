# Spec api_eduteka — `GET /progreso` completo para la web

**Repositorio:** `E:\Trabajo\api_eduteka`
**Para:** migrar `/mi-progreso` de la web (hoy `eduteka/src/views/progress/student.hbs`) a Next.js, que lee de la API con el token del puente de sesión (`POST /auth/web-exchange`, ya implementado).
**Depende de:** punto 1 (`req.client`), ya implementado.

---

## 1. Problema

`GET /progreso` tiene casi todo lo que muestra la web, con la misma librería (`src/libs/progress_metrics.js`). Faltan dos cosas, y con ellas la página nueva sería peor que la actual:

1. **Detalle por área.** La web muestra, en cada área:
   - "Ver temas": cada tema con sus respuestas y su porcentaje de aciertos, el distintivo "Tema a reforzar" y "y N temas más con menos preguntas";
   - "N en simulacros": cuántas respuestas del área vienen de simulacros.

   `buildStudentProgress` **ya lo calcula** (`area.topics` con `weak`, `area.topics_total` y `area.sim_answered`), pero `shape()` en `src/modules/progress/progress.service.js` no lo incluye en `by_area`. Solo expone `weak_topics`, que es un top global.
2. **Datos frescos.** La web calcula el progreso **sin cache**: "Hoy" se mueve en cuanto el usuario responde. La API lo guarda 5 minutos y solo invalida el cache cuando las respuestas entran por la API (`progress.cache.js`). Las respuestas de la web todavía entran por el monolito, así que alguien que responde en la web y abre "Mi progreso" vería datos de hasta 5 minutos atrás.

## 2. Cambios

### 2.1 `by_area`: temas y simulacros por área (aditivo, no rompe la app)

En `shape()`, cada elemento de `by_area` suma:

```js
{
    // ...campos actuales sin cambios (area_id, area, slug, answered, accuracy, coverage, is_weakest)
    simulacro_answered: area.sim_answered,
    topics: area.topics.map((topic) => ({
        topic: topic.name,
        answered: topic.keyed,            // el mismo criterio que weak_topics
        accuracy: fraction(topic.accuracy),
        weak: topic.weak,
    })),
    more_topics: Math.max(0, area.topics_total - area.topics.length),
}
```

- Mismo formato que el resto del endpoint: `accuracy` como fracción de 0 a 1 con 3 decimales, `null` = sin datos.
- Antes de fijar los nombres, comprobar en `progress_metrics.js` qué campo de `topic` usa la web para "N respondidas" (`studentProgressController` → `buildStudentView` en `eduteka/src/controllers/progress.controllers.js`). Si es `answered` y no `keyed`, exponer ese.
- `weak_topics` se mantiene tal cual (la app lo usa).
- Si preocupa el tamaño de la respuesta para la app, se puede incluir `topics` solo cuando `req.client === 'web'`. Con el tope de `topTopics` que ya aplica la librería, la diferencia es pequeña, así que la propuesta es incluirlo siempre.

### 2.2 Sin cache para el cliente web

En `progress.controller.js`, `dashboard`:

```js
export const dashboard = asyncHandler(async (req, res) =>
    ok(res, await getProgress(req.user._id, new Date(), { fresh: req.client === 'web' })));
```

y en `getProgress`, con `fresh: true`, saltar `getCachedProgress`. Conviene **guardar igual** el resultado con `cacheProgress`, para que la app aproveche el cálculo reciente.

Por qué solo para la web: es el comportamiento que tiene hoy la página (el monolito no cachea) y mientras sus respuestas no pasen por la API no hay forma de invalidar. Cuando las respuestas de la web entren por la API (`POST /preguntas/:id/responder`), se puede volver al cache con invalidación para todos.

## 3. Pruebas — `test/progress.test.js`

| Caso | Esperado |
|---|---|
| Usuario con respuestas en dos temas de un área | `by_area[i].topics` trae los dos temas con `answered`, `accuracy` y `weak` |
| Área con más temas que el tope | `more_topics` = total − mostrados |
| Respuestas de simulacro en un área | `by_area[i].simulacro_answered` = número de respuestas de simulacro |
| Cliente web: segunda llamada justo después de registrar una respuesta **directamente en la BD** (como hace el monolito) | Refleja la respuesta nueva (no usa el cache) |
| App: la misma situación | Sigue usando el cache de 5 minutos (sin cambio) |
| Suite existente | Sin cambios; `weak_topics` y el resto de campos idénticos |

## 4. Documentación

En `api-eduteka-standalone.md` §6.6, `GET /progreso`: los campos nuevos de `by_area` y la regla "el cliente web no usa el cache".

## 5. Criterios de aceptación

- [ ] `by_area[]` incluye `topics[]` (`topic`, `answered`, `accuracy`, `weak`), `more_topics` y `simulacro_answered`.
- [ ] Con `X-Edk-Client: web` y secreto válido, `/progreso` se calcula en cada llamada.
- [ ] La app no cambia: mismos campos que antes, más los nuevos, y el mismo cache.
- [ ] Pruebas en verde y documentación actualizada.

---

## 6. Pendiente opcional (detectado al migrar `/mi-progreso`, 2026-10-30)

Con los datos reales de una cuenta, la página de Next coincide con la del monolito en todas las cifras y secciones. Quedan tres diferencias menores, todas por datos que la API todavía no expone. Ninguna bloquea publicar la página; se pueden pedir cuando convenga.

1. **Frase del área a reforzar:** la web dice "con 24.2% de aciertos **en 33 preguntas**". `by_area[]` no trae el total de preguntas corregibles del área (`area.total_keyed` en `progress_metrics.js`). Propuesta: añadir `keyed: area.total_keyed` a cada elemento de `by_area`.
2. **Gráfico semanal ("Semanal", últimas 12 semanas):** la API solo entrega `trend` de 30 días. Propuesta: `trend_weeks: [{ week_start, answered, accuracy }]` con 12 elementos, a partir de `progress.series.week` (misma fuente que usa el monolito).
3. **Barras apiladas "Exámenes y prácticas" / "Simulacros":** `trend[].answered` es el total del día. Propuesta: añadir `practice` y `simulacro` (conteos) a cada elemento de `trend` y de `trend_weeks`, desde `progress.series.day`.

Los tres son campos nuevos, así que la app no se rompe. Con (2) y (3) la página de Next puede tener el mismo gráfico que hoy (Diario/Semanal y apilado por fuente).
