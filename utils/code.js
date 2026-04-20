const crypto = require('crypto');

function generateOfferCode() {
  const ts = Date.now().toString(36).toUpperCase();
  const rnd = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `PS-${ts}-${rnd}`;
}

module.exports = {
  generateOfferCode
};
