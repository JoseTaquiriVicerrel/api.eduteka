/**
 * Decide si un simulacro debe pedir area profesional y carrera al inscribirse.
 *
 * Ojo: "area profesional" (`simulacrum.areas`, la que elige el postulante) no es
 * lo mismo que el area/curso de una pregunta (`question.area`), que es de lo que
 * se ocupa #Libs/area_utils.js.
 *
 * No se puede usar `general` para esto. `general` significa que el examen es
 * unico (las mismas preguntas para todos, en `general_items`), no que no haya
 * areas: UNSM 2026-II es general y tiene cinco areas profesionales con sus
 * carreras, mientras que BECA 18 es general con una sola area ficticia "UNICO"
 * y sin ninguna carrera. Lo que decide es el contenido real de `areas`.
 *
 * - Con una sola area no hay eleccion posible: se asigna en el servidor.
 * - Si ninguna area trae carreras, el select de carrera nunca tendria opciones
 *   y bloquearia el formulario.
 */
export const getSimulacrumAreaOptions = (simulacrum) => {
    const areas = Object.values(simulacrum?.areas ?? {});

    return {
        ask_area: areas.length > 1,
        ask_career: areas.some((area) => (area?.careers ?? []).length > 0),
    };
};
