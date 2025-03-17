// const { options } = require("../routes/exams");

var bloque = "";
var file_lines = {};
var area_question = "";
var question_type = "";
var topice = "";
var question = "";
var resolucion = "";
var rpta = "";
var opciones = [];
var competencia = "";
//Opciones
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

let options = ["A", "B", "C", "D", "E"];
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
function get_options(options_question) {
    // console.log('OPtions questions', options_question);
    var optionsArray = {};
    var opts_orden_index = {};

    options.forEach((item) => {
        opts_orden_index[item] = options_question.indexOf(item + ') ');
    })
    console.log('OPtions questions', options);
    if (options.length == 5) {
        var options_order_old = options_question.split(/(?:A[)] |B[)] |C[)] |D[)] |E[)] )+/).filter(elem => elem);
    } else if (options.length == 4) {
        var options_order_old = options_question.split(/(?:A[)] |B[)] |C[)] |D[)] )+/).filter(elem => elem);
    }
    // console.log('OPTIONS INDEX', opts_orden_index);

    var options_sort = Object.fromEntries(
        Object.entries(opts_orden_index).sort(([, a], [, b]) => a - b)
    );
    // console.log('OPTIONS SORT', options_sort)
    Object.keys(options_sort).forEach((item, index) => {
        if (options_order_old[index]) {
            optionsArray[item] = options_order_old[index]?.replaceAll('\n', '').trim();
        } else {
            console.log("Opcion no encontrada", item)
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

function toObject(names, values) {
    var result = {};
    for (var i = 0; i < names.length; i++)
        result[names[i]] = values[i];
    return result;
}
function questionsTexts(type = 'PREGUNTA[ ]\d+[.]') {

    var arrayText = [];

    for (let index = 1; index <= 100; index++) {
        arrayText.push(type);
    }
    return arrayText.toString().replaceAll(',', '|');
}

const processLineByLine = async function (file_lines, method = 0, areas_exam, coptions=5) {

    var nquestion = 1;
    var examen = {
        bloques: [],
        questions: []
    };

    var error_opciones = [];


    console.log("File lines LLEGADA lenght", file_lines.length)
    try {
        // console.log('Areas EXAMEN', areas_exam);
        template = templates[method];
        if (coptions == 4) {
            options = ["A", "B", "C", "D"];
        }
        examen.bloques = [];
        examen.questions = [];

        var areas_text = areas_exam.join('\r\n|');
        const regex = new RegExp(`(?:${areas_text})`);
        var separate_areas = (file_lines.split(regex)).filter(elem => elem);
        var areas_pres = areas_exam.filter((area) => file_lines.indexOf(area) > -1);
        var areas_orden = areas_pres.sort((a, b) => (file_lines.indexOf(a) - file_lines.indexOf(b)))

        var areasPart = toObject(areas_orden, separate_areas);
        // console.log('Areas Part => ', { areas: areasPart });
        // console.log('Areas text', areas_text);
        //!Se han separado por areas las preguntas
        var questionsExam = [];

        Object.keys(areasPart).forEach((area) => {

            var bloqueQuestion = areasPart[area];

            // console.log('******** AREA', area)

            var questionsText = bloqueQuestion.split(/(?:PREGUNTA \d+[.]|TEXTO \d\r\n)+/).filter(elem => elem);
            // console.log("CANTIDAD DE PREGUNTAS", questionsText.length);
            console.log("CANTIDAD DE PREGUNTAS EXAM", examen.questions.length)
            // console.log(examen);
            questionsText.forEach((questionBlock, index) => {

                // !TOMAMOS LA PREGUNTA HASTA ENCONTRAR LA PRIMERA OPCION
                var opts = questionBlock.search(/(?:A[)])\s+/);

                if (opts === -1) {

                    var bloque = questionBlock;
                    // console.log('bloque', bloque);
                    if (bloque != '' && bloque != '\r\n') {
                        examen['questions'].push({
                            item: "bloque",
                            text: bloque.replaceAll('\r\n', ' ').replaceAll('\n', ' ')
                        })
                    }
                } else {
                    var question = questionBlock.substring(0, questionBlock.search(/(?:A[)])\s+/)).trim().replaceAll('\r\n', ' ');
                    questionBlock = questionBlock.substring(questionBlock.search(/(?:A[)])\s+/));
                    let opciones = [];
                    // !CONTIENE SOLUCION
                    let topic = null;
                    let resolution = null;
                    let rpta = null;
                    let rpta_text = null;

                    if (questionBlock.indexOf('SOLUCIÓN:\r\n') > -1) {
                        opciones = questionBlock.substring(0, questionBlock.indexOf('SOLUCIÓN:\r\n'));
                        questionBlock = questionBlock.substring(questionBlock.indexOf('SOLUCIÓN:\r\n') + 11);
                        opciones = get_options(opciones);
                        // opciones = ordenarTexto(opciones);

                        // !CONTIENE TEMA
                        if (questionBlock.indexOf('TEMA: ') > -1) {
                            topic = questionBlock.substring(questionBlock.indexOf('TEMA: ') + 6, questionBlock.indexOf('\r\n') == -1 ? questionBlock.length : questionBlock.indexOf('\r\n'));
                            questionBlock = questionBlock.substring(questionBlock.indexOf('\r\n') == -1 ? questionBlock.length : questionBlock.indexOf('\r\n'))
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

                        // console.log( "PREGUNTA N" + nquestion , resolution);

                    } else {
                        opciones = questionBlock.substring(questionBlock.search(/(?:A[)])\s+/), questionBlock.length);
                        opciones = get_options(opciones);
                    }
                    if (opciones) {

                        // console.log({
                        //     N: nquestion,
                        //     opciones: opciones
                        // })
                        // console.log({
                        //     N: nquestion,
                        //     opciones: opciones
                        // })
                        Object.keys(opciones).forEach((opt) => {
                            var option = opciones[opt];
                            if (option) {
                                if (option.indexOf('*') > -1 && !rpta) {
                                    rpta = opt;
                                    opciones[opt] = option.replace('*', '').trim();
                                }
                            } else {
                                error_opciones.push("Pregunta N° " + nquestion + "=> Opcion " + opt + ": No encontrada");
                            }
                        })
                    }
                    if (rpta) {
                        rpta_text = opciones[rpta];
                    }

                    examen["questions"].push({
                        item: "question",
                        n: nquestion,
                        topic: topic,
                        // 'competencia': competencia,
                        area: area,
                        pregunta_raw: question,
                        pregunta: question.replaceAll("\r\n", '</br>'),
                        resolucion: resolution,
                        type: areas_question_type[area],
                        options: opciones,
                        rpta: rpta_text,
                        rp: rpta
                    })

                    nquestion++;

                }
            })
        })

        // console.log('Areas =>', Object.keys(areasPart));
        if (error_opciones.length > 0) {
            return {
                status: false,
                errors: error_opciones
            }
        } else {
            examen['status'] = true;
            return examen;
        }

    } catch (error) {
        console.log("ERROR", error);
        return {
            status: false,
            errors: [error.message]
        }
    }
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
    console.log('Texto opciones', textoOriginal);
    function obtenerOpciones(texto) {
        //const regex = /([A-E])\)\s+)/g;
        const opciones = [];
        let match;
        while ((match = regex.exec(texto)) !== null) {
            opciones.push([match[1], match[2]]);
        }
        console.log(opciones);
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

export { processLineByLine }
