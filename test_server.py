import io
import unittest
from urllib.error import HTTPError
from unittest.mock import patch

import server


class MarketDataTests(unittest.TestCase):
    @patch("server.urlopen")
    def test_http_error_with_boolean_provider_message_is_not_exposed_as_true(self, open_url):
        open_url.side_effect = HTTPError(
            "https://provider.invalid/data",
            403,
            "Forbidden",
            {},
            io.BytesIO(b'{"error": true}'),
        )
        with self.assertRaises(server.MarketDataError) as context:
            server.request_json("https://provider.invalid/data")
        self.assertIn("plano ou a credencial", str(context.exception))
        request = open_url.call_args.args[0]
        self.assertEqual(request.get_header("User-agent"), "GabrielFinance/1.0 (local finance dashboard)")

    def test_symbol_validation_accepts_provider_symbols_and_rejects_paths(self):
        self.assertEqual(server.safe_symbol("binance:btcusdt"), "BINANCE:BTCUSDT")
        with self.assertRaises(server.MarketDataError):
            server.safe_symbol("../token")

    @patch("server.brapi_headers", return_value={"Authorization": "Bearer test"})
    @patch("server.request_json")
    def test_brazilian_dividends_sum_cash_and_ignore_fii_amortization(self, request, _headers):
        request.side_effect = [
            {
                "results": [{
                    "symbol": "PETR4",
                    "data": {"cashDividends": [{"rate": 0.25}, {"rate": 0.75}]},
                }],
                "requestedAt": "2026-10-06T12:00:00Z",
            },
            {
                "dividends": [
                    {"symbol": "MXRF11", "label": "RENDIMENTO", "rate": 0.1},
                    {"symbol": "MXRF11", "label": "AMORTIZAÇÃO", "rate": 4.0},
                ],
                "requestedAt": "2026-10-06T12:00:00Z",
            },
        ]
        result = server.brapi_dividends([
            {"symbol": "PETR4", "subType": "stock"},
            {"symbol": "MXRF11", "subType": "fii"},
        ])
        self.assertEqual(result["PETR4"][0], 1.0)
        self.assertEqual(result["MXRF11"][0], 0.1)
        self.assertEqual(request.call_count, 2)

    @patch("server.request_json", return_value={
        "currency": [
            {"fromCurrency": "USD", "bidPrice": "5.40", "askPrice": "5.42", "updatedAtDate": "2026-10-06"},
            {"fromCurrency": "EUR", "bidPrice": "5.90", "askPrice": "5.92", "updatedAtDate": "2026-10-06"},
        ]
    })
    @patch("server.brapi_headers", return_value={"Authorization": "Bearer test"})
    @patch.dict("server.os.environ", {"BRAPI_API_TOKEN": "test-token"})
    @patch("server.frankfurter_exchange_rates", side_effect=server.MarketDataError("offline"))
    def test_exchange_rates_uses_the_midpoint_for_valuation(self, _free_source, _headers, _request):
        result = server.exchange_rates()
        self.assertAlmostEqual(result["USD"]["mid"], 5.41)
        self.assertAlmostEqual(result["EUR"]["mid"], 5.91)

    @patch.dict("server.os.environ", {}, clear=True)
    @patch("server.request_json", side_effect=[
        {"date": "2026-10-07", "base": "USD", "quote": "BRL", "rate": 5.4},
        {"date": "2026-10-07", "base": "EUR", "quote": "BRL", "rate": 5.9},
    ])
    def test_exchange_rates_uses_free_frankfurter_without_a_key(self, request):
        result = server.exchange_rates()
        self.assertEqual(result["USD"]["mid"], 5.4)
        self.assertEqual(result["USD"]["source"], "Frankfurter")
        self.assertEqual(result["EUR"]["mid"], 5.9)
        self.assertEqual(request.call_args_list[0].args[0], "https://api.frankfurter.dev/v2/rate/USD/BRL")
        self.assertEqual(request.call_args_list[1].args[0], "https://api.frankfurter.dev/v2/rate/EUR/BRL")

    @patch("server.request_json", return_value=[
        {"base": "USD", "quote": "BRL", "date": "2026-10-07", "rate": 5.1},
        {"base": "USD", "quote": "BRL", "date": "2026-10-01", "rate": 5.2},
    ])
    def test_market_history_returns_usd_to_brl_series(self, request):
        result = server.get_market_history("currency", "USD", "1mo")
        self.assertEqual(result["title"], "USD / BRL")
        self.assertEqual(result["unit"], "BRL por unidade")
        self.assertEqual([point["value"] for point in result["points"]], [5.2, 5.1])
        self.assertIn("base=USD", request.call_args.args[0])
        self.assertIn("quotes=BRL", request.call_args.args[0])

    @patch("server.request_json", return_value=[
        {"base": "BRL", "quote": "USD", "date": "2026-10-01", "rate": 0.19},
        {"base": "BRL", "quote": "USD", "date": "2026-10-07", "rate": 0.2},
    ])
    def test_market_history_returns_real_appreciation_series(self, request):
        result = server.get_market_history("currency", "BRL", "1mo")
        self.assertEqual(result["title"], "Valorização do real vs dólar")
        self.assertEqual(result["metric"], "appreciation")
        self.assertEqual([point["value"] for point in result["points"]], [0.19, 0.2])
        self.assertIn("base=BRL", request.call_args.args[0])
        self.assertIn("quotes=USD", request.call_args.args[0])

    @patch("server.request_json", return_value={"results": [{
        "currency": "BRL",
        "historicalDataPrice": [
            {"date": 1790802000, "close": 42.1},
            {"date": 1790809200, "close": 43.7},
        ],
    }]})
    @patch.dict("server.os.environ", {"BRAPI_API_TOKEN": "test-token"})
    def test_market_history_returns_brazilian_stock_candles(self, request):
        result = server.get_market_history("br", "PETR4", "3mo")
        self.assertEqual(result["title"], "PETR4 · variação de mercado")
        self.assertEqual(result["unit"], "BRL")
        self.assertEqual([point["value"] for point in result["points"]], [42.1, 43.7])
        self.assertIn("https://brapi.dev/api/quote/PETR4?range=3mo&interval=1d", request.call_args.args[0])

    def test_market_history_rejects_invalid_period_and_currency(self):
        with self.assertRaises(server.MarketDataError) as invalid_period:
            server.get_market_history("currency", "USD", "max")
        self.assertEqual(invalid_period.exception.status, 400)
        with self.assertRaises(server.MarketDataError) as invalid_currency:
            server.get_market_history("currency", "GBP", "1mo")
        self.assertEqual(invalid_currency.exception.status, 400)

    @patch("server.request_json", return_value={
        "c": [101.25, 104.5],
        "t": [1790802000, 1790888400],
        "s": "ok",
    })
    @patch.dict("server.os.environ", {"FINNHUB_API_KEY": "test-token"})
    def test_market_history_returns_international_stock_candles(self, request):
        result = server.get_market_history("us", "AAPL", "1y")
        self.assertEqual(result["title"], "AAPL · variação de mercado")
        self.assertEqual(result["unit"], "USD")
        self.assertEqual([point["value"] for point in result["points"]], [101.25, 104.5])
        self.assertIn("stock/candle?symbol=AAPL", request.call_args.args[0])
        self.assertIn("resolution=D", request.call_args.args[0])

    @patch("server.request_json", return_value={
        "c": [60000.0, 62000.0],
        "t": [1790802000, 1790888400],
        "s": "ok",
    })
    @patch.dict("server.os.environ", {"FINNHUB_API_KEY": "test-token"})
    def test_market_history_returns_crypto_candles(self, request):
        result = server.get_market_history("crypto", "BINANCE:BTCUSDT", "3mo")
        self.assertEqual(result["title"], "BINANCE:BTCUSDT · variação de mercado")
        self.assertEqual(result["unit"], "USD")
        self.assertEqual([point["value"] for point in result["points"]], [60000.0, 62000.0])
        self.assertIn("crypto/candle?symbol=BINANCE%3ABTCUSDT", request.call_args.args[0])

    @patch("server.brapi_quotes", return_value={
        "PETR4": {"price": 40.0, "currency": "BRL", "source": "brapi.dev"}
    })
    @patch("server.brapi_dividends", return_value={"PETR4": (2.0, "2026-10-06T12:00:00Z")})
    def test_portfolio_quote_includes_per_share_trailing_income(self, _dividends, _quotes):
        result = server.get_portfolio_quotes([
            {"symbol": "PETR4", "market": "br", "currency": "BRL", "subType": "stock"}
        ])
        self.assertEqual(result["quotes"]["PETR4"]["price"], 40.0)
        self.assertEqual(result["quotes"]["PETR4"]["annualPerUnit"], 2.0)
        self.assertEqual(result["errors"], {})

    @patch("server.brapi_dividends", return_value={})
    @patch("server.brapi_quotes")
    def test_portfolio_quote_retries_brazilian_symbols_individually_after_provider_http_400(
        self, quotes, _dividends
    ):
        def quote_assets(assets):
            if len(assets) > 1:
                raise server.MarketDataError("O provedor respondeu com HTTP 400.", 400)
            symbol = assets[0]["symbol"]
            if symbol == "INVALID3":
                raise server.MarketDataError("O provedor respondeu com HTTP 400.", 400)
            return {symbol: {"price": 40.0, "currency": "BRL", "source": "brapi.dev"}}

        quotes.side_effect = quote_assets
        result = server.get_portfolio_quotes([
            {"symbol": "PETR4", "market": "br", "currency": "BRL", "subType": "stock"},
            {"symbol": "INVALID3", "market": "br", "currency": "BRL", "subType": "stock"},
        ])
        self.assertEqual(result["quotes"]["PETR4"]["price"], 40.0)
        self.assertEqual(result["errors"]["br:INVALID3"], "INVALID3: O provedor respondeu com HTTP 400.")

    @patch("server.cached_json", side_effect=lambda _key, _ttl, loader: loader())
    @patch("server.brapi_quotes", return_value={
        "FMOM11": {"price": 34.35, "currency": "BRL", "source": "brapi.dev"},
        "VALE3": {"price": 68.69, "currency": "BRL", "source": "brapi.dev"},
    })
    @patch("server.brapi_dividends")
    def test_portfolio_quote_isolates_dividend_http_400_by_asset(
        self, dividends, _quotes, _cache
    ):
        def dividend_data(assets):
            if len(assets) > 1:
                raise server.MarketDataError("O provedor respondeu com HTTP 400.", 400)
            symbol = assets[0]["symbol"]
            if symbol == "VALE3":
                raise server.MarketDataError("O provedor respondeu com HTTP 400.", 400)
            return {"FMOM11": (1.2, "2026-10-07")}

        dividends.side_effect = dividend_data
        result = server.get_portfolio_quotes([
            {"symbol": "FMOM11", "market": "br", "currency": "BRL", "subType": "fii"},
            {"symbol": "VALE3", "market": "br", "currency": "BRL", "subType": "stock"},
        ])
        self.assertEqual(result["quotes"]["FMOM11"]["annualPerUnit"], 1.2)
        self.assertEqual(result["quotes"]["VALE3"]["price"], 68.69)
        self.assertEqual(
            result["errors"]["br-dividends:VALE3"],
            "VALE3: O provedor respondeu com HTTP 400.",
        )

    @patch("server.finnhub_stock_quotes")
    @patch("server.finnhub_stock_dividends", return_value={})
    def test_portfolio_quote_isolates_international_ticker_errors(self, _dividends, quotes):
        def quote_assets(assets):
            symbol = assets[0]["symbol"]
            if symbol == "INVALID":
                raise server.MarketDataError("O provedor respondeu com HTTP 400.", 400)
            return {symbol: {"price": 100.0, "currency": "USD", "source": "Finnhub"}}

        quotes.side_effect = quote_assets
        result = server.get_portfolio_quotes([
            {"symbol": "AAPL", "market": "us", "currency": "USD"},
            {"symbol": "INVALID", "market": "us", "currency": "USD"},
        ])
        self.assertEqual(result["quotes"]["AAPL"]["price"], 100.0)
        self.assertEqual(result["errors"]["us:INVALID"], "INVALID: O provedor respondeu com HTTP 400.")

    def test_unknown_market_returns_a_clear_validation_error(self):
        with self.assertRaises(server.MarketDataError):
            server.get_portfolio_quotes([{"symbol": "AAPL", "market": "other"}])

    @patch("server.brapi_headers", return_value={"Authorization": "******"})
    @patch("server.request_json", return_value={"error": True, "message": True})
    def test_dividend_endpoint_boolean_error_returns_actionable_message(self, _request, _headers):
        with self.assertRaises(server.MarketDataError) as context:
            server.brapi_dividends([{"symbol": "BBDC4", "subType": "stock"}])
        self.assertIn("histórico de proventos", str(context.exception))
        self.assertNotEqual(str(context.exception), "True")

    @patch.dict("server.os.environ", {}, clear=True)
    @patch("server.request_json", return_value={
        "requestedAt": "2026-10-07T02:00:00Z",
        "results": [
            {
                "symbol": "TEND3",
                "name": "CONSTRUTORA TENDA S.A.",
                "longName": "Construtora Tenda SA",
                "assetType": "stock",
                "subType": "stock",
                "quote": {"lastPrice": 28.85},
            },
            {
                "symbol": "TEND3F",
                "name": "CONSTRUTORA TENDA S.A.",
                "assetType": "stock",
                "subType": "stock",
                "quote": {"lastPrice": 28.80},
            },
        ],
    })
    def test_brazilian_asset_search_returns_current_unit_price_without_api_token(self, _request):
        result = server.search_assets("br", "Tenda")
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["symbol"], "TEND3")
        self.assertEqual(result[0]["name"], "Construtora Tenda SA")
        self.assertEqual(result[0]["currentPrice"], 28.85)
        self.assertEqual(result[0]["quoteUpdatedAt"], "2026-10-07T02:00:00Z")

    @patch.dict("server.os.environ", {}, clear=True)
    @patch("server.search_assets", return_value=[{
        "symbol": "TEND3",
        "currentPrice": 28.85,
        "quoteUpdatedAt": "2026-10-07T02:00:00Z",
    }])
    def test_brazilian_quote_falls_back_to_provider_reference_price(self, _search):
        quote = server.get_asset_quote("br", "TEND3")
        self.assertEqual(quote["price"], 28.85)
        self.assertEqual(quote["currency"], "BRL")
        self.assertIn("referência", quote["source"])


if __name__ == "__main__":
    unittest.main()
