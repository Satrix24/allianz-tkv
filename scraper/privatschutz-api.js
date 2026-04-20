const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const GRAPHQL_URL = 'https://inno-prod.allianz.de/bundle/op/graphql';

function toBase64Utf8(value) {
  return Buffer.from(String(value), 'utf8').toString('base64');
}

async function gql(operationName, query, variables = {}) {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operationName, query, variables })
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (_) {
    json = { raw: text };
  }

  if (!res.ok) {
    const err = new Error(`GraphQL HTTP ${res.status}`);
    err.status = res.status;
    err.details = json;
    throw err;
  }

  if (json?.errors?.length) {
    const err = new Error(json.errors[0]?.message || `${operationName} failed`);
    err.details = json.errors;
    throw err;
  }

  return json.data;
}

async function gqlViaCurl(operationName, query, variables = {}) {
  const body = JSON.stringify({ operationName, query, variables });

  const args = [
    '--silent',
    '--max-time', '20',
    '--proxy', 'socks5h://127.0.0.1:9050',
    '-X', 'POST',
    GRAPHQL_URL,
    '-H', 'Content-Type: application/json',
    '-H', 'Origin: https://www.allianz.de',
    '-H', 'Referer: https://www.allianz.de/',
    '-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    '-d', body
  ];

  const { stdout } = await execFileAsync('curl', args, { timeout: 25000 });
  const json = JSON.parse(stdout);

  if (json?.errors?.length) {
    const err = new Error(json.errors[0]?.message || `${operationName} failed`);
    err.details = json.errors;
    throw err;
  }

  if (json?.data === undefined) {
    throw new Error(`${operationName}: no data`);
  }

  return json.data;
}

async function gqlWithFallback(operationName, query, variables = {}) {
  try {
    return await gqlViaCurl(operationName, query, variables);
  } catch (_) {
    return await gql(operationName, query, variables);
  }
}

function mapHouseType(gebaeudeart = '') {
  const s = String(gebaeudeart || '').trim().toLowerCase();
  if (s.includes('haus') || s.includes('house') || s === 'einfamilienhaus') return 'HOUSE';
  return 'APARTMENT';
}

function mapFloor(etage = '') {
  // Allianz API akzeptiert nur 'FIRST' — GROUND_FLOOR/UPPER_FLOOR werden abgelehnt
  return 'FIRST';
}

function normalizeHouseType(value) {
  return mapHouseType(value);
}

function normalizeFloor(value) {
  return mapFloor(value);
}

function normalizeInput(input = {}) {
  const rawWohn = Number(String(input.wohnflaeche ?? '').replace(',', '.'));
  return {
    plz: String(input.plz || '').trim(),
    wohnflaeche: Number.isFinite(rawWohn) ? rawWohn : NaN,
    familienstand: String(input.familienstand || '').trim() || 'Single',
    geburtsdatum: String(input.geburtsdatum || '').trim(),
    gebaeudeart: normalizeHouseType(input.gebaeudeart),
    etage: normalizeFloor(input.etage),
    coverageSuggestion: input.coverageSuggestion ? String(input.coverageSuggestion).trim() : 'RECOMMENDED',
    payment_schedule: input.payment_schedule ? String(input.payment_schedule).trim() : 'M'
  };
}

function validateInput(data) {
  const missing = [];
  if (!data.plz) missing.push('plz');
  if (!data.wohnflaeche || Number.isNaN(data.wohnflaeche)) missing.push('wohnflaeche');
  if (!data.familienstand) missing.push('familienstand');
  if (!data.geburtsdatum) missing.push('geburtsdatum');
  if (missing.length) throw new Error(`Fehlende/ungültige Felder: ${missing.join(', ')}`);
  if (!/^\d{5}$/.test(data.plz)) throw new Error('PLZ muss 5-stellig sein');
  if (!/^\d{2}\.\d{2}\.\d{4}$/.test(data.geburtsdatum)) throw new Error('Geburtsdatum muss TT.MM.JJJJ sein');
}

function mapScope(familienstand = '') {
  const s = familienstand.toLowerCase();
  if (s.includes('familie') || s.includes('kind')) return 'ME_MY_PARTNER_AND_MY_CHILDREN';
  if (s.includes('paar') || s.includes('partner')) return 'ME_AND_MY_PARTNER';
  return 'ME';
}

function buildOrder({ orderSessionId, plz, city, street, streetNo, wohnflaeche, geburtsdatum, familienstand, gebaeudeart, etage, coverageSuggestion, payment_schedule }) {
  return {
    id: null,
    applicationNumber: null,
    sessionId: orderSessionId,
    hash: null,
    step: 1,
    currentStep: 1,
    firstPageValid: true,
    useragent: 'Mozilla/5.0',
    leadId: null,
    confirmSectionsValidated: false,
    consultation: false,
    consultationAt: null,
    contractDocuments: false,
    contractDocumentsAt: null,
    downloadDocuments: false,
    downloadDocumentsAt: null,
    finished: false,
    finishedAt: null,
    agencyMail: false,
    agencyMailAt: null,
    agencyId: null,
    agencyIdChanged: false,
    agencySite: false,
    agencyDecision: 'AGENCY',
    context: 'GENERAL',
    bundleType: 'STANDARD',
    abTest: { group: 'A', tests: [], id: null },
    nlf: {
      valid: true,
      age: null,
      birthdate: geburtsdatum,
      zip: plz,
      city,
      dropdown: 'OPTION_A',
      street,
      streetNumber: streetNo,
      livingSpace: Number(wohnflaeche),
      scope: mapScope(familienstand)
    },
    person: [{
      salutation: 'UNKNOWN',
      firstname: '',
      lastname: '',
      street,
      number: streetNo,
      zip: plz,
      city,
      age: null,
      birthdate: geburtsdatum,
      coverageSuggestion: coverageSuggestion || 'RECOMMENDED',
      coverage: 65000,
      coverageExt: 0,
      objectValue: 0,
      underInsured: false,
      retention: 150,
      product: '',
      options: [],
      payment_schedule: payment_schedule || 'M',
      contract_term: 1,
      email: null,
      phone: null
    }],
    price: 0,
    originalPrice: 0,
    pricePositions: [],
    trackingId: null,
    visitorId: '',
    contactByEmail: false,
    contactByEmailAt: null,
    got_insurance: null,
    previous_insurance: null,
    previous_insurance_list: [],
    valueMoreThanAllowed: null,
    vhv_houseInhabitedStatus: null,
    vhv_got_damage: null,
    vhv_damage_count: 0,
    vhv_damage_bike_count: 0,
    vhv_damage_house_count: 0,
    vhv_marital_status: null,
    ph_got_damage: null,
    ph_damage_count: 0,
    rentedApartments: [],
    start_date: null,
    got_agency: null,
    want_agency: null,
    bank: { name: null, owner: null, iban: null, bic: null, sepaMandate: false, sepaMandateAt: null },
    consultationProtocol: null,
    bikeDamageSelection: null,
    mazData: { token: null, importedData: false },
    phPrice: null,
    vhvPrice: null,
    isTest: false,
    houseHold: {
      houseType: mapHouseType(gebaeudeart),
      apartmentFloor: mapFloor(etage)
    }
  };
}

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function byIdent(contracts, identPrefix) {
  const c = (contracts || []).find((x) => String(x.contractIdent || '').startsWith(identPrefix));
  return round2(c?.reducedPrice || 0);
}

function mapProduct(product) {
  const contracts = product?.includedContracts || [];
  const hausrat = byIdent(contracts, 'VHV');
  const haftpflicht = byIdent(contracts, 'PH');
  const rechtsschutz = byIdent(contracts, 'RS');

  return {
    gesamt: round2(product?.priceAmount || 0),
    hausrat,
    haftpflicht,
    rechtsschutz,
    originalPrice: round2(product?.originalPriceAmount || 0),
    discountPercent: round2(product?.priceDiscount || 0),
    title: product?.title || '',
    ident: product?.ident || '',
    includedContracts: contracts
  };
}

function mapAddonsFromProduct(products = []) {
  const bronze = products.find((p) => p.ident === 'HP001') || products[0] || null;
  const allOptions = (bronze?.includedContracts || []).flatMap((c) => c.options || []);
  const priceByIdent = Object.fromEntries(allOptions.map((o) => [o.ident, round2(o.price)]));

  return {
    fahrradschutz: {
      basic: priceByIdent.RAD || null,
      premium: null
    },
    glasschutz: {
      hausrat: priceByIdent.GLI || null,
      gebaeude: priceByIdent.GLA || null
    },
    extremwetterschutz: priceByIdent.ELE || null,
    rawOptions: allOptions
  };
}


async function fetchProductsForOrder(encodedOrder) {
  const canData = await gqlWithFallback(
    'canGetProducts',
    `query canGetProducts($order: String!) { canGetProducts(order: $order) }`,
    { order: encodedOrder }
  );

  if (!canData?.canGetProducts) {
    throw new Error('canGetProducts=false');
  }

  const productsData = await gqlWithFallback(
    'fetch_products',
    `query fetch_products($order: String!) {
      productResponse: getProducts(order: $order) {
        products {
          ident
          title
          priceAmount
          originalPriceAmount
          priceDiscount
          includedContracts {
            contractIdent
            originalPrice
            reducedPrice
            options {
              ident
              title
              price
            }
          }
        }
      }
    }`,
    { order: encodedOrder }
  );

  const products = productsData?.productResponse?.products || [];
  if (!products.length) {
    throw new Error('Keine Produkte aus fetch_products erhalten');
  }

  return products;
}

async function calculateViaAPI(rawInput = {}) {
  const input = normalizeInput(rawInput);
  validateInput(input);

  const orderSessionData = await gqlWithFallback(
    'createOrderSession',
    `mutation createOrderSession { orderSessionId: createOrderSession }`
  );

  const orderSessionId = orderSessionData?.orderSessionId;
  if (!orderSessionId) {
    throw new Error('Keine orderSessionId erhalten');
  }

  const countryData = await gqlWithFallback(
    'match_country',
    `query match_country($requestedType: GeoInformationType!, $requestedValue: String!) {
      matchCountry(requestedType: $requestedType, requestedValue: $requestedValue) {
        matchedCountryCode
        matchedCity
        matchedCities
      }
    }`,
    { requestedType: 'ZIP_CODE', requestedValue: input.plz }
  );

  const city = countryData?.matchCountry?.matchedCity || 'München';

  const addressesData = await gqlWithFallback(
    'listAddresses',
    `query listAddresses($zip: String!, $city: String!) {
      listAddresses(zip: $zip, city: $city)
    }`,
    { zip: input.plz, city }
  );

  const street = Array.isArray(addressesData?.listAddresses) && addressesData.listAddresses.length
    ? addressesData.listAddresses[0]
    : 'Alter Hof';

  const buildAndEncodeOrder = (overrides = {}) => {
    const order = buildOrder({
      orderSessionId,
      plz: input.plz,
      city,
      street,
      streetNo: '1',
      wohnflaeche: input.wohnflaeche,
      geburtsdatum: input.geburtsdatum,
      familienstand: input.familienstand,
      gebaeudeart: input.gebaeudeart,
      etage: input.etage,
      coverageSuggestion: input.coverageSuggestion,
      payment_schedule: input.payment_schedule,
      ...overrides
    });
    return toBase64Utf8(JSON.stringify(order));
  };

  const explicitlySetFloor = Object.prototype.hasOwnProperty.call(rawInput || {}, 'etage')
    && String(rawInput.etage || '').trim() !== '';

  let products;
  let usedFloor = input.etage;

  try {
    products = await fetchProductsForOrder(buildAndEncodeOrder());
  } catch (err) {
    const shouldRetryWithFirst = !explicitlySetFloor && input.etage === 'GROUND_FLOOR';
    if (!shouldRetryWithFirst) throw err;

    products = await fetchProductsForOrder(buildAndEncodeOrder({ etage: 'UPPER_FLOOR' }));
    usedFloor = 'UPPER_FLOOR';
  }

  const basis = products.find((p) => p.ident === 'HP001') || products[0];
  const smart = products.find((p) => p.ident === 'HP002') || products[1] || basis;
  const komfort = products.find((p) => p.ident === 'HP003') || products[2] || smart;

  return {
    Basis: mapProduct(basis),
    Smart: mapProduct(smart),
    Komfort: mapProduct(komfort),
    addons: mapAddonsFromProduct(products),
    _meta: {
      source: 'graphql-api',
      orderSessionId,
      city,
      street,
      requestedFloor: input.etage,
      usedFloor,
      operations: ['createOrderSession', 'match_country', 'listAddresses', 'canGetProducts', 'fetch_products']
    }
  };
}


module.exports = { calculateViaAPI };
