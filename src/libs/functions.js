import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from "crypto";

const opt_options = (options) => {

  const opts = ["A", "B", "C", "D", "E", "F", "G"];
  const optionsArray = {};

  if (!options) {
    return optionsArray;
  }

  options.forEach((item, index) => {
    optionsArray[opts[index]] = item;
  })

  return optionsArray;
}

const get_opts = (options = {}, rpta = null) => {

  const opts = [];
  const values = Object.values(options);

  Object.keys(options).forEach((item, index) => {
    opts.push({
      opt: item,
      option: values[index],
      rpta: rpta == item,
    });
  })

  return opts;
};

const optionsEmpty = () => {
  return [
    { opt: "A", option: "" },
    { opt: "B", option: "" },
    { opt: "C", option: "" },
    { opt: "D", option: "" },
    { opt: "E", option: "" },
  ];
};

const groupByAndCount =  (items, obj_key) => {

  let grouped = {};

  for (let item of items) {
    // let { languageId } = item;
    let area_key = item[obj_key];
    if (!(area_key in grouped)) {
      grouped[area_key] = [];
    }
    grouped[area_key].push(item);
  }

  let counts = Object.entries(grouped).map(([name, arr]) => ({ name, count: arr.length }));
  return counts;

}

// Reusable function
function sumByProperty(arr, propertyName) {
  return arr.reduce((accumulator, currentItem) => {
    return accumulator + (currentItem[propertyName] || 0);
  }, 0); // 0 is the initial value
}

const groupBy = (items, objPropery) => {
  items.reduce((acc, item) => {
    const key = item[objPropery];
    if (!acc[key]) {
      acc[key] = [];
    }
    acc[key].push(item);
    return acc;
  }, {});
}

const questionTextCopy = (question, options) => {

  let questionCopy = "";

  if ( question.type == 'question' || question.options ) {

    const questionTmp = question.question;
    questionCopy += questionTmp.replaceAll("<br>", "\r\n").replaceAll("<p>", "").replaceAll("</p>", "").replaceAll(/<img src="data:image\/(png|jpeg|jpg);base64,([^"]+)">/g, " [IMAGEN] ") + "\r\n";

    options.forEach((e, key) => {
      questionCopy += e.opt + ") " + e.option.replaceAll("<br>", "\r\n").replaceAll("<p>", "").replaceAll("</p>", "").replaceAll(/<img src="data:image\/(png|jpeg|jpg);base64,([^"]+)">/g, " [IMAGEN] ") + "\r\n";
    });
  } else if (question.type == 'block') {
    questionCopy += question.texto.replaceAll("<br>", "\r\n").replaceAll("<p>", "").replaceAll("</p>", "").replaceAll(/<img src="data:image\/(png|jpeg|jpg);base64,([^"]+)">/g, " [IMAGEN] ") + "\r\n";
  }

  return questionCopy;

}

const textBlockCopy = (block) => {
  return block.text.replaceAll("<br>", "\r\n").replaceAll("<p>", "").replaceAll("</p>", "").replaceAll(/<img src="data:image\/(png|jpeg|jpg);base64,([^"]+)">/g, " [IMAGEN] ") + "\r\n";
}

const get_options_object = ( question = null) => {

  let options = [];

  if (!question["options"]) {
    return options;
  }

  if (question.options instanceof Map) {

    question.options.forEach((e, key) => {

      const objOptions = {
        opt: key,
        option: e,
        block: e?.length > 10,
        rpta: question.rpta === key,
      };

      options.push(objOptions);

    })

  } else {
    Object.keys(question.options).forEach((option) => {
      options.push({
        opt: option,
        option: question.options[option],
        block: question.options[option].length > 10,
        rpta: question.rpta === option
      });
      if ( question.options_answers ) {
          options.answers = question.options_answers[option];
          options.porcent = +((question.options_answers[option] * 100  )  / question.total_answers).toFixed(2);
      }
    })

  }
  return options;
}

const get_options_map = ( question = null) => {

  let options = [];

  if (!question["options"]) {
    return options;
  }

  if (question.options instanceof Map) {

    question.options.forEach((e, key) => {

      const objOptions = {
        opt: key,
        option: e,
        block: e?.length > 10,
        rpta: question.rpta === key,
      };

      if ( question.options_answers ) {
          objOptions.answers = question.options_answers.get(key);
          objOptions.porcent = +((question.options_answers.get(key) * 100  )  / question.total_answers).toFixed(2);
      }

      options.push(objOptions);

    })

  } else {
    Object.keys(question.options).forEach((option) => {
      options.push({
        opt: option,
        option: question.options[option],
        block: question.options[option].length > 10,
        rpta: question.rpta === option
      });
      if ( question.options_answers ) {
          options.answers = question.options_answers[option];
          options.porcent = +((question.options_answers[option] * 100  )  / question.total_answers).toFixed(2);
      }
    })

  }
  return options;
}


/*
const get_template_option = (opciones, lgt = 8) => {

  let templateA = false;

  opciones.forEach((option, key) => {
    // console.log("Option", option.option.length, option)
    if ( option.option.length > lgt ) { templateA = true; }
  })

  return templateA;
}
*/


const get_template_option = (opciones, lgt = 8) => {

  let templateA = false;

  if (!opciones) {
    return templateA;
  }

  Object.keys(opciones).forEach((item) => {
    const option = normalizeText( opciones[item].option);
    if (!templateA && (option?.option?.length > lgt || option?.length > lgt )) {
      templateA = true;
    }
  })

  return templateA;
}

const base64_encode = (file) => {
  let bitmap = fs.readFileSync(file, 'base64');
  return bitmap;
}

const convertSlug = (text) => {
  return text.normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9 -]/g, '')             // Remove invalid characters
    .replaceAll(/\s+/g, '-')                    // Replace spaces with hyphens
    .replaceAll(/-+/g, '-')                     // Replace multiple hyphens with a single hyphen
    .replaceAll(/^-+|-+$/g, '')
    .replaceAll('--', '-')
    ;

}
const areaSlug = (text, unique = false) => {
  if (text === "UNICO" || text === "0" || (text === "I" && unique ) || text === "O" || text === "TODAS") {
    return ""
  }

  return "_" + text.normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9 -]/g, '')             // Remove invalid characters
    .replaceAll(/\s+/g, '_')                    // Replace spaces with hyphens
    .replaceAll(/-+/g, '_')                     // Replace multiple hyphens with a single hyphen
    .replaceAll(/^-+|-+$/g, '')
    // .toUpperCase();

}
const moveFile = async (oldPath, newPath) => {
  // 1. Create the destination directory
  // Set the `recursive` option to `true` to create all the subdirectories
  await fs.mkdir(path.dirname(newPath), { recursive: true });

  try {
    // 2. Rename the file (move it to the new directory)
    await fs.rename(oldPath, newPath);
  } catch (error) {
    // console.log("Error move file", error );
    if (error.code === 'EXDEV') {
      // 3. Copy the file as a fallback
      await fs.copyFile(oldPath, newPath);
      // Remove the old file
      await fs.unlink(oldPath);
    } else {
      // Throw any other error
      throw error;
    }
  }
}
const saveImagesBase64 = async (text, area = null, type = "question") => {
  const base64Matches = text.match(/<img src="data:image\/(png|jpeg|jpg);base64,([^"]+)">/g);
  const imageDirectory = 'src/public/images/questions/';
  const blockReplaced = [];
  if (base64Matches) {

    // console.log("Base64 Matches", base64Matches.length);

    for (let i = 0; i < base64Matches.length; i++) {

      // console.log("Base64", i);
      // const base64Data = base64Matches[i].replace(/<img src="data:image\/(png|jpeg|jpg);base64,([^"]+)">/, "").slice(0, -1);

      const base64Data = base64Matches[i].replace(/<img src="data:image\/(png|jpeg|jpg);base64,/, "").slice(0, -1);
      // console.log("Base64 Data", base64Data);

      let dataImages = "imgb_";

      if (area) {
        dataImages += convertSlug(area);
      }

      const hash = crypto.randomBytes(4).toString("hex");
      dataImages += ("_" + hash);
      const imageName = dataImages + ".png";
      const imagePath = imageDirectory + imageName;
      // console.log(imageName, imagePath);
      await fs.writeFileSync(imagePath, base64Data, 'base64');

      const urlMain = "https://eduteka.pe";

      let newText = "";

      if (process.env.MODE == "PRODUCTION") {
        newText = blockQuestion.text.replace(base64Matches[i], `<img src="${urlMain}/images/questions/${imageName}">`);
      } else {
        newText = blockQuestion.text.replace(base64Matches[i], `<img src="/images/questions/${imageName}">`);
      }

      blockQuestion.text = newText;

    }

    blockReplaced.push({
      _id: block.id,
      text: blockQuestion.text,
      itype: 'imagen guardada'
    });

    await BlockModel.findByIdAndUpdate(blockQuestion._id, { $set: { text: blockQuestion.text } }).exec();

    const blockIndex = exam.areas[area].items.findIndex(item => item.id === blockQuestion._id);

    // console.log("Index Block", blockIndex);

    exam.areas[area].items[blockIndex] = {
      _id: blockQuestion._id,
      itype: "block",
      text: blockQuestion.text
    };

    if (blockQuestion.title) {
      exam.areas[area].items[blockIndex].title = blockQuestion.title;
    }

  } else {

    // console.log("No encontrado imagen", blockQuestion._id);

    blockReplaced.push({
      _id: blockQuestion._id,
      text: blockQuestion.text,
      type: 'sin imagen'
    });

    const blockIndex = exam.areas[area].items.findIndex(item => item.id === block.id);

    // console.log("Index Block", blockIndex);

    exam.areas[area].items[blockIndex] = {
      _id: blockQuestion._id,
      itype: "block",
      text: blockQuestion.text
    };

    if (blockQuestion.title) {
      exam.areas[area].items[blockIndex].title = blockQuestion.title;
    }

    // await BlockModel.findByIdAndUpdate( BlockQues.id, { $set: { text: block.text } } ).exec();

  }
}

const saveQuestionImages = async (text, area, type = "question") => {
  if (!text || typeof text !== 'string') return text;

  const base64Matches = text.match(/<img src="data:image\/(png|jpeg|jpg);base64,([^"]+)"/g);
  if (!base64Matches) return text;

  const imageDirectory = 'src/public/images/questions/';
  const prefixes = { question: 'img_q_', resolution: 'img_r_', option: 'img_o_' };
  const prefix = prefixes[type] ?? 'img_';

  let result = text;

  for (let i = 0; i < base64Matches.length; i++) {
    const base64Data = base64Matches[i].replace(/<img src="data:image\/(png|jpeg|jpg);base64,/, "").slice(0, -1);

    let dataImages = prefix;
    if (area) dataImages += convertSlug(area);
    const hash = crypto.randomBytes(4).toString("hex");
    dataImages += ("_" + hash);
    const imageName = dataImages + ".png";
    const imagePath = imageDirectory + imageName;

    await fs.writeFile(imagePath, base64Data, 'base64');

    const imagePublicUrl = `/images/questions/${imageName}`;
    result = result.replace(base64Matches[i], `<img src="${imagePublicUrl}"`);
  }

  return result;
};
function normalizeText(html = "") {
  return html?.replace(/<[^>]+>/g, " ")          // quitar tags HTML
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quitar tildes
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export {
  get_opts, get_options_map, opt_options,
  get_template_option, optionsEmpty,
  questionTextCopy, textBlockCopy,
  groupByAndCount, convertSlug,
  areaSlug, moveFile, groupBy, sumByProperty,
  get_options_object, saveQuestionImages,
  normalizeText
};
