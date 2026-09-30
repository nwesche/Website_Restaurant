// ---------- Helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const euro = (n) => n.toLocaleString("de-DE", { style: "currency", currency: "EUR" });
// Kundeneingaben immer escapen, bevor sie ins HTML kommen
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const hhmm = (d) => d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });

function storage(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

const POLL_MS = 4000;
const REMINDER_MS = 30000;
const PAYMENT_LABEL = { bar: "💶 Bar kassieren", karte: "💳 Karte vor Ort", online: "✓ Online bezahlt" };

function paymentBadge(o) {
  if (o.payment === "online") {
    if (o.refundStatus === "erstattet") return '<span class="pay pay--refunded">↩ Erstattet</span>';
    if (o.refundStatus === "fehlgeschlagen") return '<span class="pay pay--error" title="Bitte im Stripe-Dashboard erstatten">⚠ Erstattung fehlgeschlagen</span>';
    return '<span class="pay pay--online">✓ Online bezahlt</span>';
  }
  return `<span class="pay pay--${o.payment}">${PAYMENT_LABEL[o.payment] || esc(o.payment)}</span>`;
}

const state = {
  pin: null,
  orders: [],
  snapshot: "",
  known: new Set(),
  flash: new Set(),
  firstLoad: true,
  clockOffset: 0, // Serverzeit − Tablet-Zeit
  view: "neu",
  soundOn: storage("kueche-sound", true),
  shop: { mode: "open", extraMinutes: 0, message: "" },
  cancelReasons: {},
};

const SHOP_LABEL = { open: "Online", pickup_only: "Nur Abholung", paused: "Pausiert" };
const CANCEL_SHORT = {
  ausverkauft: "🍽️ Gericht ausverkauft",
  liefergebiet: "📍 Außerhalb Liefergebiet",
  ueberlastet: "🔥 Küche überlastet",
  nicht_erreichbar: "📵 Kunde nicht erreichbar",
  kundenwunsch: "🙋 Auf Kundenwunsch",
  sonstiges: "✏️ Sonstiges",
};

let audioCtx = null;
let pollTimer, tickTimer, reminderTimer, wakeLock = null;

// ---------- API ----------
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", "X-Kitchen-Pin": state.pin, ...(options.headers || {}) },
  });
  if (res.status === 401) {
    logout("PIN ungültig oder geändert.");
    throw new Error("unauthorized");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Fehler");
  return data;
}

// ---------- Login ----------
async function login(pin) {
  state.pin = pin;
  const res = await fetch("/api/kitchen/orders", { headers: { "X-Kitchen-Pin": pin } }).catch(() => null);
  if (!res) return showLoginError("Server nicht erreichbar. Läuft start_server.bat auf dem PC?");
  if (res.status === 401) return showLoginError("Falsche PIN.");

  save("kueche-pin", pin);
  unlockAudio();
  $("#login").hidden = true;
  $("#app").hidden = false;
  requestWakeLock();
  applyOrders(await res.json());
  startLoops();
}

function logout(message) {
  stopLoops();
  save("kueche-pin", null);
  state.pin = null;
  state.firstLoad = true;
  state.known.clear();
  $("#app").hidden = true;
  $("#login").hidden = false;
  $("#pinInput").value = "";
  if (message) showLoginError(message);
}

function showLoginError(msg) {
  const el = $("#loginError");
  el.textContent = msg;
  el.hidden = false;
}

// ---------- Laden & Rendern ----------
async function poll() {
  try {
    const data = await api("/api/kitchen/orders");
    applyOrders(data);
    setConnection(true);
  } catch (e) {
    if (e.message !== "unauthorized") setConnection(false);
  }
}

function applyOrders(data) {
  state.clockOffset = Date.parse(data.serverTime) - Date.now();
  $("#testNotice").hidden = !data.testMode;
  state.shop = data.shop || state.shop;
  state.cancelReasons = data.cancelReasons || state.cancelReasons;
  renderShopBtn();

  // Neue Bestellungen erkennen
  const fresh = data.orders.filter((o) => o.status === "neu" && !state.known.has(o.number));
  data.orders.forEach((o) => state.known.add(o.number));
  if (!state.firstLoad && fresh.length) {
    playAlert();
    navigator.vibrate?.([200, 100, 200]);
    fresh.forEach((o) => {
      state.flash.add(o.number);
      setTimeout(() => { state.flash.delete(o.number); render(); }, 15000);
    });
    toast(fresh.length === 1 ? `🔔 Neue Bestellung #${fresh[0].number}` : `🔔 ${fresh.length} neue Bestellungen`);
  }
  state.firstLoad = false;

  const snapshot = JSON.stringify(data.orders.map((o) => [o.number, o.status, o.etaAt]));
  state.orders = data.orders;
  if (snapshot !== state.snapshot || fresh.length) {
    state.snapshot = snapshot;
    render();
  }
}

function now() {
  return new Date(Date.now() + state.clockOffset);
}

function minutesSince(iso) {
  return Math.max(0, Math.floor((now() - new Date(iso)) / 60000));
}

function render() {
  const by = (s) => state.orders.filter((o) => o.status === s).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const lanes = {
    neu: by("neu"),
    zubereitung: by("zubereitung"),
    fertig: by("fertig"),
    archiv: state.orders
      .filter((o) => o.status === "abgeschlossen" || o.status === "storniert")
      .sort((a, b) => b.statusChangedAt.localeCompare(a.statusChangedAt))
      .slice(0, 40),
  };

  const empty = {
    neu: "Keine neuen Bestellungen 🎉",
    zubereitung: "Gerade nichts in Arbeit",
    fertig: "Nichts wartet auf Abholung",
    archiv: "Noch nichts erledigt",
  };

  for (const [lane, list] of Object.entries(lanes)) {
    const key = lane[0].toUpperCase() + lane.slice(1);
    $(`#list${key}`).innerHTML = list.length ? list.map(card).join("") : `<p class="lane__empty">${empty[lane]}</p>`;
    $(`#count${key}`).textContent = list.length;
    $(`#laneCount${key}`).textContent = list.length;
  }

  // Kennzahlen (heute, ohne Stornos)
  const today = now().toDateString();
  const todays = state.orders.filter((o) => new Date(o.createdAt).toDateString() === today && o.status !== "storniert");
  $("#statOpen").textContent = lanes.neu.length + lanes.zubereitung.length + lanes.fertig.length;
  $("#statToday").textContent = todays.length;
  $("#statRevenue").textContent = euro(todays.reduce((s, o) => s + o.total, 0));

  const newCount = lanes.neu.length;
  document.title = newCount ? `(${newCount}) Neue Bestellung · Küche` : "Küche · Baan Siam";
  $('.lane-tab[data-lane="neu"]').classList.toggle("has-new", newCount > 0);
}

function card(o) {
  const c = o.customer;
  // Online-Bestellungen zählen ab Zahlungseingang (erst dann sind sie in der Küche)
  const age = minutesSince(o.paidAt || o.createdAt);
  const created = new Date(o.paidAt || o.createdAt);
  const isDelivery = o.mode === "delivery";
  const active = ["neu", "zubereitung", "fertig"].includes(o.status);

  // Dringlichkeit: neue Bestellung > 5 Min. unbearbeitet oder Wunschzeit in < 20 Min.
  let dueSoon = false;
  if (o.time !== "asap" && active && o.status !== "fertig") {
    const [h, m] = o.time.split(":").map(Number);
    const due = new Date(now()); due.setHours(h, m, 0, 0);
    dueSoon = (due - now()) / 60000 < 20;
  }
  const late = (o.status === "neu" && age >= 5) || dueSoon;

  const etaAt = o.etaAt ? new Date(o.etaAt) : null;
  const etaLeft = etaAt ? Math.round((etaAt - now()) / 60000) : null;
  const etaHtml =
    o.status === "zubereitung" && etaAt
      ? `<div class="order__eta ${etaLeft < 0 ? "is-over" : ""}">⏱ Zugesagt: <b>${hhmm(etaAt)} Uhr</b> <span>${etaLeft >= 0 ? `noch ${etaLeft} Min` : `${-etaLeft} Min drüber`}</span></div>`
      : "";

  const primary = {
    neu: { accept: true, label: "✓ Annehmen" },
    zubereitung: { to: "fertig", label: isDelivery ? "🛵 Losgeschickt" : "🛍️ Abholbereit" },
    fertig: { to: "abgeschlossen", label: "✔ Abschließen" },
    abgeschlossen: { to: "fertig", label: "↺ Wieder öffnen" },
    storniert: { to: "neu", label: "↺ Wiederherstellen" },
  }[o.status];
  const back = { zubereitung: "neu", fertig: "zubereitung" }[o.status];

  const address = isDelivery ? `${c.street}, ${c.zip} ${c.city}` : "";
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;

  return `
  <article class="order order--${o.status} ${late ? "is-late" : ""} ${state.flash.has(o.number) ? "is-flash" : ""}" data-number="${o.number}">
    <header class="order__head">
      <span class="order__no">#${o.number}</span>
      <span class="chip chip--${o.mode}">${isDelivery ? "🚚 Lieferung" : "🛍️ Abholung"}</span>
      <span class="order__age" title="Eingegangen ${hhmm(created)} Uhr">${active ? (age < 1 ? "gerade eben" : `vor ${age} Min`) : hhmm(created)}</span>
    </header>

    <div class="order__when ${o.time === "asap" ? "" : "order__when--timed"}">
      ${o.time === "asap" ? "⚡ So schnell wie möglich" : `⏰ Gewünscht: <b>${esc(o.time)} Uhr</b>`}
      ${o.status === "storniert" ? '<span class="chip chip--cancel">Storniert</span>' : ""}
    </div>
    ${etaHtml}
    ${o.status === "storniert" && o.cancelReason ? `<p class="order__cancel">${esc(CANCEL_SHORT[o.cancelReason] || o.cancelReason)}${o.cancelNote ? ` – ${esc(o.cancelNote)}` : ""}</p>` : ""}

    <ul class="order__items">
      ${o.items.map((i) => `<li><b>${i.qty}×</b><span>${esc(i.name)}</span></li>`).join("")}
    </ul>

    ${c.notes ? `<p class="order__notes">📝 ${esc(c.notes)}</p>` : ""}

    <div class="order__customer">
      <strong>${esc(c.name)}</strong>
      <a href="tel:${esc(c.phone.replace(/[^\d+]/g, ""))}">📞 ${esc(c.phone)}</a>
      ${isDelivery ? `<a href="${mapsUrl}" target="_blank" rel="noopener">📍 ${esc(address)}</a>` : ""}
    </div>

    <div class="order__sum">
      <span>${paymentBadge(o)}</span>
      <b>${euro(o.total)}</b>
    </div>

    <div class="order__actions">
      ${o.status === "storniert" && o.refundStatus
        ? `<button class="kbtn kbtn--grow" disabled>Erstattet – nicht wiederherstellbar</button>`
        : `<button class="kbtn ${active ? "kbtn--primary" : ""} kbtn--grow" ${primary.accept ? "data-accept" : `data-set="${primary.to}"`}>${primary.label}</button>`}
      ${o.status === "zubereitung" ? `<button class="kbtn kbtn--icon kbtn--text" data-delay="10" title="Kunde bekommt neue Uhrzeit">+10 Min</button>` : ""}
      ${back ? `<button class="kbtn kbtn--icon" data-set="${back}" title="Einen Schritt zurück" aria-label="Einen Schritt zurück">↶</button>` : ""}
      <button class="kbtn kbtn--icon" data-print title="Drucken" aria-label="Drucken">🖨</button>
      ${active ? `<button class="kbtn kbtn--icon kbtn--danger-ghost" data-cancel title="Stornieren" aria-label="Stornieren">✕</button>` : ""}
    </div>
  </article>`;
}

// ---------- Aktionen ----------
async function setStatus(number, status, extra = {}) {
  const order = state.orders.find((o) => o.number === number);
  if (!order) return;
  const previous = order.status;
  order.status = status; // sofort anzeigen, dann speichern
  state.snapshot = "";
  render();
  try {
    const saved = await api(`/api/kitchen/orders/${number}/status`, { method: "POST", body: JSON.stringify({ status, ...extra }) });
    Object.assign(order, saved);
    render();
    if (saved.refundStatus === "erstattet" && status === "storniert") toast(`↩ #${number}: ${euro(saved.total)} automatisch erstattet`);
    if (saved.refundStatus === "fehlgeschlagen") toast(`⚠ #${number}: Erstattung fehlgeschlagen – bitte im Stripe-Dashboard erstatten`);
  } catch (e) {
    if (e.message === "unauthorized") return;
    order.status = previous;
    render();
    toast(`⚠️ ${e.message === "Fehler" ? "Konnte Status nicht speichern – Verbindung prüfen" : e.message}`);
  }
}

async function delayOrder(number, minutes) {
  const order = state.orders.find((o) => o.number === number);
  try {
    Object.assign(order, await api(`/api/kitchen/orders/${number}/delay`, { method: "POST", body: JSON.stringify({ minutes }) }));
    state.snapshot = "";
    render();
    toast(`⏱ #${number}: neue Uhrzeit ${hhmm(new Date(order.etaAt))} Uhr – Kunde sieht sie sofort`);
  } catch (e) {
    if (e.message !== "unauthorized") toast("⚠️ Konnte Zeit nicht ändern");
  }
}

// Annehmen: Küche legt fest, wann die Bestellung fertig ist
function openAccept(number) {
  const o = state.orders.find((x) => x.number === number);
  if (!o) return;
  const delivery = o.mode === "delivery";
  const options = delivery ? [20, 30, 40, 50, 60, 90] : [10, 15, 20, 30, 45, 60];
  const suggested = options.reduce((best, m) => (Math.abs(m - o.prepMinutes) < Math.abs(best - o.prepMinutes) ? m : best));
  const at = (min) => hhmm(new Date(now().getTime() + min * 60000));

  $("#acceptTitle").textContent = `#${o.number} annehmen`;
  $("#acceptText").textContent = delivery
    ? "Wann ist das Essen beim Kunden? Er bekommt die Uhrzeit per E-Mail und auf der Status-Seite."
    : "Wann ist die Bestellung abholbereit? Der Kunde bekommt die Uhrzeit per E-Mail und auf der Status-Seite.";
  $("#acceptChoices").innerHTML =
    (o.time !== "asap" ? `<button type="button" class="choice choice--wish" data-wish><b>Zur Wunschzeit</b><span>${esc(o.time)} Uhr</span></button>` : "") +
    options
      .map((m) => `<button type="button" class="choice ${m === suggested && o.time === "asap" ? "is-suggested" : ""}" data-minutes="${m}"><b>${m} Min</b><span>${at(m)} Uhr</span></button>`)
      .join("");

  const dialog = $("#acceptDialog");
  dialog.onclick = (e) => {
    const choice = e.target.closest(".choice");
    if (!choice) return;
    dialog.close();
    setStatus(number, "zubereitung", choice.dataset.wish !== undefined ? { etaAt: "wish" } : { etaMinutes: +choice.dataset.minutes });
  };
  dialog.showModal();
}

function openCancel(number) {
  const dialog = $("#cancelDialog");
  let reason = null;
  const order = state.orders.find((o) => o.number === number);
  $("#cancelTitle").textContent = `#${number} stornieren`;
  $("#cancelRefundNote").hidden = order?.paymentStatus !== "bezahlt";
  $("#cancelRefundNote").textContent = `✓ Online bezahlt – ${euro(order?.total || 0)} werden automatisch erstattet.`;
  $("#cancelNote").value = "";
  $("#cancelConfirm").disabled = true;
  $("#cancelChoices").innerHTML = Object.keys(state.cancelReasons)
    .map((key) => `<button type="button" class="choice choice--row" data-reason="${key}">${CANCEL_SHORT[key] || key}</button>`)
    .join("");
  $("#cancelChoices").onclick = (e) => {
    const btn = e.target.closest("[data-reason]");
    if (!btn) return;
    reason = btn.dataset.reason;
    $$("#cancelChoices .choice").forEach((b) => b.classList.toggle("is-selected", b === btn));
    $("#cancelConfirm").disabled = false;
  };
  dialog.returnValue = "";
  dialog.addEventListener(
    "close",
    () => dialog.returnValue === "ok" && reason && setStatus(number, "storniert", { reason, note: $("#cancelNote").value.trim() }),
    { once: true }
  );
  dialog.showModal();
}

// ---------- Online-Bestellungen steuern ----------
function renderShopBtn() {
  const { mode, extraMinutes } = state.shop;
  const btn = $("#shopBtn");
  btn.dataset.mode = mode;
  $("#shopBtnText").textContent = SHOP_LABEL[mode] + (extraMinutes && mode !== "paused" ? ` · +${extraMinutes}` : "");
}

function openShopDialog() {
  const draft = { ...state.shop };
  const sync = () => {
    $$("#shopModes button").forEach((b) => b.classList.toggle("is-active", b.dataset.mode === draft.mode));
    $$("#shopExtra button").forEach((b) => b.classList.toggle("is-active", +b.dataset.extra === draft.extraMinutes));
  };
  $("#shopModes").onclick = (e) => { const b = e.target.closest("[data-mode]"); if (b) { draft.mode = b.dataset.mode; sync(); } };
  $("#shopExtra").onclick = (e) => { const b = e.target.closest("[data-extra]"); if (b) { draft.extraMinutes = +b.dataset.extra; sync(); } };
  $("#shopMessage").value = draft.message || "";
  sync();

  const dialog = $("#shopDialog");
  dialog.returnValue = "";
  dialog.addEventListener("close", async () => {
    if (dialog.returnValue !== "ok") return;
    draft.message = $("#shopMessage").value.trim();
    try {
      state.shop = await api("/api/kitchen/shop", { method: "POST", body: JSON.stringify(draft) });
      renderShopBtn();
      toast(`Online-Bestellungen: ${SHOP_LABEL[state.shop.mode]}${state.shop.extraMinutes ? `, +${state.shop.extraMinutes} Min` : ""}`);
    } catch (e) {
      if (e.message !== "unauthorized") toast("⚠️ Konnte Einstellung nicht speichern");
    }
  }, { once: true });
  dialog.showModal();
}

function printOrder(number) {
  const o = state.orders.find((x) => x.number === number);
  if (!o) return;
  const c = o.customer;
  $("#printArea").innerHTML = `
    <div class="receipt">
      <h1>Baan Siam</h1>
      <p class="receipt__big">#${o.number} · ${o.mode === "delivery" ? "LIEFERUNG" : "ABHOLUNG"}</p>
      <p>${new Date(o.createdAt).toLocaleString("de-DE")}<br>Zeit: ${o.time === "asap" ? "Sofort" : esc(o.time) + " Uhr"}</p>
      <hr>
      ${o.items.map((i) => `<div class="receipt__row"><span>${i.qty}× ${esc(i.name)}</span><span>${euro(i.price * i.qty)}</span></div>`).join("")}
      <hr>
      ${o.fee ? `<div class="receipt__row"><span>Liefergebühr</span><span>${euro(o.fee)}</span></div>` : ""}
      <div class="receipt__row receipt__big"><span>Gesamt</span><span>${euro(o.total)}</span></div>
      <p>Zahlung: ${PAYMENT_LABEL[o.payment] || esc(o.payment)}</p>
      ${c.notes ? `<hr><p><b>Anmerkung:</b> ${esc(c.notes)}</p>` : ""}
      <hr>
      <p><b>${esc(c.name)}</b><br>${esc(c.phone)}${o.mode === "delivery" ? `<br>${esc(c.street)}<br>${esc(c.zip)} ${esc(c.city)}` : ""}</p>
    </div>`;
  window.print();
}

// ---------- Ton ----------
function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume();
  } catch { audioCtx = null; }
}

function playAlert(soft = false) {
  if (!state.soundOn || !audioCtx) return;
  audioCtx.resume();
  const notes = soft ? [880, 660] : [880, 1175, 880, 1175];
  notes.forEach((freq, i) => {
    const t = audioCtx.currentTime + i * 0.22;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(soft ? 0.25 : 0.6, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.22);
  });
}

function renderSoundBtn() {
  const btn = $("#soundBtn");
  btn.textContent = state.soundOn ? "🔔" : "🔕";
  btn.classList.toggle("is-off", !state.soundOn);
}

// ---------- Bildschirm anlassen (nur bei https/localhost verfügbar) ----------
async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch { /* nicht unterstützt – Bildschirm-Timeout am Tablet deaktivieren */ }
}

// ---------- Schleifen ----------
function startLoops() {
  stopLoops();
  pollTimer = setInterval(poll, POLL_MS);
  tickTimer = setInterval(tick, 15000);
  // Erinnerungston, solange neue Bestellungen unbeantwortet sind
  reminderTimer = setInterval(() => {
    if (state.orders.some((o) => o.status === "neu")) playAlert(true);
  }, REMINDER_MS);
  tick();
}
function stopLoops() {
  clearInterval(pollTimer);
  clearInterval(tickTimer);
  clearInterval(reminderTimer);
}
function tick() {
  $("#clock").textContent = hhmm(now());
  render(); // „vor X Min“ aktualisieren
}

function setConnection(ok) {
  const el = $("#conn");
  el.classList.toggle("is-offline", !ok);
  $("em", el).textContent = ok ? "Live" : "Keine Verbindung";
}

// ---------- Ansicht (schmale Bildschirme: eine Spalte) ----------
function setView(view) {
  state.view = view;
  $("#board").dataset.view = view;
  $$(".lane-tab").forEach((t) =>
    t.classList.toggle("is-active", t.dataset.lane === view || (t.dataset.lane === "aktiv" && view !== "archiv"))
  );
}

let toastTimer;
function toast(msg) {
  const t = $("#ktoast");
  t.textContent = msg;
  t.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("is-visible"), 4000);
}

// ---------- Events ----------
$("#loginForm").addEventListener("submit", (e) => {
  e.preventDefault();
  $("#loginError").hidden = true;
  login($("#pinInput").value.trim());
});

$("#board").addEventListener("click", (e) => {
  const cardEl = e.target.closest(".order");
  if (!cardEl) return;
  const number = +cardEl.dataset.number;
  const setBtn = e.target.closest("[data-set]");
  if (setBtn) return setStatus(number, setBtn.dataset.set);
  if (e.target.closest("[data-accept]")) return openAccept(number);
  const delayBtn = e.target.closest("[data-delay]");
  if (delayBtn) return delayOrder(number, +delayBtn.dataset.delay);
  if (e.target.closest("[data-cancel]")) return openCancel(number);
  if (e.target.closest("[data-print]")) return printOrder(number);
});

$("#lanesNav").addEventListener("click", (e) => {
  const tab = e.target.closest(".lane-tab");
  if (!tab) return;
  setView(tab.dataset.lane === "aktiv" ? "neu" : tab.dataset.lane);
});

$("#soundBtn").addEventListener("click", () => {
  state.soundOn = !state.soundOn;
  save("kueche-sound", state.soundOn);
  renderSoundBtn();
  unlockAudio();
  if (state.soundOn) playAlert(true);
});

$("#fullscreenBtn").addEventListener("click", () => {
  const el = document.documentElement;
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
  } else {
    (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
  }
});

$("#logoutBtn").addEventListener("click", () => logout());
$("#shopBtn").addEventListener("click", openShopDialog);

document.addEventListener("visibilitychange", () => {
  if (document.hidden || !state.pin) return;
  poll();
  requestWakeLock();
  audioCtx?.resume();
});

// ---------- Start ----------
(function init() {
  // „Aktiv“-Tab für breite Bildschirme (alle drei Spalten gleichzeitig)
  $("#lanesNav").insertAdjacentHTML("afterbegin", '<button class="lane-tab lane-tab--all is-active" data-lane="aktiv">Aktive Bestellungen</button>');
  renderSoundBtn();
  setView("neu");
  const savedPin = storage("kueche-pin", null);
  if (savedPin) $("#pinInput").value = savedPin;
  $("#pinInput").focus();
})();
