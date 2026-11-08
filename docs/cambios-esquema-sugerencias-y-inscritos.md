# Cambios de esquema — sugerencias de práctica e inscritos del simulacro

La API comparte la base con el monolito y **no crea índices** (`autoIndex: false`), así que todo lo de abajo se aplica en el monolito (o con un script de mantenimiento). Las declaraciones `schema.index(...)` ya están en `src/schemas/*` de la API como espejo/documentación; no se crean solas.

Las dos funciones nuevas **funcionan sin ningún cambio de esquema**: los índices solo evitan recorrer colecciones grandes.

---

## 1. Sugerencias al terminar una práctica

`POST /practicas/:slug/finalizar` y `POST /practicas-area/finalizar` devuelven ahora `suggestions: { continue: [...], explore: [...] }` (máx. 3 cada grupo). Es aditivo; el cierre no depende de él (si falla el cálculo, vuelve vacío).

| Grupo | `reason` | Origen | Qué abre el cliente |
|---|---|---|---|
| `continue` | `next_in_series` | Misma serie (`suggestion.key`), `series` mayor, aún no resuelta | `GET /practicas/:slug` |
| `continue` | `same_area` (lista) | Otras listas públicas del mismo área | `GET /practicas/:slug` |
| `continue` | `same_topic` / `same_area` (tanda) | Otra tanda del mismo tema (o del área) | `GET /practicas-area/preguntas?area=&topic=` |
| `explore` | `weak_topic` | Tema del área con < 60 % de acierto y ≥ 10 respuestas (de `practiceattempts`); incluye `accuracy` | `GET /practicas-area/preguntas?area=&topic=` |
| `explore` | `new_topic` / `other_topic` | Temas del área nunca practicados / los menos recientes | idem |
| `explore` | `other_area` / `same_area` | Listas públicas más guardadas (`favorites`) de otras áreas / del área | `GET /practicas/:slug` |

Nunca se sugiere una lista privada, la que acaba de terminar ni una que el usuario ya resolvió (`practiceattempts` con `source: 'lista'`).

### Índices recomendados (monolito)

```js
// userquestionslists
db.userquestionslists.createIndex({ 'suggestion.key': 1, 'suggestion.series': 1 }, { sparse: true });
db.userquestionslists.createIndex({ public: 1, favorites: -1, created_at: -1 });
```

`practiceattempts` ya tiene `{ user_id: 1, created_at: -1 }`: las dos consultas del usuario (listas resueltas, rendimiento por tema) arrancan por `user_id` y recorren solo sus intentos; no hace falta otro índice.

### Campos opcionales (mejoran la precisión; no son necesarios)

Hoy una lista guarda sus áreas como **texto** (`areas: [{ name: 'LENGUAJE', count }]`, con variantes de mayúsculas) y no tiene tema. Por eso la API empareja por nombre (`areas.name`) y no puede sugerir "otra lista del mismo **tema**". Si se quiere:

| Colección | Campo | Tipo | Para qué |
|---|---|---|---|
| `userquestionslists` | `area_id` | `String` (ref `Area`) | Emparejar por id en vez de por texto; evita `distinct('area')` por petición |
| `userquestionslists` | `topic` | `String` | Sugerir listas del mismo tema (`continue`) y dejar de depender de `suggestion.key` |

Ambos opcionales y sin `default`, como los demás campos aditivos. Las listas de `/admin/practicas-sugeridas` ya conocen área y tema al crearse: basta con guardarlos ahí y rellenar las anteriores con un script de una sola vez. Cuando existan, `practice.suggestions.js` pasa a filtrar por `area_id`/`topic`.

---

## 2. Inscritos en la ficha del simulacro

`GET /simulacros/:slug` agrega `registered_count`: inscripciones **aprobadas** (`state: true`) del simulacro, es decir, usuarios (hay una inscripción por usuario). Los pagos en revisión no cuentan. Se cachea 60 s en Redis (`api:simulacrum-registered:<id>`) y se invalida al inscribirse alguien.

### Índice recomendado (monolito)

```js
db.usersimulacrums.createIndex({ simulacrum_id: 1, state: 1 });
```

Hoy `usersimulacrums` solo tiene `{ user_id: 1, simulacrum_id: 1 }` y `{ created_at: -1, state: 1, amount_paid: 1 }`; ninguno empieza por `simulacrum_id`, así que sin el índice el conteo recorre toda la colección (la ficha es pública).

### Si algún día no alcanza (contador desnormalizado)

Con el índice y el caché el conteo es barato. Si `usersimulacrums` crece mucho o la ficha recibe mucho tráfico, guardar el contador en el propio simulacro:

| Colección | Campo | Mantenimiento |
|---|---|---|
| `simulacrums` | `registered_count` (`Number`, opcional) | `$inc: 1` atómico al **aprobar** una inscripción (monolito y API), `$inc: -1` al rechazarla/eliminarla; script de reconciliación nocturno |

Requiere que el monolito y la API lo mantengan igual (dos escritores): por eso no es el primer paso.
