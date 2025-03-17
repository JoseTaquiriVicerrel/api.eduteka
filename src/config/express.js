import express from "express";
import cookieParser from "cookie-parser";
// import session from "express-session";
import bodyParser from "body-parser";
import cors from 'cors';
import questionModel from "#Schemas/questions_schema.js";
import htmlToJson from "#Libs/question_json.js";

// import crypto from "crypto";
// import path from "path";
// import { dirname, join, extname } from 'path';
// import homeRouter from "#Routes/home.routes.js";
// import { fileURLToPath } from 'url';
// import exphbs from 'express-handlebars';
// import { jwtVerify } from "jose";
// import morgan from "morgan";
// import multer from "multer";
// import questionRouter from "#Routes/question.routes.js";
// import examRouter from "#Routes/exam.routes.js";
// import institutionRouter from "#Routes/institution.routes.js";
// import simulacrumRouter from "#Routes/simulacrum.routes.js";
// import authRouter from "#Routes/auth.routes.js";
// import adminExamRouter from "#Routes/admin/admin.exam.routes.js";
// import { check_session } from "#Libs/auth.js";
// import { getImage } from "#Libs/cloudinary.js";
// import userRouter from "#Routes/user.routes.js";
// import adminUserRouter from "#Routes/admin/admin.user.routes.js";
// import adminHomeRouter from "#Routes/admin/admin.home.routes.js";
// import adminTemplateRouter from "#Routes/admin/admin.template.routes.js";
// import adminMaterialRouter from "#Routes/material.routes.js";
// import adminSimulacrumRouter from "#Routes/admin/admin.simulacrum.routes.js";
// import adminQuestionRouter from "#Routes/admin/admin.question.routes.js";
// import adminInstitutionRouter from "#Routes/admin/admin.institution.routes.js";
// import storeRouter from "#Routes/store.routes.js";
// import adminProductRoute from "#Routes/admin/admin.product.routes.js";
// import productRouter from "#Routes/products.routes.js";
// import textsRouter from "#Routes/block.routes.js";
// import adminBlockRouter from "#Routes/admin/admin.block.routes.js";
// import adminProspectRouter from "#Routes/admin/admin.prospect.routes.js";
// import practiceRouter from "#Routes/practice.routes.js";
// import adminUsersAnswersRouter from "#Routes/admin/admin.user-answers.routes.js";

// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);
const expressApp = express();

// expressApp.set('views', path.join(__dirname, '../views'));
expressApp.use(cors());

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
// expressApp.engine('.hbs', exphbs.create({
//   defaultLayout: 'main',
//   extname: '.hbs',
//   layoutsDir: path.join(expressApp.get('views'), 'layouts'),
//   partialsDir: path.join(expressApp.get('views'), 'partials'),
//   helpers: {
//     json(arg1) {
//       return JSON.stringify(arg1)
//     },
//     questionOption(arg1, arg2) {
//       return '<strong>' + arg1 + ')</strong><p>' + arg2.replace('<p></p>', '').replaceAll('<p>', '').replaceAll('</p>', '') + '</p>';
//     },
//     ifEquals(arg1, arg2, options) {
//       return (arg1 == arg2) ? options.fn(this) : options.inverse(this);
//     },
//     cardQuestionAds(arg1,options) {
//       return ( (parseInt(arg1 + 1 ) % 6) === 0) ? options.fn(this) : options.inverse(this);
//     },
//     mode_production(options) {
//       return (process.env.MODE === "PRODUCTION") ? options.fn(this) : options.inverse(this);
//     },
//     count(array) {
//       return array.length;
//     },
//     ifContains(arg1, arg2, options) {
//       return (typeof arg1 !== "undefined" && arg1.indexOf(arg2) > -1) ? options.fn(this) : options.inverse(this);
//     },
//     inc(value, options) {
//       return parseInt(value) + 1;
//     }
//   }
// }).engine
// );

// expressApp.set('view engine', '.hbs')
const CURRENT_DIR = "";
const MIMETYPES = ["image/png", "image/jpeg", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]
const MAX_FILE_SIZE = 10 * 1000 * 1000;

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

// // Routes Admin
// expressApp.use(adminExamRouter);
// expressApp.use(adminUserRouter);
// expressApp.use(adminHomeRouter);
// expressApp.use(adminTemplateRouter);
// expressApp.use(adminMaterialRouter);
// expressApp.use(adminSimulacrumRouter);
// expressApp.use(adminQuestionRouter);
// expressApp.use(adminInstitutionRouter)
// expressApp.use(adminProductRoute);
// expressApp.use(adminProspectRouter);
// expressApp.use(adminBlockRouter);
// expressApp.use(adminUsersAnswersRouter);

// // Routes

// expressApp.use(homeRouter);
// expressApp.use(textsRouter);
// expressApp.use(questionRouter);
// expressApp.use(institutionRouter);
// expressApp.use(examRouter);
// expressApp.use(simulacrumRouter);
// expressApp.use(authRouter);
// expressApp.use(userRouter);
// expressApp.use(storeRouter);
// expressApp.use(productRouter);
// expressApp.use(practiceRouter);

// expressApp.use(function (req, res, next) {
//   res.status(404);

//   // respond with html page
//   if (req.accepts('html')) {
//     res.render('error/404', { layout: false });
//     return;
//   }

//   // respond with json
//   if (req.accepts('json')) {
//     res.json({ error: 'Not found' });
//     return;
//   }

//   // default to plain-text. send()
//   res.type('txt').send('Not found');

// });
expressApp.get('/', (req, res) => {
  res.send('Hello World!');
});

expressApp.post('/preguntas/get-questions-related', async (req, res, next) => {

  let questions = await questionModel.find({ area: 'Razonamiento Matemático' , verified: true, resolution: { $exists: true }}).limit(10).exec();

  questions = questions.map(question => {
    question["question_json"] = htmlToJson(question.question);
    return question;
  });

  return res.json({
    status: true,
    questions: questions
  });

});
expressApp.post('/examenes/fetch-all', async (req, res, next) => {

  let exams = await examModel.find({}, {
    _id: true,
    title: true,
    image_post: true,
  }).limit(10).exec();

  exams = exams.map(exam => {
    return exam;
  });

  return res.json({
    status: true,
    exams: exams
  });
});

expressApp.get('/areas', async (req, res) => {

  let areas = await questionModel.aggregate(
    [
      {
        $group: {
          _id: "$area",
          count: {
            $sum: 1,
          },
        },
        //order by count desc
      },
      {
          $sort: {
            count: -1,
          },
        }
    ]
  ).limit(5).exec();


  return res.json({
    status: true,
    areas: areas
  }
  );

})

export default expressApp;