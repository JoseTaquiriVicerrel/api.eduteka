import '#Config/env.js';
import connectDB from '#Config/db.js';
import httpServer from "#Config/http.js";

const boostrap = async () => {

    await connectDB(process.env.MONGODB_URI);

    httpServer.listen(process.env.PORT, () => {
        console.log("Ejecuntando el puerto: " + process.env.PORT);
    });

}
boostrap();
