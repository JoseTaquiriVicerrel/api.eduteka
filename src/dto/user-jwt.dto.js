const userRolJWTDTO = (role) => {
  return async function (req, res, next) {
    const sessionCokie = req.cookies.session || "";

    if (sessionCokie == "") return res.redirect('/login');

    try {
      const encoder = new TextEncoder();
      const { payload } = await jwtVerify(sessionCokie, encoder.encode(process.env.JWT_PRIVATE_KEY));

      const user = await UserModel.findById(payload.uid).exec();

      if (user.rol != role && role != "Auth") {
        return res.status(404).send('Forbidden');
      } else {
        next();
      }

    } catch (err) {
      console.log(err);
      res.redirect('/login');
    }
  }
}
export default userRolJWTDTO;