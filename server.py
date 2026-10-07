from __future__ import annotations

import json
import os
import re
import ssl
import time
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
FINNHUB_BASE = "https://finnhub.io/api/v1"
BRAPI_BASE = "https://brapi.dev/api/v2"
FRANKFURTER_BASE = "https://api.frankfurter.dev/v2"
SYMBOL_PATTERN = re.compile(r"^[A-Za-z0-9:._-]{1,32}$")
cache: dict[str, tuple[float, object]] = {}


def tls_context() -> ssl.SSLContext:
    configured = os.environ.get("SSL_CERT_FILE")
    if configured and Path(configured).is_file():
        return ssl.create_default_context(cafile=configured)
    default_ca = ssl.get_default_verify_paths().cafile
    if default_ca and Path(default_ca).is_file():
        return ssl.create_default_context(cafile=default_ca)
    system_ca = Path("/etc/ssl/cert.pem")
    if system_ca.is_file():
        return ssl.create_default_context(cafile=str(system_ca))
    return ssl.create_default_context()


class MarketDataError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def load_local_env() -> None:
    env_path = ROOT / ".env"
    if not env_path.is_file():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        value = value.strip().strip('"').strip("'")
        if name.strip() and value:
            os.environ.setdefault(name.strip(), value)


def cached_json(key: str, ttl: int, loader):
    now = time.monotonic()
    cached = cache.get(key)
    if cached and cached[0] > now:
        return cached[1]
    value = loader()
    cache[key] = (now + ttl, value)
    return value


def request_json(
    url: str,
    headers: dict[str, str] | None = None,
    payload: dict | None = None,
    method: str | None = None,
):
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    request_headers = {
        "Accept": "application/json",
        "User-Agent": "GabrielFinance/1.0 (local finance dashboard)",
        **(headers or {}),
    }
    if payload is not None:
        request_headers["Content-Type"] = "application/json"
    request = Request(url, data=body, headers=request_headers, method=method)
    try:
        with urlopen(request, timeout=12, context=tls_context()) as response:
            raw = response.read(4_000_001)
            if len(raw) > 4_000_000:
                raise MarketDataError("A resposta do provedor excedeu o limite esperado.")
            if not raw:
                return None
            return json.loads(raw.decode("utf-8"))
    except HTTPError as error:
        try:
            payload = json.loads(error.read(64_000).decode("utf-8"))
            message = payload.get("error") or payload.get("message") or payload.get("detail")
        except (UnicodeDecodeError, json.JSONDecodeError):
            message = None
        if not isinstance(message, str) or not message.strip():
            message = None
        if error.code in (401, 403):
            message = message or "O plano ou a credencial não permite este dado."
        elif error.code == 429:
            message = message or "Limite de chamadas do provedor atingido. Aguarde e tente novamente."
        else:
            message = message or f"O provedor respondeu com HTTP {error.code}."
        status = error.code if 400 <= error.code < 500 else 502
        raise MarketDataError(str(message), status) from error
    except (URLError, TimeoutError) as error:
        raise MarketDataError(f"Não foi possível acessar o provedor: {error.reason if isinstance(error, URLError) else 'tempo esgotado'}.") from error
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise MarketDataError("O provedor retornou uma resposta inválida.") from error


def require_key(name: str, provider: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise MarketDataError(f"Configure {name} no arquivo .env para consultar {provider}.", 503)
    return value


def finnhub_url(path: str, params: dict[str, object], token: str) -> str:
    return f"{FINNHUB_BASE}/{path}?{urlencode({**params, 'token': token})}"


def brapi_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {require_key('BRAPI_API_TOKEN', 'brapi.dev')}"}


def safe_symbol(value: object) -> str:
    symbol = str(value or "").strip()
    if not SYMBOL_PATTERN.fullmatch(symbol):
        raise MarketDataError("Código de ativo inválido.", 400)
    return symbol.upper()


def batches(items: list[str], size: int = 20):
    for start in range(0, len(items), size):
        yield items[start:start + size]


def search_assets(market: str, query: str) -> list[dict]:
    if market == "br":
        params = urlencode({"search": query[:64], "limit": 15})
        payload = request_json(f"{BRAPI_BASE}/tickers?{params}")
        if not isinstance(payload, dict) or payload.get("error"):
            raise MarketDataError(str(payload.get("message") if isinstance(payload, dict) else "Resposta inválida da brapi.dev."))
        results = []
        for item in payload.get("results", []):
            symbol = item.get("symbol")
            if not symbol or symbol.upper().endswith("F"):
                continue
            sub_type = str(item.get("subType") or "")
            asset_type = str(item.get("assetType") or "")
            quote = item.get("quote") or {}
            results.append({
                "symbol": safe_symbol(symbol),
                "name": item.get("longName") or item.get("name") or symbol,
                "market": "br",
                "currency": "BRL",
                "subType": sub_type or asset_type,
                "kind": "FII" if sub_type == "fii" else "Ação/ETF",
                "source": "brapi.dev",
                "currentPrice": quote.get("lastPrice"),
                "quoteUpdatedAt": payload.get("requestedAt"),
                "currentPrice": (item.get("quote") or {}).get("lastPrice"),
                "quoteUpdatedAt": payload.get("requestedAt"),
            })
        return results

    token = require_key("FINNHUB_API_KEY", "Finnhub")
    if market == "us":
        payload = request_json(finnhub_url("search", {"q": query[:64]}, token))
        if not isinstance(payload, dict) or payload.get("error"):
            raise MarketDataError(str(payload.get("error") if isinstance(payload, dict) else "Resposta inválida do Finnhub."))
        results = []
        for item in payload.get("result", []):
            symbol = item.get("symbol")
            if not symbol or item.get("type", "").lower() not in (
                "common stock", "etp", "adr", "depositary receipt",
            ):
                continue
            results.append({
                "symbol": safe_symbol(symbol),
                "name": item.get("description") or symbol,
                "market": "us",
                "currency": "USD",
                "subType": item.get("type") or "Common Stock",
                "kind": "Ação internacional",
                "source": "Finnhub",
            })
        return results[:15]

    if market == "crypto":
        exchange = "BINANCE"
        symbols = cached_json(
            "finnhub-crypto-symbols",
            3600,
            lambda: request_json(finnhub_url("crypto/symbol", {"exchange": exchange}, token)),
        )
        needle = query.casefold()
        results = []
        for item in symbols:
            symbol = item.get("symbol", "")
            display = item.get("displaySymbol") or symbol
            description = item.get("description") or display
            if needle not in symbol.casefold() and needle not in display.casefold() and needle not in description.casefold():
                continue
            results.append({
                "symbol": safe_symbol(symbol),
                "name": description,
                "market": "crypto",
                "currency": "USD",
                "subType": "crypto",
                "kind": f"Cripto · {exchange}",
                "source": "Finnhub",
            })
            if len(results) == 15:
                break
        return results

    raise MarketDataError("Categoria de ativos inválida.", 400)


def get_asset_quote(market: str, symbol: str) -> dict:
    symbol = safe_symbol(symbol)
    if market == "br":
        quote_warning = None
        if os.environ.get("BRAPI_API_TOKEN", "").strip():
            try:
                quote = cached_json(
                    f"brapi-single-quote:{symbol}",
                    10,
                    lambda: brapi_quotes([{"symbol": symbol}]).get(symbol),
                )
                if quote:
                    return quote
            except MarketDataError as error:
                quote_warning = str(error)
        assets = cached_json(
            f"brapi-single-search:{symbol}",
            15,
            lambda: search_assets("br", symbol),
        )
        match = next((item for item in assets if item["symbol"] == symbol), None)
        if match and isinstance(match.get("currentPrice"), (int, float)):
            return {
                "price": match["currentPrice"],
                "currency": "BRL",
                "updatedAt": match.get("quoteUpdatedAt"),
                "source": "brapi.dev · cotação de referência",
                "warning": quote_warning,
            }
        raise MarketDataError(f"Não há cotação disponível para {symbol}.")
    if market == "us":
        return finnhub_stock_quotes([{"symbol": symbol, "currency": "USD"}]).get(symbol) or {}
    if market == "crypto":
        return finnhub_crypto_quotes([{"symbol": symbol}]).get(symbol) or {}
    raise MarketDataError("Categoria de ativo inválida.", 400)


def brapi_quotes(assets: list[dict]) -> dict[str, dict]:
    token = require_key("BRAPI_API_TOKEN", "brapi.dev")
    symbols = [safe_symbol(asset.get("symbol")) for asset in assets]
    result = {}
    for batch in batches(symbols):
        params = urlencode({"symbols": ",".join(batch)})
        payload = request_json(f"{BRAPI_BASE}/stocks/quote?{params}", brapi_headers())
        if not isinstance(payload, dict) or payload.get("error"):
            raise MarketDataError(str(payload.get("message") if isinstance(payload, dict) else "Resposta inválida da brapi.dev."))
        for item in payload.get("results", []):
            data = item.get("data") or {}
            symbol = item.get("symbol") or item.get("requestedSymbol")
            if not symbol or data.get("regularMarketPrice") is None:
                continue
            result[symbol] = {
                "price": data["regularMarketPrice"],
                "currency": data.get("currency") or "BRL",
                "updatedAt": data.get("regularMarketTime") or payload.get("requestedAt"),
                "changePercent": data.get("regularMarketChangePercent"),
                "source": "brapi.dev",
            }
    return result


def brapi_dividends(assets: list[dict]) -> dict[str, tuple[float, str | None]]:
    grouped: dict[str, list[str]] = {"stock": [], "fii": []}
    for asset in assets:
        symbol = safe_symbol(asset.get("symbol"))
        grouped["fii" if asset.get("subType") == "fii" else "stock"].append(symbol)
    result: dict[str, tuple[float, str | None]] = {}
    today = datetime.now(timezone.utc).date()
    start = (today - timedelta(days=366)).isoformat()
    end = today.isoformat()
    for kind, symbols in grouped.items():
        if not symbols:
            continue
        path = "fii/dividends" if kind == "fii" else "stocks/dividends"
        for batch in batches(symbols):
            params = urlencode({"symbols": ",".join(batch), "startDate": start, "endDate": end})
            payload = request_json(f"{BRAPI_BASE}/{path}?{params}", brapi_headers())
            if not isinstance(payload, dict) or payload.get("error"):
                message = payload.get("message") if isinstance(payload, dict) else None
                if not isinstance(message, str) or not message.strip():
                    message = "A brapi.dev não disponibilizou o histórico de proventos; verifique o acesso do plano a esse endpoint."
                raise MarketDataError(message)
            if kind == "fii":
                grouped_events: dict[str, list[dict]] = {}
                for event in payload.get("dividends", []):
                    if event.get("label") == "AMORTIZAÇÃO":
                        continue
                    grouped_events.setdefault(str(event.get("symbol", "")).upper(), []).append(event)
                for symbol in batch:
                    events = grouped_events.get(symbol, [])
                    result[symbol] = (
                        sum(float(event.get("rate") or 0) for event in events),
                        payload.get("requestedAt"),
                    )
            else:
                returned_symbols = set()
                for item in payload.get("results", []):
                    symbol = str(item.get("symbol") or item.get("requestedSymbol") or "").upper()
                    cash_events = ((item.get("data") or {}).get("cashDividends") or [])
                    result[symbol] = (
                        sum(float(event.get("rate") or 0) for event in cash_events),
                        payload.get("requestedAt"),
                    )
                    returned_symbols.add(symbol)
                for symbol in batch:
                    if symbol not in returned_symbols:
                        result[symbol] = (0.0, payload.get("requestedAt"))
    return result


def finnhub_stock_quotes(assets: list[dict]) -> dict[str, dict]:
    token = require_key("FINNHUB_API_KEY", "Finnhub")
    result = {}
    for asset in assets:
        symbol = safe_symbol(asset.get("symbol"))
        payload = request_json(finnhub_url("quote", {"symbol": symbol}, token))
        if not isinstance(payload, dict) or payload.get("error"):
            raise MarketDataError(str(payload.get("error") if isinstance(payload, dict) else "Resposta inválida do Finnhub."))
        if payload.get("c") is None or not payload.get("t"):
            continue
        result[symbol] = {
            "price": payload["c"],
            "currency": asset.get("currency") or "USD",
            "updatedAt": datetime.fromtimestamp(payload["t"], timezone.utc).isoformat(),
            "changePercent": payload.get("dp"),
            "source": "Finnhub",
        }
    return result


def finnhub_stock_dividends(assets: list[dict]) -> dict[str, tuple[float, str | None]]:
    token = require_key("FINNHUB_API_KEY", "Finnhub")
    today = datetime.now(timezone.utc).date()
    params = {
        "from": (today - timedelta(days=366)).isoformat(),
        "to": today.isoformat(),
    }
    result = {}
    for asset in assets:
        symbol = safe_symbol(asset.get("symbol"))
        payload = request_json(finnhub_url("stock/dividend", {"symbol": symbol, **params}, token))
        if not isinstance(payload, list):
            message = payload.get("error") if isinstance(payload, dict) else None
            raise MarketDataError(str(message or "O Finnhub não retornou uma lista de proventos."))
        amount = sum(float(item.get("amount") or 0) for item in payload if isinstance(item, dict))
        result[symbol] = (amount, datetime.now(timezone.utc).isoformat())
    return result


def finnhub_crypto_quotes(assets: list[dict]) -> dict[str, dict]:
    token = require_key("FINNHUB_API_KEY", "Finnhub")
    now = int(time.time())
    result = {}
    for asset in assets:
        symbol = safe_symbol(asset.get("symbol"))
        payload = request_json(finnhub_url(
            "crypto/candle",
            {"symbol": symbol, "resolution": "1", "from": now - 3600, "to": now},
            token,
        ))
        if not isinstance(payload, dict) or payload.get("error"):
            raise MarketDataError(str(payload.get("error") if isinstance(payload, dict) else "Resposta inválida do Finnhub."))
        closes = payload.get("c") or []
        timestamps = payload.get("t") or []
        if payload.get("s") != "ok" or not closes or not timestamps:
            continue
        result[symbol] = {
            "price": closes[-1],
            "currency": "USD",
            "updatedAt": datetime.fromtimestamp(timestamps[-1], timezone.utc).isoformat(),
            "source": "Finnhub · candle de 1 min",
        }
    return result


def brapi_exchange_rates() -> dict:
    params = urlencode({"currency": "USD-BRL,EUR-BRL"})
    payload = request_json(f"{BRAPI_BASE}/currency?{params}", brapi_headers())
    if not isinstance(payload, dict) or payload.get("error"):
        raise MarketDataError(str(payload.get("message") if isinstance(payload, dict) else "Resposta inválida da brapi.dev."))
    rates = {}
    for item in payload.get("currency", []):
        code = item.get("fromCurrency")
        try:
            bid = float(item["bidPrice"])
            ask = float(item["askPrice"])
        except (KeyError, TypeError, ValueError):
            continue
        rates[code] = {
            "bid": bid,
            "ask": ask,
            "mid": (bid + ask) / 2,
            "updatedAt": item.get("updatedAtTimestamp") or item.get("updatedAtDate") or payload.get("requestedAt"),
            "source": "brapi.dev · PTAX",
        }
    if not rates:
        raise MarketDataError("A brapi.dev não retornou cotações de câmbio utilizáveis.")
    return rates


def frankfurter_exchange_rates() -> dict:
    rates = {}
    for code in ("USD", "EUR"):
        payload = request_json(
            f"{FRANKFURTER_BASE}/rate/{code}/BRL",
            {"User-Agent": "GabrielFinance/1.0"},
        )
        if not isinstance(payload, dict) or payload.get("base") != code or payload.get("quote") != "BRL":
            continue
        try:
            rate = float(payload["rate"])
        except (KeyError, TypeError, ValueError):
            continue
        if rate <= 0:
            continue
        rates[code] = {
            "bid": rate,
            "ask": rate,
            "mid": rate,
            "updatedAt": payload.get("date"),
            "source": "Frankfurter",
        }
    if not rates:
        raise MarketDataError("A fonte gratuita Frankfurter não retornou cotações utilizáveis.")
    return rates


def exchange_rates() -> dict:
    try:
        return frankfurter_exchange_rates()
    except MarketDataError as free_source_error:
        if not os.environ.get("BRAPI_API_TOKEN", "").strip():
            raise
        try:
            return brapi_exchange_rates()
        except MarketDataError as brapi_error:
            raise MarketDataError(
                f"Fonte gratuita Frankfurter: {free_source_error} brapi.dev: {brapi_error}"
            ) from brapi_error


def get_market_history(market: str, symbol: str, period: str) -> dict:
    period_days = {"1mo": 31, "3mo": 92, "1y": 366}
    if period not in period_days:
        raise MarketDataError("Período de gráfico inválido.", 400)
    end = datetime.now(timezone.utc).date()
    start = end - timedelta(days=period_days[period])

    if market == "currency":
        currency = symbol.upper()
        if currency not in {"USD", "EUR", "BRL"}:
            raise MarketDataError("Moeda inválida para o gráfico.", 400)
        base, quote = (("BRL", "USD") if currency == "BRL" else (currency, "BRL"))
        params = {
            "base": base,
            "quotes": quote,
            "from": start.isoformat(),
            "to": end.isoformat(),
        }
        if period == "1y":
            params["group"] = "month"
        elif period == "3mo":
            params["group"] = "week"
        payload = request_json(f"{FRANKFURTER_BASE}/rates?{urlencode(params)}")
        if not isinstance(payload, list):
            raise MarketDataError("A fonte cambial não retornou um histórico utilizável.")
        points = []
        for item in payload:
            try:
                value = float(item["rate"])
                date = str(item["date"])
            except (KeyError, TypeError, ValueError):
                continue
            if item.get("base") == base and item.get("quote") == quote and value > 0:
                points.append({"date": date, "value": value})
        points.sort(key=lambda point: point["date"])
        if len(points) < 2:
            raise MarketDataError("Ainda não há pontos históricos suficientes para esta cotação.")
        if currency == "BRL":
            title = "Valorização do real vs dólar"
            unit = "USD por BRL"
            metric = "appreciation"
        else:
            title = f"{currency} / BRL"
            unit = "BRL por unidade"
            metric = "rate"
        return {
            "title": title,
            "unit": unit,
            "metric": metric,
            "source": "Frankfurter · taxas diárias oficiais",
            "points": points,
        }

    symbol = safe_symbol(symbol)
    if market == "br":
        params = urlencode({"range": period, "interval": "1d"})
        payload = request_json(f"https://brapi.dev/api/quote/{symbol}?{params}", brapi_headers())
        if not isinstance(payload, dict) or payload.get("error"):
            message = payload.get("message") if isinstance(payload, dict) else None
            raise MarketDataError(str(message or "A brapi.dev não retornou o histórico deste ativo."))
        results = payload.get("results") or []
        historical = results[0].get("historicalDataPrice", []) if results else []
        points = []
        for item in historical:
            value = item.get("close")
            timestamp = item.get("date")
            if isinstance(value, (int, float)) and isinstance(timestamp, (int, float)):
                points.append({
                    "date": datetime.fromtimestamp(timestamp, timezone.utc).date().isoformat(),
                    "value": float(value),
                })
        source = "brapi.dev"
        unit = results[0].get("currency", "BRL") if results else "BRL"
    elif market in {"us", "crypto"}:
        token = require_key("FINNHUB_API_KEY", "Finnhub")
        params = {
            "symbol": symbol,
            "resolution": "D",
            "from": int(datetime.combine(start, datetime.min.time(), timezone.utc).timestamp()),
            "to": int(datetime.combine(end, datetime.max.time(), timezone.utc).timestamp()),
        }
        endpoint = "stock/candle" if market == "us" else "crypto/candle"
        payload = request_json(finnhub_url(endpoint, params, token))
        if not isinstance(payload, dict) or payload.get("error"):
            message = payload.get("error") if isinstance(payload, dict) else None
            raise MarketDataError(str(message or "O Finnhub não retornou o histórico deste ativo."))
        closes = payload.get("c") or []
        timestamps = payload.get("t") or []
        points = [
            {"date": datetime.fromtimestamp(timestamp, timezone.utc).date().isoformat(), "value": float(value)}
            for timestamp, value in zip(timestamps, closes)
            if isinstance(timestamp, (int, float)) and isinstance(value, (int, float))
        ]
        source = "Finnhub · candles diários"
        unit = "USD"
    else:
        raise MarketDataError("Categoria de ativo inválida.", 400)

    points.sort(key=lambda point: point["date"])
    if len(points) < 2:
        raise MarketDataError(f"Histórico diário indisponível para {symbol} neste período.")
    return {
        "title": f"{symbol} · variação de mercado",
        "unit": unit,
        "metric": "rate",
        "source": source,
        "points": points,
    }


def get_portfolio_quotes(assets: list[dict]) -> dict:
    supported = {"br": [], "us": [], "crypto": []}
    for asset in assets:
        market = asset.get("market")
        if market not in supported:
            raise MarketDataError("A carteira contém uma categoria de ativo inválida.", 400)
        safe_symbol(asset.get("symbol"))
        supported[market].append(asset)

    quotes: dict[str, dict] = {}
    errors: dict[str, str] = {}
    for market, group in supported.items():
        if not group:
            continue
        if market == "br":
            try:
                quotes.update(brapi_quotes(group))
            except MarketDataError as error:
                if error.status == 400:
                    for asset in group:
                        symbol = safe_symbol(asset.get("symbol"))
                        try:
                            quotes.update(brapi_quotes([asset]))
                        except MarketDataError as asset_error:
                            errors[f"{market}:{symbol}"] = f"{symbol}: {asset_error}"
                else:
                    errors[market] = str(error)
            symbols = ",".join(sorted(safe_symbol(asset.get("symbol")) for asset in group))
            try:
                dividends = cached_json(
                    f"brapi-dividends:{symbols}",
                    1800,
                    lambda: brapi_dividends(group),
                )
            except MarketDataError as error:
                if error.status != 400:
                    errors[f"{market}-dividends"] = str(error)
                    dividends = {}
                else:
                    dividends = {}
                    for asset in group:
                        symbol = safe_symbol(asset.get("symbol"))
                        kind = "fii" if asset.get("subType") == "fii" else "stock"
                        try:
                            asset_dividends = cached_json(
                                f"brapi-dividends:{kind}:{symbol}",
                                1800,
                                lambda asset=asset: brapi_dividends([asset]),
                            )
                            dividends.update(asset_dividends)
                        except MarketDataError as asset_error:
                            errors[f"{market}-dividends:{symbol}"] = (
                                f"{symbol}: {asset_error}"
                            )
            for symbol, (annual_per_unit, updated_at) in dividends.items():
                if symbol in quotes:
                    quotes[symbol]["annualPerUnit"] = annual_per_unit
                    quotes[symbol]["dividendUpdatedAt"] = updated_at
                    quotes[symbol]["dividendSource"] = "brapi.dev · proventos 12 meses"
        elif market == "us":
            for asset in group:
                symbol = safe_symbol(asset.get("symbol"))
                try:
                    quotes.update(finnhub_stock_quotes([asset]))
                except MarketDataError as error:
                    errors[f"{market}:{symbol}"] = f"{symbol}: {error}"
            try:
                symbols = ",".join(sorted(safe_symbol(asset.get("symbol")) for asset in group))
                dividends = cached_json(
                    f"finnhub-dividends:{symbols}",
                    1800,
                    lambda: finnhub_stock_dividends(group),
                )
                for symbol, (annual_per_unit, updated_at) in dividends.items():
                    if symbol in quotes:
                        quotes[symbol]["annualPerUnit"] = annual_per_unit
                        quotes[symbol]["dividendUpdatedAt"] = updated_at
                        quotes[symbol]["dividendSource"] = "Finnhub · proventos 12 meses"
            except MarketDataError as error:
                errors[f"{market}-dividends"] = str(error)
        else:
            for asset in group:
                symbol = safe_symbol(asset.get("symbol"))
                try:
                    quotes.update(finnhub_crypto_quotes([asset]))
                    if symbol in quotes:
                        quotes[symbol]["annualPerUnit"] = 0
                except MarketDataError as error:
                    errors[f"{market}:{symbol}"] = f"{symbol}: {error}"

    for market, group in supported.items():
        for asset in group:
            symbol = safe_symbol(asset.get("symbol"))
            if symbol not in quotes and market not in errors and f"{market}:{symbol}" not in errors:
                errors.setdefault(market, f"Sem cotação disponível para {symbol}.")
    return {"quotes": quotes, "errors": errors, "requestedAt": datetime.now(timezone.utc).isoformat()}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format_string: str, *args) -> None:
        super().log_message(format_string, *args)

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
            "font-src 'self' https://fonts.gstatic.com data:; connect-src 'self'; img-src 'self' data:; "
            "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
        )
        super().end_headers()

    def send_json(self, payload: object, status: int = 200) -> None:
        encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def read_json_body(self, max_length: int = 50_000) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length < 1 or length > max_length:
            raise ValueError("Tamanho de requisição inválido.")
        payload = json.loads(self.rfile.read(length))
        if not isinstance(payload, dict):
            raise ValueError("O corpo da requisição deve ser um objeto JSON.")
        return payload

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        params = parse_qs(parsed.query)
        if parsed.path == "/api/status":
            return self.send_json({
                "finnhubConfigured": bool(os.environ.get("FINNHUB_API_KEY")),
                "brapiConfigured": bool(os.environ.get("BRAPI_API_TOKEN")),
            })
        if parsed.path == "/api/market/history":
            market = (params.get("market") or [""])[0]
            symbol = (params.get("symbol") or [""])[0]
            period = (params.get("period") or ["1mo"])[0]
            try:
                data = cached_json(
                    f"history:{market}:{symbol.upper()}:{period}",
                    900,
                    lambda: get_market_history(market, symbol, period),
                )
                return self.send_json(data)
            except MarketDataError as error:
                return self.send_json({"error": str(error)}, error.status)
        if parsed.path == "/api/exchange":
            try:
                data = cached_json("brapi-exchange", 300, exchange_rates)
                return self.send_json(data)
            except MarketDataError as error:
                return self.send_json({"error": str(error)}, error.status)
        if parsed.path == "/api/search":
            query = (params.get("q") or [""])[0].strip()
            market = (params.get("market") or [""])[0]
            if len(query) < 1:
                return self.send_json({"error": "Digite ao menos um caractere para buscar ativos."}, 400)
            try:
                result = cached_json(
                    f"search:{market}:{query.casefold()}",
                    90,
                    lambda: search_assets(market, query),
                )
                return self.send_json({"results": result})
            except MarketDataError as error:
                return self.send_json({"error": str(error)}, error.status)
        if parsed.path == "/api/asset/quote":
            market = (params.get("market") or [""])[0]
            symbol = (params.get("symbol") or [""])[0]
            try:
                quote = cached_json(
                    f"asset-quote:{market}:{symbol.upper()}",
                    15,
                    lambda: get_asset_quote(market, symbol),
                )
                if not quote:
                    raise MarketDataError(f"Não há cotação disponível para {symbol}.")
                return self.send_json(quote)
            except MarketDataError as error:
                return self.send_json({"error": str(error)}, error.status)
        if parsed.path.startswith("/api/"):
            return self.send_json({"error": "Endpoint não encontrado."}, 404)
        return super().do_GET()

    def do_POST(self) -> None:
        path = urlsplit(self.path).path
        if path != "/api/portfolio/quotes":
            return self.send_json({"error": "Endpoint não encontrado."}, 404)
        try:
            payload = self.read_json_body()
            assets = payload.get("assets")
            if not isinstance(assets, list) or len(assets) > 80:
                return self.send_json({"error": "A carteira deve conter até 80 ativos."}, 400)
            data = cached_json(
                f"quotes:{json.dumps(assets, sort_keys=True)}",
                30,
                lambda: get_portfolio_quotes(assets),
            )
            return self.send_json(data)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return self.send_json({"error": "O corpo da requisição deve ser JSON válido."}, 400)
        except MarketDataError as error:
            return self.send_json({"error": str(error)}, error.status)
        except (KeyError, TypeError, ValueError) as error:
            return self.send_json({"error": f"Dados inválidos para cotação: {error}."}, 400)

def main() -> None:
    load_local_env()
    server = ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("PORT", "8000"))), Handler)
    print(f"Gabriel disponível em http://127.0.0.1:{server.server_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor encerrado.", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
