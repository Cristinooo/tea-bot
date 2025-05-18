const config = require("./config/config");
const colors = require("colors");
const axios = require("axios");
const Captcha = require("2captcha");
const settings = require("./config/config");
const solver = new Captcha.Solver(settings.API_KEY_2CAPTCHA);

// Sitekey & Domain
const solveCaptcha = async () => {
  const sitekey = settings.WEBSITE_KEY;
  const domain = settings.CAPTCHA_URL;

  // Solve the captcha
  return solver
    .hcaptcha(sitekey, domain)
    .then((res) => {
      console.log(colors.green("Captcha solved successfully!"));
      return res.data;
    })
    .catch((err) => {
      console.error(colors.red("Error solving captcha: "), err);
      return null;
    });
};

module.exports = { solveCaptcha };
