// Status-Seite: zeigt den Live-Stand einer Bestellung (Link aus der Bestätigungs-E-Mail)
const $ = (sel) => document.querySelector(sel);
const euro = (n) => n.toLocaleString("de-DE", { style: "currency", currency: "EUR" });
const hhmm = (iso) => (iso ? iso.slice(11, 16) : "");
const STEPS = ["neu", "zubereitung", "fertig", "abgeschlossen"];

const token = new URLSearchParams(location.search).get("t");
let last = null;
let timer = null;

function headline(o) {
  const delivery = o.mode === "delivery";
  return {
    zahlung: "Zahlung wird bestätigt …",
    abgebrochen: "Zahlung nicht abgeschlossen",
    neu: `Danke, ${o.firstName}! Deine Bestellung ist eingegangen.`,
    zubereitung: "Wir kochen gerade für dich 🍳",
    fertig: delivery ? "Dein Essen ist unterwegs 🛵" : "Dein Essen ist abholbereit 🛍️",
    abgeschlossen: "Guten Appetit! 🍜",
    storniert: "Bestellung storniert",
  }[o.status];
}

function etaLine(o) {
  const delivery = o.mode === "delivery";
  const at = hhmm(o.etaAt);
  if (o.status === "zahlung") return "Einen Moment – wir warten auf die Bestätigung deiner Zahlung.";
  if (o.status === "abgebrochen") return 'Es wurde nichts abgebucht. <a href="index.html">Zurück zum Warenkorb</a>';
  if (o.status === "storniert" || o.status === "abgeschlossen") return "";
  if (o.status === "fertig") return delivery ? "Gleich klingelt es bei dir." : "Du kannst dein Essen jetzt bei uns abholen.";
  if (o.etaConfirmed) return delivery ? `Lieferung voraussichtlich um <strong>${at} Uhr</strong>` : `Abholbereit um <strong>${at} Uhr</strong>`;
  return `Voraussichtlich ca. ${at} Uhr – die Küche bestätigt gleich die genaue Uhrzeit.`;
}

function render(o) {
  $("#statusLoading").hidden = true;
  $("#statusContent").hidden = false;
  document.title = `#${o.number} · ${headline(o)}`;
  $("#statusNumber").textContent = `Bestellung #${o.number} · ${o.mode === "delivery" ? "Lieferung" : "Abholung"}`;
  $("#statusHeadline").textContent = headline(o);
  $("#statusEta").innerHTML = etaLine(o);
  $("#trackerReadyLabel").textContent = o.mode === "delivery" ? "Unterwegs" : "Abholbereit";

  const cancelled = o.status === "storniert";
  $("#tracker").hidden = cancelled || o.status === "abgebrochen";
  $("#statusPay").textContent = paymentLine(o);
  $("#statusCancelled").hidden = !cancelled;
  $("#statusCancelled").textContent = cancelled ? `${o.cancelReason} ${o.cancelNote || ""}`.trim() : "";

  const idx = STEPS.indexOf(o.status);
  document.querySelectorAll("#tracker li").forEach((li, i) => {
    li.classList.toggle("is-done", i < idx || idx === 3);
    li.classList.toggle("is-current", i === idx);
  });

  const items = $("#statusItems");
  items.replaceChildren(
    ...o.items.map((i) => {
      const li = document.createElement("li");
      li.textContent = `${i.qty}× ${i.name}`;
      return li;
    })
  );
  $("#statusTotal").textContent = euro(o.total) + (o.fee ? ` (inkl. ${euro(o.fee)} Lieferung)` : "");
  $("#statusUpdated").textContent = `Stand: ${new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })} Uhr`;

  if (o.restaurant?.phone) {
    $("#statusPhone").textContent = o.restaurant.phone;
    $("#statusPhone").href = "tel:" + o.restaurant.phone.replace(/[^\d+]/g, "");
  }

  // Bei Statuswechsel kurz vibrieren (Handy)
  if (last && (last.status !== o.status || last.etaAt !== o.etaAt)) navigator.vibrate?.([40, 60, 40]);
  last = o;
  adoptPaidOrder(o);

  if (["abgeschlossen", "storniert", "abgebrochen"].includes(o.status)) clearInterval(timer);
}

function paymentLine(o) {
  if (o.payment !== "online") return o.payment === "bar" ? "💶 Barzahlung bei Übergabe" : o.payment === "karte" ? "💳 Kartenzahlung bei Übergabe" : "";
  if (o.refundStatus === "erstattet") return "↩ Betrag wurde erstattet – in wenigen Werktagen wieder auf deinem Konto.";
  if (o.refundStatus) return "↩ Erstattung wird bearbeitet.";
  return { bezahlt: "✓ Online bezahlt", offen: "⏳ Zahlung ausstehend", abgebrochen: "Zahlung abgebrochen" }[o.paymentStatus] || "";
}

// Nach erfolgreicher Online-Zahlung: Warenkorb auf der Hauptseite leeren und Bestellung dort verfolgen
function adoptPaidOrder(o) {
  try {
    const pending = JSON.parse(localStorage.getItem("baansiam-pending-payment"));
    if (!pending || pending.token !== token || ["zahlung", "abgebrochen"].includes(o.status)) return;
    localStorage.setItem("baansiam-active-order", JSON.stringify({ ...pending, status: o.status, etaAt: o.etaAt, etaConfirmed: o.etaConfirmed }));
    localStorage.setItem("baansiam-cart", "{}");
    localStorage.removeItem("baansiam-pending-payment");
  } catch { /* localStorage nicht verfügbar */ }
}

async function load() {
  try {
    const res = await fetch(`/api/status/${encodeURIComponent(token)}`, { cache: "no-store" });
    if (res.status === 404) {
      $("#statusLoading").hidden = true;
      $("#statusError").hidden = false;
      clearInterval(timer);
      return;
    }
    if (res.ok) render(await res.json());
  } catch { /* offline – nächster Versuch im Intervall */ }
}

if (!token) {
  $("#statusLoading").hidden = true;
  $("#statusError").hidden = false;
} else {
  load();
  timer = setInterval(load, 8000);
  document.addEventListener("visibilitychange", () => !document.hidden && load());
}
