const FLAGS = {
  Argentina: "🇦🇷",
  Australia: "🇦🇺",
  Belgium: "🇧🇪",
  "Bosnia and Herzegovina": "🇧🇦",
  Brazil: "🇧🇷",
  Canada: "🇨🇦",
  "Cabo Verde": "🇨🇻",
  Egypt: "🇪🇬",
  France: "🇫🇷",
  Germany: "🇩🇪",
  "Ivory Coast": "🇨🇮",
  Japan: "🇯🇵",
  Mexico: "🇲🇽",
  Morocco: "🇲🇦",
  Netherlands: "🇳🇱",
  Norway: "🇳🇴",
  Spain: "🇪🇸",
  "South Africa": "🇿🇦",
  Switzerland: "🇨🇭",
  "United States": "🇺🇸",
};

export function getFlag(teamName) {
  return FLAGS[teamName] || "◇";
}

export function formatTeam(teamName) {
  return `${getFlag(teamName)} ${teamName}`;
}
