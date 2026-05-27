"""Historical price data — synthetic + best-effort real fetcher.

For Task 14.2: the synthetic generator is used by default so tests and the
notebook run offline. ``cached_fetch`` swaps in real CoinGecko data when the
network is available.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
from numpy.random import Generator


# ─── Synthetic ────────────────────────────────────────────────────────────────


def synthetic_returns(
    n_days: int,
    annual_vol: float = 0.80,
    df: float = 4.0,
    rng: Generator | None = None,
) -> np.ndarray:
    """Synthetic daily log-returns calibrated to ETH-like behaviour.

    Uses a Student-t with ``df`` degrees of freedom (excess kurtosis = 6/(df−4),
    so ``df=4`` gives infinite kurtosis in theory and very fat empirical tails),
    rescaled so the realised daily vol matches ``annual_vol / √365``.

    Defaults (``annual_vol=0.80``, ``df=4``) target the spec §2.3 ETH example.
    """
    if rng is None:
        rng = np.random.default_rng()
    if df <= 2:
        raise ValueError(f"df must be > 2 for finite variance (got {df})")
    daily_vol = annual_vol / np.sqrt(365)
    t = rng.standard_t(df=df, size=n_days)
    # Variance of Student-t(df) is df/(df-2); scale so empirical std → daily_vol
    return t * daily_vol / np.sqrt(df / (df - 2))


# ─── Real data fetcher (CoinGecko free tier; best-effort) ─────────────────────

_COINGECKO_IDS = {
    "ETH": "ethereum",
    "BTC": "bitcoin",
    "ARB": "arbitrum",
}


def fetch_coingecko_daily(symbol: str, days: int = 1095) -> pd.Series:
    """Fetch daily close prices from CoinGecko's free tier.

    ``symbol`` ∈ ``{"ETH", "BTC", "ARB"}``. Returns a date-indexed ``pd.Series``
    of USD prices. Raises on any HTTP / parse error — caller can fall back to
    :func:`synthetic_returns`.

    CoinGecko free tier rate-limits to ~5–15 calls/min. Use :func:`cached_fetch`
    if you call repeatedly.
    """
    import requests  # imported lazily so the module is usable offline

    if symbol not in _COINGECKO_IDS:
        raise ValueError(f"unknown symbol {symbol!r}; choose from {list(_COINGECKO_IDS)}")
    coin_id = _COINGECKO_IDS[symbol]

    url = f"https://api.coingecko.com/api/v3/coins/{coin_id}/market_chart"
    r = requests.get(url, params={"vs_currency": "usd", "days": days}, timeout=30)
    r.raise_for_status()
    prices = pd.DataFrame(r.json()["prices"], columns=["ts", "price"])
    prices["date"] = pd.to_datetime(prices["ts"], unit="ms").dt.date
    return prices.set_index("date")["price"].astype(float)


def cached_fetch(
    symbol: str,
    days: int = 1095,
    cache_dir: Path | str = "data",
) -> pd.Series:
    """Cached version of :func:`fetch_coingecko_daily`.

    On first call, fetches and writes ``<symbol>_<days>d.csv`` under ``cache_dir``.
    Subsequent calls read from cache. Delete the file to refresh.
    """
    cache_dir = Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = cache_dir / f"{symbol}_{days}d.csv"
    if cache_file.exists():
        return pd.read_csv(cache_file, index_col=0, parse_dates=True).squeeze("columns")
    series = fetch_coingecko_daily(symbol, days)
    series.to_csv(cache_file)
    return series


def log_returns(prices: pd.Series | np.ndarray) -> np.ndarray:
    """Daily log-returns from a price series."""
    p = np.asarray(prices, dtype=float)
    return np.log(p[1:] / p[:-1])
