function asString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function normalizePrivatschutzWebhook(body = {}) {
  return {
    name:         asString(body.name || body.kundenname || body.kunde_name || body.fullName),
    telefon:      asString(body.telefon || body.phone || body.tel || body.mobile),
    email:        asString(body.email || body.mail),
    plz:          asString(body.plz || body.postleitzahl || body.zip || body.postal_code),
    wohnflaeche:  toNumber(body.wohnflaeche || body.wohnfläche || body.living_space || body.qm),
    familienstand: asString(body.familienstand || body.family_status || body.haushalt),
    geburtsdatum: asString(body.geburtsdatum || body.birthdate || body.dob),
  };
}

function validatePrivatschutzWebhook(payload) {
  const errors = [];
  if (!payload.plz)           errors.push('plz fehlt');
  if (!payload.wohnflaeche)   errors.push('wohnflaeche fehlt');
  if (!payload.familienstand) errors.push('familienstand fehlt');
  if (!payload.geburtsdatum)  errors.push('geburtsdatum fehlt');
  if (payload.plz && !/^\d{5}$/.test(payload.plz)) errors.push('plz muss 5-stellig sein');
  return { valid: errors.length === 0, errors };
}

module.exports = { normalizePrivatschutzWebhook, validatePrivatschutzWebhook };
