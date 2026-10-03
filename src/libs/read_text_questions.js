// const { options } = require("../routes/exams");

var opt = "";

var templates = [
    {
        pregunta: "Pregunta N°",
        question: true,
        options: ["A) ", "B) ", "C) ", "D) ", "E) "],
        opt_bf: ")",
    },
    {
        pregunta: "Pregunta N°",
        options: ["A. ", "B. ", "C. ", "D. ", "E. "],
        opt_bf: ".",
    },
    {
        pregunta: "",
        options: ["A. ", "B. ", "C. ", "D. ", "E. "],
        opt_bf: ".",
    }
];
var template = {};

// let options = ["A", "B", "C", "D", "E"];
const breakPoints = ["TEXTO "];
const areas_question_type = {
    "RAZONAMIENTO VERBAL": "Directa",
    "RAZONAMIENTO MATEMÁTICO": "Ejercicio",
    "HABILIDAD VERBAL": "Directa",
    "APTITUD VERBAL": "Directa",
    "APTITUD MATEMÁTICA": "Ejercicio",
    "APTITUD LÓGICO MATEMÁTICO": "Ejercicio",
    "APTITUD PARA LA COMUNICACIÓN VERBAL Y ESCRITA": "Directa",
    'ACTUALIDAD LOCAL, REGIONAL, NACIONAL E INTERNACIONAL': 'Directa',
    "HABILIDAD LÓGICO-MATEMÁTICA": "Ejercicio",
    "RAZONAMIENTO LÓGICO-MATEMÁTICO": "Ejercicio",
    "LENGUAJE": "Directa",
    'REALIDAD NACIONAL': 'Directa',
    "CULTURA GENERAL": "Directa",
    "LITERATURA": "Directa",
    "PSICOLOGÍA": "Directa",
    "CIENCIA Y TECNOLOGÍA": "Directa",
    "DESARROLLO PERSONAL, CIUDADANÍA Y CÍVICA": "Directa",
    "ANATOMÍA": "Directa",
    "ACTITUDINAL": "Directa",
    "APTITUD COMUNICATIVA": "Directa",
    "GEOGRAFÍA Y AMBIENTE": "Directa",
    "GEOGRAFÍA": "Directa",
    "ECONOMÍA": "Directa",
    "FILOSOFÍA": "Directa",
    "INGLÉS": "Directa",
    "HISTORIA": "Directa",
    "HISTORIA DEL PERÚ": "Directa", "HISTORIA UNIVERSAL": "Directa",
    "QUÍMICA": "Ejercicio",
    "MATEMÁTICA": "Ejercicio",
    "COMUNICACIÓN": "Directa",
    "ARITMÉTICA": "Ejercicio",
    "BIOLOGÍA": "Directa",
    "FÍSICA": "Ejercicio",
    "GEOMETRÍA": "Ejercicio",
    "ÁLGEBRA": "Ejercicio",
    "EDUCACIÓN CÍVICA": "Directa",
    "CÍVICA": "Directa",
    "LÓGICA": "Directa",
    "TRIGONOMETRÍA": "Ejercicio"
};

function containsUppercase(str) {
    return /^[A-Z]+ $/.test(str);
}

function containBlock(str) {

    var idx = -1;

    breakPoints.forEach((ele) => {
        if ((srt.indexOf(ele) == 0) || (srt.indexOf(" " + ele) > 0)) {
            idx = srt.indexOf(ele);
        }
    })

    return idx;
}

function indexBreakQuestion(srt) {
    var idx = -1;
    if (!srt) {
        return idx;
    }
    breakPoints.forEach((ele) => {
        if ((srt.indexOf(ele) == 0) || (srt.indexOf(" " + ele) > 0)) {
            idx = srt.indexOf(ele);
        }
    })
    return idx;
}

function split(str, index) {
    const result = [str.slice(0, index), str.slice(index)];

    return result;
}
function containsNumber(str) {
    return /^[0-9]+$/.test(str);
}
function get_options(options, options_question) {
    // console.log('OPtions questions', options_question);
    var optionsArray = {};
    var opts_orden_index = {};

    options.forEach((item) => {
        opts_orden_index[item] = options_question.indexOf(item + ') ');
    })
    // console.log('OPtions questions', options);
    let options_order_old = null;
    if (options.length === 5) {
        options_order_old = options_question.split(/(?:A[)] |B[)] |C[)] |D[)] |E[)] )+/).filter(elem => elem);
    } else if (options.length === 4) {
        options_order_old = options_question.split(/(?:A[)] |B[)] |C[)] |D[)] )+/).filter(elem => elem);
    }
    // console.log('OPTIONS INDEX', opts_orden_index);

    let options_sort = Object.fromEntries(
        Object.entries(opts_orden_index).sort(([, a], [, b]) => a - b)
    );
    // console.log('OPTIONS SORT', options_sort)
    Object.keys(options_sort).forEach((item, index) => {
        if (options_order_old[index]) {
            optionsArray[item] = options_order_old[index]?.replaceAll('\n', '').trim();
        } else {
            // console.log("Opcion no encontrada", item)
            optionsArray[item] = null;
        }
    })
    const ordered = Object.keys(optionsArray).sort().reduce(
        (obj, key) => {
            obj[key] = optionsArray[key];
            return obj;
        },
        {}
    );

    return ordered;

}

function questionsTexts(type = 'PREGUNTA[ ]\d+[.]') {

    const arrayText = [];

    for (let index = 1; index <= 100; index++) {
        arrayText.push(type);
    }
    return arrayText.toString().replaceAll(',', '|');
}

/**
 * Saca de un texto los marcadores de figura y los devuelve al literal `[IMAGEN]`.
 *
 * La extraccion pide a Gemini `[IMAGEN p3: triangulo rectangulo con altura BH]`
 * (ver #Services/pdf_extract.service.js): la pagina es lo que despues permite
 * recortar la figura del PDF, y la descripcion alimenta la biblioteca de
 * graficos.
 *
 * Esos datos NO pueden quedarse dentro del enunciado. `question_raw` -y con el
 * el `hash` que detecta duplicados- conserva el texto del marcador
 * (#Libs/text_utils.js), asi que un enunciado con `[IMAGEN p3: ...]` y el mismo
 * enunciado con `[IMAGEN]` darian hashes distintos y el aviso de duplicado
 * dejaria de saltar justo en las preguntas con figura. Ademas `classifyQuestion`
 * busca el literal exacto para marcar el tipo C.
 *
 * Por eso se extraen a un campo aparte y el enunciado queda como siempre.
 *
 * @param {string} text
 * @param {'question'|'resolution'} target de donde sale el marcador
 * @returns {{text: string, figures: {page: number|null, description: string|null, target: string}[]}}
 */
const extractFigureMarkers = (text, target = 'question') => {
    // `p3`, `p. 3`, `pag 3`; separador `:` o `-`; y el marcador pelado de toda
    // la vida, que es lo que sigue llegando de los PDF ya procesados.
    const marker = /\[IMAGEN(?:\s*(?:p|pag|pagina)\.?\s*(\d{1,4}))?(?:\s*[:\-]\s*([^\]]{0,200}))?\]/gi;
    const figures = [];

    const normalized = String(text ?? '').replace(marker, (_match, page, description) => {
        figures.push({
            page: page ? Number(page) : null,
            description: description ? description.trim().replace(/\s+/g, ' ') : null,
            target
        });
        return '[IMAGEN]';
    });

    return { text: normalized, figures };
};

function classifyQuestion(text) {
    if (text.includes('[IMAGEN]')) {
        return 'C';
    }
    // Regex para detectar fórmulas comunes (LaTeX, símbolos matemáticos, etc.)
    const formulaRegex = /[\$\\\{\}\_\^\+\=\/\(\)]/;
    if (formulaRegex.test(text)) {
        return 'B';
    }
    return 'A';
}

/**
 * Normaliza los saltos de linea a CRLF.
 *
 * Todo el parser busca marcadores con `\r\n` pegado: 'SOLUCIÓN:\r\n', el corte
 * del 'TEMA: ', el split de 'TEXTO \d\r\n' y el `indexOf(area + '\r\n')` que
 * ordena las areas. Pero el navegador manda el texto con LF solo: la ingesta
 * hace `formdata.append("text", editableText.value)` y `textarea.value` devuelve
 * la "API value", que por especificacion tiene los saltos normalizados a `\n`
 * (el CRLF solo aparece al enviar el formulario de la forma clasica, que esta
 * pantalla no usa).
 *
 * Con LF ninguno de esos marcadores casaba y el resultado era:
 *   - `resolution`, `topic` y `rpta` siempre null,
 *   - el bloque SOLUCION entero tragado dentro de la ultima alternativa,
 *   - las areas ordenadas por el orden del examen y no por el del documento, con
 *     lo que cada area se quedaba con el trozo de texto de otra.
 *
 * Se canonicaliza a CRLF -y no a LF- a proposito: es lo que el resto del parser
 * ya espera, asi que los documentos que hoy entran bien no cambian en nada y los
 * de LF pasan a comportarse igual. Cubre tambien el CR suelto (Mac clasico) y es
 * idempotente sobre un texto que ya venga en CRLF.
 */
const toCRLF = (texto) => String(texto ?? '').replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n');

const processLineByLine = async function (rawTextExtractExam, method = 0, areasExam, coptions=5) {

    const textExtractExam = toCRLF(rawTextExtractExam);

    let nquestion = 1;
    const examen = {
        bloques: [],
        questions: []
    };

    const error_opciones = [];
    const error_areas = [];

    let nOptions = [];

    // Un area es una CABECERA: una linea que contiene solo el nombre del area.
    //
    // Antes bastaba con que el nombre apareciera en cualquier sitio
    // (`indexOf(area) > -1`) para darla por presente, pero el corte del texto
    // se hacia con otro criterio (el nombre seguido de salto de linea). Cuando
    // los dos no coincidian -un area nombrada dentro de un enunciado, una
    // cabecera con un espacio o dos puntos de mas, un nombre que es prefijo de
    // otro como HISTORIA y HISTORIA DEL PERU- habia mas nombres que trozos de
    // texto y `toObject` los emparejaba corridos: las preguntas se guardaban
    // con el area de al lado y la ultima area se quedaba sin trozo, que es el
    // `undefined.forEach` que rompia toda la ingesta.
    //
    // Ahora el mismo corte decide presencia, orden y contenido, asi que no
    // pueden volver a descuadrarse.
    const escapeRegex = (texto) => String(texto).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Los nombres largos primero: con `HISTORIA|HISTORIA DEL PERU` la
    // alternancia cortaria en `HISTORIA` y dejaria ` DEL PERU` dentro del texto.
    const areasPattern = [...areasExam]
        .sort((a, b) => b.length - a.length)
        .map(escapeRegex)
        .join('|');
    // `:?` y los espacios opcionales absorben las cabeceras que la IA escribe
    // como `ARITMETICA:` o con espacios de sobra al final de la linea.
    //
    // El salto de linea entra en la cabecera y no en el bloque: si se quedara
    // fuera, ese `\n` suelto se colaria como una lectura vacia delante de la
    // primera pregunta de cada area.
    const areasHeaderRegex = new RegExp(`^[ \t]*(${areasPattern})[ \t]*:?[ \t]*(?:\r?\n|$)`, 'gm');

    // `split` con grupo de captura devuelve [preambulo, area, bloque, area, ...].
    const areasChunks = textExtractExam.split(areasHeaderRegex);
    const areasPart = {};
    const areas_orden = [];

    for (let i = 1; i < areasChunks.length; i += 2) {
        const area = areasChunks[i];
        if (areasPart[area] === undefined) {
            areasPart[area] = '';
            areas_orden.push(area);
        }
        // Un area que aparece dos veces en el cuadernillo suma sus dos tramos
        // en vez de pisar el primero.
        areasPart[area] += areasChunks[i + 1] ?? '';
    }

    const separateAreasExam = Object.values(areasPart);
    const areasPres = areas_orden;
    // Diagnostico: las areas del examen que NO aparecen como cabecera en el
    // texto extraido se descartan en silencio junto con todas sus preguntas.
    // Es el fallo mas comun de la ingesta, asi que se reporta al llamador.
    const areasMissing = areasExam.filter((area) => areasPart[area] === undefined);
    // check areas
    // if(separateAreasExam.length !== areasPres.length){
    //     error_areas.push("Error en el orden de las areas, alguna de las areas no se encuentra en el texto o tiene algun error en la escritura");
    //     return {
    //         status: false,
    //         errors: error_areas
    //     }
    // }

    try {
        // console.log('Areas EXAMEN', areas_exam);
        template = templates[method];
        nOptions = ["A", "B", "C", "D", "E"].splice(0, coptions);
        examen.bloques = [];
        examen.questions = [];

        // console.log('Areas Part => ', { areas: areasPart });
        // console.log('Areas text', areas_text);
        //! Se han separado por areas las preguntas
        let questionsExam = [];

        Object.keys(areasPart).forEach((area) => {

            // `?? ''`: un area sin bloque ya no deberia poder existir, pero si
            // vuelve a pasar es preferible un area vacia que tumbar la ingesta
            // entera con un `undefined.forEach` sin contexto.
            const bloqueQuestion = areasPart[area] ?? '';
            // console.log('******** AREA', area)
            // console.log("AREA", area, "BLOQUE QUESTION", bloqueQuestion?.length );
            let questionsText = bloqueQuestion.split(/(?:PREGUNTA \d+[.]|TEXTO \d\r\n)+/).filter(elem => elem);
            // console.log("CANTIDAD DE PREGUNTAS", questionsText.length);
	        // console.log("QUESTIONS TEXT", questionsText );
            // console.log("CANTIDAD DE PREGUNTAS EXAM", examen.questions.length)
            // console.log(examen);
            questionsText.forEach((questionBlock, index) => {

                // !TOMAMOS LA PREGUNTA HASTA ENCONTRAR LA PRIMERA OPCION
                const opts = questionBlock.search(/(?:A[)])\s+/);

                if (opts === -1) {

                    const bloque = questionBlock;
                    // console.log('bloque', bloque);
                    if (bloque !== '' && bloque !== '\r\n') {
                        examen['questions'].push({
                            itype: "block",
                            // text: bloque.replaceAll('\r\n', ' ').replaceAll('\n', ' ')
                            text: bloque
                        })
                    }
                } else {
                    const question = questionBlock.substring(0, questionBlock.search(/(?:A[)])\s+/)).trim();
                    questionBlock = questionBlock.substring(questionBlock.search(/(?:A[)])\s+/));

                    let options = [];
                    // let opciones = [];
                    // !CONTIENE SOLUCION
                    let topic = null;
                    let resolution = null;
                    let rpta = null;
                    let rpta_text = null;

                    if (questionBlock.indexOf('SOLUCIÓN:\r\n') > -1) {
                        options = questionBlock.substring(0, questionBlock.indexOf('SOLUCIÓN:\r\n'));
                        questionBlock = questionBlock.substring(questionBlock.indexOf('SOLUCIÓN:\r\n') + 11);
                        options = get_options(nOptions, options);

                        // !CONTIENE TEMA
                        if (questionBlock.indexOf('TEMA: ') > -1) {
                            topic = questionBlock.substring(questionBlock.indexOf('TEMA: ') + 6, questionBlock.indexOf('\r\n') === -1 ? questionBlock.length : questionBlock.indexOf('\r\n'));
                            questionBlock = questionBlock.substring(questionBlock.indexOf('\r\n') === -1 ? questionBlock.length : questionBlock.indexOf('\r\n'))
                        }

                        if (questionBlock.length > 0 && questionBlock.indexOf('RESPUESTA: ') > -1) {
                            resolution = questionBlock.substring(0, questionBlock.indexOf('RESPUESTA: ')).replace('\r\n', '');
                            questionBlock = questionBlock.substring(questionBlock.indexOf('RESPUESTA: '));
                            rpta = questionBlock.substring(questionBlock.indexOf('RESPUESTA: ') + 11, questionBlock.length).replace('\n', '').replace('\r', '');
                            //rpta = questionBlock.substring(0, questionBlock.length).replace('\n', '').replace('\r', '');
                        }
                        if (!resolution) {
                            resolution = questionBlock;
                        }

                    } else {
                        options = questionBlock.substring(questionBlock.search(/(?:A[)])\s+/), questionBlock.length);
                        options = get_options(nOptions, options);
                    }
                    if (options) {
                        Object.keys(options).forEach((opt) => {
                            let option = options[opt];
                            if (option) {
                                if (option.indexOf('*') > -1 && !rpta) {
                                    rpta = opt;
                                    options[opt] = option.replace('*', '').trim();
                                }
                            } else {
                                error_opciones.push(`${area} | Pregunta N° " ${nquestion} => Opcion ${opt} : No encontrada`);
                            }
                        })
                    }

                    if (rpta) {
                        rpta_text = options[rpta];
                    }

                    // Antes de armar el item: el enunciado se queda con el
                    // marcador pelado y la pagina/descripcion viajan aparte.
                    const questionFigures = extractFigureMarkers(question, 'question');
                    const resolutionFigures = extractFigureMarkers(resolution ?? '', 'resolution');
                    const questionText = questionFigures.text;
                    const resolutionText = resolution != null ? resolutionFigures.text : null;
                    const figures = [...questionFigures.figures, ...resolutionFigures.figures];

                    examen["questions"].push({
                        itype: "question",
                        n: nquestion,
                        topic,
                        area,
                        question_raw: questionText,
                        // El salto entero, no solo el `\n`: con `replaceAll("\n")`
                        // el `\r` del CRLF sobrevivia y se guardaba en la base
                        // como "...texto\r</br>...".
                        question: questionText.replace(/\r?\n/g, '</br>'),
                        resolution: resolutionText != null ? resolutionText.replace(/\r?\n/g, '</br>') : null,
                        type: areas_question_type[area] ?? "Directa",
                        options,
                        rpta_text,
                        rpta,
                        type_correction: classifyQuestion(questionText + ' ' + (resolutionText || '')),
                        // null y no [] cuando no hay figura: es lo que distingue
                        // "esta pregunta no lleva figura" de "lleva y no sabemos
                        // de que pagina" al encolar el trabajo.
                        figures: figures.length ? figures : null
                    })
                    nquestion++;
                }
            })
        })

        if (error_opciones.length > 0) {
            return {
                status: false,
                errors: error_opciones,
                areas_found: areas_orden,
                areas_missing: areasMissing
            }
        } else {
            examen['status'] = true;
            examen['areas_found'] = areas_orden;
            examen['areas_missing'] = areasMissing;
            return examen;
        }

    } catch (error) {
        return {
            status: false,
            errors: [error.message],
            console: error,
            areas: separateAreasExam,
            areasPres: areasPres,
            areas_orden: areas_orden,
        }
    }
}

function checkAreas(areas, textExtractExam){
    const areasError = [];
    areas.forEach((area) => {
        if (!textExtractExam.slice > -1) {
            areasError.push(area);
        }
    });

}

function siguiente_primera_opcion(linea) {
    // console.log("Verificando Opcion A.", linea,' => ',linea.indexOf(template.options[0]) )
    return (linea.indexOf(template.options[0]) == -1)
}
function siguiente_pregunta(linea_actual) {
    if (!linea_actual) {
        return false;
    }
    // console.log("Siguiente pregunta ", nquestion,linea_actual.toUpperCase().indexOf(nquestion + "."), linea_actual )
    return (linea_actual.toUpperCase().indexOf(nquestion + ". ") > -1)
}
function text_siguiente_pregunta(n_question) {
    return n_question + ". ";
}
function linea_anterior_es_area(linea_anterior) {
    return (linea_anterior == linea_anterior.toUpperCase() && !containsNumber(linea_anterior))
}
function linea_siguiente_area(linea_actual) {
    // console.log( "Verificando Area =>", linea_actual.trim());
    if (!linea_actual) {
        return false;
    }
    return areas.hasOwnProperty(linea_actual.trim())
}


function linea_siguiente_solucion(linea) {

    return (!areas.hasOwnProperty(linea)
        && linea
        && linea.toUpperCase().indexOf(nquestion + ".") == -1
        && linea.indexOf("TEXTO ") == -1
        && linea.indexOf(opt) > -1
        && linea.indexOf("SOLUCIÓN") == -1)
}

function ordenarTexto(textoOriginal) {
    // Función para extraer las opciones y sus valores
    // console.log('Texto opciones', textoOriginal);
    function obtenerOpciones(texto) {
        //const regex = /([A-E])\)\s+)/g;
        const opciones = [];
        let match;
        while ((match = regex.exec(texto)) !== null) {
            opciones.push([match[1], match[2]]);
        }
        // console.log(opciones);
        return opciones.sort((a, b) => a[0].localeCompare(b[0]));
    }

    // Función para convertir las opciones en un objeto JSON
    function convertirAJSON(opciones) {
        const json = {};
        opciones.forEach((opcion) => {
            json[opcion[0]] = opcion[1];
        });
        return json;
    }

    // Obtener opciones ordenadas
    const opcionesOrdenadas = obtenerOpciones(textoOriginal);
    console.log(opcionesOrdenadas);
    // Convertir a JSON
    const jsonResultante = convertirAJSON(opcionesOrdenadas);

    return jsonResultante;
}

export { processLineByLine, extractFigureMarkers }
