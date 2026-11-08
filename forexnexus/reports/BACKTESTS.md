# Backtestoverzicht

Gegenereerd: 2026-11-08T00:48:52.365Z

> **Alle runs hieronder gebruiken SYNTHETISCHE softwarefixtures.** Er was geen echte historische data beschikbaar (OANDA niet gekoppeld, geen CSV/Parquet aangeleverd). Deze cijfers bewijzen niets over handelsrendement; ze tonen alleen dat de engine werkt.

| Instrument | Strategie | Data | Candles | Signalen (BUY/SELL/NO TRADE) | Trades | Expectancy R | Netto R | Oordeel | Meest voorkomende blokkades |
|---|---|---|---|---|---|---|---|---|---|
| EUR_USD | LEGACY_EMA_RSI_VOL v1.0.0 | SYNTHETISCH | 37416 | 0 | 0 | — | 0 | ONVOLDOENDE BEWIJS | — |
| EUR_USD | LEGACY_EMA_RSI_VOL_ATR4 v1.0.0 | SYNTHETISCH | 37416 | 0 | 0 | — | 0 | ONVOLDOENDE BEWIJS | — |
| EUR_USD | STRUCT_SWEEP_MSS v1.0.0 | SYNTHETISCH | 37416 | 136 | 0 | — | 0 | ONVOLDOENDE BEWIJS | RR_BELOW_MIN 132, SESSION_NOT_ALLOWED 92, SPREAD_TOO_WIDE_ATR 81 |
| GBP_USD | LEGACY_EMA_RSI_VOL v1.0.0 | SYNTHETISCH | 37416 | 0 | 0 | — | 0 | ONVOLDOENDE BEWIJS | — |
| GBP_USD | LEGACY_EMA_RSI_VOL_ATR4 v1.0.0 | SYNTHETISCH | 37416 | 0 | 0 | — | 0 | ONVOLDOENDE BEWIJS | — |
| GBP_USD | STRUCT_SWEEP_MSS v1.0.0 | SYNTHETISCH | 37416 | 160 | 0 | — | 0 | ONVOLDOENDE BEWIJS | RR_BELOW_MIN 155, SPREAD_TOO_WIDE_ATR 117, SESSION_NOT_ALLOWED 101 |
| USD_JPY | LEGACY_EMA_RSI_VOL v1.0.0 | SYNTHETISCH | 37416 | 0 | 0 | — | 0 | ONVOLDOENDE BEWIJS | — |
| USD_JPY | LEGACY_EMA_RSI_VOL_ATR4 v1.0.0 | SYNTHETISCH | 37416 | 0 | 0 | — | 0 | ONVOLDOENDE BEWIJS | — |
| USD_JPY | STRUCT_SWEEP_MSS v1.0.0 | SYNTHETISCH | 37416 | 127 | 1 | -1.0161 | -1.016 | ONVOLDOENDE BEWIJS | RR_BELOW_MIN 124, SESSION_NOT_ALLOWED 78, SPREAD_TOO_WIDE_ATR 29 |

Kostenscenario's, splits, jaar/maand/sessie en parametergevoeligheid: zie de HTML-rapporten in `reports/backtests/`.