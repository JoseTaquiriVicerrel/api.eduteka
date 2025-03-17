import { Type } from "@sinclair/typebox";
import addFomats from 'ajv-formats';
import addErrors from 'ajv-errors';
import Ajv from "ajv";
// const { Type } = require("@sinclair/typebox");
// const addFormats = require("ajv-formats");
// const addErrors = require("ajv-errors");
// const Ajv = require("ajv");


const contactDTOSchema = Type.Object({
    username: Type.String(),
    email: Type.String({
        format: "email",
        errorMessage: {
            type: "El campo email debe ser un string",
            format: "El email de ser correcto"
        }
    }),
    // phone: Type.String({
    //     // format: "regex",
    //     minLength: 9,
    //     maxLength: 9,
    //     pattern: "^[0-9]+$",
    //     errorMessage: {
    //         type: "El campo N° de Celular debe ser un numero",
    //         format: "El N° de Celulat debe correcto"
    //     }
    // }),
}, {
    additionalProperties: true,
    errorMessage: {
        additionalProperties: "El formato del objeto no es correcto"
    }
});

const ajv = new Ajv({ allErrors: true })
addFormats(ajv, ["email"]).addKeyword("kind").addKeyword("modifier");
addErrors(ajv);
const validate = ajv.compile(contactDTOSchema);

function validateContactDTO(req, res, next) {
    const contactDTO = req.body;

    const isValidDTO = validate(contactDTO)
    if (!isValidDTO) {

        return res.status(400).send(ajv.errorsText(validate.errors, { separator: "\n" }));
    }
    next()
}


// module.exports = { validateContactDTO }
export default validateContactDTO;