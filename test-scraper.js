const { calculateOffer } = require('./scraper/allianz-scraper');
const path = require('path');

calculateOffer({
  plz: '87435',
  geburtsdatum_halter: '01.01.1990',
  tierart: 'Hund',
  geschlecht: 'männlich',
  tiername: 'Max',
  geburtsdatum_tier: '15.06.2022',
  tarifPraferenz: 'OP-Schutz'
}, {
  downloadsDir: path.join(__dirname, 'downloads'),
  headless: true
}).then(result => {
  console.log('SUCCESS:', JSON.stringify(result, null, 2));
}).catch(err => {
  console.error('FEHLER:', err.message);
  if (err.details?.artifacts) console.log('Screenshots:', err.details.artifacts);
});
