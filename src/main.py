#!/usr/bin/env python3
"""
PolyCheck - Extract Polymarket contenders and their birth dates for horoscope analysis.

Flow:
1. Fetch active markets from Polymarket API
2. Extract person names from market options (top contenders)
3. Look up each person on Wikipedia for birth dates
4. Write results to Google Sheets (or CSV fallback)
"""

import os
import sys
import argparse
from datetime import datetime

from dotenv import load_dotenv

from polymarket import PolymarketClient, Market
from wikipedia_lookup import WikipediaLookup, WikipediaResult
from sheets import SheetsWriter, CSVWriter


def crawl_markets(
    market_limit: int = 100,
    top_contenders: int = 4,
    verbose: bool = True
) -> list[dict]:
    """
    Crawl Polymarket markets and look up contender birth dates.

    Args:
        market_limit: Maximum markets to fetch
        top_contenders: Number of top contenders per market
        verbose: Print progress information

    Returns:
        List of result dictionaries ready for output
    """
    if verbose:
        print("=" * 60)
        print("PolyCheck - Polymarket Contender Birth Date Extraction")
        print("=" * 60)
        print()

    # Initialize clients
    polymarket = PolymarketClient()
    wikipedia = WikipediaLookup()

    # Fetch markets with person contenders
    if verbose:
        print(f"Fetching up to {market_limit} active markets from Polymarket...")

    markets = polymarket.get_markets_with_people(
        limit=market_limit,
        top_n_contenders=top_contenders
    )

    if verbose:
        print(f"Found {len(markets)} markets with person contenders")
        print()

    # Process each market
    results = []
    total_contenders = sum(len(m.contenders) for m in markets)

    if verbose:
        print(f"Looking up {total_contenders} contenders on Wikipedia...")
        print()

    contender_count = 0
    for market in markets:
        if verbose:
            print(f"Market: {market.title[:60]}...")

        for contender in market.contenders:
            contender_count += 1

            if verbose:
                print(f"  [{contender_count}/{total_contenders}] Looking up: {contender.name}")

            # Wikipedia lookup
            wiki_result = wikipedia.lookup_person(contender.name)

            result = {
                "market_title": market.title,
                "person_name": contender.name,
                "birth_date": wiki_result.birth_date,
                "birth_date_raw": wiki_result.birth_date_raw,
                "wikipedia_url": wiki_result.wikipedia_url,
                "probability": contender.probability,
                "market_volume": market.volume,
                "market_end_date": market.end_date,
                "status": wiki_result.status,
            }
            results.append(result)

            if verbose:
                if wiki_result.birth_date:
                    print(f"      -> Birth date: {wiki_result.birth_date}")
                else:
                    print(f"      -> {wiki_result.status}")

        if verbose:
            print()

    return results


def write_to_sheets(results: list[dict], clear_existing: bool = False) -> bool:
    """
    Write results to Google Sheets.

    Args:
        results: List of result dictionaries
        clear_existing: If True, clear existing data first

    Returns:
        True if successful, False otherwise
    """
    writer = SheetsWriter()

    if not writer.connect():
        print("Failed to connect to Google Sheets")
        return False

    if clear_existing:
        print("Clearing existing data...")
        writer.clear_data(keep_headers=True)

    writer.setup_headers()
    writer.write_results_batch(results)

    print(f"Successfully wrote {len(results)} rows to Google Sheets")
    return True


def write_to_csv(results: list[dict], output_path: str = "polymarket_contenders.csv"):
    """
    Write results to CSV file (fallback).

    Args:
        results: List of result dictionaries
        output_path: Output file path
    """
    writer = CSVWriter(output_path)
    writer.write_results_batch(results)
    writer.save()


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Crawl Polymarket markets and extract contender birth dates from Wikipedia"
    )
    parser.add_argument(
        "--markets", "-m",
        type=int,
        default=100,
        help="Maximum number of markets to fetch (default: 100)"
    )
    parser.add_argument(
        "--top", "-t",
        type=int,
        default=4,
        help="Number of top contenders per market (default: 4)"
    )
    parser.add_argument(
        "--output", "-o",
        choices=["sheets", "csv", "both"],
        default="both",
        help="Output destination (default: both)"
    )
    parser.add_argument(
        "--csv-path",
        default="polymarket_contenders.csv",
        help="CSV output file path (default: polymarket_contenders.csv)"
    )
    parser.add_argument(
        "--clear",
        action="store_true",
        help="Clear existing sheet data before writing"
    )
    parser.add_argument(
        "--quiet", "-q",
        action="store_true",
        help="Suppress progress output"
    )

    args = parser.parse_args()

    # Load environment variables
    load_dotenv()

    # Run the crawler
    results = crawl_markets(
        market_limit=args.markets,
        top_contenders=args.top,
        verbose=not args.quiet
    )

    if not results:
        print("No results to write")
        return

    print()
    print("=" * 60)
    print(f"Crawl complete! Found {len(results)} contenders")
    print("=" * 60)
    print()

    # Write output
    if args.output in ("sheets", "both"):
        success = write_to_sheets(results, clear_existing=args.clear)
        if not success and args.output == "sheets":
            print("Falling back to CSV output...")
            write_to_csv(results, args.csv_path)
        elif not success:
            print("Google Sheets write failed, continuing with CSV...")

    if args.output in ("csv", "both"):
        write_to_csv(results, args.csv_path)

    # Print summary
    print()
    print("Summary:")
    print("-" * 40)

    found_dates = sum(1 for r in results if r["birth_date"])
    missing_wiki = sum(1 for r in results if "not found" in r["status"].lower())
    missing_date = sum(1 for r in results if r["wikipedia_url"] and not r["birth_date"])

    print(f"Total contenders processed: {len(results)}")
    print(f"Birth dates found: {found_dates}")
    print(f"Wikipedia page not found: {missing_wiki}")
    print(f"Wikipedia found, but no birth date: {missing_date}")


if __name__ == "__main__":
    main()
