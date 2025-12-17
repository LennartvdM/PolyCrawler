"""
Wikipedia API client for looking up people and extracting birth dates.
"""

import re
import requests
from typing import Optional
from dataclasses import dataclass
from datetime import datetime


@dataclass
class WikipediaResult:
    """Result of a Wikipedia lookup for a person."""
    name: str
    found: bool
    wikipedia_url: Optional[str] = None
    birth_date: Optional[str] = None
    birth_date_raw: Optional[str] = None
    error: Optional[str] = None

    @property
    def status(self) -> str:
        """Human-readable status of the lookup."""
        if not self.found:
            return "Wikipedia page not found"
        if not self.birth_date:
            return "Birth date not found on Wikipedia"
        return "Found"


class WikipediaLookup:
    """Client for looking up people on Wikipedia and extracting birth dates."""

    API_URL = "https://en.wikipedia.org/w/api.php"

    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "PolyCrawler/1.0 (Horoscope research tool)"
        })

    def search_person(self, name: str) -> Optional[str]:
        """
        Search Wikipedia for a person and return the page title.

        Args:
            name: The person's name to search for

        Returns:
            The Wikipedia page title if found, None otherwise
        """
        params = {
            "action": "query",
            "list": "search",
            "srsearch": name,
            "srlimit": 5,
            "format": "json",
        }

        response = self.session.get(self.API_URL, params=params)
        response.raise_for_status()
        data = response.json()

        results = data.get("query", {}).get("search", [])
        if not results:
            return None

        # Try to find an exact or close match
        name_lower = name.lower()
        for result in results:
            title = result.get("title", "")
            if name_lower in title.lower():
                return title

        # Fall back to first result
        return results[0].get("title")

    def get_page_wikitext(self, title: str) -> Optional[str]:
        """
        Get the raw wikitext of a Wikipedia page.

        Args:
            title: The Wikipedia page title

        Returns:
            The raw wikitext content or None
        """
        params = {
            "action": "query",
            "titles": title,
            "prop": "revisions",
            "rvprop": "content",
            "rvslots": "main",
            "format": "json",
        }

        response = self.session.get(self.API_URL, params=params)
        response.raise_for_status()
        data = response.json()

        pages = data.get("query", {}).get("pages", {})
        for page_id, page_data in pages.items():
            if page_id == "-1":
                return None
            revisions = page_data.get("revisions", [])
            if revisions:
                return revisions[0].get("slots", {}).get("main", {}).get("*")

        return None

    def extract_birth_date(self, wikitext: str) -> Optional[tuple[str, str]]:
        """
        Extract birth date from Wikipedia infobox wikitext.

        Args:
            wikitext: Raw wikitext content

        Returns:
            Tuple of (formatted_date, raw_date) or None if not found
        """
        if not wikitext:
            return None

        # Pattern 1: {{birth date and age|YYYY|MM|DD}}
        pattern1 = r'\{\{[Bb]irth date(?: and age)?\|(\d{4})\|(\d{1,2})\|(\d{1,2})'
        match = re.search(pattern1, wikitext)
        if match:
            year, month, day = match.groups()
            try:
                date = datetime(int(year), int(month), int(day))
                return (date.strftime("%B %d, %Y"), f"{year}-{month.zfill(2)}-{day.zfill(2)}")
            except ValueError:
                pass

        # Pattern 2: {{birth date|df=yes|YYYY|MM|DD}} or similar
        pattern2 = r'\{\{[Bb]irth date[^}]*\|(\d{4})\|(\d{1,2})\|(\d{1,2})'
        match = re.search(pattern2, wikitext)
        if match:
            year, month, day = match.groups()
            try:
                date = datetime(int(year), int(month), int(day))
                return (date.strftime("%B %d, %Y"), f"{year}-{month.zfill(2)}-{day.zfill(2)}")
            except ValueError:
                pass

        # Pattern 3: birth_date = {{birth date and age|1962|12|22}}
        pattern3 = r'birth_date\s*=\s*\{\{[^|]+\|(\d{4})\|(\d{1,2})\|(\d{1,2})'
        match = re.search(pattern3, wikitext, re.IGNORECASE)
        if match:
            year, month, day = match.groups()
            try:
                date = datetime(int(year), int(month), int(day))
                return (date.strftime("%B %d, %Y"), f"{year}-{month.zfill(2)}-{day.zfill(2)}")
            except ValueError:
                pass

        # Pattern 4: Plain text like "born January 22, 1962" or "(born December 22, 1962)"
        pattern4 = r'\(?\s*born\s+([A-Z][a-z]+)\s+(\d{1,2}),?\s+(\d{4})'
        match = re.search(pattern4, wikitext)
        if match:
            month_name, day, year = match.groups()
            try:
                date = datetime.strptime(f"{month_name} {day} {year}", "%B %d %Y")
                return (date.strftime("%B %d, %Y"), date.strftime("%Y-%m-%d"))
            except ValueError:
                pass

        # Pattern 5: "born (\d{1,2} Month YYYY)"
        pattern5 = r'born\s+(\d{1,2})\s+([A-Z][a-z]+)\s+(\d{4})'
        match = re.search(pattern5, wikitext)
        if match:
            day, month_name, year = match.groups()
            try:
                date = datetime.strptime(f"{day} {month_name} {year}", "%d %B %Y")
                return (date.strftime("%B %d, %Y"), date.strftime("%Y-%m-%d"))
            except ValueError:
                pass

        # Pattern 6: Just year like {{birth year and age|1962}}
        pattern6 = r'\{\{[Bb]irth year(?: and age)?\|(\d{4})'
        match = re.search(pattern6, wikitext)
        if match:
            year = match.group(1)
            return (f"{year} (month/day unknown)", year)

        return None

    def lookup_person(self, name: str) -> WikipediaResult:
        """
        Look up a person on Wikipedia and extract their birth date.

        Args:
            name: The person's name

        Returns:
            WikipediaResult with all available information
        """
        try:
            # Search for the person
            title = self.search_person(name)
            if not title:
                return WikipediaResult(
                    name=name,
                    found=False,
                    error="No Wikipedia page found"
                )

            # Get the page content
            wikitext = self.get_page_wikitext(title)
            if not wikitext:
                return WikipediaResult(
                    name=name,
                    found=False,
                    error="Could not retrieve Wikipedia page content"
                )

            # Build Wikipedia URL
            wiki_url = f"https://en.wikipedia.org/wiki/{title.replace(' ', '_')}"

            # Extract birth date
            birth_info = self.extract_birth_date(wikitext)

            if birth_info:
                formatted_date, raw_date = birth_info
                return WikipediaResult(
                    name=name,
                    found=True,
                    wikipedia_url=wiki_url,
                    birth_date=formatted_date,
                    birth_date_raw=raw_date
                )
            else:
                return WikipediaResult(
                    name=name,
                    found=True,
                    wikipedia_url=wiki_url,
                    error="Birth date not found in Wikipedia infobox"
                )

        except requests.RequestException as e:
            return WikipediaResult(
                name=name,
                found=False,
                error=f"Network error: {str(e)}"
            )
        except Exception as e:
            return WikipediaResult(
                name=name,
                found=False,
                error=f"Error: {str(e)}"
            )


if __name__ == "__main__":
    # Quick test with the example names
    lookup = WikipediaLookup()

    test_names = [
        "Kevin Hassett",
        "Kevin Warsh",
        "Christopher Waller",
        "Scott Bessent",
    ]

    for name in test_names:
        result = lookup.lookup_person(name)
        print(f"\n{'='*50}")
        print(f"Name: {result.name}")
        print(f"Found: {result.found}")
        print(f"Wikipedia URL: {result.wikipedia_url}")
        print(f"Birth Date: {result.birth_date}")
        print(f"Status: {result.status}")
        if result.error:
            print(f"Error: {result.error}")
