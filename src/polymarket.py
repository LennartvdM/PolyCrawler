"""
Polymarket API client for fetching active markets and extracting contenders.
"""

import requests
from typing import Optional
from dataclasses import dataclass


@dataclass
class Contender:
    """A person/option in a Polymarket prediction market."""
    name: str
    probability: float  # 0-100 percentage


@dataclass
class Market:
    """A Polymarket prediction market."""
    title: str
    slug: str
    volume: float
    end_date: Optional[str]
    contenders: list[Contender]


class PolymarketClient:
    """Client for interacting with Polymarket's API."""

    BASE_URL = "https://gamma-api.polymarket.com"

    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "PolyCheck/1.0"
        })

    def get_active_markets(self, limit: int = 100) -> list[dict]:
        """
        Fetch active markets from Polymarket.

        Args:
            limit: Maximum number of markets to fetch

        Returns:
            List of raw market data dictionaries
        """
        url = f"{self.BASE_URL}/markets"
        params = {
            "limit": limit,
            "active": "true",
            "closed": "false",
        }

        response = self.session.get(url, params=params)
        response.raise_for_status()
        return response.json()

    def get_market_by_slug(self, slug: str) -> Optional[dict]:
        """
        Fetch a specific market by its slug.

        Args:
            slug: The market's URL slug

        Returns:
            Market data dictionary or None if not found
        """
        url = f"{self.BASE_URL}/markets/{slug}"

        response = self.session.get(url)
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return response.json()

    def extract_contenders(self, market_data: dict, top_n: int = 4) -> Market:
        """
        Extract the top contenders from a market's data.

        Args:
            market_data: Raw market data from API
            top_n: Number of top contenders to extract (default 4, the "chart" entries)

        Returns:
            Market object with extracted contenders
        """
        title = market_data.get("question", market_data.get("title", "Unknown"))
        slug = market_data.get("slug", "")
        volume = float(market_data.get("volume", 0) or 0)
        end_date = market_data.get("endDate") or market_data.get("end_date_iso")

        # Extract outcomes/tokens - these are the prediction options
        outcomes = []

        # Handle different API response formats
        if "tokens" in market_data:
            # Format with tokens array
            for token in market_data["tokens"]:
                name = token.get("outcome", "")
                price = float(token.get("price", 0) or 0)
                outcomes.append({"name": name, "probability": price * 100})
        elif "outcomes" in market_data:
            # Format with outcomes string array and outcomePrices
            outcome_names = market_data.get("outcomes", [])
            if isinstance(outcome_names, str):
                import json
                try:
                    outcome_names = json.loads(outcome_names)
                except:
                    outcome_names = []

            prices = market_data.get("outcomePrices", [])
            if isinstance(prices, str):
                import json
                try:
                    prices = json.loads(prices)
                except:
                    prices = []

            for i, name in enumerate(outcome_names):
                price = float(prices[i]) if i < len(prices) else 0
                outcomes.append({"name": name, "probability": price * 100})

        # Sort by probability descending and take top N
        outcomes.sort(key=lambda x: x["probability"], reverse=True)
        top_outcomes = outcomes[:top_n]

        contenders = [
            Contender(name=o["name"], probability=o["probability"])
            for o in top_outcomes
            if o["name"] and self._looks_like_person_name(o["name"])
        ]

        return Market(
            title=title,
            slug=slug,
            volume=volume,
            end_date=end_date,
            contenders=contenders
        )

    def _looks_like_person_name(self, name: str) -> bool:
        """
        Heuristic check if a string looks like a person's name.
        Filters out options like "Yes", "No", "Other", etc.
        """
        # Common non-person outcomes to filter
        non_person_terms = {
            "yes", "no", "other", "none", "neither", "both",
            "before", "after", "over", "under", "between",
            "january", "february", "march", "april", "may", "june",
            "july", "august", "september", "october", "november", "december",
        }

        name_lower = name.lower().strip()

        # Filter out single words that are common non-person terms
        if name_lower in non_person_terms:
            return False

        # Filter out pure numbers or dates
        if name.replace(",", "").replace(".", "").replace(" ", "").isdigit():
            return False

        # Person names typically have at least 2 parts (first + last)
        # and don't start with numbers
        parts = name.split()
        if len(parts) < 2:
            return False

        if parts[0][0].isdigit():
            return False

        return True

    def get_markets_with_people(self, limit: int = 100, top_n_contenders: int = 4) -> list[Market]:
        """
        Fetch markets and extract those that appear to involve people.

        Args:
            limit: Maximum markets to fetch from API
            top_n_contenders: Number of top contenders to keep per market

        Returns:
            List of Market objects that have person contenders
        """
        raw_markets = self.get_active_markets(limit=limit)
        markets_with_people = []

        for raw_market in raw_markets:
            market = self.extract_contenders(raw_market, top_n=top_n_contenders)
            if market.contenders:  # Only include markets with person contenders
                markets_with_people.append(market)

        return markets_with_people


if __name__ == "__main__":
    # Quick test
    client = PolymarketClient()
    markets = client.get_markets_with_people(limit=20)

    for market in markets:
        print(f"\n{'='*60}")
        print(f"Market: {market.title}")
        print(f"Volume: ${market.volume:,.0f}")
        print(f"End Date: {market.end_date}")
        print("Top Contenders:")
        for c in market.contenders:
            print(f"  - {c.name}: {c.probability:.1f}%")
