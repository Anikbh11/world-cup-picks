const FLAGS = {
  Algeria: "🇩🇿",
  Argentina: "🇦🇷",
  Australia: "🇦🇺",
  Austria: "🇦🇹",
  Belgium: "🇧🇪",
  "Bosnia and Herzegovina": "🇧🇦",
  Brazil: "🇧🇷",
  Canada: "🇨🇦",
  "Cabo Verde": "🇨🇻",
  Colombia: "🇨🇴",
  Croatia: "🇭🇷",
  "DR Congo": "🇨🇩",
  Ecuador: "🇪🇨",
  Egypt: "🇪🇬",
  England: "🏴",
  France: "🇫🇷",
  Germany: "🇩🇪",
  Ghana: "🇬🇭",
  "Ivory Coast": "🇨🇮",
  Japan: "🇯🇵",
  Mexico: "🇲🇽",
  Morocco: "🇲🇦",
  Netherlands: "🇳🇱",
  Norway: "🇳🇴",
  Paraguay: "🇵🇾",
  Portugal: "🇵🇹",
  Senegal: "🇸🇳",
  Spain: "🇪🇸",
  "South Africa": "🇿🇦",
  Switzerland: "🇨🇭",
  Sweden: "🇸🇪",
  "United States": "🇺🇸",
};

export function getFlag(teamName) {
  return FLAGS[teamName] || "◇";
}

export function formatTeam(teamName) {
  return `${getFlag(teamName)} ${teamName}`;
}
