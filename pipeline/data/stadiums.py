"""Home-stadium coordinates and roof type for every NFL team.

Used to pull a kickoff-time weather forecast for the game-week dossier. A
retractable roof still gets a forecast: whether it's open on game day is a
late call by the home team (cold-weather teams often play with it open), so
the forecast has to exist even though it may end up irrelevant.

Domes are the opposite case — no forecast is shown at all, because the roof
never opens regardless of conditions outside.
"""

STADIUMS = {
    "ARI": {
        "name": "State Farm Stadium",
        "city": "Glendale, AZ",
        "lat": 33.5276,
        "lon": -112.2626,
        "roof": "retractable",
    },
    "ATL": {
        "name": "Mercedes-Benz Stadium",
        "city": "Atlanta, GA",
        "lat": 33.7556,
        "lon": -84.4000,
        "roof": "retractable",
    },
    "BAL": {
        "name": "M&T Bank Stadium",
        "city": "Baltimore, MD",
        "lat": 39.2781,
        "lon": -76.6228,
        "roof": "outdoor",
    },
    "BUF": {
        "name": "Highmark Stadium",
        "city": "Orchard Park, NY",
        "lat": 42.7731,
        "lon": -78.7922,
        # The 360-degree canopy only shields ~65% of seating; the field itself
        # is uncovered, so this is weather-exposed like any open stadium.
        "roof": "outdoor",
    },
    "CAR": {
        "name": "Bank of America Stadium",
        "city": "Charlotte, NC",
        "lat": 35.2258,
        "lon": -80.8528,
        "roof": "outdoor",
    },
    "CHI": {
        "name": "Soldier Field",
        "city": "Chicago, IL",
        "lat": 41.8623,
        "lon": -87.6167,
        "roof": "outdoor",
    },
    "CIN": {
        "name": "Paycor Stadium",
        "city": "Cincinnati, OH",
        "lat": 39.0950,
        "lon": -84.5160,
        "roof": "outdoor",
    },
    "CLE": {
        "name": "Huntington Bank Field",
        "city": "Cleveland, OH",
        "lat": 41.5061,
        "lon": -81.6994,
        "roof": "outdoor",
    },
    "DAL": {
        "name": "AT&T Stadium",
        "city": "Arlington, TX",
        "lat": 32.7478,
        "lon": -97.0928,
        "roof": "retractable",
    },
    "DEN": {
        "name": "Empower Field at Mile High",
        "city": "Denver, CO",
        "lat": 39.7439,
        "lon": -105.0200,
        "roof": "outdoor",
    },
    "DET": {
        "name": "Ford Field",
        "city": "Detroit, MI",
        "lat": 42.3400,
        "lon": -83.0456,
        "roof": "dome",
    },
    "GB": {
        "name": "Lambeau Field",
        "city": "Green Bay, WI",
        "lat": 44.5014,
        "lon": -88.0622,
        "roof": "outdoor",
    },
    "HOU": {
        "name": "NRG Stadium",
        "city": "Houston, TX",
        "lat": 29.6847,
        "lon": -95.4108,
        "roof": "retractable",
    },
    "IND": {
        "name": "Lucas Oil Stadium",
        "city": "Indianapolis, IN",
        "lat": 39.7601,
        "lon": -86.1638,
        "roof": "retractable",
    },
    "JAX": {
        "name": "EverBank Stadium",
        "city": "Jacksonville, FL",
        "lat": 30.3239,
        "lon": -81.6375,
        "roof": "outdoor",
    },
    "KC": {
        "name": "Arrowhead Stadium",
        "city": "Kansas City, MO",
        "lat": 39.0489,
        "lon": -94.4839,
        "roof": "outdoor",
    },
    # LAC and LAR both play at SoFi Stadium — same venue, duplicated here so
    # each team code resolves on its own without a shared-venue lookup step.
    "LAC": {
        "name": "SoFi Stadium",
        "city": "Inglewood, CA",
        "lat": 33.9530,
        "lon": -118.3390,
        # The ETFE canopy has open sides and vent panels; it's read as a dome
        # from photos but the field is weather-exposed (it's had a lightning
        # delay), so it belongs with the outdoor stadiums for forecast purposes.
        "roof": "outdoor",
    },
    "LAR": {
        "name": "SoFi Stadium",
        "city": "Inglewood, CA",
        "lat": 33.9530,
        "lon": -118.3390,
        "roof": "outdoor",
    },
    "LV": {
        "name": "Allegiant Stadium",
        "city": "Paradise, NV",
        "lat": 36.0906,
        "lon": -115.1839,
        # Translucent ETFE roof lets light in but does not open — fully
        # enclosed and climate-controlled, so it's a dome, not a retractable.
        "roof": "dome",
    },
    "MIA": {
        "name": "Hard Rock Stadium",
        "city": "Miami Gardens, FL",
        "lat": 25.9581,
        "lon": -80.2389,
        # The canopy has a field-sized hole in the middle by design — it
        # shields seating, not the playing surface, so rain still falls on the game.
        "roof": "outdoor",
    },
    "MIN": {
        "name": "U.S. Bank Stadium",
        "city": "Minneapolis, MN",
        "lat": 44.9740,
        "lon": -93.2580,
        # A retractable design was considered and dropped as impractical for
        # Minnesota winters; the fixed ETFE roof never opens, so this is a dome.
        "roof": "dome",
    },
    "NE": {
        "name": "Gillette Stadium",
        "city": "Foxborough, MA",
        "lat": 42.0910,
        "lon": -71.2640,
        "roof": "outdoor",
    },
    "NO": {
        "name": "Caesars Superdome",
        "city": "New Orleans, LA",
        "lat": 29.9508,
        "lon": -90.0811,
        "roof": "dome",
    },
    # NYG and NYJ both play at MetLife Stadium — same venue, duplicated here so
    # each team code resolves on its own without a shared-venue lookup step.
    "NYG": {
        "name": "MetLife Stadium",
        "city": "East Rutherford, NJ",
        "lat": 40.8135,
        "lon": -74.0744,
        "roof": "outdoor",
    },
    "NYJ": {
        "name": "MetLife Stadium",
        "city": "East Rutherford, NJ",
        "lat": 40.8135,
        "lon": -74.0744,
        "roof": "outdoor",
    },
    "PHI": {
        "name": "Lincoln Financial Field",
        "city": "Philadelphia, PA",
        "lat": 39.9008,
        "lon": -75.1675,
        "roof": "outdoor",
    },
    "PIT": {
        "name": "Acrisure Stadium",
        "city": "Pittsburgh, PA",
        "lat": 40.4467,
        "lon": -80.0158,
        "roof": "outdoor",
    },
    "SEA": {
        "name": "Lumen Field",
        "city": "Seattle, WA",
        "lat": 47.5952,
        "lon": -122.3316,
        # The fixed roof covers ~70% of seating on trusses/arches, but the
        # field itself is open to the sky, so weather still reaches the game.
        "roof": "outdoor",
    },
    "SF": {
        "name": "Levi's Stadium",
        "city": "Santa Clara, CA",
        "lat": 37.4030,
        "lon": -121.9700,
        "roof": "outdoor",
    },
    "TB": {
        "name": "Raymond James Stadium",
        "city": "Tampa, FL",
        "lat": 27.9758,
        "lon": -82.5033,
        "roof": "outdoor",
    },
    "TEN": {
        "name": "Nissan Stadium",
        "city": "Nashville, TN",
        "lat": 36.1664,
        "lon": -86.7714,
        # The Titans' new domed stadium is under construction next door but
        # doesn't open until 2027 — this is still the current, open-air venue.
        "roof": "outdoor",
    },
    "WSH": {
        "name": "Northwest Stadium",
        "city": "Landover, MD",
        "lat": 38.9078,
        "lon": -76.8644,
        "roof": "outdoor",
    },
}
