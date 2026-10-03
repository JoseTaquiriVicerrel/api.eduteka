import fs from "fs";
import mailer from "nodemailer";
import handlebars from "handlebars";
// const path = require("path");
// const fs = require("fs");
// const mailer = require("nodemailer");
// const handlebars = require("handlebars");
import path from "path";
import { fileURLToPath } from 'url';
import { Resend } from "resend";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


// const send_mail_notification = async function ({ from, subject, email, template = null }, data) {
//   return new Promise((resolve, reject) => {

//     const emailTemplate = fs.readFileSync(path.join(__dirname, '../views/mail/' + template + '.hbs'), 'utf-8');
//     let transporter;
    // if (from == 'eduteka.noresponder@gmail.com') {

    //   transporter = mailer.createTransport({
    //     host: process.env.G_EMAIL_SMTP,
    //     port: process.env.G_EMAIL_PORT,
    //     secure: true,
    //     auth: {
    //       user: process.env.G_EMAIL,
    //       pass: process.env.G_EMAIL_PASSWORD
    //     }
    //   });

    // } else if (from == 'no-reply@eduteka.site') {

    //   transporter = mailer.createTransport({
    //     host: process.env.EMAIL_SMTP,
    //     port: process.env.EMAIL_PORT,
    //     secure: true,
    //     auth: {
    //       user: process.env.EMAIL,
    //       pass: process.env.EMAIL_PASSWORD
    //     }
    //   });

    // }

    // const hbscompile = handlebars.compile(emailTemplate)
    // const htmlSend = hbscompile(data);
    // const resend = new Resend(process.env.RESEND_API_KEY);

    // const {data, error} = await resend.emails.send({
    //   from: from,
    //   to: email,
    //   subject: subject,
    //   html: htmlSend
    // });

    // if (error) {
    //   console.log({error});
    //   resolve(false);
    // }

    // console.log({data});
    // resolve(true);

//     // var options = {
//     //   from: from,
//     //   to: email,
//     //   subject: subject,
//     //   html: htmlSend
//     // };

//     // transporter.sendMail(options, function (error, info) {
//     //   if (error) {
//     //     console.log(error);
//     //     resolve(false);
//     //   } else {
//     //     console.log('Email enviado:' + info.response);
//     //     resolve(true);
//     //   }
//     // })
//   })
// }

const sendMailNotification = async function ({ from, subject, email, template = null, provider='zoho' }, maildata) {

  const emailTemplate = fs.readFileSync(path.join(__dirname, '../views/mail/' + template + '.hbs'), 'utf-8');
  const hbscompile = handlebars.compile(emailTemplate)
  const htmlSend = hbscompile(maildata);
  const resend = new Resend(process.env.RESEND_API_KEY);

  if ( from == 'no-reply@eduteka.site' ) {

    if ( provider == 'zoho' ) {

      return new Promise((resolve, reject) => {

        const transporter = mailer.createTransport({
            host: process.env.EMAIL_SMTP,
            port: process.env.EMAIL_PORT,
            secure: true,
            auth: {
              user: process.env.EMAIL,
              pass: process.env.EMAIL_PASSWORD
            }
          });

        const options = {
              from,
              to: email,
              subject,
              html: htmlSend
            };

        transporter.sendMail(options, function (error, info) {
          if (error) {
            console.log(error);
            resolve(false);
          } else {
            console.log('Email enviado:' + info.response);
            resolve(true);
          }
        })

      })

    } else if (provider === 'resend') {

      const { data, error } = await resend.emails.send({
        from: 'Eduteka <no-reply@eduteka.site>',
        to: email,
        subject,
        html: htmlSend
      });

      if (error) {
        console.log({ error });
        return false;
      }

      console.log("Email enviado: ", email , { data });
      return true;
    }

  } else if (from === 'eduteka.noresponder@gmail.com') {

    return new Promise((resolve, reject) => {
      const transporter = mailer.createTransport({
        host: process.env.G_EMAIL_SMTP,
        port: process.env.G_EMAIL_PORT,
        secure: true,
        auth: {
          user: process.env.G_EMAIL,
          pass: process.env.G_EMAIL_PASSWORD
        }
      });

      const options = {
        from: 'Eduteka <eduteka.noresponder@gmail.com>',
        to: email,
        subject,
        html: htmlSend
      };

      transporter.sendMail(options, function (error, info) {
        if ( error ) {
          console.log(error);
          resolve(false);
        } else {
          console.log('Email enviado:' + info.response);
          resolve(true);
        }
      })

    })
  }
}

export default sendMailNotification;
