// Vercel Serverless Function entry point
const { appHandler } = require('../server');

module.exports = (req, res) => {
  return appHandler(req, res);
};
