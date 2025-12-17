# PolyCrawler

Extract public figure birth dates from Polymarket prediction markets for horoscope analysis.

## Flow

```
Polymarket API
  ↓ (fetch active markets)
Extract person names from market titles/options
  ↓ (identify top contenders)
Wikipedia API lookup
  ↓ (get birth dates if available)
Write to Google Sheet / CSV:
  | Market Title | Person Name | Birth Date | Wikipedia URL | Last Updated |
```

## Installation

```bash
# Clone the repository
git clone https://github.com/LennartvdM/PolyCrawler.git
cd PolyCrawler

# Create virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt
```

## Configuration

### Google Sheets (Optional)

1. Create a Google Cloud project and enable the Google Sheets API
2. Create a service account and download the credentials JSON
3. Share your Google Sheet with the service account email
4. Create a `.env` file from the template:

```bash
cp .env.example .env
```

Edit `.env` with your settings:
```
GOOGLE_CREDENTIALS_PATH=config/google_credentials.json
GOOGLE_SHEET_ID=your_sheet_id_here
WORKSHEET_NAME=Polymarket Contenders
```

If Google Sheets is not configured, results will be saved to CSV instead.

## Usage

```bash
# Run with default settings (100 markets, 4 top contenders each)
python src/main.py

# Customize the crawl
python src/main.py --markets 50 --top 6

# Output only to CSV
python src/main.py --output csv --csv-path results.csv

# Output only to Google Sheets (clears existing data)
python src/main.py --output sheets --clear

# Quiet mode (minimal output)
python src/main.py --quiet
```

### Command Line Options

| Option | Default | Description |
|--------|---------|-------------|
| `--markets`, `-m` | 100 | Maximum number of markets to fetch |
| `--top`, `-t` | 4 | Number of top contenders per market |
| `--output`, `-o` | both | Output destination: `sheets`, `csv`, or `both` |
| `--csv-path` | polymarket_contenders.csv | CSV output file path |
| `--clear` | False | Clear existing sheet data before writing |
| `--quiet`, `-q` | False | Suppress progress output |

## Output Columns

| Column | Description |
|--------|-------------|
| Market Title | The Polymarket prediction question |
| Person Name | Name of the contender |
| Birth Date | Formatted birth date (e.g., "December 22, 1962") |
| Birth Date (Raw) | ISO format date for parsing (e.g., "1962-12-22") |
| Wikipedia URL | Link to the person's Wikipedia page |
| Probability % | Current odds for this contender |
| Market Volume | Total market trading volume |
| Market End Date | When the market closes |
| Status | "Found", "Wikipedia page not found", or "Birth date not found on Wikipedia" |
| Last Updated | Timestamp of when this row was written |

## Example Output

```
Market: Who will Trump nominate as Fed Chair?
Volume: $67,875,031
End Date: Dec 31, 2026

| Person Name         | Birth Date        | Status |
|---------------------|-------------------|--------|
| Kevin Hassett       | September 2, 1962 | Found  |
| Kevin Warsh         | January 21, 1970  | Found  |
| Christopher Waller  | July 22, 1959     | Found  |
| Scott Bessent       | August 27, 1962   | Found  |
```

## Data Sources

- **Polymarket API**: Public prediction market data
- **Wikipedia API**: Birth date extraction from freely available Wikipedia infoboxes

This tool only extracts publicly available information. No OSINT or hard-to-find data is collected.

## License

MIT
