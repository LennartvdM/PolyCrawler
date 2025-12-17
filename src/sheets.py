"""
Google Sheets integration for writing crawler results.
"""

import os
from datetime import datetime
from typing import Optional

import gspread
from google.oauth2.service_account import Credentials


class SheetsWriter:
    """Write crawler results to Google Sheets."""

    SCOPES = [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive",
    ]

    HEADERS = [
        "Market Title",
        "Person Name",
        "Birth Date",
        "Birth Date (Raw)",
        "Wikipedia URL",
        "Probability %",
        "Market Volume",
        "Market End Date",
        "Status",
        "Last Updated",
    ]

    def __init__(
        self,
        credentials_path: Optional[str] = None,
        sheet_id: Optional[str] = None,
        worksheet_name: str = "Polymarket Contenders"
    ):
        """
        Initialize the Sheets writer.

        Args:
            credentials_path: Path to Google service account credentials JSON
            sheet_id: The Google Sheet ID (from URL)
            worksheet_name: Name of the worksheet to write to
        """
        self.credentials_path = credentials_path or os.getenv("GOOGLE_CREDENTIALS_PATH")
        self.sheet_id = sheet_id or os.getenv("GOOGLE_SHEET_ID")
        self.worksheet_name = worksheet_name or os.getenv("WORKSHEET_NAME", "Polymarket Contenders")

        self.client: Optional[gspread.Client] = None
        self.sheet: Optional[gspread.Spreadsheet] = None
        self.worksheet: Optional[gspread.Worksheet] = None

    def connect(self) -> bool:
        """
        Connect to Google Sheets.

        Returns:
            True if connection successful, False otherwise
        """
        if not self.credentials_path:
            print("Error: GOOGLE_CREDENTIALS_PATH not set")
            return False

        if not self.sheet_id:
            print("Error: GOOGLE_SHEET_ID not set")
            return False

        if not os.path.exists(self.credentials_path):
            print(f"Error: Credentials file not found: {self.credentials_path}")
            return False

        try:
            credentials = Credentials.from_service_account_file(
                self.credentials_path,
                scopes=self.SCOPES
            )
            self.client = gspread.authorize(credentials)
            self.sheet = self.client.open_by_key(self.sheet_id)

            # Get or create worksheet
            try:
                self.worksheet = self.sheet.worksheet(self.worksheet_name)
            except gspread.WorksheetNotFound:
                self.worksheet = self.sheet.add_worksheet(
                    title=self.worksheet_name,
                    rows=1000,
                    cols=len(self.HEADERS)
                )

            return True

        except Exception as e:
            print(f"Error connecting to Google Sheets: {e}")
            return False

    def setup_headers(self):
        """Set up the header row if not already present."""
        if not self.worksheet:
            return

        # Check if headers exist
        try:
            first_row = self.worksheet.row_values(1)
            if first_row != self.HEADERS:
                self.worksheet.update("A1", [self.HEADERS])
                # Format header row (bold)
                self.worksheet.format("A1:J1", {
                    "textFormat": {"bold": True},
                    "backgroundColor": {"red": 0.9, "green": 0.9, "blue": 0.9}
                })
        except:
            self.worksheet.update("A1", [self.HEADERS])

    def write_result(
        self,
        market_title: str,
        person_name: str,
        birth_date: Optional[str],
        birth_date_raw: Optional[str],
        wikipedia_url: Optional[str],
        probability: float,
        market_volume: float,
        market_end_date: Optional[str],
        status: str
    ):
        """
        Write a single result row to the sheet.
        """
        if not self.worksheet:
            print("Error: Not connected to worksheet")
            return

        row = [
            market_title,
            person_name,
            birth_date or "N/A",
            birth_date_raw or "N/A",
            wikipedia_url or "N/A",
            f"{probability:.1f}%",
            f"${market_volume:,.0f}",
            market_end_date or "N/A",
            status,
            datetime.now().strftime("%Y-%m-%d %H:%M:%S UTC"),
        ]

        self.worksheet.append_row(row, value_input_option="USER_ENTERED")

    def write_results_batch(self, results: list[dict]):
        """
        Write multiple results at once (more efficient).

        Args:
            results: List of result dictionaries with keys matching write_result params
        """
        if not self.worksheet:
            print("Error: Not connected to worksheet")
            return

        if not results:
            return

        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S UTC")

        rows = []
        for r in results:
            rows.append([
                r.get("market_title", ""),
                r.get("person_name", ""),
                r.get("birth_date") or "N/A",
                r.get("birth_date_raw") or "N/A",
                r.get("wikipedia_url") or "N/A",
                f"{r.get('probability', 0):.1f}%",
                f"${r.get('market_volume', 0):,.0f}",
                r.get("market_end_date") or "N/A",
                r.get("status", "Unknown"),
                timestamp,
            ])

        # Append all rows at once
        self.worksheet.append_rows(rows, value_input_option="USER_ENTERED")

    def clear_data(self, keep_headers: bool = True):
        """
        Clear all data from the worksheet.

        Args:
            keep_headers: If True, preserve the header row
        """
        if not self.worksheet:
            return

        if keep_headers:
            # Get total rows and clear from row 2 onwards
            row_count = self.worksheet.row_count
            if row_count > 1:
                self.worksheet.delete_rows(2, row_count)
        else:
            self.worksheet.clear()


class CSVWriter:
    """Fallback CSV writer for when Google Sheets is not configured."""

    HEADERS = SheetsWriter.HEADERS

    def __init__(self, output_path: str = "polymarket_contenders.csv"):
        self.output_path = output_path
        self.rows = []

    def connect(self) -> bool:
        """Always returns True for CSV writer."""
        return True

    def setup_headers(self):
        """Headers are written when saving."""
        pass

    def write_result(
        self,
        market_title: str,
        person_name: str,
        birth_date: Optional[str],
        birth_date_raw: Optional[str],
        wikipedia_url: Optional[str],
        probability: float,
        market_volume: float,
        market_end_date: Optional[str],
        status: str
    ):
        """Add a result row to the buffer."""
        self.rows.append({
            "market_title": market_title,
            "person_name": person_name,
            "birth_date": birth_date,
            "birth_date_raw": birth_date_raw,
            "wikipedia_url": wikipedia_url,
            "probability": probability,
            "market_volume": market_volume,
            "market_end_date": market_end_date,
            "status": status,
        })

    def write_results_batch(self, results: list[dict]):
        """Add multiple results to the buffer."""
        self.rows.extend(results)

    def save(self):
        """Save all results to CSV file."""
        import csv

        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S UTC")

        with open(self.output_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(self.HEADERS)

            for r in self.rows:
                writer.writerow([
                    r.get("market_title", ""),
                    r.get("person_name", ""),
                    r.get("birth_date") or "N/A",
                    r.get("birth_date_raw") or "N/A",
                    r.get("wikipedia_url") or "N/A",
                    f"{r.get('probability', 0):.1f}%",
                    f"${r.get('market_volume', 0):,.0f}",
                    r.get("market_end_date") or "N/A",
                    r.get("status", "Unknown"),
                    timestamp,
                ])

        print(f"Results saved to {self.output_path}")

    def clear_data(self, keep_headers: bool = True):
        """Clear the rows buffer."""
        self.rows = []
