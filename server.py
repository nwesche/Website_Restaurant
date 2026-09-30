"""
Baan Siam – lokaler Bestellserver.

Startet einen Webserver im lokalen Netzwerk (WLAN):
  • Website für Kunden:        http://<PC-IP>:8000/
  • Küchen-Dashboard (Tablet): http://<PC-IP>:8000/kueche
  • Status-Seite für Kunden:   http://<PC-IP>:8000/status.html?t=<token>

Einstellungen (PIN, E-Mail-Versand, Restaurantdaten) stehen in config.json.
Nur Python-Standardbibliothek – keine Installation nötig.
Start: python server.py   (oder Doppelklick auf start_server.bat)
"""

import copy
import json
import re
import secrets
import smtplib
import socket
import sys
import threading
import time as clock
from datetime import datetime, timedelta
from email.message import EmailMessage
from html import escape
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, urlparse

import payments

BASE = Path(__file__).resolve().parent
PUBLIC = BASE / "public"
DATA = BASE / "data"
ORDERS_FILE = DATA / "orders.json"
SHOP_FILE = DATA / "shop.json"
MAIL_DIR = DATA / "mails"
CONFIG = json.loads((BASE / "config.json").read_text(encoding="utf-8"))

PORT = int(CONFIG.get("port", 8000))
KITCHEN_PIN = str(CONFIG.get("kitchenPin", "1234"))
RESTAURANT = CONFIG.get("restaurant", {})
SMTP = CONFIG.get("smtp", {})
STRIPE = CONFIG.get("stripe", {})
STRIPE_KEY = STRIPE.get("secretKey", "").strip()
WEBHOOK_SECRET = STRIPE.get("webhookSecret", "").strip()
ONLINE_PAYMENT = bool(CONFIG.get("onlinePayment", True))
# Ohne Stripe-Schlüssel läuft die Online-Zahlung als Demo (kein echtes Geld)
PAYMENT_MODE = "stripe" if STRIPE_KEY else "demo"

# Statuswechsel durch die Küche
STATUSES = ["neu", "zubereitung", "fertig", "abgeschlossen", "storniert"]
# Zusätzliche interne Zustände: "zahlung" (wartet auf Online-Zahlung), "abgebrochen" (nie bezahlt)
HIDDEN_FROM_KITCHEN = {"zahlung", "abgebrochen"}
PAYMENTS = {"bar", "karte", "online"}
PAYMENT_TIMEOUT_MIN = 45
SHOP_MODES = {"open", "pickup_only", "paused"}
CANCEL_REASONS = {
    "ausverkauft": "Ein Gericht aus deiner Bestellung ist leider ausverkauft.",
    "liefergebiet": "Deine Adresse liegt leider außerhalb unseres Liefergebiets.",
    "ueberlastet": "Unsere Küche ist gerade leider komplett ausgelastet.",
    "nicht_erreichbar": "Wir konnten dich bei Rückfragen leider nicht erreichen.",
    "kundenwunsch": "Die Bestellung wurde auf deinen Wunsch storniert.",
    "sonstiges": "Wir konnten deine Bestellung leider nicht annehmen.",
}
MAX_BODY = 50_000

lock = threading.Lock()


# ---------- Daten ----------
def read_json(path, fallback):
    if not path.exists():
        return fallback
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        # Beschädigte Datei sichern statt überschreiben
        path.rename(path.with_suffix(f".defekt-{datetime.now():%Y%m%d%H%M%S}.json"))
        return fallback


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def load_menu():
    return json.loads((PUBLIC / "menu.json").read_text(encoding="utf-8"))


def load_orders():
    return read_json(ORDERS_FILE, [])


def save_orders(orders):
    write_json(ORDERS_FILE, orders)


def load_shop():
    shop = {"mode": "open", "extraMinutes": 0, "message": ""}
    shop.update(read_json(SHOP_FILE, {}))
    return shop


def iso(dt):
    return dt.isoformat(timespec="seconds")


def to_minutes(hhmm):
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def at_time_today(hhmm, now):
    h, m = hhmm.split(":")
    return now.replace(hour=int(h), minute=int(m), second=0, microsecond=0)


def accepting_orders(menu, now):
    if menu["settings"].get("testMode"):
        return True
    # JS-Zählweise: 0 = Sonntag
    hours = menu["hours"].get(str((now.weekday() + 1) % 7))
    if not hours:
        return False
    minutes = now.hour * 60 + now.minute
    return to_minutes(hours[0]) - 60 <= minutes <= to_minutes(hours[1]) - 30


# ---------- Validierung ----------
class OrderError(Exception):
    pass


def text(value, field, required=True, max_len=200):
    value = str(value or "").strip()
    if required and not value:
        raise OrderError(f"Bitte „{field}“ ausfüllen.")
    if len(value) > max_len:
        raise OrderError(f"„{field}“ ist zu lang.")
    return value


def build_order(payload, orders):
    menu = load_menu()
    shop = load_shop()
    settings = menu["settings"]
    items_by_id = {item["id"]: item for item in menu["items"]}
    now = datetime.now()

    if shop["mode"] == "paused":
        raise OrderError(shop["message"] or "Online-Bestellungen sind gerade pausiert. Bitte versuche es später erneut.")
    if not accepting_orders(menu, now):
        raise OrderError("Wir nehmen gerade keine Bestellungen an.")

    mode = payload.get("mode")
    if mode not in ("delivery", "pickup"):
        raise OrderError("Ungültige Bestellart.")
    if mode == "delivery" and shop["mode"] == "pickup_only":
        raise OrderError("Lieferung ist gerade nicht möglich – bitte wähle Abholung.")

    # Positionen – Preise immer aus der Speisekarte, nie vom Client übernehmen
    items = []
    for entry in payload.get("items") or []:
        item = items_by_id.get(entry.get("id"))
        qty = entry.get("qty")
        if not item or not isinstance(qty, int) or not 1 <= qty <= 50:
            raise OrderError("Ungültige Position im Warenkorb.")
        items.append({"id": item["id"], "name": item["name"], "price": item["price"], "qty": qty})
    if not items:
        raise OrderError("Der Warenkorb ist leer.")

    c = payload.get("customer") or {}
    customer = {
        "name": text(c.get("name"), "Name"),
        "phone": text(c.get("phone"), "Telefon", max_len=40),
        "email": text(c.get("email"), "E-Mail"),
        "notes": text(c.get("notes"), "Anmerkungen", required=False, max_len=500),
    }
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", customer["email"]):
        raise OrderError("Bitte eine gültige E-Mail-Adresse angeben.")
    if mode == "delivery":
        customer["street"] = text(c.get("street"), "Straße")
        customer["zip"] = text(c.get("zip"), "PLZ", max_len=5)
        customer["city"] = text(c.get("city"), "Ort", max_len=80)
        if not re.fullmatch(r"\d{5}", customer["zip"]):
            raise OrderError("Bitte eine gültige PLZ angeben.")

    time = str(c.get("time") or "asap")
    if time != "asap" and not re.fullmatch(r"\d{2}:\d{2}", time):
        raise OrderError("Ungültiger Zeitpunkt.")
    payment = c.get("payment") if c.get("payment") in PAYMENTS else "bar"
    if payment == "online" and not ONLINE_PAYMENT:
        raise OrderError("Online-Zahlung ist gerade nicht verfügbar.")

    subtotal = round(sum(i["price"] * i["qty"] for i in items), 2)
    fee = 0.0
    if mode == "delivery":
        if subtotal < settings["minOrderDelivery"]:
            raise OrderError("Mindestbestellwert für Lieferung nicht erreicht.")
        if subtotal < settings["freeDeliveryFrom"]:
            fee = settings["deliveryFee"]

    prep = settings["prepMinutes"][mode] + int(shop.get("extraMinutes") or 0)
    # Vorläufige Uhrzeit – wird von der Küche beim Annehmen bestätigt
    eta = at_time_today(time, now) if time != "asap" else now + timedelta(minutes=prep)

    number = max((o["number"] for o in orders), default=1000) + 1
    return {
        "number": number,
        "token": secrets.token_urlsafe(12),
        "createdAt": iso(now),
        # Online-Bestellungen erscheinen erst nach erfolgreicher Zahlung in der Küche
        "status": "zahlung" if payment == "online" else "neu",
        "statusChangedAt": iso(now),
        "mode": mode,
        "time": time,
        "payment": payment,
        "paymentStatus": "offen" if payment == "online" else "vor_ort",
        "customer": customer,
        "items": items,
        "subtotal": subtotal,
        "fee": fee,
        "total": round(subtotal + fee, 2),
        "prepMinutes": prep,
        "etaAt": iso(eta),
        "etaConfirmed": False,
        "mails": [],
    }


def public_status(order):
    """Was der Kunde über den (geheimen) Status-Link sehen darf – keine Adresse, kein Telefon."""
    return {
        "number": order["number"],
        "status": order["status"],
        "mode": order["mode"],
        "time": order["time"],
        "createdAt": order["createdAt"],
        "prepMinutes": order.get("prepMinutes", 30),
        "etaAt": order.get("etaAt"),
        "etaConfirmed": order.get("etaConfirmed", False),
        "firstName": order["customer"]["name"].split()[0],
        "items": [{"name": i["name"], "qty": i["qty"]} for i in order["items"]],
        "fee": order["fee"],
        "total": order["total"],
        "payment": order.get("payment"),
        "paymentStatus": order.get("paymentStatus"),
        "refundStatus": order.get("refundStatus"),
        "cancelReason":CANCEL_REASONS.get(order.get("cancelReason"), "") if order["status"] == "storniert" else "",
        "cancelNote": order.get("cancelNote", "") if order["status"] == "storniert" else "",
        "restaurant": {"name": RESTAURANT.get("name", ""), "phone": RESTAURANT.get("phone", "")},
    }


# ---------- E-Mails ----------
def public_url():
    return (CONFIG.get("publicUrl") or f"http://{local_ip()}:{PORT}").rstrip("/")


def euro(n):
    return f"{n:.2f} €".replace(".", ",")


def hhmm(iso_str):
    return iso_str[11:16] if iso_str else ""


def build_mail(order, kind):
    c = order["customer"]
    first = c["name"].split()[0]
    n = order["number"]
    delivery = order["mode"] == "delivery"
    eta = hhmm(order.get("etaAt"))
    name = RESTAURANT.get("name", "Restaurant")
    phone = RESTAURANT.get("phone", "")

    if kind == "bestaetigung":
        subject = f"Bestellung #{n} ist eingegangen"
        lines = [f"Danke, {first}! Wir haben deine Bestellung erhalten.",
                 "Sobald unsere Küche sie annimmt, schicken wir dir die genaue Uhrzeit."]
    elif kind == "angenommen":
        subject = f"Bestellung #{n} angenommen – {'Lieferung' if delivery else 'abholbereit'} ca. {eta} Uhr"
        lines = [f"Gute Nachrichten, {first}: Wir kochen gerade für dich.",
                 f"Wir bringen dein Essen voraussichtlich gegen {eta} Uhr." if delivery
                 else f"Deine Bestellung ist voraussichtlich um {eta} Uhr abholbereit."]
    elif kind == "fertig":
        subject = f"Bestellung #{n} ist unterwegs 🛵" if delivery else f"Bestellung #{n} ist abholbereit 🛍️"
        lines = ["Dein Essen hat gerade unsere Küche verlassen und ist auf dem Weg zu dir." if delivery
                 else f"Dein Essen wartet auf dich! Abholung: {RESTAURANT.get('address', '')}."]
    elif kind == "storniert":
        subject = f"Bestellung #{n} wurde storniert"
        lines = [f"Es tut uns leid, {first}.", CANCEL_REASONS.get(order.get("cancelReason"), "")]
        if order.get("cancelNote"):
            lines.append(order["cancelNote"])
        if order.get("paymentStatus") in ("bezahlt", "erstattet"):
            lines.append("Den bereits bezahlten Betrag erstatten wir automatisch – er ist in der Regel "
                         "innerhalb weniger Werktage wieder auf deinem Konto.")
        lines.append(f"Bei Fragen erreichst du uns unter {phone}.")
    else:
        raise ValueError(kind)

    pay_line = {
        "online": "Online bezahlt ✓",
        "bar": "Barzahlung bei " + ("Lieferung" if delivery else "Abholung"),
        "karte": "Kartenzahlung bei " + ("Lieferung" if delivery else "Abholung"),
    }.get(order.get("payment"), "")

    link = f"{public_url()}/status.html?t={order['token']}"
    items_txt = "\n".join(f"  {i['qty']}× {i['name']}  {euro(i['price'] * i['qty'])}" for i in order["items"])
    text_body = (
        "\n".join(lines)
        + f"\n\nBestellung #{n} ({'Lieferung' if delivery else 'Abholung'})\n{items_txt}\n"
        + (f"  Liefergebühr  {euro(order['fee'])}\n" if order["fee"] else "")
        + f"  Gesamt  {euro(order['total'])}\n  Zahlung: {pay_line}\n\nStatus live verfolgen: {link}\n\n{name} · {phone}\n"
    )

    rows = "".join(
        f'<tr><td style="padding:4px 0">{i["qty"]}× {escape(i["name"])}</td>'
        f'<td style="padding:4px 0;text-align:right">{euro(i["price"] * i["qty"])}</td></tr>'
        for i in order["items"]
    )
    if order["fee"]:
        rows += f'<tr><td style="padding:4px 0;color:#6f655d">Liefergebühr</td><td style="text-align:right;color:#6f655d">{euro(order["fee"])}</td></tr>'
    button = "" if kind == "storniert" else (
        f'<p style="margin:24px 0"><a href="{escape(link)}" style="background:#c8431f;color:#fff;'
        f'text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:600;display:inline-block">'
        f"Status live verfolgen</a></p>"
    )
    html_body = f"""<!doctype html><html><body style="margin:0;background:#fbf7f2;font-family:Arial,sans-serif;color:#1f1a17">
<div style="max-width:520px;margin:0 auto;padding:24px">
  <p style="font-size:20px;font-weight:bold;margin:0 0 16px">{escape(name)}</p>
  <div style="background:#fff;border-radius:16px;padding:24px">
    <h1 style="font-size:22px;margin:0 0 12px">{escape(subject)}</h1>
    {''.join(f'<p style="margin:0 0 8px;font-size:15px;line-height:1.5">{escape(l)}</p>' for l in lines if l)}
    {button}
    <table style="width:100%;border-collapse:collapse;font-size:15px;border-top:1px solid #ece4da;margin-top:16px;padding-top:8px">
      {rows}
      <tr><td style="padding:10px 0 0;font-weight:bold;border-top:1px dashed #ece4da">Gesamt</td>
          <td style="padding:10px 0 0;font-weight:bold;text-align:right;border-top:1px dashed #ece4da">{euro(order['total'])}</td></tr>
      <tr><td colspan="2" style="padding:6px 0 0;color:#6f655d;font-size:14px">Zahlung: {escape(pay_line)}</td></tr>
    </table>
  </div>
  <p style="font-size:13px;color:#6f655d;text-align:center;margin-top:16px">{escape(name)} · {escape(RESTAURANT.get('address', ''))} · {escape(phone)}</p>
</div></body></html>"""
    return subject, text_body, html_body


def deliver_mail(order, kind):
    try:
        subject, text_body, html_body = build_mail(order, kind)
        to = order["customer"]["email"]
        if not SMTP.get("host"):
            # Vorschau-Modus: E-Mail als Datei speichern statt versenden
            MAIL_DIR.mkdir(parents=True, exist_ok=True)
            path = MAIL_DIR / f"{order['number']}_{kind}.html"
            path.write_text(html_body, encoding="utf-8")
            print(f"  ✉ E-Mail-Vorschau „{subject}“ → data/mails/{path.name}")
            return
        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = SMTP.get("from") or SMTP.get("user")
        msg["To"] = to
        if RESTAURANT.get("email"):
            msg["Reply-To"] = RESTAURANT["email"]
        msg.set_content(text_body)
        msg.add_alternative(html_body, subtype="html")
        port = int(SMTP.get("port", 587))
        if port == 465:
            server = smtplib.SMTP_SSL(SMTP["host"], port, timeout=20)
        else:
            server = smtplib.SMTP(SMTP["host"], port, timeout=20)
            server.starttls()
        with server:
            if SMTP.get("user"):
                server.login(SMTP["user"], SMTP.get("password", ""))
            server.send_message(msg)
        print(f"  ✉ E-Mail „{subject}“ an {to} gesendet")
    except Exception as e:  # Versandfehler dürfen nie eine Bestellung blockieren
        print(f"  ⚠ E-Mail #{order['number']} ({kind}) fehlgeschlagen: {e}")


def notify(order, kind):
    """Jede E-Mail-Art höchstens einmal pro Bestellung. Aufruf innerhalb von `lock`."""
    sent = order.setdefault("mails", [])
    if kind in sent:
        return
    sent.append(kind)
    threading.Thread(target=deliver_mail, args=(copy.deepcopy(order), kind), daemon=True).start()


# ---------- Küche: Statuswechsel ----------
def change_status(order, payload):
    status = payload.get("status")
    if status not in STATUSES:
        raise OrderError("Ungültiger Status.")
    now = datetime.now()
    previous = order["status"]
    if previous in HIDDEN_FROM_KITCHEN:
        raise OrderError("Diese Bestellung ist noch nicht bezahlt.")
    if previous == "storniert" and status != "storniert" and order.get("refundStatus"):
        raise OrderError("Diese Bestellung wurde bereits erstattet und kann nicht wiederhergestellt werden.")

    if status == "zubereitung" and previous == "neu":
        eta_minutes = payload.get("etaMinutes")
        if isinstance(eta_minutes, int) and 5 <= eta_minutes <= 240:
            order["etaAt"] = iso(now + timedelta(minutes=eta_minutes))
        elif payload.get("etaAt") == "wish" and order["time"] != "asap":
            order["etaAt"] = iso(at_time_today(order["time"], now))
        order["etaConfirmed"] = True

    if status == "storniert":
        reason = payload.get("reason")
        if reason not in CANCEL_REASONS:
            raise OrderError("Bitte einen Stornogrund wählen.")
        order["cancelReason"] = reason
        order["cancelNote"] = text(payload.get("note"), "Hinweis", required=False, max_len=200)
        if order.get("paymentStatus") == "bezahlt" and not order.get("refundStatus"):
            order["refundStatus"] = "ausstehend"  # wird direkt danach von do_refund() erledigt
    elif previous == "storniert":
        order.pop("cancelReason", None)
        order.pop("cancelNote", None)

    order["status"] = status
    order["statusChangedAt"] = iso(now)

    if status == "zubereitung" and previous == "neu":
        notify(order, "angenommen")
    elif status == "fertig":
        notify(order, "fertig")
    elif status == "storniert":
        notify(order, "storniert")


# ---------- Zahlung ----------
def with_order(match, fn):
    """Lädt die passende Bestellung, ändert sie mit fn und speichert – alles unter `lock`."""
    with lock:
        orders = load_orders()
        order = next((o for o in orders if match(o)), None)
        if order is None:
            return None
        fn(order)
        save_orders(orders)
        return copy.deepcopy(order)


def find_order(match):
    with lock:
        return next((o for o in load_orders() if match(o)), None)


def mark_paid(order, payment_intent=None):
    if order["status"] != "zahlung":
        return
    now = datetime.now()
    order.update(status="neu", paymentStatus="bezahlt", paidAt=iso(now), statusChangedAt=iso(now))
    if payment_intent:
        order["paymentIntent"] = payment_intent
    if order["time"] == "asap":
        order["etaAt"] = iso(now + timedelta(minutes=order["prepMinutes"]))
    notify(order, "bestaetigung")
    print(f"  💳 Bestellung #{order['number']} online bezahlt ({euro(order['total'])}) → Küche")


def mark_abandoned(order, why):
    if order["status"] != "zahlung":
        return
    order.update(status="abgebrochen", paymentStatus="abgebrochen", statusChangedAt=iso(datetime.now()))
    print(f"  ✖ Bestellung #{order['number']} nicht bezahlt ({why})")


def start_checkout(order):
    """Gibt die Adresse der Bezahlseite zurück (Stripe oder lokale Demo)."""
    token = quote(order["token"])
    if PAYMENT_MODE == "demo":
        return f"/demo-zahlung.html?t={token}"
    base = public_url()
    session_id, url = payments.create_checkout(
        STRIPE_KEY, order,
        success_url=f"{base}/status.html?t={token}",
        cancel_url=f"{base}/?zahlung=abgebrochen&t={token}",
    )
    with_order(lambda o: o["token"] == order["token"], lambda o: o.update(sessionId=session_id))
    return url


def apply_session(session):
    """Überträgt den Stand einer Stripe-Checkout-Session auf die Bestellung."""
    def update(order):
        if session.get("payment_status") == "paid":
            mark_paid(order, session.get("payment_intent"))
        elif session.get("status") == "expired":
            mark_abandoned(order, "Bezahlseite abgelaufen")
    with_order(lambda o: o.get("sessionId") == session.get("id"), update)


_last_sync = {}


def sync_stripe_payment(token, force=False):
    """Fragt bei Stripe nach, falls der Webhook (noch) nicht angekommen ist."""
    if PAYMENT_MODE != "stripe":
        return
    order = find_order(lambda o: o["token"] == token)
    if not order or order["status"] != "zahlung" or not order.get("sessionId"):
        return
    if not force and clock.time() - _last_sync.get(token, 0) < 5:
        return
    _last_sync[token] = clock.time()
    try:
        apply_session(payments.retrieve_session(STRIPE_KEY, order["sessionId"]))
    except payments.PaymentError as e:
        print(f"  ⚠ Stripe-Abfrage #{order['number']} fehlgeschlagen: {e}")


def do_refund(number):
    """Erstattet eine online bezahlte, stornierte Bestellung."""
    order = find_order(lambda o: o["number"] == number)
    if not order or order.get("refundStatus") != "ausstehend":
        return order
    error = None
    if PAYMENT_MODE == "stripe":
        try:
            payments.refund(STRIPE_KEY, order["paymentIntent"])
        except (payments.PaymentError, KeyError) as e:
            error = str(e) or "Zahlungs-ID fehlt"

    def update(o):
        o["refundStatus"] = "fehlgeschlagen" if error else "erstattet"
        if error:
            o["refundError"] = error
        else:
            o["paymentStatus"] = "erstattet"
    print(f"  ↩ Erstattung #{number}: {'FEHLGESCHLAGEN – ' + error if error else 'erledigt'}")
    return with_order(lambda o: o["number"] == number, update)


def payment_watchdog():
    """Prüft jede Minute offene Online-Zahlungen und räumt nie bezahlte Bestellungen auf."""
    while True:
        clock.sleep(60)
        try:
            with lock:
                pending = [o["token"] for o in load_orders() if o["status"] == "zahlung"]
            for token in pending:
                sync_stripe_payment(token, force=True)
            cutoff = datetime.now() - timedelta(minutes=PAYMENT_TIMEOUT_MIN)
            with lock:
                orders = load_orders()
                stale = [o for o in orders if o["status"] == "zahlung" and datetime.fromisoformat(o["createdAt"]) < cutoff]
                for o in stale:
                    mark_abandoned(o, f"nach {PAYMENT_TIMEOUT_MIN} Min nicht bezahlt")
                if stale:
                    save_orders(orders)
        except Exception as e:
            print(f"  ⚠ Zahlungsprüfung fehlgeschlagen: {e}")


# ---------- HTTP ----------
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "/api/" in self.path and self.command == "POST":
            print(f"[{datetime.now():%H:%M:%S}] {self.command} {self.path} → {args[1] if len(args) > 1 else ''}")

    def send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            raise OrderError("Ungültige Anfrage.")
        try:
            return json.loads(self.rfile.read(length))
        except json.JSONDecodeError:
            raise OrderError("Ungültige Anfrage.")

    def kitchen_authorized(self):
        return secrets.compare_digest(self.headers.get("X-Kitchen-Pin", ""), KITCHEN_PIN)

    # --- GET ---
    def do_GET(self):
        path = urlparse(self.path).path

        if path in ("/kueche", "/kueche/"):
            self.send_response(302)
            self.send_header("Location", "/kueche.html")
            self.end_headers()
            return

        if path == "/api/shop":
            return self.send_json(200, {**load_shop(), "onlinePayment": ONLINE_PAYMENT, "paymentMode": PAYMENT_MODE})

        if path == "/api/kitchen/orders":
            if not self.kitchen_authorized():
                return self.send_json(401, {"error": "Falsche PIN"})
            cutoff = datetime.now() - timedelta(hours=18)
            with lock:
                orders = load_orders()
            recent = [
                o for o in orders
                if o["status"] not in HIDDEN_FROM_KITCHEN
                and (datetime.fromisoformat(o["createdAt"]) >= cutoff or o["status"] in ("neu", "zubereitung", "fertig"))
            ]
            return self.send_json(200, {
                "orders": recent,
                "shop": load_shop(),
                "cancelReasons": CANCEL_REASONS,
                "paymentMode": PAYMENT_MODE,
                "serverTime": iso(datetime.now()),
                "testMode": bool(load_menu()["settings"].get("testMode")),
            })

        match = re.fullmatch(r"/api/status/([\w-]+)", path)
        if match:
            sync_stripe_payment(match[1])  # falls der Kunde gerade von Stripe zurückkommt
            order = find_order(lambda o: o["token"] == match[1])
            if not order:
                return self.send_json(404, {"error": "Bestellung nicht gefunden"})
            return self.send_json(200, public_status(order))

        if path.startswith("/api/"):
            return self.send_json(404, {"error": "Nicht gefunden"})
        super().do_GET()

    # --- POST ---
    def do_POST(self):
        path = urlparse(self.path).path
        try:
            if path == "/api/orders":
                payload = self.read_body()
                with lock:
                    orders = load_orders()
                    order = build_order(payload, orders)
                    orders.append(order)
                    if order["payment"] != "online":
                        notify(order, "bestaetigung")
                    save_orders(orders)
                online = order["payment"] == "online"
                print(f"  ➜ Neue Bestellung #{order['number']} – {order['customer']['name']} – {euro(order['total'])}"
                      + (" – wartet auf Online-Zahlung" if online else ""))
                redirect = None
                if online:
                    try:
                        redirect = start_checkout(order)
                    except payments.PaymentError as e:
                        print(f"  ⚠ Bezahlseite für #{order['number']} konnte nicht erstellt werden: {e}")
                        with_order(lambda o: o["token"] == order["token"], lambda o: mark_abandoned(o, "Stripe-Fehler"))
                        return self.send_json(502, {"error": "Online-Zahlung ist gerade nicht möglich. Bitte wähle Bar- oder Kartenzahlung vor Ort."})
                return self.send_json(201, {**public_status(order), "token": order["token"], "redirectUrl": redirect})

            # Kunde hat die Zahlung abgebrochen (Rückkehr von der Bezahlseite)
            match = re.fullmatch(r"/api/orders/([\w-]+)/abort", path)
            if match:
                order = find_order(lambda o: o["token"] == match[1])
                if order and order["status"] == "zahlung":
                    if PAYMENT_MODE == "stripe" and order.get("sessionId"):
                        try:
                            payments.expire_session(STRIPE_KEY, order["sessionId"])
                        except payments.PaymentError:
                            sync_stripe_payment(match[1], force=True)  # evtl. doch schon bezahlt
                    with_order(lambda o: o["token"] == match[1], lambda o: mark_abandoned(o, "vom Kunden abgebrochen"))
                order = find_order(lambda o: o["token"] == match[1])
                return self.send_json(200, public_status(order) if order else {})

            # Demo-Bezahlseite (nur ohne Stripe-Schlüssel) – es fließt kein Geld
            match = re.fullmatch(r"/api/demo-pay/([\w-]+)", path)
            if match and PAYMENT_MODE == "demo":
                action = self.read_body().get("action")
                token = match[1]
                if action == "pay":
                    order = with_order(lambda o: o["token"] == token, lambda o: mark_paid(o, "demo_" + secrets.token_hex(6)))
                    redirect = f"/status.html?t={quote(token)}"
                else:
                    order = with_order(lambda o: o["token"] == token, lambda o: mark_abandoned(o, "Demo abgebrochen"))
                    redirect = f"/?zahlung=abgebrochen&t={quote(token)}"
                if not order:
                    return self.send_json(404, {"error": "Bestellung nicht gefunden"})
                return self.send_json(200, {"redirectUrl": redirect})

            if path == "/api/stripe/webhook":
                return self.handle_stripe_webhook()

            if path.startswith("/api/kitchen/") and not self.kitchen_authorized():
                return self.send_json(401, {"error": "Falsche PIN"})

            if path == "/api/kitchen/shop":
                body = self.read_body()
                mode = body.get("mode")
                extra = body.get("extraMinutes", 0)
                if mode not in SHOP_MODES or not isinstance(extra, int) or not 0 <= extra <= 120:
                    raise OrderError("Ungültige Einstellung.")
                shop = {"mode": mode, "extraMinutes": extra,
                        "message": text(body.get("message"), "Hinweis", required=False, max_len=200)}
                with lock:
                    write_json(SHOP_FILE, shop)
                print(f"  ⚙ Shop-Status: {mode}, +{extra} Min")
                return self.send_json(200, shop)

            match = re.fullmatch(r"/api/kitchen/orders/(\d+)/(status|delay)", path)
            if match:
                body = self.read_body()
                with lock:
                    orders = load_orders()
                    order = next((o for o in orders if o["number"] == int(match[1])), None)
                    if not order:
                        return self.send_json(404, {"error": "Bestellung nicht gefunden"})
                    if match[2] == "status":
                        change_status(order, body)
                    else:
                        minutes = body.get("minutes")
                        if not isinstance(minutes, int) or not 5 <= minutes <= 60:
                            raise OrderError("Ungültige Verzögerung.")
                        base = max(datetime.fromisoformat(order["etaAt"]), datetime.now())
                        order["etaAt"] = iso(base + timedelta(minutes=minutes))
                    save_orders(orders)
                if order.get("refundStatus") == "ausstehend":
                    order = do_refund(order["number"])  # Online-Zahlung automatisch erstatten
                return self.send_json(200, order)

            self.send_json(404, {"error": "Nicht gefunden"})
        except OrderError as e:
            self.send_json(400, {"error": str(e)})

    def handle_stripe_webhook(self):
        if not WEBHOOK_SECRET:
            return self.send_json(400, {"error": "Webhook-Secret nicht konfiguriert"})
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= 1_000_000:
            return self.send_json(400, {"error": "Ungültige Anfrage"})
        payload = self.rfile.read(length)
        try:
            event = payments.verify_webhook(payload, self.headers.get("Stripe-Signature"), WEBHOOK_SECRET)
        except (payments.PaymentError, ValueError) as e:
            print(f"  ⚠ Webhook abgelehnt: {e}")
            return self.send_json(400, {"error": "Ungültige Signatur"})
        if event.get("type") in ("checkout.session.completed", "checkout.session.async_payment_succeeded",
                                 "checkout.session.expired"):
            apply_session(event["data"]["object"])
        return self.send_json(200, {"received": True})


class OrderServer(ThreadingHTTPServer):
    # Unter Windows könnten sonst zwei Server gleichzeitig denselben Port belegen
    allow_reuse_address = sys.platform != "win32"
    daemon_threads = True

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


_ip_cache = None


def local_ip():
    global _ip_cache
    if _ip_cache is None:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect(("8.8.8.8", 80))  # sendet nichts, ermittelt nur die Netzwerk-IP
                _ip_cache = s.getsockname()[0]
        except OSError:
            _ip_cache = "127.0.0.1"
    return _ip_cache


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    ip = local_ip()
    try:
        server = OrderServer(("0.0.0.0", PORT), Handler)
    except OSError:
        print(f"Port {PORT} ist bereits belegt – läuft der Server schon in einem anderen Fenster?")
        sys.exit(1)
    print("=" * 56)
    print(f"  {RESTAURANT.get('name', 'Restaurant')} – Bestellserver läuft")
    print("=" * 56)
    print(f"  Website (dieser PC):  http://localhost:{PORT}/")
    print(f"  Website (im WLAN):    http://{ip}:{PORT}/")
    print(f"  Küche (Tablet):       http://{ip}:{PORT}/kueche")
    print(f"  Küchen-PIN:           {KITCHEN_PIN}")
    print(f"  E-Mails:              {'Versand über ' + SMTP['host'] if SMTP.get('host') else 'Vorschau in data/mails/ (kein Mailserver eingetragen)'}")
    if not ONLINE_PAYMENT:
        print("  Online-Zahlung:       ausgeschaltet")
    elif PAYMENT_MODE == "demo":
        print("  Online-Zahlung:       DEMO (kein Stripe-Schlüssel – es fließt kein Geld)")
    else:
        live = STRIPE_KEY.startswith("sk_live")
        print(f"  Online-Zahlung:       Stripe {'LIVE – echtes Geld!' if live else 'Testmodus'}"
              + ("" if WEBHOOK_SECRET else " (ohne Webhook – Abgleich per Abfrage)"))
    threading.Thread(target=payment_watchdog, daemon=True).start()
    print("  Beenden mit Strg+C")
    print("=" * 56)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer beendet.")
