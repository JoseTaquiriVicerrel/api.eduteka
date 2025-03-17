import UserModel from '#Schemas/user_schema.js';
import bcrypt from 'bcrypt';
import { jwtVerify } from 'jose';

const check_session = async (req) => {

  const sessionCokie = req.cookies.session || "";

  if (sessionCokie == "") {
    return { anonymous: true };
  }

  try {
    const encoder = new TextEncoder();
    const { payload } = await jwtVerify(sessionCokie, encoder.encode(process.env.JWT_PRIVATE_KEY));
    // console.log(payload);
    const user = await UserModel.findById(payload.uid).exec();
    return user;
  } catch (err) {
    return { anonymous: true };
  }
}

const cryptPassword = (password, callback) => {
  bcrypt.genSalt(10, function (err, salt) {
    if (err)
      return callback(err);
    bcrypt.hash(password, salt, function (err, hash) {
      return callback(err, hash);
    });
  });
};

const comparePassword = (plainPass, hashword, callback) => {
  bcrypt.compare(plainPass, hashword, function (err, isPasswordMatch) {
    return err == null ?
      callback(null, isPasswordMatch) :
      callback(err);
  });
};
function authorize(role) {
  return async function (req, res, next) {
    // console.log('Cookies', req.cookies);
    const sessionCokie = req.cookies.session || "";

    if (sessionCokie == "") {
      // console.log('Sesion', sessionCokie);
      return res.redirect('/login');
      //res.status(401).send( '401:Unauthorized');
    }

    try {
      const encoder = new TextEncoder();
      const { payload } = await jwtVerify(sessionCokie, encoder.encode(process.env.JWT_PRIVATE_KEY));
      const user = await UserModel.findById(payload.uid).exec();
      // console.log(user);
      if (user.rol != role && role != "Auth") {

        return res.status(404).send('Forbidden');
        //res.render('login',{layout:false });
      } else {
        // console.log("passed");
        next();
      }

    } catch (err) {
      return res.redirect('/login');
      res.status(401).send('Unauthorized');
    }
  }
}

function checkJWTToken () {

}

export { check_session, cryptPassword, comparePassword, authorize };
