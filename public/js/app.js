// ---------- Helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const euro = (n) => n.toLocaleString("de-DE", { style: "currency", currency: "EUR" });
const DAY_NAMES = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];

function storage(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

const hhmm = (iso) => (iso ? iso.slice(11, 16) : "");

// Werden aus menu.json geladen
let MENU = [], CATEGORIES = [], HOURS = {}, SETTINGS = {}, ALLERGENS = {};
// Wird von der Küche gesteuert (Pause, nur Abholung, Zusatz-Wartezeit)
let SHOP = { mode: "open", extraMinutes: 0, message: "" };

// ---------- State ----------
const state = {
  category: "all",
  veggieOnly: false,
  query: "",
  excludedAllergens: storage("baansiam-allergens", []),
  cart: storage("baansiam-cart", {}), // { [id]: qty }
  mode: storage("baansiam-mode", "delivery"),
  activeOrder: storage("baansiam-active-order", null), // { token, number, mode, time, prepMinutes, status }
  submitting: false,
};

// ---------- Menu ----------
function renderTabs() {
  $("#categoryTabs").innerHTML = CATEGORIES.map(
    (c) => `<button class="tab ${c.id === state.category ? "is-active" : ""}" data-cat="${c.id}" role="tab" aria-selected="${c.id === state.category}">${c.label}</button>`
  ).join("");
}

function renderMenu() {
  const q = state.query.trim().toLowerCase();
  const matches = MENU.filter(
    (m) =>
      (state.category === "all" || m.cat === state.category) &&
      (!state.veggieOnly || m.veggie) &&
      (!q || m.name.toLowerCase().includes(q) || m.desc.toLowerCase().includes(q))
  );
  const items = matches.filter((m) => !(m.allergens || []).some((a) => state.excludedAllergens.includes(a)));
  const hidden = matches.length - items.length;

  $("#menuEmpty").hidden = items.length > 0;
  $("#menuHidden").hidden = hidden === 0;
  $("#menuHidden").textContent = `${hidden} ${hidden === 1 ? "Gericht" : "Gerichte"} wegen deiner Allergie-Auswahl ausgeblendet.`;
  $("#menuGrid").innerHTML = items
    .map((m) => {
      const qty = state.cart[m.id] || 0;
      return `
      <article class="dish ${qty ? "is-in-cart" : ""}" data-id="${m.id}">
        <div class="dish__img dish__img--${m.cat}">
          <span>${m.emoji}</span>
          ${m.popular ? '<span class="tag tag--hot">Beliebt</span>' : ""}
        </div>
        <div class="dish__body">
          <div class="dish__head">
            <h3>${m.name}</h3>
            <span class="dish__price">${euro(m.price)}</span>
          </div>
          <p>${m.desc}</p>
          <p class="dish__allergens">${
            m.allergens?.length ? "Allergene: " + m.allergens.map((a) => ALLERGENS[a] || a).join(" · ") : "Keine Hauptallergene"
          }</p>
          <div class="dish__foot">
            <span class="dish__meta">${"🌶️".repeat(m.spice)}${m.veggie ? " 🌱" : ""}</span>
            ${
              qty
                ? `<div class="stepper">
                     <button data-action="dec" aria-label="${m.name}: eins weniger">−</button>
                     <span aria-live="polite">${qty}</span>
                     <button data-action="inc" aria-label="${m.name}: eins mehr">+</button>
                   </div>`
                : `<button class="add-btn" data-action="inc" aria-label="${m.name} hinzufügen">+ <span>Hinzufügen</span></button>`
            }
          </div>
        </div>
      </article>`;
    })
    .join("");
}

function renderAllergenFilter() {
  $("#allergenChips").innerHTML = Object.entries(ALLERGENS)
    .map(
      ([code, label]) =>
        `<button class="allergen-chip ${state.excludedAllergens.includes(code) ? "is-active" : ""}" data-allergen="${code}" aria-pressed="${state.excludedAllergens.includes(code)}">${label}</button>`
    )
    .join("");
  const count = state.excludedAllergens.length;
  $("#allergenCount").hidden = count === 0;
  $("#allergenCount").textContent = count;
  $("#allergenToggle").classList.toggle("is-active", count > 0);
}

// ---------- Shop-Status (von der Küche gesteuert) ----------
function prepFor(mode) {
  return SETTINGS.prepMinutes[mode] + (SHOP.extraMinutes || 0);
}

async function fetchShop() {
  try {
    const res = await fetch("/api/shop", { cache: "no-store" });
    if (res.ok) SHOP = await res.json();
  } catch { /* Server nicht erreichbar – letzten Stand behalten */ }
  if (SHOP.mode === "pickup_only" && state.mode === "delivery") state.mode = "pickup";
  renderShop();
  renderCart();
}

function renderShop() {
  const notice = $("#shopNotice");
  let text = "";
  if (SHOP.mode === "paused") text = "⏸️ Online-Bestellungen sind gerade pausiert. Bitte schau in ein paar Minuten wieder vorbei.";
  else if (SHOP.mode === "pickup_only") text = "🛍️ Gerade nur Abholung möglich – Lieferung ist vorübergehend pausiert.";
  if (SHOP.extraMinutes > 0 && SHOP.mode !== "paused") {
    text += `${text ? " " : ""}⏱️ Viel los bei uns: Aktuell ca. ${prepFor("delivery")} Min. Lieferzeit, ${prepFor("pickup")} Min. bei Abholung.`;
  }
  if (SHOP.message) text += `${text ? " " : ""}${SHOP.message}`;
  notice.hidden = !text;
  notice.textContent = text;
  notice.classList.toggle("shop-notice--paused", SHOP.mode === "paused");

  $("#drawerNotice").hidden = !text;
  $("#drawerNotice").textContent = text;

  $$("[data-wait]").forEach((el) => (el.textContent = `ca. ${prepFor(el.dataset.wait)} Min.`));

  // Online-Zahlung nur anbieten, wenn der Server sie freigibt
  const online = $('#paymentSelect option[value="online"]');
  online.hidden = online.disabled = SHOP.onlinePayment === false;
  online.textContent = "Online bezahlen (Karte, Apple Pay, PayPal …)" + (SHOP.paymentMode === "demo" ? " – Demo" : "");
  if (online.disabled && $("#paymentSelect").value === "online") $("#paymentSelect").value = "bar";
  const deliveryBtn = $('.mode-switch__btn[data-mode="delivery"]');
  deliveryBtn.disabled = SHOP.mode === "pickup_only";
}

// ---------- Cart ----------
function cartItems() {
  return Object.entries(state.cart)
    .map(([id, qty]) => ({ ...MENU.find((m) => m.id === +id), qty }))
    .filter((i) => i.name && i.qty > 0);
}

function totals() {
  const subtotal = cartItems().reduce((s, i) => s + i.price * i.qty, 0);
  const isDelivery = state.mode === "delivery";
  const fee = isDelivery && subtotal < SETTINGS.freeDeliveryFrom && subtotal > 0 ? SETTINGS.deliveryFee : 0;
  const belowMin = isDelivery && subtotal < SETTINGS.minOrderDelivery;
  return { subtotal, fee, total: subtotal + fee, belowMin };
}

function setQty(id, delta) {
  const next = (state.cart[id] || 0) + delta;
  if (next <= 0) delete state.cart[id];
  else state.cart[id] = next;
  save("baansiam-cart", state.cart);
  if (delta > 0) {
    // Im offenen Warenkorb sieht man die Änderung direkt – dort keine Meldung über dem Kassen-Button
    if (!$("#drawer").classList.contains("is-open")) toast(`${MENU.find((m) => m.id === id).name} hinzugefügt`);
    bump();
    navigator.vibrate?.(15);
  }
  renderMenu();
  renderCart();
}

function renderCart() {
  const items = cartItems();
  const count = items.reduce((s, i) => s + i.qty, 0);
  const { subtotal, fee, total, belowMin } = totals();
  const drawerOpen = $("#drawer").classList.contains("is-open");

  $("#cartCount").textContent = count;
  $("#cartCount").classList.toggle("is-visible", count > 0);
  $("#cartBar").hidden = count === 0 || drawerOpen;
  document.body.classList.toggle("has-cart-bar", count > 0);
  $("#cartBarCount").textContent = count;
  $("#cartBarTotal").textContent = euro(total);

  $("#cartEmpty").hidden = items.length > 0;
  $("#cartList").innerHTML = items
    .map(
      (i) => `
      <li class="cart-item" data-id="${i.id}">
        <span class="cart-item__emoji">${i.emoji}</span>
        <div class="cart-item__info">
          <strong>${i.name}</strong>
          <span>${euro(i.price * i.qty)}</span>
        </div>
        <div class="stepper stepper--sm">
          <button data-action="dec" aria-label="${i.name}: eins weniger">−</button>
          <span>${i.qty}</span>
          <button data-action="inc" aria-label="${i.name}: eins mehr">+</button>
        </div>
      </li>`
    )
    .join("");

  $$(".mode-switch__btn").forEach((b) => {
    const active = b.dataset.mode === state.mode;
    b.classList.toggle("is-active", active);
    b.setAttribute("aria-checked", active);
  });
  $("#feeRow").hidden = state.mode !== "delivery";
  $("#subtotal").textContent = euro(subtotal);
  $("#fee").textContent = fee ? euro(fee) : "Gratis";
  $("#total").textContent = euro(total);

  const hint = $("#minHint");
  if (belowMin && subtotal > 0) {
    hint.textContent = `Noch ${euro(SETTINGS.minOrderDelivery - subtotal)} bis zum Mindestbestellwert.`;
  } else if (state.mode === "delivery" && subtotal > 0 && subtotal < SETTINGS.freeDeliveryFrom) {
    hint.textContent = `Noch ${euro(SETTINGS.freeDeliveryFrom - subtotal)} bis zur Gratis-Lieferung.`;
  } else hint.textContent = "";

  const onCheckout = !$("#stepCheckout").hidden;
  const open = isOpenForOrders();
  $("#payHint").hidden = !(onCheckout && $("#paymentSelect").value === "online");
  const btn = $("#checkoutBtn");
  btn.disabled = state.submitting || items.length === 0 || belowMin || !open;
  btn.textContent = state.submitting
    ? "Wird gesendet …"
    : SHOP.mode === "paused"
    ? "Online-Bestellungen pausiert"
    : !open
    ? "Aktuell keine Bestellungen möglich"
    : onCheckout
    ? `Zahlungspflichtig bestellen · ${euro(total)}`
    : "Zur Kasse";

  if (items.length === 0 && onCheckout) showStep("cart");
}

// ---------- Drawer / steps ----------
let lastFocus = null;

function openDrawer(step = "cart") {
  lastFocus = document.activeElement;
  showStep(step);
  const drawer = $("#drawer");
  drawer.style.transform = "";
  drawer.classList.add("is-open");
  drawer.setAttribute("aria-hidden", "false");
  $("#overlay").hidden = false;
  document.documentElement.classList.add("no-scroll");
  closeNav();
  renderCart();
  setTimeout(() => $("#cartClose").focus({ preventScroll: true }), 50);
}

function closeDrawer() {
  const drawer = $("#drawer");
  if (!drawer.classList.contains("is-open")) return;
  drawer.style.transform = "";
  drawer.classList.remove("is-open");
  drawer.setAttribute("aria-hidden", "true");
  $("#overlay").hidden = true;
  document.documentElement.classList.remove("no-scroll");
  if (!$("#stepDone").hidden) showStep("cart");
  renderCart();
  lastFocus?.focus?.({ preventScroll: true });
}

function showStep(step) {
  $("#stepCart").hidden = step !== "cart";
  $("#stepCheckout").hidden = step !== "checkout";
  $("#stepDone").hidden = step !== "done";
  $("#drawerFoot").hidden = step === "done";
  $("#drawerTitle").textContent = { cart: "Dein Warenkorb", checkout: "Deine Daten", done: "Deine Bestellung" }[step];
  $$(".delivery-only").forEach((el) => {
    el.hidden = state.mode !== "delivery";
    $$("input", el).forEach((i) => (i.required = state.mode === "delivery"));
  });
  if (step === "checkout") fillTimes();
  if (step === "done") renderConfirmation();
  $$(".drawer__body").forEach((b) => (b.scrollTop = 0));
  renderCart();
}

// Bottom-Sheet auf dem Handy per Wischen nach unten schließen
function enableSwipeToClose() {
  const drawer = $("#drawer");
  let startY = null, delta = 0;
  const grab = $$(".drawer__handle, .drawer__head", drawer);

  grab.forEach((el) =>
    el.addEventListener("touchstart", (e) => {
      if (!matchMedia("(max-width: 760px)").matches) return;
      startY = e.touches[0].clientY;
      delta = 0;
      drawer.style.transition = "none";
    }, { passive: true })
  );
  drawer.addEventListener("touchmove", (e) => {
    if (startY === null) return;
    delta = Math.max(0, e.touches[0].clientY - startY);
    drawer.style.transform = `translateY(${delta}px)`;
  }, { passive: true });
  drawer.addEventListener("touchend", () => {
    if (startY === null) return;
    drawer.style.transition = "";
    startY = null;
    if (delta > 110) closeDrawer();
    else drawer.style.transform = "";
  });
}

// ---------- Opening hours ----------
function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
function todayHours(date = new Date()) {
  return HOURS[date.getDay()];
}
function isOpenForOrders(date = new Date()) {
  if (SHOP.mode === "paused") return false;
  if (SETTINGS.testMode) return true;
  const h = todayHours(date);
  if (!h) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  // Vorbestellung ab 1 h vor Öffnung, letzte Bestellung 30 Min. vor Schluss
  return now >= toMinutes(h[0]) - 60 && now <= toMinutes(h[1]) - 30;
}

function renderHours() {
  const today = new Date().getDay();
  $("#hoursList").innerHTML = [1, 2, 3, 4, 5, 6, 0]
    .map((d) => {
      const h = HOURS[d];
      return `<li class="${d === today ? "is-today" : ""}"><span>${DAY_NAMES[d]}</span><span>${h ? `${h[0]} – ${h[1]}` : "Ruhetag"}</span></li>`;
    })
    .join("");

  const badge = $("#openBadge");
  const h = todayHours();
  const now = new Date().getHours() * 60 + new Date().getMinutes();
  if (h && now >= toMinutes(h[0]) && now < toMinutes(h[1])) {
    badge.textContent = `● Jetzt geöffnet bis ${h[1]} Uhr`;
    badge.className = "badge badge--open";
  } else if (h && now < toMinutes(h[0])) {
    badge.textContent = `Öffnet heute um ${h[0]} Uhr`;
    badge.className = "badge";
  } else {
    badge.textContent = "Aktuell geschlossen";
    badge.className = "badge badge--closed";
  }
}

function fillTimes() {
  const h = todayHours();
  const prep = prepFor(state.mode);
  const opts =[`<option value="asap">So schnell wie möglich (~${prep} Min.)</option>`];
  if (h) {
    const now = new Date();
    let t = Math.max(now.getHours() * 60 + now.getMinutes() + prep, toMinutes(h[0]) + prep);
    t = Math.ceil(t / 15) * 15;
    for (; t <= toMinutes(h[1]); t += 15) {
      const label = `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
      opts.push(`<option value="${label}">${label} Uhr</option>`);
    }
  }
  $("#timeSelect").innerHTML = opts.join("");
}

// ---------- Bestellung absenden ----------
async function submitOrder() {
  if (state.submitting) return;
  const form = $("#stepCheckout");
  const err = $("#formError");
  if (!form.checkValidity()) {
    const firstInvalid = $$("input:invalid", form)[0];
    err.textContent = firstInvalid?.name === "zip" ? "Bitte eine gültige 5-stellige PLZ angeben." : "Bitte fülle alle Pflichtfelder korrekt aus.";
    err.hidden = false;
    firstInvalid?.focus();
    firstInvalid?.scrollIntoView({ block: "center", behavior: "smooth" });
    return;
  }
  err.hidden = true;

  const customer = Object.fromEntries(new FormData(form));
  const payload = {
    mode: state.mode,
    items: cartItems().map(({ id, qty }) => ({ id, qty })),
    customer,
  };

  state.submitting = true;
  renderCart();
  try {
    const res = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Die Bestellung konnte nicht gesendet werden.");

    // Kontaktdaten für die nächste Bestellung merken (ohne Anmerkungen)
    const { notes, time, ...remember } = customer;
    save("baansiam-customer", remember);

    const order = {
      token: data.token,
      number: data.number,
      mode: state.mode,
      time: data.time,
      prepMinutes: data.prepMinutes,
      etaAt: data.etaAt,
      etaConfirmed: false,
      email: customer.email,
      status: "neu",
      createdAt: Date.now(),
    };

    // Online-Zahlung: weiter zur Bezahlseite. Der Warenkorb bleibt, bis die Zahlung bestätigt ist.
    if (data.redirectUrl) {
      save("baansiam-pending-payment", order);
      location.href = data.redirectUrl;
      return new Promise(() => {}); // Button bleibt gesperrt, bis die Seite wechselt
    }

    state.activeOrder = order;
    save("baansiam-active-order", state.activeOrder);
    state.cart = {};
    save("baansiam-cart", state.cart);
    $("textarea[name=notes]", form).value = "";
    renderMenu();
    showStep("done");
    renderOrderBanner();
    startTracking();
  } catch (e) {
    err.textContent = e instanceof TypeError
      ? "Keine Verbindung zum Restaurant. Bitte versuche es erneut oder ruf uns an: 030 123 45 67"
      : e.message;
    err.hidden = false;
  } finally {
    state.submitting = false;
    renderCart();
  }
}

function prefillCustomer() {
  const saved = storage("baansiam-customer", null);
  if (!saved) return;
  const form = $("#stepCheckout");
  Object.entries(saved).forEach(([k, v]) => {
    const field = form.elements[k];
    if (field && !field.value) field.value = v;
  });
}

// ---------- Live-Status der Bestellung ----------
const STATUS_ORDER = ["neu", "zubereitung", "fertig", "abgeschlossen"];
let trackTimer = null;

function statusText(o) {
  const n = `#${o.number}`;
  const eta = o.etaConfirmed ? ` · ${o.mode === "delivery" ? "bei dir" : "fertig"} ca. ${hhmm(o.etaAt)} Uhr` : "";
  return {
    neu: `Bestellung ${n} ist eingegangen`,
    zubereitung: `Bestellung ${n} wird zubereitet 🍳${eta}`,
    fertig: o.mode === "delivery" ? `Bestellung ${n} ist unterwegs 🛵` : `Bestellung ${n} ist abholbereit 🛍️`,
    abgeschlossen: `Bestellung ${n} ist abgeschlossen`,
    storniert: `Bestellung ${n} wurde storniert`,
  }[o.status];
}

function renderConfirmation() {
  const o = state.activeOrder;
  if (!o) return;
  $("#orderId").textContent = `#${o.number}`;
  $("#orderEta").innerHTML = etaText(o);
  $("#orderMail").textContent = o.email ? `Bestätigung und Status-Updates gehen an ${o.email}.` : "";
  $("#statusLink").href = `status.html?t=${encodeURIComponent(o.token)}`;
  $("#trackerReadyLabel").textContent = o.mode === "delivery" ? "Unterwegs" : "Abholbereit";

  const cancelled = o.status === "storniert";
  $("#tracker").hidden = cancelled;
  $("#trackerCancelled").hidden = !cancelled;
  $("#trackerCancelled").textContent = cancelled ? `${o.cancelReason || "Diese Bestellung wurde storniert."} ${o.cancelNote || ""}` : "";
  const idx = STATUS_ORDER.indexOf(o.status);
  $$("#tracker li").forEach((li, i) => {
    li.classList.toggle("is-done", i < idx || idx === 3);
    li.classList.toggle("is-current", i === idx);
  });
}

function etaText(o) {
  const at = hhmm(o.etaAt);
  const delivery = o.mode === "delivery";
  if (o.status === "storniert") return "";
  if (o.status === "fertig") return delivery ? "Dein Essen ist unterwegs zu dir! 🛵" : "Dein Essen ist abholbereit! 🛍️";
  if (o.status === "abgeschlossen") return "Guten Appetit! 🍜";
  if (o.etaConfirmed) {
    return delivery ? `Lieferung voraussichtlich um <strong>${at} Uhr</strong>` : `Abholbereit um <strong>${at} Uhr</strong>`;
  }
  return `Voraussichtlich ca. ${at} Uhr – die genaue Uhrzeit bekommst du, sobald die Küche bestätigt.`;
}

function renderOrderBanner() {
  const o = state.activeOrder;
  const banner = $("#orderBanner");
  banner.hidden = !o;
  if (!o) return;
  $("#orderBannerText").textContent = statusText(o);
  banner.dataset.status = o.status;
}

async function pollStatus() {
  const o = state.activeOrder;
  if (!o) return stopTracking();
  // Nach 6 Stunden nicht mehr anzeigen
  if (Date.now() - o.createdAt > 6 * 3600 * 1000) return clearActiveOrder();
  try {
    const res = await fetch(`/api/status/${encodeURIComponent(o.token)}`);
    if (res.status === 404) return clearActiveOrder();
    if (!res.ok) return;
    const data = await res.json();
    const statusChanged = data.status !== o.status;
    const delayed = !statusChanged && o.etaConfirmed && data.etaAt !== o.etaAt;
    Object.assign(o, {
      status: data.status,
      etaAt: data.etaAt,
      etaConfirmed: data.etaConfirmed,
      cancelReason: data.cancelReason,
      cancelNote: data.cancelNote,
    });
    save("baansiam-active-order", o);
    if ((statusChanged && data.status !== "neu") || delayed) {
      toast(delayed ? `Neue Uhrzeit: ca. ${hhmm(o.etaAt)} Uhr` : statusText(o));
      navigator.vibrate?.([40, 60, 40]);
    }
    renderOrderBanner();
    if (!$("#stepDone").hidden) renderConfirmation();
    if (data.status === "abgeschlossen") setTimeout(clearActiveOrder, 60_000);
  } catch {
    /* offline – beim nächsten Intervall erneut versuchen */
  }
}

function startTracking() {
  stopTracking();
  if (!state.activeOrder) return;
  pollStatus();
  trackTimer = setInterval(pollStatus, 8000);
}
function stopTracking() {
  clearInterval(trackTimer);
  trackTimer = null;
}
function clearActiveOrder() {
  state.activeOrder = null;
  save("baansiam-active-order", null);
  stopTracking();
  renderOrderBanner();
}

// ---------- Rückkehr von der Bezahlseite ----------
async function resolvePendingPayment() {
  const pending = storage("baansiam-pending-payment", null);
  const params = new URLSearchParams(location.search);
  const aborted = params.get("zahlung") === "abgebrochen";
  if (params.has("zahlung")) history.replaceState(null, "", location.pathname + location.hash);
  if (!pending) return;

  const token = encodeURIComponent(pending.token);
  try {
    // Nur bei ausdrücklichem Abbruch stornieren; /abort lässt bereits bezahlte Bestellungen unverändert
    const res = aborted
      ? await fetch(`/api/orders/${token}/abort`, { method: "POST" })
      : await fetch(`/api/status/${token}`);
    if (res.status === 404) return save("baansiam-pending-payment", null);
    if (!res.ok) return;
    const data = await res.json();

    if (data.status === "zahlung") return; // Zahlung läuft evtl. noch in einem anderen Tab
    if (data.status === "abgebrochen") {
      save("baansiam-pending-payment", null);
      if (aborted) {
        openDrawer("cart");
        toast("Zahlung abgebrochen – dein Warenkorb ist noch da.");
      }
      return;
    }
    paymentSucceeded(pending, data);
  } catch { /* offline – beim nächsten Laden erneut */ }
}

function paymentSucceeded(pending, data) {
  save("baansiam-pending-payment", null);
  state.activeOrder = { ...pending, status: data.status, etaAt: data.etaAt, etaConfirmed: data.etaConfirmed };
  save("baansiam-active-order", state.activeOrder);
  state.cart = {};
  save("baansiam-cart", state.cart);
  renderMenu();
  renderCart();
  renderOrderBanner();
  startTracking();
}

// ---------- UI bits ----------
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("is-visible"), 2000);
}
function bump() {
  const el = $("#cartOpen");
  el.classList.remove("bump");
  void el.offsetWidth;
  el.classList.add("bump");
}
function closeNav() {
  $("#nav").classList.remove("is-open");
  $("#burger").setAttribute("aria-expanded", "false");
}

// Höhe des Headers als CSS-Variable (für Sticky-Toolbar & Scroll-Abstand)
function trackHeaderHeight() {
  const header = $(".header");
  const set = () => document.documentElement.style.setProperty("--header-h", header.offsetHeight + "px");
  set();
  new ResizeObserver(set).observe(header);
}

// Beim Kategoriewechsel: Tab sichtbar machen und an den Anfang der Liste springen
function focusMenuTop() {
  $("#categoryTabs .is-active")?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  const toolbar = $("#menuToolbar").getBoundingClientRect();
  const grid = $("#menuGrid").getBoundingClientRect();
  if (grid.top < toolbar.bottom) {
    window.scrollBy({ top: grid.top - toolbar.bottom - 12, behavior: "smooth" });
  }
}

// ---------- Events ----------
function bindEvents() {
  $("#categoryTabs").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-cat]");
    if (!btn) return;
    state.category = btn.dataset.cat;
    renderTabs();
    renderMenu();
    focusMenuTop();
  });
  $("#filterVeggie").addEventListener("change", (e) => {
    state.veggieOnly = e.target.checked;
    renderMenu();
  });
  $("#searchInput").addEventListener("input", (e) => {
    state.query = e.target.value;
    renderMenu();
  });
  $("#searchInput").addEventListener("keydown", (e) => e.key === "Enter" && e.target.blur());

  // Allergie-Filter
  $("#allergenToggle").addEventListener("click", () => {
    const panel = $("#allergenPanel");
    panel.hidden = !panel.hidden;
    $("#allergenToggle").setAttribute("aria-expanded", !panel.hidden);
  });
  $("#allergenChips").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-allergen]");
    if (!chip) return;
    const code = chip.dataset.allergen;
    const list = state.excludedAllergens;
    state.excludedAllergens = list.includes(code) ? list.filter((a) => a !== code) : [...list, code];
    save("baansiam-allergens", state.excludedAllergens);
    renderAllergenFilter();
    renderMenu();
  });

  // +/- in Menü und Warenkorb
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const id = +btn.closest("[data-id]").dataset.id;
    setQty(id, btn.dataset.action === "inc" ? 1 : -1);
  });

  $("#cartOpen").addEventListener("click", () => openDrawer());
  $("#cartBar").addEventListener("click", () => openDrawer());
  $("#orderBanner").addEventListener("click", () => {
    if (state.activeOrder?.status === "storniert") {
      openDrawer("done");
      clearActiveOrder();
    } else openDrawer("done");
  });
  $("#cartClose").addEventListener("click", closeDrawer);
  $("#overlay").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => e.key === "Escape" && (closeDrawer(), closeNav()));
  $$("[data-close]").forEach((b) =>
    b.addEventListener("click", () => {
      closeDrawer();
      $("#menu").scrollIntoView({ behavior: "smooth" });
    })
  );

  $$(".mode-switch__btn").forEach((b) =>
    b.addEventListener("click", () => {
      state.mode = b.dataset.mode;
      save("baansiam-mode", state.mode);
      renderCart();
    })
  );

  $("#checkoutBtn").addEventListener("click", () => {
    if ($("#stepCheckout").hidden) {
      showStep("checkout");
      prefillCustomer();
    } else submitOrder();
  });
  $("#backToCart").addEventListener("click", () => showStep("cart"));
  $("#paymentSelect").addEventListener("change", renderCart);

  // Zurück-Button von der Bezahlseite: Browser zeigt evtl. die alte Seite aus dem Cache
  window.addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    state.submitting = false;
    renderCart();
    resolvePendingPayment();
  });
  $("#stepCheckout").addEventListener("submit", (e) => {
    e.preventDefault();
    submitOrder();
  });

  // Mobile Navigation
  $("#burger").addEventListener("click", (e) => {
    e.stopPropagation();
    const open = $("#nav").classList.toggle("is-open");
    $("#burger").setAttribute("aria-expanded", open);
  });
  $$("#nav a").forEach((a) => a.addEventListener("click", closeNav));
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#nav, #burger")) closeNav();
  });

  // Header-Schatten beim Scrollen
  window.addEventListener("scroll", () => $(".header").classList.toggle("is-scrolled", scrollY > 10), { passive: true });

  // Status sofort aktualisieren, wenn der Kunde zur Seite zurückkehrt
  document.addEventListener("visibilitychange", () => !document.hidden && state.activeOrder && pollStatus());

  enableSwipeToClose();
}

// ---------- Init ----------
async function init() {
  $("#year").textContent = new Date().getFullYear();
  trackHeaderHeight();
  bindEvents();

  try {
    const res = await fetch("menu.json", { cache: "no-store" });
    const data = await res.json();
    MENU = data.items;
    CATEGORIES = data.categories;
    HOURS = data.hours;
    SETTINGS = data.settings;
    ALLERGENS = data.allergens || {};
  } catch {
    $("#menuGrid").innerHTML = `<p class="menu__loading">Die Speisekarte konnte nicht geladen werden.<br>
      <small>Hinweis: Die Seite muss über den Server geöffnet werden (start_server.bat), nicht per Doppelklick auf index.html.</small></p>`;
    return;
  }

  $$("[data-setting]").forEach((el) => {
    const value = SETTINGS[el.dataset.setting];
    if (typeof value === "number") el.textContent = euro(value);
  });

  renderTabs();
  renderAllergenFilter();
  renderMenu();
  renderHours();
  renderShop();
  showStep("cart");
  renderOrderBanner();
  startTracking();
  fetchShop();
  setInterval(fetchShop, 60_000);
  resolvePendingPayment();
}

init();
