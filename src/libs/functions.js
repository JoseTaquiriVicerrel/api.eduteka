const opt_options = (options) => {

  var opts = ["A", "B", "C", "D", "E", "F", "G"];

  var optionsArray = {};
  if (!options) {
    return optionsArray;
  }
  options.forEach((item, index) => {
    optionsArray[opts[index]] = item;
  })

  return optionsArray;
}

const get_opts = (options = {}, rpta = null) => {

  var opts = [];
  var values = Object.values(options);

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

const questionTextCopy = (question, options) => {

  let questionCopy = "";
  console.log("question", question);
  if (question.type == 'question' || question.options) {

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

const get_options_map = ( question = null) => {

  var options = [];

  if (!question["options"]) {
    return options;
  }

  if (question.options instanceof Map) {

    question.options.forEach((e, key) => {
      let is_rpta = false;

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
        rpta: false
      });
    })

  }
  return options;
}

const get_template_option = (opciones, lgt = 8) => {

  let templateA = false;

  opciones.forEach((option, key) => {

    if ( option.length > lgt ) {
      templateA = true;
    }

  })

  return templateA;
}

const get_template_option_object = (opciones, lgt = 8) => {
  let templateA = false;
  if (!opciones) {
    return templateA;
  }
  Object.keys(opciones).forEach((item) => {
    var option = opciones[item];
    if (!templateA && option.length > lgt) {
      templateA = true;
    }
  })
  return templateA;
}
const base64_encode = (file) => {
  var bitmap = fs.readFileSync(file, 'base64');
  return bitmap;
}

export {
  get_template_option, get_opts,
  get_options_map, opt_options,
  get_template_option_object, optionsEmpty,
  questionTextCopy, textBlockCopy
};
