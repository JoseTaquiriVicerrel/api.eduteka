
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
  areaSlug, groupBy, sumByProperty,
  get_options_object,
  normalizeText
};
