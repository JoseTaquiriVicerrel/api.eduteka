import { Type } from "@sinclair/typebox";
import addFomats from 'ajv-formats';
import addErrors from 'ajv-errors';
import Ajv from "ajv";

// const { Type } = require("@sinclair/typebox");
// const addFormats = require("ajv-formats");
// const addErrors = require("ajv-errors");
// const Ajv = require("ajv");

const registerDTOSchema = Type.Object({
    username: Type.String(),
    email: Type.String({
        format: "email",
        errorMessage: {
            type: "El campo email debe ser un string",
            format: "El email debe ser correcto"
        }
    }),
    password: Type.String(),
    edkTerms: Type.String({
        errorMessage: {
            type: "El campo edkTermsCheck debe ser un entero"
        }
    })
}, {
    additionalProperties: true,
    errorMessage: {
        additionalProperties: "El formato del objeto no es correcto"
    }
});

const ajv = new Ajv({ allErrors: true })
addFormats(ajv, ["email"]).addKeyword("kind").addKeyword("modifier");
addErrors(ajv);
const validate = ajv.compile(registerDTOSchema);

function validateRegisterDTO(req, res, next) {
    const registerDTO = req.body;
    const isValidDTO = validate(registerDTO)
    if (!isValidDTO) {

        return res.status(400).send(ajv.errorsText(validate.errors, { separator: "\n" }));
    }
    next()
}

// module.exports = { validateRegisterDTO }
export default validateRegisterDTO;
