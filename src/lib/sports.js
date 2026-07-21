// Sports taxonomy + auto-detection from a Page's name.
// Users can override the detected category manually in the Accounts hub.

export const SPORTS = [
  "NFL", "NBA", "MLB", "NHL", "MMA/UFC", "Boxing", "Golf",
  "Soccer", "Motorsport", "Tennis", "WWE", "College", "Cricket", "Other"
];

const KEYWORDS = {
  "NFL": ["nfl", "chiefs", "bills", "cowboys", "49ers", "niners", "eagles", "packers", "ravens", "steelers", "dolphins", "browns", "dawg pound", "gridiron", "4th down", "arrowhead", "touchdown", "quarterback", "mahomes", "bengals", "lions", "vikings"],
  "NBA": ["nba", "lakers", "celtics", "warriors", "hoops", "basketball", "dunk", "knicks", "bulls", "heat", "kobe"],
  "MLB": ["mlb", "yankees", "dodgers", "baseball", "red sox"],
  "NHL": ["nhl", "hockey", "stanley cup"],
  "MMA/UFC": ["ufc", "mma", "octagon", "fighter", "bellator"],
  "Boxing": ["boxing", "boxer", "knockout", "heavyweight"],
  "Golf": ["golf", "liv golf", "pga", "masters", "birdie"],
  "Soccer": ["soccer", "football club", "premier league", "la liga", "champions league", "messi", "ronaldo"],
  "Motorsport": ["nascar", "racing", "motorsport", "formula 1", "formula1", "f1", "grand prix"],
  "Tennis": ["tennis", "atp", "wta", "grand slam", "wimbledon"],
  "WWE": ["wwe", "wrestling", "wrestlemania", "wwenewsone"],
  "College": ["college", "ncaa", "michigan", "ohio state", "colorado", "buckeye", "wolverine", "gators", "crimson tide"],
  "Cricket": ["cricket", "ipl", "wicket"]
};

export function detectSport(name = "") {
  const n = String(name).toLowerCase();
  for (const sport of Object.keys(KEYWORDS)) {
    if (KEYWORDS[sport].some((k) => n.includes(k))) return sport;
  }
  return "Other";
}
