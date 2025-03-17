import { reportTypeError } from 'ajv/dist/compile/validate/dataType.js';
import { v2 as cloudinary } from 'cloudinary';

cloudinary.config({
    cloud_name: 'daogief4l',
    api_key: '129111276328194',
    api_secret: 'N9zM9nrHSPiN3UzWIQnkSLQAdnc'
});

const upload = async function (filename,folder) {
    return new Promise((resolve, reject) => {

        cloudinary.uploader.upload( filename , {
            folder: folder,
            use_filename: true,
        }, (error, result) => {
            if (error) {
                resolve({ status:true, error });
                // return { status: false, error: error };
                // console.log("error", error);
            }
            // console.log("result", result);
            resolve({ status: true, result: result });
            // return { status: true, result: result };
        })

    })
}

const getImage = async function (public_file) {
    console.log('Public -Id', public_id);
    var public_id = public_file.split(".")[0];
    return new Promise((resolve, reject) => {
        var result = cloudinary.api.resource(public_id, { colors: true })
        // resolve({ status: true, result: result });
        .then((result) => {
            resolve({ status: true, result: result });
        }).catch((error) => {
            resolve({ status: false, message: error });
        })
    })
}

export { upload,getImage };