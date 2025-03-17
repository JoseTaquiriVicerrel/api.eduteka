import { Type } from "@sinclair/typebox";
import addFomats from 'ajv-formats';
import addErrors from 'ajv-errors';
import Ajv from "ajv";

// const { Type } = require("@sinclair/typebox")
// const addFormats = require("ajv-formats");
// const addErrors = require("ajv-errors");
// const Ajv = require("ajv");

const loginDTOSchema = Type.Object({
    password: Type.String({
        minLength: 8,
        errorMessage: {
            length: 'El campo contreseña deber ser minimo de 8 caracteres',
            type: 'El campo contraseña debe ser una cadena de texto',
        }
    }),
    passwordRepeat: Type.String({
        minLength: 8,
        errorMessage: {
            length: 'El campo contreseña deber ser minimo de 8 caracteres',
            type: 'El campo contraseña debe ser una cadena de texto'
        }
    })
},
    {
        additionalProperties: false,
        errorMessage: {
            additionalProperties: "El formato del objeto no es valido",
        }
    });

const ajv = new Ajv({ allErrors: true });

addErrors(ajv);
const validate = ajv.compile(loginDTOSchema);

function validateLoginDTO(req, res, next) {
    const loginDTO = req.body;
    const isValidDTO = validate(loginDTO);

    if (!isValidDTO) {
        return res.status(400).send(ajv.errorsText(validate.errors, { separator: "\n" }));
    }
    next();
}


// module.exports = { validateLoginDTO }
export default validateLoginDTO;