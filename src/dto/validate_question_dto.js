import { Type } from "@sinclair/typebox";
import addFomats from 'ajv-formats';
import addErrors from 'ajv-errors';
import Ajv from "ajv";

// const { Type } = require("@sinclair/typebox")
// const addFormats = require("ajv-formats");
// const addErrors = require("ajv-errors");
// const  Ajv = require("ajv");

const questionDTOSchema = Type.Object({
    topic: Type.String(),
    area: Type.String(),
    difficulty: Type.String(),
    type: Type.String(),
    question: Type.String(),
    options: Type.Object,
    resolution: Type.String(),
    //rpta: Type.String(),
    //competition: Type.String()
},
    {
        additionalProperties: true,
        errorMessage: {
            additionalProperties: "El formato del objeto debe ser valido"
        }
    })
const ajv = new Ajv({ allErrors: true });

addFormats(ajv).addKeyword("kind").addKeyword("modifier")

addErrors(ajv);

const validate = ajv.compile(questionDTOSchema);
function validateQuestionDTO(req, res, next) {
    const questionDTO = req.body;
    console.log("DTO", questionDTO);
    const isValidDTO = validate(questionDTO);
    if (!isValidDTO) {
        return res.status(400).send(ajv.errorsText(validate.errors, { separator: "\n" }))
    }

    next();
}

// module.exports = {validateQuestionDTO};
export default validateQuestionDTO;
