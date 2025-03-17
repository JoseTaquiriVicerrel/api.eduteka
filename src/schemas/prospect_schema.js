import mongoose from 'mongoose';

const { Schema } = mongoose;

const prospectSchema = new Schema({
    _id: String,
    name: String,
    descripcion: String,
    institution_id: { type: String, ref: 'Institution' },
    calification_type: String,
    academics_unit: Array, // Unidades academicas
    professional_areas: Object, // Areas profesionales del examen con sus respectivas profesiones
    subjects: Array, // Asignaturas/cursos del examen
    structure: Object,
    exam_type: String, // Examen UNICO (Para todas las areas profesionales) - Diferente Examen por Areas profesionales
    exam_unique: Boolean,
    calification: Object,
    state: Boolean,
    created_at: {
        type: Date,
        default: Date.now
    }
});

const ProspectModel = mongoose.model("Prospect", prospectSchema);

export default ProspectModel;
/*
// calification type - score_units_academic
var calification = {
    "MATEMATICA": {
        "A": 5,
        "B": 2,
        "C": 6,
    },
    "score_incorrect": 0.25,
    "score_not_answered": 0
};
// calification type - score_areas_units_academic
var calification = {
    "TRIGONOMETRIA": {
        "A": 2,
        "B": 2,
        "C": 6
    }

    "score_incorrect": 0,
    "score_not_answered": 0
}

// calification type - score_question
var calification = {
    "score_correct": 20,
    "score_incorrect": -1,125,
    "score_not_answered": 0
}
*/
// structure type 
/*var structure = {
    "MATEMATICA": {
        nquestions: 20,
        subjects: {
            "TRIGONOMETRIA": {
                "A": 5,
                "B": 5,
                "C": 5,
                "D": 5
            },
        }
    },
    "CIENCIAS NATURALES": {
        nquestions: 20,
        subjects: {
            "BIOLOGIA": 8
        }
    }
};*/