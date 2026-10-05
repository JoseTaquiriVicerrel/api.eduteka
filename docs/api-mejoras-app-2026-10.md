# Mejoras de la app que requieren cambios en el API

Documento para quien implementa **api_eduteka**. Sale de la revisión de la app del 2026-10-04 (secciones Inicio, Estudiar, Evaluar y Simulacros). Cada punto se contrastó con el código del API y con datos reales de la base local (`localhost:4000`); las cifras citadas son de esa medición.

Convenciones: rutas bajo `/api/v1`, JSON `snake_case`, envelope `{data, meta}` / `{error:{code,message,details}}`. Todo cambio **debe ser compatible hacia atrás** (campos nuevos opcionales): la app instalada hoy no puede romperse.

---

## 1. Resumen: qué toca al API y qué no

| # | Pedido | Dónde | Prioridad |
|---|---|---|---|
| 1 | Estudiar → área: la cantidad de la lista no coincide con la de dentro del área | **API** (§2) + app | Alta (bug) |
| 2 | Simulacros → inscripción sin DNI | **API** (§3) + app | Alta |
| 3 | Simulacros → nombre completo autocompletado con `fullname` | **API** (§3.2, opcional) + app | Media |
| 4 | Simulacros → detalle: «Áreas» debe mostrar cantidad de **carreras**, no de preguntas | **API** (§4) + app | Alta (bug) |
| 5 | Evaluar → navegación por número agrupada por áreas | **API** (§5.1, opcional) + app | Media |
| 6 | Evaluar → quitar áreas del listado y del detalle de exámenes | App (§5.2; el API puede aligerar el payload) | Baja |
| 7 | Simulacros → fórmulas LaTeX se ven como texto en la tarjeta de pregunta | App en su mayor parte; verificación del API en §6 | Alta (bug) |
| 8 | Inicio → avance semanal por área y meta de preguntas por semana | **API nuevo** (§7.1) | Media |
| 9 | Inicio → temas a reforzar según el simulacro | **API** (§7.2) | Media |
| 10 | Inicio → próximo examen según la institución y la modalidad del postulante | **API nuevo, futuro** (§7.3) | Futura |
| — | Evaluar → listado de simulacros sin etiquetas de áreas; card de pregunta con el área junto al número; opciones con borde sólido | Solo app (§8) | — |

---

## 2. Estudiar → área: conteos que no coinciden (bug)

### Qué pasa
La lista de áreas usa `GET /areas` (campo `count`). Al entrar al área, la app suma los `count` de `GET /practicas-area/temas?area=` para decir cuántas preguntas hay. No coinciden porque **cuentan cosas distintas**:

- `listAreas` (`catalog.service.js`) cuenta todas las preguntas practicables del área (`practicableFilter`).
- `getTopics` (`question.service.js`) cuenta solo las practicables **que tienen `topic` no vacío** (`topic: { $exists: true, $nin: [null, ''] }`).

La mayoría del banco no tiene tema. Medición (12 áreas con más preguntas):

| Área | `/areas` count | Suma de `/temas` | Sin tema |
|---|---:|---:|---:|
| Razonamiento Verbal | 1030 | 848 | 182 |
| Razonamiento Matemático | 832 | 192 | 640 |
| Química | 719 | 86 | 633 |
| Biología | 668 | 58 | 610 |
| Física | 629 | 62 | 567 |
| Aritmética | 422 | 55 | 367 |
| Álgebra | 385 | 43 | 342 |

Al generar una práctica **sin** tema (`GET /practicas-area/preguntas?area=&count=`) el servidor sí sirve las 719 de Química, así que el número correcto de «disponibles» sin tema es el de `/areas`, no la suma de temas.

### Cambio propuesto (compatible)
Mantener `data` como está (lista de `{topic, count}`) y **añadir `meta`** en `GET /practicas-area/temas`:

```json
{
  "data": [ { "topic": "Cinemática", "count": 12 } ],
  "meta": { "total_questions": 719, "with_topic": 86, "without_topic": 633 }
}
```

- `total_questions` = mismo valor que `count` de `/areas` para esa área y los mismos filtros (`institution`, `with_resolution`). Calcularlo con el mismo `practicableFilter` para que **no puedan divergir**.
- `with_topic` = suma de `data[].count`; `without_topic` = diferencia.
- Alternativa descartada: devolver un tema falso «Sin tema» dentro de `data`; rompería a la app instalada, que lo mostraría como un tema más.

La app pasa a mostrar `meta.total_questions` cuando no hay tema elegido y el `count` del tema cuando sí lo hay (§8).

### Pruebas
- Para cada área, `meta.total_questions` es igual al `count` de `GET /areas` con los mismos filtros.
- `with_topic + without_topic == total_questions`.
- Con `institution=` y `with_resolution=true` los tres valores respetan el filtro.

---

## 3. Simulacros → inscripción

### 3.1 No pedir DNI (implementado)
El DNI es un dato sensible (exige permisos y tratamiento adicionales) y la app ya no lo pide. Antes `POST /simulacros/:slug/inscribirme` lo exigía (`^[A-Za-z0-9]{8,12}$`) y lo guardaba en `UserSimulacrum.dni`.

Estado actual:
- `dni` es **opcional y obsoleto** en `EnrollBody`: se tolera solo para que las apps antiguas, que aún lo envían, no reciban 422 por el `additionalProperties: false`. Se descarta **sin validarlo ni guardarlo**.
- Las inscripciones nuevas no tienen `dni`. Las antiguas conservan el suyo; no hay migración. Si se quiere borrar los existentes, es una decisión aparte (`$unset` sobre `usersimulacrums.dni`).
- Pendiente fuera de este repo: el panel del monolito proyecta `dni: '$dni'` en los listados de participantes (`simulacrum.admin.controllers.js`, `simulacrum.controllers.js`); con inscripciones nuevas saldrá vacío. Confirmar que no sea clave para exportar o conciliar ranking.
- Una vez que ninguna versión de la app envíe `dni`, se puede quitar el campo del esquema.

### 3.2 Nombre completo autocompletado (implementado)
La app ya recibe `fullname` en `GET /perfil` y `GET /auth/me`, y el servicio ya guarda el nombre usado en la inscripción en el usuario (`UserModel.updateOne(..., { $set: { fullname } })`), así que el prellenado puede hacerse solo en la app.

Implementado: `fullname` es **opcional en el body** cuando `user.fullname` ya existe, y usarlo como valor por defecto:

```js
const fullname = body.fullname ?? user.fullname;
if (!fullname) throw ApiError.validation([{ field: 'fullname', message: 'Escribe tu nombre completo.' }]);
```

Así una app que no envíe el campo no falla si el perfil ya lo tiene. Mantener la validación de longitud (3–150) para ambos orígenes.

### Pruebas
- Inscripción sin `dni` → 201 y `dni` ausente en el documento.
- Inscripción con `dni` (app antigua) → 201 y `dni` **no** se guarda.
- Con `user.fullname` guardado y sin `fullname` en el body → 201; sin ninguno de los dos → 422 `VALIDATION_ERROR` en `fullname`.

---

## 4. Simulacros → detalle: «Áreas» mostraba preguntas en vez de carreras (bug)

`GET /simulacros/:slug` devuelve `areas[]` con `key`, `title`, `description`, `careers[]` y `questions_count`. Las «áreas» son **áreas profesionales** (p. ej. Ciencias de la Salud) y lo que corresponde mostrar debajo es cuántas **carreras** tiene cada una; la app mostraba `questions_count`. Con datos reales:

| Simulacro | Área | `careers` | `questions_count` |
|---|---|---:|---:|
| UNICA 2025 N1 | Ciencias de la salud | 8 | 102 |
| UNICA 2025 N1 | Ciencias Sociales y Humanidades | 16 | 102 |
| UNSM 2026-II N1 | Ingenierías y Tecnología | 3 | **0** |
| BECA 18 2023 | UNICO | 0 | 68 |

Dos problemas del API, además del de la app:

1. **`questions_count` vale 0** en simulacros basados en prospecto (`prospect`): el `LIGHT_PIPELINE` cuenta `areas.<k>.questions`, pero esos simulacros no guardan las preguntas en el snapshot (solo referencias) y las resuelve `questionSource` desde el prospecto. El número es engañoso.
2. No hay un campo explícito para la cantidad de carreras; la app tiene que contar `careers.length`.

Cambio propuesto (compatible):

```json
"areas": [
  { "key": "A", "title": "Ciencias de la salud", "description": null,
    "careers": ["Enfermería", "..."], "careers_count": 8, "questions_count": 102 }
],
"questions_total": 102
```

- Añadir `careers_count` (= `careers.length`).
- Corregir `questions_count` en prospectos: resolverlo con la misma lógica que sirve el intento (`questionSource`/`loadQuestionSet`) o, si es costoso en el detalle, devolver `null` en vez de `0`.
- Añadir `questions_total` al nivel del simulacro: el número de preguntas que realmente rinde el postulante (no depende del área en los de banco general).
- Cuando `ask_area` es `false` (una sola área «UNICO», p. ej. BECA 18) la app **no** debe pintar el bloque «Áreas»; el API ya manda `ask_area`/`ask_career`, no hace falta nada más.

### Pruebas
- `careers_count == careers.length` para todas las áreas.
- En un simulacro con `prospect`, `questions_count` no es 0 ni engañoso (valor real o `null`).
- `questions_total` coincide con la cantidad de preguntas de `POST /simulacros/:slug/iniciar`.

---

## 5. Evaluar

### 5.1 Navegación por número agrupada por áreas (opcional)
`GET /examenes/:slug` ya manda `area` (texto) en cada pregunta y las preguntas llegan ordenadas, así que **la app puede agrupar sola**. Con datos reales, el examen UNSCH 2026 trae bloques contiguos (p. ej. `RAZONAMIENTO VERBAL 1–6`, `LENGUAJE 7–12`, …). Dos fragilidades:

- El texto del área no está normalizado: conviven `RAZONAMIENTO VERBAL` y `Anatomía y Fisiología`.
- La app tiene que recorrer todas las preguntas para armar los grupos.

Cambio propuesto (compatible, opcional): añadir al detalle un resumen precalculado.

```json
"sections": [
  { "area": "Razonamiento Verbal", "area_id": "area-rv", "from": 1, "to": 6, "count": 6 },
  { "area": "Lenguaje",            "area_id": "area-leng", "from": 7, "to": 12, "count": 6 }
]
```

- `area_id`/nombre canónico salen de la colección `areas` (resolver por texto sin distinguir mayúsculas); si no se puede resolver, conservar el texto original y `area_id: null`.
- Los rangos son de `n` (el número de la pregunta en el cuadernillo servido). Con la vista previa (`access.preview`), calcularlos sobre lo servido.
- Aplicarlo también al intento y al solucionario de simulacros (`items[]` ya trae `area`).

### 5.2 Quitar las áreas del listado y del detalle (principalmente app)
Las «áreas» que se ven en la lista y arriba del detalle de un examen son `subjects[]`. Es un cambio de pantalla; el API **no necesita cambiar**. Si se quiere aligerar la respuesta:

- `GET /examenes` (listado): `subjects` podría omitirse de `serializeExamSummary`, **pero** lo usan el filtro por `area` (consulta en servidor, no depende de la respuesta) y posiblemente otras pantallas. No quitarlo sin confirmar; mejor dejarlo y que la app no lo pinte.
- `areas` del detalle son los **cuadernillos** (A, B, I…), distintos de las materias: no confundir ni eliminar.

---

## 6. Simulacros → fórmulas LaTeX como texto (verificación del API)

Lo medido en el API (cuenta de prueba, `GET /simulacros/:slug/solucionario`):

| Simulacro | Sin `?math=svg` | Con `?math=svg` |
|

**Resultado de la verificación (implementado)**
- `iniciar?math=svg` convierte las fórmulas (banco general y prospecto); `reintentar` **no devuelve HTML** (solo `attempt_id` y `attempt_number`): las fórmulas del nuevo intento salen en el `iniciar` siguiente. Ambos casos tienen prueba en `test/math_coverage.test.js`.
- `scripts/warm_math_cache.js` ahora lee, para los simulacros, lo que el intento **sirve** (`loadQuestionSet`) además del snapshot, así que cubre los de prospecto. Nuevo `--slug=<simulacro>` para precalentar uno solo (p. ej. al publicarlo). Este repo no publica simulacros: el paso de publicación vive en el monolito y debería lanzar ese script.

---|---|---|
| BECA 18 2023 | 56 fórmulas en LaTeX | 0 en LaTeX, 56 `<img class="math">` |
| UNSM 2026-II N1 | 174 | 0 en LaTeX, 174 `<img>` |

Es decir: el API convierte correctamente con `?math=svg` (y la app lo añade en las rutas de simulacros). La causa más probable está en la app (la tarjeta de pregunta del intento). Para descartarlo del lado del API:

- Confirmar que `POST /simulacros/:slug/iniciar?math=svg` (y `reintentar`) pasa por `createMathResponse`: está montado en `/simulacros`, pero verificar con una prueba que el cuerpo de `created(...)` se transforma (la transformación se hace en `res.json`).
- **Presupuesto de 5 s**: las fórmulas que no alcanzan a convertirse se devuelven en LaTeX y «se completan en las siguientes peticiones». En un simulacro nuevo, el primer postulante puede ver LaTeX crudo. `scripts/warm_math_cache.js` recorre `simulacra` solo por el snapshot (`areas.*.questions`, `general_items`); en simulacros de **prospecto** el snapshot son referencias, así que sus fórmulas solo se precalientan por la fuente `questions` (preguntas practicables), no por las que realmente sirve el intento. Recomendado: al publicar o verificar un simulacro, precalentar sus fórmulas resolviendo las preguntas con `loadQuestionSet`.

---

## 7. Inicio

### 7.1 Avance semanal por área y meta de preguntas por semana (nuevo)

Estado actual: `GET /progreso` ya devuelve `week.current`/`week.previous` (totales globales), `by_area[]` (acumulado de siempre, con `answered`, `accuracy` y `coverage`) y `week_dots`. **No hay desglose semanal por área ni metas.** El cálculo vive en `libs/progress_metrics.js` (`windowTotals`, `weekWindow`) y puede agruparse por área con el mapa pregunta→área que `progress.service.js` ya carga (`fetchQuestionMap`).

**a) Desglose semanal por área** — añadir a `GET /progreso`:

```json
"week_by_area": [
  { "area_id": "area-quim", "area": "Química", "answered": 24, "accuracy": 0.708, "goal": 30, "goal_pct": 0.8 }
]
```

- Misma ventana que `week.current` (semana ISO en hora de Lima).
- Solo áreas con actividad esa semana, o con meta aunque no tengan actividad (ver b).
- La caché de 5 min (`progress.cache.js`) sigue valiendo; invalidar al guardar metas.

**b) Metas semanales** — cuántas preguntas de práctica quiere hacer el estudiante por semana (globales o por área):

```
GET /perfil/metas          → { "weekly_questions": 100, "by_area": { "area-quim": 30 } }
PUT /perfil/metas          body: { "weekly_questions": 100, "by_area": { "area-quim": 30 } }
```

- Requiere capacidad `TRACK_PROGRESS` (estudiantes); docentes `403 CAPABILITY_REQUIRED`.
- Validación: enteros 0–1000; claves de `by_area` deben existir en `areas`; `0` o ausencia = sin meta.
- Persistencia: campo `goals` en el usuario (`{ weekly_questions, by_area }`) o colección propia si se quiere historial. Sin meta, el API devuelve `goal: null` y la app no pinta barra.
- «Preguntas de práctica» = respuestas registradas desde prácticas/preguntas (no simulacros); definir qué cuenta (`UserAnswer` con origen práctica) y documentarlo.

### 7.2 Temas a reforzar según el simulacro

Hoy `weak_topics[]` sale de **todas** las respuestas (mínimo 10 por tema, `WEAK_TOPIC_MIN_ANSWERED`). Pedido: que dependan del simulacro. Los intentos guardan `answers` por pregunta, y cada pregunta tiene `area`/`topic`, así que se puede calcular.

Propuesta:

```
GET /progreso?weak_from=simulacro          (por defecto: all, comportamiento actual)
GET /progreso/refuerzo?simulacro=<slug>    (alternativa: endpoint propio)
```

```json
"weak_topics_simulacro": {
  "simulacro": { "slug": "simulacro-unica-2025-n1", "title": "…", "attempt_number": 1, "date": "…" },
  "topics": [ { "topic": "…", "area": "…", "area_id": "…", "accuracy": 0.25, "answered": 6, "wrong": 4 } ]
}
```

- Base: el último intento calificado (o el indicado) del usuario; temas con al menos `N` preguntas en ese intento (el umbral de 10 de hoy es demasiado alto para un solo simulacro; sugerir 3, configurable).
- Ordenar por menor acierto, luego por más errores; límite 10.
- Cada tema debe poder abrirse como práctica (`GET /practicas-area/preguntas?area=&topic=`), así que incluir `area_id` y el `topic` tal cual.
- Sin simulacros calificados: lista vacía y la app cae a `weak_topics` global.

### 7.3 Próximo examen según institución y modalidad (futuro; solo análisis)

Lo que hay hoy: el usuario guarda su institución objetivo (`university`, en `GET/PATCH /perfil`); los exámenes tienen `modality` (ORDINARIO, EXONERADOS, EXTRAORDINARIO, CEPRE, CPU, BECA 18, …) y `date`, pero **son exámenes ya rendidos** (0 de 50 con fecha futura): no existe un calendario de admisión. Tampoco hay en el perfil la modalidad a la que postula el estudiante.

Faltan, por tanto, dos piezas de datos:

1. **Modalidad del postulante**: campo `target_modality` en el usuario (`PATCH /perfil`), tomado del conjunto de modalidades de la institución elegida.
2. **Calendario de admisión** (nueva colección, administrada desde el panel):
   ```
   AdmissionEvent { _id, institution_id, modality, title, exam_date, registration_start, registration_end, source_url, state }
   ```

Endpoints propuestos cuando se implemente:

```
GET /instituciones/:id/modalidades                  → lista de modalidades con calendario
GET /calendario?institution=<id>&modality=<m>        → próximos eventos (exam_date >= hoy), ordenados
GET /progreso → "next_exam": { institution, modality, title, exam_date, days_left } | null
```

Dependencia con §7.2: «temas a reforzar según el simulacro» se vuelve más útil si el simulacro está ligado a la misma institución/modalidad (el simulacro ya tiene `institution`). No implementar hasta definir el origen de los datos del calendario.

---

## 8. Cambios que son solo de la app (para tener el cuadro completo)

No requieren API, salvo lo indicado:

- **Estudiar → área**: mostrar `meta.total_questions` (§2) y dejar de sumar los temas.
- **Evaluar → listado de exámenes**: no pintar `subjects`.
- **Evaluar → detalle de examen**: quitar el bloque inicial de áreas/materias.
- **Tarjeta de pregunta**: el área va junto al número («Pregunta 7 · Lenguaje»); `area` ya viene en cada pregunta.
- **Opciones**: borde sólido.
- **Navegación por número**: agrupar por área (con `sections` del §5.1 si se implementa; si no, agrupando por `area` consecutiva).
- **Simulacros → listado**: quitar las etiquetas de áreas (el listado del API ya no las trae).
- **Simulacros → inscripción**: no mostrar el campo DNI; prellenar «Nombres completos» con `fullname` del perfil si existe.
- **Simulacros → detalle**: mostrar «N carreras» (`careers_count`, o `careers.length` mientras tanto) y ocultar el bloque cuando `ask_area` es `false`.
- **Simulacros → tarjeta de pregunta con LaTeX**: revisar el render del intento (fórmulas `<img class="math">` del `?math=svg`); ver §6.

---

## 9. Orden sugerido de implementación

1. §2 (conteos de Estudiar): cambio pequeño, quita un bug visible.
2. §3.1 y §4 (DNI y carreras del detalle): cambios de esquema/serialización, sin migración.
3. §6 (verificación y precalentamiento de fórmulas de simulacros).
4. §5.1 y §3.2 (opcionales de comodidad).
5. §7.1 y §7.2 (metas y refuerzo por simulacro): necesitan diseño de producto cerrado antes (qué cuenta como «pregunta de práctica», umbrales).
6. §7.3 (calendario de admisión): cuando exista la fuente de datos.

Todos los campos nuevos son opcionales y las rutas existentes no cambian de forma, por lo que se pueden desplegar antes de que la app los use.
