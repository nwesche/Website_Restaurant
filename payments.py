"""
Stripe-Anbindung ohne Zusatzpakete (direkt über die Stripe-REST-API).

Genutzt werden:
  • Checkout Sessions  – Stripe-gehostete Bezahlseite (Karte, Apple Pay, Google Pay, PayPal, Klarna …
                         je nachdem, was im Stripe-Dashboard aktiviert ist)
  • Refunds            – automatische Erstattung bei Stornierung
  • Webhook-Signatur   – prüft, dass Zahlungsmeldungen wirklich von Stripe kommen
"""

import hashlib
import hmac
import json
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.stripe.com/v1"


class PaymentError(Exception):
    pass


def _request(secret, method, path, params=None):
    data = urllib.parse.urlencode(params or []).encode() if method == "POST" else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Authorization", f"Bearer {secret}")
    if data is not None:
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        try:
            message = json.loads(e.read()).get("error", {}).get("message")
        except (json.JSONDecodeError, AttributeError):
            message = None
        raise PaymentError(message or f"Stripe-Fehler {e.code}")
    except urllib.error.URLError as e:
        raise PaymentError(f"Stripe nicht erreichbar: {e.reason}")


def cents(amount):
    return str(round(amount * 100))


def create_checkout(secret, order, success_url, cancel_url):
    """Legt eine Stripe-Bezahlseite an. Gibt (session_id, url) zurück."""
    params = [
        ("mode", "payment"),
        ("locale", "de"),
        ("success_url", success_url),
        ("cancel_url", cancel_url),
        ("client_reference_id", str(order["number"])),
        ("metadata[order]", str(order["number"])),
        ("payment_intent_data[metadata][order]", str(order["number"])),
        ("customer_email", order["customer"]["email"]),
        # Bezahlseite läuft nach 31 Minuten ab (Stripe-Minimum sind 30)
        ("expires_at", str(int(time.time()) + 31 * 60)),
    ]
    lines = [(i["name"], i["price"], i["qty"]) for i in order["items"]]
    if order["fee"]:
        lines.append(("Liefergebühr", order["fee"], 1))
    for idx, (name, price, qty) in enumerate(lines):
        p = f"line_items[{idx}]"
        params += [
            (f"{p}[quantity]", str(qty)),
            (f"{p}[price_data][currency]", "eur"),
            (f"{p}[price_data][unit_amount]", cents(price)),
            (f"{p}[price_data][product_data][name]", name),
        ]
    session = _request(secret, "POST", "/checkout/sessions", params)
    return session["id"], session["url"]


def retrieve_session(secret, session_id):
    return _request(secret, "GET", f"/checkout/sessions/{urllib.parse.quote(session_id)}")


def expire_session(secret, session_id):
    return _request(secret, "POST", f"/checkout/sessions/{urllib.parse.quote(session_id)}/expire")


def refund(secret, payment_intent):
    return _request(secret, "POST", "/refunds", [("payment_intent", payment_intent)])


def verify_webhook(payload, header, secret, tolerance=300):
    """Prüft die Stripe-Signatur (Header „Stripe-Signature“) und gibt das Event zurück."""
    items = [part.split("=", 1) for part in (header or "").split(",") if "=" in part]
    timestamp = next((v for k, v in items if k == "t"), None)
    signatures = [v for k, v in items if k == "v1"]
    if not timestamp or not signatures:
        raise PaymentError("Signatur fehlt")
    expected = hmac.new(secret.encode(), timestamp.encode() + b"." + payload, hashlib.sha256).hexdigest()
    if not any(hmac.compare_digest(expected, s) for s in signatures):
        raise PaymentError("Ungültige Signatur")
    if abs(time.time() - int(timestamp)) > tolerance:
        raise PaymentError("Signatur abgelaufen")
    return json.loads(payload)
