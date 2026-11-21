"""DELIRA rails SDK for Python 3.8+. One file, standard library only.

Your agent asks; the five rails (PROOF, LIMIT, ROUTE, PLAIN, WAIT) decide on the DELIRA server.

    from delira import Delira
    d = Delira(os.environ["DELIRA_API_KEY"])
    r = d.pay(chain="base", asset="USDC", to="0x…", amount="1.5",
              memo="weekly price report from data-agent",
              proof={"source": "invoice", "ref": "INV-1042", "usd": 1.5},
              idempotency_key="INV-1042")
    if r["status"] == "stopped":
        print(r["rail"], r["reason"])
    else:
        print(d.wait(r["id"]))
"""
import hashlib
import hmac
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request

FINAL = {"confirmed", "failed", "cancelled", "stopped"}


class DeliraError(Exception):
    def __init__(self, message, status=0):
        super().__init__(message)
        self.status = status


class Delira:
    def __init__(self, api_key, base_url="https://delira.cc", timeout=30):
        if not re.fullmatch(r"dlr_[A-Za-z0-9_-]{40}", str(api_key or "")):
            raise DeliraError("A DELIRA API key looks like dlr_ + 40 characters.")
        self.key = api_key
        self.base = base_url.rstrip("/") + "/api/v1/rails"
        self.timeout = timeout

    def _call(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Authorization", "Bearer " + self.key)
        req.add_header("User-Agent", "delira-python/1.0")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                msg = json.loads(e.read())["error"]["message"]
            except Exception:
                msg = "HTTP %d" % e.code
            raise DeliraError(msg, e.code) from None

    def wallet(self):
        """Address, caps, used today, allowed networks and addresses, balances."""
        return self._call("GET", "/wallet")

    def pay(self, chain, asset, to, amount, memo, proof, idempotency_key, dry_run=False, callback_url=None):
        """Ask for a payment. A stop is an answer (status "stopped", rail, reason), not an exception."""
        body = {"action": "pay", "chain": chain, "asset": asset, "to": to, "amount": str(amount), "memo": memo,
                "proof": proof, "idempotency_key": str(idempotency_key)}
        if dry_run:
            body["dry_run"] = True
        if callback_url:
            body["callback_url"] = callback_url
        return self._call("POST", "/request", body)

    def approve(self, chain, asset, spender, amount, memo, idempotency_key, dry_run=False):
        """Ask for an exact ERC-20 allowance (unlimited is always refused)."""
        body = {"action": "approve", "chain": chain, "asset": asset, "to": spender, "amount": str(amount), "memo": memo,
                "idempotency_key": str(idempotency_key)}
        if dry_run:
            body["dry_run"] = True
        return self._call("POST", "/request", body)

    def check(self, **kw):
        """Only check the rails: nothing is saved or paid."""
        return self.pay(dry_run=True, **kw)

    def status(self, request_id):
        return self._call("GET", "/requests/" + urllib.parse.quote(str(request_id), safe=""))

    def wait(self, request_id, timeout=1800, every=5, on_change=None):
        """Follow a request until it is final or the time runs out. Waiting ones are polled slowly."""
        end, last = time.time() + timeout, None
        while True:
            r = self.status(request_id)
            if r["status"] != last:
                last = r["status"]
                if on_change:
                    on_change(r)
            if r["status"] in FINAL or time.time() > end:
                return r
            time.sleep(max(every, 30) if r["status"] == "waiting" else every)

    def verify_callback(self, raw_body, signature_header):
        return verify_callback(self.key, raw_body, signature_header)


def verify_callback(api_key, raw_body, signature_header):
    """Check a status callback: HMAC-SHA-256 of the raw body, keyed with the SHA-256 (hex) of your API key."""
    secret = hashlib.sha256(api_key.encode()).hexdigest().encode()
    body = raw_body if isinstance(raw_body, (bytes, bytearray)) else str(raw_body).encode()
    want = "sha256=" + hmac.new(secret, body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(want, str(signature_header or ""))
