import { Type } from "@sinclair/typebox";
import addFomats from 'ajv-formats';
import addErrors from 'ajv-errors';
import Ajv from "ajv";
// const { Type } = require("@sinclair/typebox")
// const addFormats = require("ajv-formats");
// const addErrors = require("ajv-errors");
// const  Ajv = require("ajv");

const loginDTOSchema = Type.Object({
    email: Type.String({
        format: "email",
        errorMessage: {
            type: 'El tipo de email debe ser un string',
            format: "El email de ser correcto"
        }
    }),
    password: Type.String()
},
    {
        additionalProperties: false,
        errorMessage: {
            additionalProperties: "El formato del objeto no es valido",
        }
    });

const ajv = new Ajv({ allErrors: true });

addFormats(ajv, ["email"]).addKeyword("kind").addKeyword("modifier");
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