import express from "express";
import cookieParser from "cookie-parser";
// import session from "express-session";
import bodyParser from "body-parser";
import cors from 'cors';
import questionModel from "#Schemas/questions_schema.js";
import authRouter from "#Routes/auth.routes.js";
import questionRouter from "#Routes/question.routes.js";
import exphbs from 'express-handlebars';
import path from "path";
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import examRouter from "#Routes/exam.routes.js";
// import crypto from "crypto";
// import path from "path";
// import { dirname, join, extname } from 'path';
// import homeRouter from "#Routes/home.routes.js";
// import exphbs from 'express-handlebars';
// import { jwtVerify } from "jose";
// import morgan from "morgan";
// import multer from "multer";
// import { check_session } from "#Libs/auth.js";
// import { getImage } from "#Libs/cloudinary.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const expressApp = express();

// expressApp.use(cors());

expressApp.use(express.json());

// expressApp.use(
//   session({
//     name: 'eduteka_session',
//     secret: '41763C84F2939F381A22F26EFC234',
//     resave: false,
//     saveUninitialized: true,
//     cookie: {
//       maxAge: (1000 * 60 * 100)
//     } 
//   })
// )

// expressApp.set('view engine', '.hbs')
const CURRENT_DIR = "";
const MIMETYPES = ["image/png", "image/jpeg", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]
const MAX_FILE_SIZE = 10 * 1000 * 1000;

expressApp.set('views', path.join(__dirname,'../views'));
expressApp.engine('.hbs', exphbs.create({
  defaultLayout: 'main',
  extname: '.hbs',
  layoutsDir: path.join(expressApp.get('views'), 'layouts'),
  partialsDir: path.join(expressApp.get('views'), 'partials'),
  helpers: { }
}).engine
);

// const storage = multer.diskStorage({
//   destination: (req, file, cb) => {
//     cb(null, 'src/storage/upload')
//   },
//   filename: (req, file, cb) => {
//     const extension = extname(file.originalname);
//     let filename = file.originalname.split(extension)[0];
//     filename = filename.normalize("NFD").toLowerCase().replace(" ", "_");
//     cb(null, `${filename}_${Date.now()}${extension}`)
//   }
// });
// const upload = multer({
//   storage: storage,
//   dest: 'src/storage/upload',
//   filefilter: (req, file, cb) => {
//     if (mimetypes.includes(file.mimetype)) cb(null)
//     else cb(new error(`solo se permiten ${mimetypes.join("")}  archivos de este tipo`))
//   },
//   limits: {
//     filesize: MAX_FILE_SIZE
//   }
// }).any()
// expressApp.use(upload);

expressApp.use(bodyParser.text({ defaultCharset: 'utf-8' }));
expressApp.use(bodyParser.urlencoded({ extended: true }));
expressApp.use(bodyParser.json());
expressApp.use(cookieParser());

// expressApp.use(morgan('dev'));
// expressApp.use(express.static(path.join(__dirname, '../public')))
// expressApp.locals.NAME_DOMAIN = process.env.NAME_DOMAIN;
expressApp.locals.WEB_URL = process.env.MODE === "PRODUCTION" ? process.env.APP_URL : process.env.HOST + ":" + process.env.PORT;
// expressApp.use('/storage/templates/upload/', express.static('src/storage/templates/upload'));
// expressApp.use('/storage/upload/', express.static('src/storage/upload'));

// expressApp.use(async function (req, res, next) {

//   res.locals.user_session = await check_session(req);
//   res.locals.authenticated = !res.locals.user_session.anonymous ?? false;
//   res.locals.user_name = res.locals.user_session.name ?? res.locals.user_session.username;
//   res.locals.user_id = res.locals.user_session._id ?? null;
//   res.locals.rol_user = res.locals.user_session.rol || "User";

//   res.locals.hash_mail = crypto.createHash('sha256').update(res.locals.user_session.email ?? '').digest('hex');
//   res.locals.MODE = res.locals.rol_user === 'Administrador' ? 'DEBUG' : process.env.MODE;
//   res.locals.APP_MODE = process.env.MODE ?? "DEBUG";
//   res.locals.ws_url = process.env.WS_URL || 'http://localhost:' + process.env.WS_PORT;
//   res.locals.WEB_URL = process.env.MODE === "PRODUCTION" ? process.env.APP_URL : process.env.HOST + ":" + process.env.PORT;
//   res.locals.NAME_DOMAIN = process.env.NAME_DOMAIN;
//   next();

// });
// //
// expressApp.use('/storage/images/:folder/:filename', async function (req, res) {
//   const response = await getImage(req.params.folder + "/" + req.params.filename );
//   console.log(response);
//   if (response.status) {
//     // return res.send(response.result);
//     return res.redirect(response.result.url)
//   }

//   return res.send("404");

// });

// // TODO nidlewares, routes

// Routes Admin
// expressApp.use(adminExamRouter);

// Routes

expressApp.use(authRouter);
expressApp.use(examRouter);
expressApp.use(questionRouter);

expressApp.use(function (req, res, next) {
  res.status(404);

  // respond with html page
  if (req.accepts('html')) {
    return res.render('error/404.hbs', { layout: false });
  }

  // respond with json
  if (req.accepts('json')) {
    return res.json({ message: 'Not found', error:"" });
  }

  // default to plain-text. send()
  return res.type('txt').send('Not found');

});

export default expressApp;