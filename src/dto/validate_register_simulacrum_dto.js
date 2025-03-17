import { Type } from "@sinclair/typebox";
import addFomats from 'ajv-formats';
import addErrors from 'ajv-errors';
import Ajv from "ajv";


// const { Type } = require('@sinclair/typebox');
// const addFormats = require('ajv-formats');
// const addErrors = require('ajv-errors');
// const Ajv = require('ajv');

const registerUserSimulacrumDTOSchema = Type.Object({
  dni:
    Type.Optional(
      Type.String(
        {
          minLength: 8,
          errorMessage: {
            type: 'El campo dni debe ser una cadena de texto',
            minLength: 'El campo dni debe contar con 8 digitos'
          }
        }
      )
    )
  ,
  fullname:
    Type.Optional(
      Type.String(
        {
          minLength: 1,
          errorMessage: {
            type: 'El campo nombres y apellidos debe ser una cadena de texto',
            minLength: 'El campo nombres y apellidos es requerido'
          }
        }
      )
    )
  ,
  career: Type.String(
    {
      errorMessage: {
        type: 'El campo carrera debe ser un cadena de texto',
      }
    }
  ),
  area: Type.String({
    errorMessage: {
      type: 'El campo area debe ser un cadena de texto',
    }
  }),
  capture:
    Type.Optional(
      Type.Object({
        fieldname: Type.String(),
        originalname: Type.String(),
        encoding: Type.String(),
        mimetype: Type.String(),
        destination: Type.String(),
        fieldname: Type.String(),
        path: Type.String(),
        size: Type.Number(),
      })
    ),
}, {
  additionalProperties: false,
  errorMessage: {
    additionalProperties: 'El formato del objeto no es correcto'
  }
});

const ajv = new Ajv({ allErrors: true });
addFormats(ajv, ["binary"]).addKeyword("kind").addKeyword("modifier")
addErrors(ajv);
const validate = ajv.compile(registerUserSimulacrumDTOSchema);

function validateRegisterUserSimulacrumDTO(req, res, next) {
  var registerDTO = req.body;
  if (req.files && req.files.length != 0) {
    if (req.files[0].fieldname == 'capture') {
      registerDTO['capture'] = req.files[0];
    }
  }

  // console.log(req.body);
  // console.log(req.files);
  console.log(registerDTO);
  const isValidDTO = validate(registerDTO);
  if (!isValidDTO) {
    // return res.status(400).send(ajv.errorsText( validate.errors, { separator: '\n' }))
    return res.status(200).json({
      status: false,
      message: 'Información incorrecta',
      errors: ajv.errorsText(
        validate.errors,
        {
          separator: '</br>'
        }
      )
    })
  }
  next();
}

// module.exports = { validateRegisterUserSimulacrumDTO };

export default validateRegisterUserSimulacrumDTO;
