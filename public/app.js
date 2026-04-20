(function () {
  'use strict';

  const qs = new URLSearchParams(window.location.search);
  const code = qs.get('code');

  const loadingOverlay = document.getElementById('loadingOverlay');
  const errorContainer = document.getElementById('errorContainer');
  const app = document.getElementById('app');
  const stickyCta = document.getElementById('stickyCta');
  const stickyLabel = document.getElementById('stickyLabel');
  const stickyLink = document.getElementById('stickyLink');

  let billingMode = 'monthly';
  let currentOffer = null;

  const formatEUR = (num) => {
    if (typeof num !== 'number' || Number.isNaN(num)) return '-';
    return num.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  };

  const setText = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  const normalizeTarifeForUI = (tarife = {}) => {
    const basis = tarife.Basis?.gesamt || 0;
    const smart = tarife.Smart?.gesamt || 0;

    return {
      Basis: { ...tarife.Basis, gesamt: basis },
      Smart: { ...tarife.Smart, gesamt: smart },
      Komfort: { ...tarife.Komfort }
    };
  };

  function setSummary(listId, summary) {
    const ul = document.getElementById(listId);
    if (!ul || !Array.isArray(summary) || summary.length === 0) return;
    ul.innerHTML = summary.slice(0, 3).map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  }

  function valueForMode(monthlyValue, mode) {
    if (typeof monthlyValue !== 'number' || Number.isNaN(monthlyValue)) return monthlyValue;
    return mode === 'yearly' ? monthlyValue * 12 : monthlyValue;
  }

  function renderPrices(offer, mode = billingMode) {
    const tarife = normalizeTarifeForUI(offer.tarife || {});

    setText('preisBasis', formatEUR(valueForMode(tarife.Basis?.gesamt, mode)));
    setText('preisSmart', formatEUR(valueForMode(tarife.Smart?.gesamt, mode)));
    setText('preisKomfort', formatEUR(valueForMode(tarife.Komfort?.gesamt, mode)));

    setSummary('summaryBasis', tarife.Basis?.summary);
    setSummary('summarySmart', tarife.Smart?.summary);
    setSummary('summaryKomfort', tarife.Komfort?.summary);

    const original = tarife.Komfort?.originalPrice;
    const special = !!tarife.Komfort?.specialPrice;

    const originalEl = document.getElementById('komfortOriginal');
    const specialEl = document.getElementById('komfortSpecial');
    const savingEl = document.getElementById('komfortSaving');

    if (special && original && tarife.Komfort?.gesamt) {
      originalEl.classList.remove('hidden');
      specialEl.classList.remove('hidden');
      savingEl.classList.remove('hidden');
      originalEl.textContent = formatEUR(valueForMode(original, mode));

      const yearly = Math.max(0, (original - tarife.Komfort.gesamt) * 12);
      savingEl.textContent = `Jahresersparnis: ${formatEUR(yearly)}`;
    } else {
      originalEl.classList.add('hidden');
      specialEl.classList.add('hidden');
      savingEl.classList.add('hidden');
    }
  }

  function renderAddons(offer, mode = billingMode) {
    const addons = offer.addons || {};
    const bike = addons.fahrradschutz || {};
    const glass = addons.glasschutz || {};

    setText('addonBikeBasic', formatEUR(valueForMode(bike.basic, mode)));
    setText('addonBikePremium', formatEUR(valueForMode(bike.premium, mode)));
    setText('addonGlassHousehold', formatEUR(valueForMode(glass.hausrat, mode)));
    setText('addonGlassBuilding', formatEUR(valueForMode(glass.gebaeude, mode)));
    setText('addonWeather', formatEUR(valueForMode(addons.extremwetterschutz, mode)));
  }

  function renderHero(offer) {
    const input = offer.input || {};
    setText('customerName', 'Ihr persönliches Privatschutz-Angebot');
    setText('tagPlz', `PLZ: ${input.plz || '-'}`);
    setText('tagWohnflaeche', `Wohnfläche: ${input.wohnflaeche ? input.wohnflaeche + ' m²' : '-'}`);
    setText('tagFamilienstand', `Familienstand: ${input.familienstand || '-'}`);
  }

  function updateBillingUI() {
    const billingToggle = document.querySelector('.billing-toggle');
    if (!billingToggle) return;

    const labels = billingToggle.querySelectorAll('.toggle-label');
    const toggleSwitch = billingToggle.querySelector('.toggle-switch');
    const toggleKnob = toggleSwitch ? toggleSwitch.querySelector('span') : null;

    if (labels.length >= 2) {
      labels[0].classList.toggle('active', billingMode === 'monthly');
      labels[1].classList.toggle('active', billingMode === 'yearly');
    }

    if (toggleSwitch) {
      toggleSwitch.style.cursor = 'pointer';
      toggleSwitch.setAttribute('aria-pressed', String(billingMode === 'yearly'));
      toggleSwitch.title = billingMode === 'yearly' ? 'Jährliche Preise anzeigen' : 'Monatliche Preise anzeigen';
    }

    if (toggleKnob) {
      toggleKnob.style.transform = billingMode === 'yearly' ? 'translateX(22px)' : 'translateX(0)';
      toggleKnob.style.transition = 'transform .18s ease';
    }

    document.querySelectorAll('.price-main small').forEach((el) => {
      el.textContent = billingMode === 'yearly' ? '/Jahr' : '/Monat';
    });
  }

  function wirePlanButtons() {
    const buttons = document.querySelectorAll('.select-plan');
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const plan = btn.dataset.plan;
        window.location.href = `/checkout?plan=${encodeURIComponent(plan)}&code=${encodeURIComponent(code || '')}`;
      });
    });

    const defaultPlan = 'Komfort';
    stickyLabel.textContent = `${defaultPlan} wählen`;
    stickyLink.href = `/checkout?plan=${encodeURIComponent(defaultPlan)}&code=${encodeURIComponent(code || '')}`;
  }

  function wireHighlightsToggle() {
    const toggle = document.getElementById('komfortToggle');
    const panel = document.getElementById('komfortHighlights');
    if (!toggle || !panel) return;

    toggle.addEventListener('click', () => {
      panel.classList.toggle('collapsed');
      const expanded = !panel.classList.contains('collapsed');
      toggle.textContent = expanded
        ? 'Exklusive Komfort-Highlights ausblenden'
        : 'Exklusive Komfort-Highlights anzeigen';
    });
  }

  function wireBillingToggle() {
    const toggleSwitch = document.querySelector('.toggle-switch');
    if (!toggleSwitch) return;

    toggleSwitch.addEventListener('click', () => {
      billingMode = billingMode === 'monthly' ? 'yearly' : 'monthly';
      updateBillingUI();

      if (currentOffer) {
        renderPrices(currentOffer, billingMode);
        renderAddons(currentOffer, billingMode);
      }
    });

    updateBillingUI();
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function loadOffer() {
    if (!code) {
      throw new Error('Kein code Parameter vorhanden');
    }

    const url = `/api/privatschutz/offer/${encodeURIComponent(code)}`;
    let response;
    try {
      response = await fetch(url);
    } catch (e) {
      throw new Error(`Netzwerkfehler: ${e.message}`);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Offer fetch failed (${response.status}): ${body}`);
    }

    return response.json();
  }

  function showApp() {
    loadingOverlay.classList.add('hidden');
    errorContainer.classList.add('hidden');
    app.classList.remove('hidden');
    stickyCta.classList.remove('hidden');
  }

  function showError() {
    loadingOverlay.classList.add('hidden');
    app.classList.add('hidden');
    stickyCta.classList.add('hidden');
    errorContainer.classList.remove('hidden');
  }

  (async function init() {
    try {
      const offer = await loadOffer();
      currentOffer = offer;
      renderHero(offer);
      renderPrices(offer, billingMode);
      renderAddons(offer, billingMode);
      wirePlanButtons();
      wireHighlightsToggle();
      wireBillingToggle();
      showApp();
    } catch (err) {
      console.error(err);
      showError();
    }
  })();
})();
