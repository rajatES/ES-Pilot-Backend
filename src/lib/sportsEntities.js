// Starter keyword list used to check whether text found IN an image (via OCR)
// references a recognizable sports entity, league, or personality. This is a
// free, static word-list match — not real entity recognition — so it will
// miss anyone not on the list. Expand it as needed for your beat; it is not
// meant to be an exhaustive global roster.

export const SPORTS_ENTITIES = [
  // Leagues / orgs
  "nfl", "nba", "mlb", "nhl", "mls", "ncaa", "fifa", "uefa", "premier league",
  "la liga", "bundesliga", "serie a", "ligue 1", "ufc", "wwe", "aew", "pga",
  "lpga", "atp", "wta", "f1", "formula 1", "nascar", "indycar", "ipl", "bcci",
  "icc cricket", "olympics", "wimbledon", "us open", "french open",
  "australian open", "the masters", "super bowl", "world cup", "champions league",

  // NFL
  "mahomes", "josh allen", "lamar jackson", "joe burrow", "justin jefferson",
  "travis kelce", "aaron rodgers", "tom brady", "cooper kupp", "micah parsons",

  // NBA
  "lebron james", "stephen curry", "kevin durant", "giannis", "luka doncic",
  "jayson tatum", "nikola jokic", "joel embiid", "damian lillard", "kobe bryant",
  "michael jordan", "shaq", "shaquille o'neal",

  // MLB
  "shohei ohtani", "aaron judge", "mike trout", "mookie betts",

  // Soccer / football
  "messi", "ronaldo", "cristiano ronaldo", "mbappe", "haaland", "neymar",
  "kylian mbappe", "erling haaland", "vinicius jr", "jude bellingham",

  // Tennis
  "novak djokovic", "rafael nadal", "roger federer", "carlos alcaraz",
  "iga swiatek", "coco gauff", "serena williams",

  // Golf
  "tiger woods", "rory mcilroy", "scottie scheffler", "jon rahm",

  // MMA / boxing / wrestling
  "conor mcgregor", "jon jones", "khabib", "israel adesanya", "canelo alvarez",
  "roman reigns", "cody rhodes",

  // Cricket
  "virat kohli", "rohit sharma", "babar azam", "ben stokes", "joe root",

  // F1
  "max verstappen", "lewis hamilton", "charles leclerc", "lando norris"
];

export function mentionsSportsEntity(text) {
  const lower = (text || "").toLowerCase();
  return SPORTS_ENTITIES.some((entity) => lower.includes(entity));
}
