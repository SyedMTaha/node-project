//Prints the time, method, and URL of every request
//old method


module.exports = (req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next(); // without this, the request hangs forever
};