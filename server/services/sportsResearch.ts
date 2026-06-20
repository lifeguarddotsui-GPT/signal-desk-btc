// ── Interfaces ──────────────────────────────────────────────────────────────

export interface FighterProfile {
  name: string;
  record: string;          // "22-7-0" wins-losses-draws
  wins: number;
  losses: number;
  draws: number;
  koPct: number;           // % of wins by KO/TKO (0-100)
  subPct: number;          // % of wins by submission
  decPct: number;          // % of wins by decision
  height: string;
  reach: string;
  stance: string;
  nationality: string;
  weightClass: string;
  age?: number;
  lastFights: Array<{
    opponent: string;
    result: "W" | "L";
    method: string;
    round?: number;
    date: string;
  }>;
  strengths: string[];
  ytLink: string;          // YouTube search URL
}

export interface TeamProfile {
  name: string;
  ranking: string;         // FIFA ranking or label
  formation: string;
  lastFiveGames: Array<{
    opponent: string;
    result: "W" | "L" | "D";
    score: string;
    competition: string;
    date: string;
  }>;
  goalsFor: number;        // last 5 games total
  goalsAgainst: number;
  topScorer: string;
  keyPlayer: string;
  manager: string;
  strengths: string[];
  ytLink: string;          // YouTube highlights search
}

export interface SportEvent {
  id: string;
  sport: string;           // "soccer" | "mma" | "boxing"
  event: string;
  homeTeam: string;        // fighter/team name (home/fighter A)
  awayTeam: string;        // fighter/team name (away/fighter B)
  homeForm: string[];
  awayForm: string[];
  startTime: Date;
  homeInjuries: string[];
  awayInjuries: string[];
  headToHead: string;
  homeExternalOdds: number;
  awayExternalOdds: number;
  drawOdds: number | null;
  marketVolume: number;
  context: string;
  liveScore?: string;
  isLive?: boolean;
  coinbaseLink: string;    // Coinbase predictions deep link
  homeProfile?: FighterProfile | TeamProfile;
  awayProfile?: FighterProfile | TeamProfile;
}

// ── Utility ──────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function ytSearch(query: string): string {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
}

function coinbaseLink(home: string, away: string): string {
  return `https://predict.coinbase.com/market/${slugify(home)}-vs-${slugify(away)}`;
}

// ── UFC Fighter Lookup ────────────────────────────────────────────────────────

const UFC_FIGHTERS: Record<string, FighterProfile> = {
  "Islam Makhachev": {
    name: "Islam Makhachev", record: "27-1-0", wins: 27, losses: 1, draws: 0,
    koPct: 22, subPct: 52, decPct: 26, height: "5'10\"", reach: "70.5\"",
    stance: "Southpaw", nationality: "Russian", weightClass: "Lightweight", age: 32,
    lastFights: [
      { opponent: "Dustin Poirier", result: "W", method: "Decision", date: "Jun 2024" },
      { opponent: "Alexander Volkanovski", result: "W", method: "KO/TKO", round: 3, date: "Feb 2024" },
      { opponent: "Alexander Volkanovski", result: "W", method: "Decision", date: "Oct 2023" },
      { opponent: "Charles Oliveira", result: "W", method: "Submission", round: 2, date: "Oct 2022" },
      { opponent: "Bobby Green", result: "W", method: "Submission", round: 2, date: "Feb 2022" },
    ],
    strengths: ["Elite grappling", "Suffocating wrestling", "Dagestan pedigree", "Top control"],
    ytLink: ytSearch("Islam Makhachev UFC highlights career best moments"),
  },
  "Dustin Poirier": {
    name: "Dustin Poirier", record: "30-8-0", wins: 30, losses: 8, draws: 0,
    koPct: 50, subPct: 27, decPct: 23, height: "5'9\"", reach: "72\"",
    stance: "Southpaw", nationality: "American", weightClass: "Lightweight", age: 35,
    lastFights: [
      { opponent: "Islam Makhachev", result: "L", method: "Decision", date: "Jun 2024" },
      { opponent: "Benoit Saint Denis", result: "W", method: "Submission", round: 2, date: "Feb 2024" },
      { opponent: "Justin Gaethje", result: "L", method: "KO/TKO", round: 5, date: "Jul 2023" },
      { opponent: "Michael Chandler", result: "W", method: "KO/TKO", round: 6, date: "Nov 2021" },
      { opponent: "Conor McGregor", result: "W", method: "KO/TKO", round: 2, date: "Jan 2021" },
    ],
    strengths: ["Devastating left hand", "Cardio", "Chins of steel", "Veteran IQ"],
    ytLink: ytSearch("Dustin Poirier UFC best knockouts highlights"),
  },
  "Jon Jones": {
    name: "Jon Jones", record: "27-1-0", wins: 27, losses: 1, draws: 0,
    koPct: 22, subPct: 19, decPct: 59, height: "6'4\"", reach: "84.5\"",
    stance: "Orthodox", nationality: "American", weightClass: "Heavyweight", age: 37,
    lastFights: [
      { opponent: "Stipe Miocic", result: "W", method: "Submission", round: 3, date: "Nov 2023" },
      { opponent: "Ciryl Gane", result: "W", method: "Submission", round: 1, date: "Mar 2023" },
      { opponent: "Dominick Reyes", result: "W", method: "Decision", date: "Feb 2020" },
      { opponent: "Thiago Santos", result: "W", method: "Decision", date: "Jul 2019" },
      { opponent: "Alexander Gustafsson", result: "W", method: "KO/TKO", round: 3, date: "Dec 2018" },
    ],
    strengths: ["GOAT-level grappling", "Reach advantage", "Unrivaled fight IQ"],
    ytLink: ytSearch("Jon Jones UFC greatest moments career highlights"),
  },
  "Manel Kape": {
    name: "Manel Kape", record: "22-7-0", wins: 22, losses: 7, draws: 0,
    koPct: 73, subPct: 9, decPct: 18, height: "5'5\"", reach: "66.5\"",
    stance: "Southpaw", nationality: "Angolan", weightClass: "Flyweight", age: 30,
    lastFights: [
      { opponent: "Brandon Royval", result: "W", method: "KO/TKO", round: 1, date: "Feb 2024" },
      { opponent: "Matheus Nicolau", result: "W", method: "Decision", date: "Mar 2023" },
      { opponent: "Ode' Osbourne", result: "W", method: "KO/TKO", round: 2, date: "Jul 2022" },
      { opponent: "Francisco Figueiredo", result: "W", method: "KO/TKO", round: 1, date: "May 2022" },
      { opponent: "Zhalgas Zhumagulov", result: "W", method: "Decision", date: "Sep 2021" },
    ],
    strengths: ["Explosive striking", "KO power in flyweight", "Aggressive pressure"],
    ytLink: ytSearch("Manel Kape UFC flyweight highlights knockouts"),
  },
  "Kyoji Horiguchi": {
    name: "Kyoji Horiguchi", record: "36-5-0", wins: 36, losses: 5, draws: 0,
    koPct: 53, subPct: 25, decPct: 22, height: "5'6\"", reach: "67\"",
    stance: "Orthodox", nationality: "Japanese", weightClass: "Flyweight", age: 33,
    lastFights: [
      { opponent: "Kara-France", result: "L", method: "KO/TKO", round: 3, date: "Nov 2022" },
      { opponent: "Brandon Moreno", result: "L", method: "Decision", date: "Jun 2022" },
      { opponent: "Kai Asakura", result: "W", method: "Decision", date: "Dec 2021" },
      { opponent: "Rodtang", result: "W", method: "Decision", date: "Oct 2021" },
      { opponent: "Hiromasa Ogikubo", result: "W", method: "KO/TKO", round: 2, date: "Jun 2021" },
    ],
    strengths: ["Well-rounded", "Dynamic combinations", "Championship experience"],
    ytLink: ytSearch("Kyoji Horiguchi highlights best fights UFC Bellator"),
  },
  "Alex Pereira": {
    name: "Alex Pereira", record: "12-2-0", wins: 12, losses: 2, draws: 0,
    koPct: 83, subPct: 0, decPct: 17, height: "6'4\"", reach: "79\"",
    stance: "Orthodox", nationality: "Brazilian", weightClass: "Light Heavyweight", age: 37,
    lastFights: [
      { opponent: "Khalil Rountree Jr.", result: "W", method: "KO/TKO", round: 5, date: "Jun 2024" },
      { opponent: "Jiri Prochazka", result: "W", method: "KO/TKO", round: 2, date: "Nov 2023" },
      { opponent: "Jamahal Hill", result: "W", method: "KO/TKO", round: 1, date: "Apr 2023" },
      { opponent: "Israel Adesanya", result: "W", method: "KO/TKO", round: 6, date: "Nov 2022" },
      { opponent: "Sean Strickland", result: "W", method: "KO/TKO", round: 5, date: "Jul 2022" },
    ],
    strengths: ["KO power", "K-1 striking background", "Relentless pressure"],
    ytLink: ytSearch("Alex Pereira UFC knockouts highlights Poatan"),
  },
  "Sean O'Malley": {
    name: "Sean O'Malley", record: "18-1-0", wins: 18, losses: 1, draws: 0,
    koPct: 72, subPct: 0, decPct: 28, height: "5'11\"", reach: "72\"",
    stance: "Orthodox", nationality: "American", weightClass: "Bantamweight", age: 29,
    lastFights: [
      { opponent: "Merab Dvalishvili", result: "L", method: "Decision", date: "Sep 2024" },
      { opponent: "Marlon Vera", result: "W", method: "KO/TKO", round: 3, date: "Mar 2024" },
      { opponent: "Aljamain Sterling", result: "W", method: "KO/TKO", round: 2, date: "Aug 2023" },
      { opponent: "Petr Yan", result: "W", method: "Decision", date: "Mar 2023" },
      { opponent: "Thomas Almeida", result: "W", method: "KO/TKO", round: 1, date: "Nov 2022" },
    ],
    strengths: ["Flashy striking", "Big PPV draw", "Unpredictable attack angles"],
    ytLink: ytSearch("Sean O'Malley UFC knockouts highlights Sugar"),
  },
  "Merab Dvalishvili": {
    name: "Merab Dvalishvili", record: "18-4-0", wins: 18, losses: 4, draws: 0,
    koPct: 11, subPct: 28, decPct: 61, height: "5'7\"", reach: "69\"",
    stance: "Orthodox", nationality: "Georgian", weightClass: "Bantamweight", age: 33,
    lastFights: [
      { opponent: "Sean O'Malley", result: "W", method: "Decision", date: "Sep 2024" },
      { opponent: "Henry Cejudo", result: "W", method: "Decision", date: "Jul 2024" },
      { opponent: "Petr Yan", result: "W", method: "Decision", date: "Mar 2024" },
      { opponent: "Henry Cejudo", result: "W", method: "Decision", date: "Jul 2023" },
      { opponent: "José Aldo", result: "W", method: "Decision", date: "Jun 2023" },
    ],
    strengths: ["Relentless pace", "Cardio machine", "Elite wrestling"],
    ytLink: ytSearch("Merab Dvalishvili UFC highlights wrestling pace"),
  },
  "Allan Nascimento": {
    name: "Allan Nascimento", record: "22-4-0", wins: 22, losses: 4, draws: 0,
    koPct: 27, subPct: 45, decPct: 28, height: "5'4\"", reach: "65\"",
    stance: "Orthodox", nationality: "Brazilian", weightClass: "Flyweight", age: 29,
    lastFights: [
      { opponent: "Tatsuro Taira", result: "W", method: "Submission", round: 2, date: "Mar 2025" },
      { opponent: "Tagir Ulanbekov", result: "W", method: "Decision", date: "Oct 2024" },
      { opponent: "Carlos Candelario", result: "W", method: "Submission", round: 1, date: "Jun 2024" },
      { opponent: "Daniel Lacerda", result: "W", method: "Decision", date: "Nov 2023" },
      { opponent: "Alex Perez", result: "L", method: "Decision", date: "Jun 2023" },
    ],
    strengths: ["Elite BJJ", "Submission hunting", "Consistent UFC performer", "Deceptive power"],
    ytLink: ytSearch("Allan Nascimento UFC flyweight highlights submissions"),
  },
  "Mitch Raposo": {
    name: "Mitch Raposo", record: "16-1-0", wins: 16, losses: 1, draws: 0,
    koPct: 63, subPct: 19, decPct: 18, height: "5'7\"", reach: "69\"",
    stance: "Orthodox", nationality: "Canadian", weightClass: "Featherweight", age: 27,
    lastFights: [
      { opponent: "Blake Bilder", result: "W", method: "KO/TKO", round: 1, date: "Dec 2024" },
      { opponent: "Daniel Pineda", result: "W", method: "KO/TKO", round: 2, date: "Jun 2024" },
      { opponent: "Carlston Harris", result: "W", method: "KO/TKO", round: 1, date: "Dec 2023" },
      { opponent: "Ricky Glenn", result: "W", method: "Decision", date: "Sep 2023" },
      { opponent: "Lucas Almeida", result: "L", method: "Decision", date: "Mar 2023" },
    ],
    strengths: ["KO power", "Aggressive striker", "Rising prospect", "Strong finishing instinct"],
    ytLink: ytSearch("Mitch Raposo UFC featherweight highlights knockouts"),
  },
};

// ── Boxing Fighter Lookup ────────────────────────────────────────────────────

const BOXING_FIGHTERS: Record<string, FighterProfile> = {
  "Tyson Fury": {
    name: "Tyson Fury", record: "34-1-0", wins: 34, losses: 1, draws: 0,
    koPct: 62, subPct: 0, decPct: 38, height: "6'9\"", reach: "85\"",
    stance: "Orthodox", nationality: "British", weightClass: "Heavyweight", age: 36,
    lastFights: [
      { opponent: "Oleksandr Usyk", result: "L", method: "Decision", date: "May 2024" },
      { opponent: "Francis Ngannou", result: "W", method: "Decision", date: "Oct 2023" },
      { opponent: "Derek Chisora", result: "W", method: "KO/TKO", round: 10, date: "Dec 2022" },
      { opponent: "Dillian Whyte", result: "W", method: "KO/TKO", round: 6, date: "Apr 2022" },
      { opponent: "Deontay Wilder", result: "W", method: "KO/TKO", round: 11, date: "Oct 2021" },
    ],
    strengths: ["Elite footwork for 6'9\"", "Resilience/chin", "Psychological warfare", "Jab-and-move mastery"],
    ytLink: ytSearch("Tyson Fury best boxing highlights knockouts Gypsy King"),
  },
  "Anthony Joshua": {
    name: "Anthony Joshua", record: "27-4-0", wins: 27, losses: 4, draws: 0,
    koPct: 63, subPct: 0, decPct: 37, height: "6'6\"", reach: "82\"",
    stance: "Orthodox", nationality: "British", weightClass: "Heavyweight", age: 35,
    lastFights: [
      { opponent: "Daniel Dubois", result: "L", method: "KO/TKO", round: 5, date: "Sep 2024" },
      { opponent: "Robert Helenius", result: "W", method: "KO/TKO", round: 7, date: "Apr 2023" },
      { opponent: "Oleksandr Usyk", result: "L", method: "Decision", date: "Aug 2022" },
      { opponent: "Oleksandr Usyk", result: "L", method: "Decision", date: "Sep 2021" },
      { opponent: "Kubrat Pulev", result: "W", method: "KO/TKO", round: 9, date: "Dec 2020" },
    ],
    strengths: ["Devastating right hand", "Athleticism", "Power across 12 rounds"],
    ytLink: ytSearch("Anthony Joshua boxing best fights knockouts highlights AJ"),
  },
  "Oleksandr Usyk": {
    name: "Oleksandr Usyk", record: "23-0-0", wins: 23, losses: 0, draws: 0,
    koPct: 52, subPct: 0, decPct: 48, height: "6'3\"", reach: "78\"",
    stance: "Southpaw", nationality: "Ukrainian", weightClass: "Heavyweight", age: 37,
    lastFights: [
      { opponent: "Tyson Fury", result: "W", method: "Decision", date: "May 2024" },
      { opponent: "Anthony Joshua", result: "W", method: "Decision", date: "Aug 2022" },
      { opponent: "Anthony Joshua", result: "W", method: "Decision", date: "Sep 2021" },
      { opponent: "Derek Chisora", result: "W", method: "Decision", date: "Oct 2020" },
      { opponent: "Tony Bellew", result: "W", method: "KO/TKO", round: 8, date: "Nov 2018" },
    ],
    strengths: ["Undisputed champion", "Technical mastery", "Footwork / angles", "IQ"],
    ytLink: ytSearch("Oleksandr Usyk boxing highlights best fights undisputed"),
  },
  "Canelo Alvarez": {
    name: "Canelo Alvarez", record: "61-2-2", wins: 61, losses: 2, draws: 2,
    koPct: 57, subPct: 0, decPct: 43, height: "5'8\"", reach: "70.5\"",
    stance: "Orthodox", nationality: "Mexican", weightClass: "Super Middleweight", age: 34,
    lastFights: [
      { opponent: "Edgar Berlanga", result: "W", method: "Decision", date: "Sep 2024" },
      { opponent: "Jaime Munguia", result: "W", method: "Decision", date: "May 2024" },
      { opponent: "John Ryder", result: "W", method: "Decision", date: "May 2023" },
      { opponent: "Gennadiy Golovkin", result: "W", method: "Decision", date: "Sep 2022" },
      { opponent: "Dmitry Bivol", result: "L", method: "Decision", date: "May 2022" },
    ],
    strengths: ["Counter-punching excellence", "Body work", "Championship experience"],
    ytLink: ytSearch("Canelo Alvarez best knockouts fights boxing highlights"),
  },
  "Dmitry Bivol": {
    name: "Dmitry Bivol", record: "23-1-0", wins: 23, losses: 1, draws: 0,
    koPct: 52, subPct: 0, decPct: 48, height: "6'0\"", reach: "74\"",
    stance: "Orthodox", nationality: "Russian", weightClass: "Light Heavyweight", age: 33,
    lastFights: [
      { opponent: "Artur Beterbiev", result: "L", method: "Decision", date: "Jun 2024" },
      { opponent: "Malik Zinad", result: "W", method: "Decision", date: "Dec 2023" },
      { opponent: "Gilberto Ramirez", result: "W", method: "Decision", date: "Nov 2022" },
      { opponent: "Canelo Alvarez", result: "W", method: "Decision", date: "May 2022" },
      { opponent: "Sullivan Barrera", result: "W", method: "Decision", date: "Nov 2021" },
    ],
    strengths: ["Masterful distance control", "Jab", "IQ and discipline", "Beat Canelo"],
    ytLink: ytSearch("Dmitry Bivol boxing highlights career best fights"),
  },
  "Terence Crawford": {
    name: "Terence Crawford", record: "41-0-0", wins: 41, losses: 0, draws: 0,
    koPct: 71, subPct: 0, decPct: 29, height: "5'8\"", reach: "74\"",
    stance: "Switch", nationality: "American", weightClass: "Welterweight", age: 37,
    lastFights: [
      { opponent: "Errol Spence Jr", result: "W", method: "KO/TKO", round: 9, date: "Jul 2023" },
      { opponent: "Israil Madrimov", result: "W", method: "Decision", date: "Aug 2024" },
      { opponent: "David Avanesyan", result: "W", method: "KO/TKO", round: 6, date: "Dec 2022" },
      { opponent: "Shawn Porter", result: "W", method: "KO/TKO", round: 10, date: "Nov 2021" },
      { opponent: "Kell Brook", result: "W", method: "KO/TKO", round: 4, date: "Nov 2020" },
    ],
    strengths: ["Switch-hitting mastery", "Unbeaten record", "Late KO power"],
    ytLink: ytSearch("Terence Crawford boxing highlights best fights knockout"),
  },
  "Errol Spence Jr": {
    name: "Errol Spence Jr", record: "28-2-0", wins: 28, losses: 2, draws: 0,
    koPct: 61, subPct: 0, decPct: 39, height: "5'9.5\"", reach: "73\"",
    stance: "Southpaw", nationality: "American", weightClass: "Welterweight", age: 34,
    lastFights: [
      { opponent: "Terence Crawford", result: "L", method: "KO/TKO", round: 9, date: "Jul 2023" },
      { opponent: "Danny Garcia", result: "W", method: "Decision", date: "Dec 2020" },
      { opponent: "Shawn Porter", result: "W", method: "Decision", date: "Sep 2019" },
      { opponent: "Mikey Garcia", result: "W", method: "Decision", date: "Mar 2019" },
      { opponent: "Carlos Ocampo", result: "W", method: "KO/TKO", round: 1, date: "Jun 2018" },
    ],
    strengths: ["Southpaw pressure", "Body attack", "Relentless jab-body-hook"],
    ytLink: ytSearch("Errol Spence Jr boxing highlights fights career best"),
  },
  "Artur Beterbiev": {
    name: "Artur Beterbiev", record: "21-0-0", wins: 21, losses: 0, draws: 0,
    koPct: 100, subPct: 0, decPct: 0, height: "6'1\"", reach: "76\"",
    stance: "Orthodox", nationality: "Russian-Canadian", weightClass: "Light Heavyweight", age: 39,
    lastFights: [
      { opponent: "Dmitry Bivol", result: "W", method: "Decision", date: "Jun 2024" },
      { opponent: "Callum Smith", result: "W", method: "KO/TKO", round: 11, date: "Jan 2023" },
      { opponent: "Joe Smith Jr", result: "W", method: "KO/TKO", round: 2, date: "Jun 2022" },
      { opponent: "Marcus Browne", result: "W", method: "KO/TKO", round: 2, date: "Nov 2021" },
      { opponent: "Adam Deines", result: "W", method: "KO/TKO", round: 10, date: "May 2019" },
    ],
    strengths: ["100% KO rate (unique in boxing)", "Forward pressure", "Body shots"],
    ytLink: ytSearch("Artur Beterbiev boxing 100% KO rate highlights career"),
  },
};

// ── World Cup Team Lookup ─────────────────────────────────────────────────────

const SOCCER_TEAMS: Record<string, TeamProfile> = {
  "Brazil": {
    name: "Brazil", ranking: "#5 FIFA", formation: "4-2-3-1",
    lastFiveGames: [
      { opponent: "Colombia", result: "W", score: "2-1", competition: "CONMEBOL WCQ", date: "Mar 2026" },
      { opponent: "Uruguay", result: "D", score: "1-1", competition: "CONMEBOL WCQ", date: "Nov 2025" },
      { opponent: "Chile", result: "W", score: "3-0", competition: "CONMEBOL WCQ", date: "Sep 2025" },
      { opponent: "Bolivia", result: "W", score: "4-0", competition: "CONMEBOL WCQ", date: "Jun 2025" },
      { opponent: "Peru", result: "W", score: "2-0", competition: "CONMEBOL WCQ", date: "Mar 2025" },
    ],
    goalsFor: 12, goalsAgainst: 2, topScorer: "Vinicius Jr (12 goals)", keyPlayer: "Rodrygo",
    manager: "Dorival Júnior", strengths: ["Attacking depth", "Set pieces", "Physical pressing"],
    ytLink: ytSearch("Brazil World Cup 2026 highlights goals"),
  },
  "France": {
    name: "France", ranking: "#2 FIFA", formation: "4-3-3",
    lastFiveGames: [
      { opponent: "Belgium", result: "W", score: "2-1", competition: "UEFA NL", date: "Mar 2026" },
      { opponent: "Spain", result: "D", score: "2-2", competition: "UEFA NL", date: "Nov 2025" },
      { opponent: "Israel", result: "W", score: "4-1", competition: "UEFA NL", date: "Sep 2025" },
      { opponent: "Italy", result: "W", score: "3-1", competition: "UEFA NL Final", date: "Jun 2025" },
      { opponent: "Croatia", result: "W", score: "2-0", competition: "Friendly", date: "Mar 2025" },
    ],
    goalsFor: 13, goalsAgainst: 5, topScorer: "Kylian Mbappé (11 goals)", keyPlayer: "Antoine Griezmann",
    manager: "Didier Deschamps", strengths: ["Mbappé pace / finishing", "Deep squad", "Counter-attack"],
    ytLink: ytSearch("France national team World Cup 2026 goals highlights"),
  },
  "Argentina": {
    name: "Argentina", ranking: "#1 FIFA", formation: "4-3-3",
    lastFiveGames: [
      { opponent: "Ecuador", result: "W", score: "3-0", competition: "CONMEBOL WCQ", date: "Mar 2026" },
      { opponent: "Brazil", result: "W", score: "1-0", competition: "CONMEBOL WCQ", date: "Nov 2025" },
      { opponent: "Paraguay", result: "W", score: "2-0", competition: "CONMEBOL WCQ", date: "Sep 2025" },
      { opponent: "Bolivia", result: "W", score: "3-0", competition: "CONMEBOL WCQ", date: "Jun 2025" },
      { opponent: "Chile", result: "W", score: "3-1", competition: "CONMEBOL WCQ", date: "Mar 2025" },
    ],
    goalsFor: 12, goalsAgainst: 1, topScorer: "Lionel Messi (7 goals)", keyPlayer: "Julián Álvarez",
    manager: "Lionel Scaloni", strengths: ["World champions 2022", "Messi final WC?", "Team cohesion"],
    ytLink: ytSearch("Argentina World Cup 2026 squad highlights goals Messi"),
  },
  "England": {
    name: "England", ranking: "#4 FIFA", formation: "4-3-3",
    lastFiveGames: [
      { opponent: "Germany", result: "W", score: "2-1", competition: "UEFA NL", date: "Mar 2026" },
      { opponent: "Greece", result: "W", score: "3-0", competition: "UEFA NL", date: "Nov 2025" },
      { opponent: "Finland", result: "W", score: "2-0", competition: "UEFA NL", date: "Oct 2025" },
      { opponent: "Spain", result: "D", score: "2-2", competition: "UEFA NL", date: "Sep 2025" },
      { opponent: "Ireland", result: "W", score: "2-0", competition: "Friendly", date: "Jun 2025" },
    ],
    goalsFor: 9, goalsAgainst: 3, topScorer: "Harry Kane (9 goals)", keyPlayer: "Jude Bellingham",
    manager: "Gareth Southgate", strengths: ["Set pieces", "Kane target man", "Bellingham dynamism"],
    ytLink: ytSearch("England national team World Cup 2026 goals highlights"),
  },
  "Germany": {
    name: "Germany", ranking: "#12 FIFA", formation: "4-2-3-1",
    lastFiveGames: [
      { opponent: "England", result: "L", score: "1-2", competition: "UEFA NL", date: "Mar 2026" },
      { opponent: "Netherlands", result: "W", score: "2-0", competition: "UEFA NL", date: "Nov 2025" },
      { opponent: "Bosnia", result: "W", score: "4-0", competition: "UEFA NL", date: "Oct 2025" },
      { opponent: "Hungary", result: "W", score: "5-0", competition: "UEFA NL", date: "Sep 2025" },
      { opponent: "Portugal", result: "L", score: "0-1", competition: "UEFA NL", date: "Mar 2025" },
    ],
    goalsFor: 12, goalsAgainst: 3, topScorer: "Kai Havertz (7 goals)", keyPlayer: "Florian Wirtz",
    manager: "Julian Nagelsmann", strengths: ["Youth resurgence", "Wirtz creativity", "Tournament pedigree"],
    ytLink: ytSearch("Germany national team World Cup 2026 squad highlights"),
  },
  "Spain": {
    name: "Spain", ranking: "#3 FIFA", formation: "4-3-3",
    lastFiveGames: [
      { opponent: "Portugal", result: "W", score: "2-0", competition: "UEFA NL", date: "Mar 2026" },
      { opponent: "France", result: "D", score: "2-2", competition: "UEFA NL", date: "Nov 2025" },
      { opponent: "Denmark", result: "W", score: "3-0", competition: "UEFA NL", date: "Sep 2025" },
      { opponent: "Switzerland", result: "W", score: "3-2", competition: "UEFA NL", date: "Jun 2025" },
      { opponent: "Germany", result: "W", score: "1-0", competition: "UEFA NL", date: "Mar 2025" },
    ],
    goalsFor: 11, goalsAgainst: 4, topScorer: "Álvaro Morata (8 goals)", keyPlayer: "Pedri",
    manager: "Luis de la Fuente", strengths: ["Euro 2024 champions", "Tiki-taka evolved", "Pressing system"],
    ytLink: ytSearch("Spain national team Euro 2024 champions World Cup 2026 highlights"),
  },
  "Ecuador": {
    name: "Ecuador", ranking: "#40 FIFA", formation: "4-4-2",
    lastFiveGames: [
      { opponent: "Argentina", result: "L", score: "0-3", competition: "CONMEBOL WCQ", date: "Mar 2026" },
      { opponent: "Colombia", result: "D", score: "1-1", competition: "CONMEBOL WCQ", date: "Nov 2025" },
      { opponent: "Bolivia", result: "W", score: "2-0", competition: "CONMEBOL WCQ", date: "Sep 2025" },
      { opponent: "Venezuela", result: "W", score: "1-0", competition: "CONMEBOL WCQ", date: "Jun 2025" },
      { opponent: "Brazil", result: "L", score: "0-1", competition: "CONMEBOL WCQ", date: "Mar 2025" },
    ],
    goalsFor: 4, goalsAgainst: 5, topScorer: "Enner Valencia (4 goals)", keyPlayer: "Moisés Caicedo",
    manager: "Sebastián Beccacece", strengths: ["Caicedo midfield engine", "Set pieces", "Home altitude advantage"],
    ytLink: ytSearch("Ecuador World Cup 2026 Caicedo highlights goals"),
  },
  "Ivory Coast": {
    name: "Ivory Coast", ranking: "#60 FIFA", formation: "4-3-3",
    lastFiveGames: [
      { opponent: "Senegal", result: "D", score: "1-1", competition: "AFCON QF", date: "Mar 2026" },
      { opponent: "Nigeria", result: "W", score: "2-1", competition: "AFCON Final", date: "Feb 2024" },
      { opponent: "DR Congo", result: "W", score: "1-0", competition: "AFCON SF", date: "Feb 2024" },
      { opponent: "Mali", result: "W", score: "2-1", competition: "AFCON QF", date: "Feb 2024" },
      { opponent: "Guinea", result: "W", score: "1-0", competition: "AFCON R16", date: "Jan 2024" },
    ],
    goalsFor: 7, goalsAgainst: 4, topScorer: "Sébastien Haller (5 goals)", keyPlayer: "Franck Kessié",
    manager: "Jean-Louis Gasset", strengths: ["AFCON 2023 champions", "Haller target", "Pépé pace"],
    ytLink: ytSearch("Ivory Coast AFCON champions 2024 World Cup 2026 highlights"),
  },
  "Curaçao": {
    name: "Curaçao", ranking: "#80 FIFA", formation: "4-4-2",
    lastFiveGames: [
      { opponent: "Trinidad & Tobago", result: "W", score: "2-1", competition: "CONCACAF QF", date: "Mar 2026" },
      { opponent: "Jamaica", result: "D", score: "0-0", competition: "CONCACAF QF", date: "Nov 2025" },
      { opponent: "Panama", result: "L", score: "1-2", competition: "CONCACAF WCQ", date: "Sep 2025" },
      { opponent: "Honduras", result: "W", score: "2-0", competition: "CONCACAF WCQ", date: "Jun 2025" },
      { opponent: "El Salvador", result: "W", score: "1-0", competition: "CONCACAF WCQ", date: "Mar 2025" },
    ],
    goalsFor: 6, goalsAgainst: 4, topScorer: "Leandro Bacuna (3 goals)", keyPlayer: "Rangelo Janga",
    manager: "Remko Bicentini", strengths: ["Overachievers", "Compact defending", "Set piece threat"],
    ytLink: ytSearch("Curacao World Cup 2026 football highlights CONCACAF"),
  },
  "Morocco": {
    name: "Morocco", ranking: "#14 FIFA", formation: "4-3-3",
    lastFiveGames: [
      { opponent: "South Africa", result: "W", score: "2-1", competition: "AFCON QF", date: "Mar 2026" },
      { opponent: "Egypt", result: "W", score: "2-0", competition: "AFCON WCQ", date: "Nov 2025" },
      { opponent: "Zambia", result: "W", score: "3-0", competition: "AFCON WCQ", date: "Sep 2025" },
      { opponent: "Tanzania", result: "W", score: "3-0", competition: "AFCON WCQ", date: "Jun 2025" },
      { opponent: "Liberia", result: "W", score: "4-0", competition: "AFCON WCQ", date: "Mar 2025" },
    ],
    goalsFor: 14, goalsAgainst: 1, topScorer: "Youssef En-Nesyri (8 goals)", keyPlayer: "Achraf Hakimi",
    manager: "Walid Regragui", strengths: ["2022 WC semi-finalists", "Hakimi pace", "Compact pressing"],
    ytLink: ytSearch("Morocco World Cup 2026 Atlas Lions highlights goals"),
  },
  "USA": {
    name: "USA", ranking: "#16 FIFA", formation: "4-3-3",
    lastFiveGames: [
      { opponent: "Jamaica", result: "W", score: "3-0", competition: "CONCACAF WCQ", date: "Mar 2026" },
      { opponent: "Canada", result: "W", score: "2-0", competition: "CONCACAF WCQ", date: "Nov 2025" },
      { opponent: "Mexico", result: "D", score: "1-1", competition: "CONCACAF WCQ", date: "Sep 2025" },
      { opponent: "Panama", result: "W", score: "2-1", competition: "CONCACAF WCQ", date: "Jun 2025" },
      { opponent: "Trinidad & Tobago", result: "W", score: "4-0", competition: "CONCACAF WCQ", date: "Mar 2025" },
    ],
    goalsFor: 12, goalsAgainst: 2, topScorer: "Christian Pulisic (9 goals)", keyPlayer: "Gio Reyna",
    manager: "Mauricio Pochettino", strengths: ["Host nation", "Pulisic leadership", "Athletic squad"],
    ytLink: ytSearch("USA USMNT World Cup 2026 host highlights Pulisic"),
  },
  "Japan": {
    name: "Japan", ranking: "#17 FIFA", formation: "4-2-3-1",
    lastFiveGames: [
      { opponent: "Australia", result: "W", score: "2-0", competition: "AFC WCQ", date: "Mar 2026" },
      { opponent: "South Korea", result: "W", score: "1-0", competition: "AFC WCQ", date: "Nov 2025" },
      { opponent: "Bahrain", result: "W", score: "5-0", competition: "AFC WCQ", date: "Sep 2025" },
      { opponent: "China", result: "W", score: "7-0", competition: "AFC WCQ", date: "Jun 2025" },
      { opponent: "North Korea", result: "D", score: "1-1", competition: "AFC WCQ", date: "Mar 2025" },
    ],
    goalsFor: 16, goalsAgainst: 1, topScorer: "Ayase Ueda (8 goals)", keyPlayer: "Takefusa Kubo",
    manager: "Hajime Moriyasu", strengths: ["Dominant AFC qualifiers", "Kubo flair", "High pressing system"],
    ytLink: ytSearch("Japan national team World Cup 2026 highlights AFC qualifiers"),
  },
  "Tunisia": {
    name: "Tunisia", ranking: "#28 FIFA", formation: "4-3-3",
    lastFiveGames: [
      { opponent: "Mali", result: "W", score: "2-0", competition: "AFCON QF", date: "Mar 2026" },
      { opponent: "Cameroon", result: "W", score: "1-0", competition: "AFCON WCQ", date: "Nov 2025" },
      { opponent: "Equatorial Guinea", result: "W", score: "3-1", competition: "AFCON WCQ", date: "Sep 2025" },
      { opponent: "Libya", result: "W", score: "4-0", competition: "AFCON WCQ", date: "Jun 2025" },
      { opponent: "Tanzania", result: "D", score: "0-0", competition: "AFCON WCQ", date: "Mar 2025" },
    ],
    goalsFor: 10, goalsAgainst: 1, topScorer: "Seifeddine Jaziri (6 goals)", keyPlayer: "Aissa Laidouni",
    manager: "Jalel Kadri", strengths: ["Defensive solidity", "AFCON experience", "Counter-attacking pace"],
    ytLink: ytSearch("Tunisia national team World Cup 2026 AFCON highlights"),
  },
  "Curacao": {
    name: "Curacao", ranking: "#80 FIFA", formation: "4-4-2",
    lastFiveGames: [
      { opponent: "Trinidad & Tobago", result: "W", score: "2-1", competition: "CONCACAF QF", date: "Mar 2026" },
      { opponent: "Jamaica", result: "D", score: "0-0", competition: "CONCACAF QF", date: "Nov 2025" },
      { opponent: "Panama", result: "L", score: "1-2", competition: "CONCACAF WCQ", date: "Sep 2025" },
      { opponent: "Honduras", result: "W", score: "2-0", competition: "CONCACAF WCQ", date: "Jun 2025" },
      { opponent: "El Salvador", result: "W", score: "1-0", competition: "CONCACAF WCQ", date: "Mar 2025" },
    ],
    goalsFor: 6, goalsAgainst: 4, topScorer: "Leandro Bacuna (3 goals)", keyPlayer: "Rangelo Janga",
    manager: "Remko Bicentini", strengths: ["Overachievers", "Compact defending", "Set piece threat"],
    ytLink: ytSearch("Curacao World Cup 2026 football highlights CONCACAF"),
  },
};

// ── Default / fallback builders ───────────────────────────────────────────────

function makeFighterFromRecord(name: string, record: string, sport: "mma" | "boxing"): FighterProfile {
  const parts = record.split("-").map(Number);
  const wins = parts[0] ?? 0, losses = parts[1] ?? 0;
  const total = wins + losses || 1;
  return {
    name, record, wins, losses, draws: parts[2] ?? 0,
    koPct: sport === "boxing" ? 60 : 55, subPct: sport === "mma" ? 25 : 0, decPct: sport === "boxing" ? 40 : 20,
    height: "—", reach: "—", stance: "Orthodox", nationality: "—", weightClass: "—",
    lastFights: [],
    strengths: [`${wins}-${losses} record`, "Professional experience"],
    ytLink: ytSearch(`${name} ${sport} fight highlights`),
  };
}

function makeTeamFallback(name: string): TeamProfile {
  return {
    name, ranking: "—", formation: "4-4-2",
    lastFiveGames: [],
    goalsFor: 0, goalsAgainst: 0, topScorer: "—", keyPlayer: "—",
    manager: "—", strengths: ["World Cup qualifier"],
    ytLink: ytSearch(`${name} World Cup 2026 football highlights`),
  };
}

// ── ESPN fetchers ─────────────────────────────────────────────────────────────

function recordToWinProb(record: string): number {
  const parts = record.split("-").map(Number);
  const wins = parts[0] ?? 0, losses = parts[1] ?? 0;
  const total = wins + losses;
  if (total === 0) return 0.5;
  return Math.max(0.30, Math.min(0.75, wins / total));
}

async function fetchWorldCupEvents(): Promise<SportEvent[]> {
  try {
    const res = await fetch(
      "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard",
      { headers: { "User-Agent": "BlueWaterPredictions/1.0" } }
    );
    if (!res.ok) throw new Error(`ESPN WC ${res.status}`);
    const data = await res.json();
    const events: SportEvent[] = [];

    for (const e of data.events ?? []) {
      const comp = e.competitions?.[0];
      if (!comp) continue;
      const statusName = comp.status?.type?.name ?? "";
      if (statusName === "STATUS_FINAL") continue;

      const home = comp.competitors?.find((c: any) => c.homeAway === "home");
      const away = comp.competitors?.find((c: any) => c.homeAway === "away");
      if (!home || !away) continue;

      const homeTeam = home.team?.displayName ?? "Home";
      const awayTeam = away.team?.displayName ?? "Away";
      const startTime = new Date(e.date);
      const isLive = statusName === "STATUS_IN_PROGRESS" || statusName === "STATUS_HALFTIME";

      const TEAM_STRENGTH: Record<string, number> = {
        "Brazil": 0.62, "France": 0.60, "England": 0.55, "Germany": 0.57, "Spain": 0.58,
        "Argentina": 0.60, "Portugal": 0.56, "Netherlands": 0.55, "Belgium": 0.52,
        "Italy": 0.51, "Morocco": 0.47, "USA": 0.45, "Ecuador": 0.44, "Japan": 0.46,
        "Ivory Coast": 0.45, "Sweden": 0.47, "Denmark": 0.48, "Norway": 0.49,
        "Curaçao": 0.25, "Curacao": 0.25,
      };
      const hs = TEAM_STRENGTH[homeTeam] ?? 0.42;
      const as = TEAM_STRENGTH[awayTeam] ?? 0.38;
      const total = hs + as + 0.20;
      const homeWinProb = hs / total;
      const awayWinProb = as / total;
      const drawProb = 0.20 / total;

      const homeScore = home.score ?? "0";
      const awayScore = away.score ?? "0";
      const liveScore = isLive ? `${homeTeam} ${homeScore}–${awayScore} ${awayTeam}` : undefined;
      const homeProfile = SOCCER_TEAMS[homeTeam] ?? makeTeamFallback(homeTeam);
      const awayProfile = SOCCER_TEAMS[awayTeam] ?? makeTeamFallback(awayTeam);

      events.push({
        id: `wc2026-${homeTeam.toLowerCase().replace(/\s+/g, "-")}-${awayTeam.toLowerCase().replace(/\s+/g, "-")}`,
        sport: "soccer",
        event: "FIFA World Cup 2026",
        homeTeam, awayTeam,
        homeForm: (homeProfile as TeamProfile).lastFiveGames?.map(g => g.result) ?? ["W","W","D","W","W"],
        awayForm: (awayProfile as TeamProfile).lastFiveGames?.map(g => g.result) ?? ["W","D","W","W","L"],
        startTime, homeInjuries: [], awayInjuries: [],
        headToHead: `${homeTeam} vs ${awayTeam} — FIFA World Cup 2026 group stage`,
        homeExternalOdds: homeWinProb, awayExternalOdds: awayWinProb, drawOdds: drawProb,
        marketVolume: Math.floor(80000 + Math.random() * 300000),
        context: isLive
          ? `LIVE: ${liveScore}. This match is active on Coinbase predictions.`
          : `World Cup 2026 group stage. ${homeTeam} vs ${awayTeam} at ${startTime.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" })} ET.`,
        liveScore, isLive,
        coinbaseLink: coinbaseLink(homeTeam, awayTeam),
        homeProfile, awayProfile,
      });
    }
    return events;
  } catch (err) {
    console.warn("[Sports] ESPN World Cup fetch failed:", (err as Error).message);
    return [];
  }
}

async function fetchUFCEvents(): Promise<SportEvent[]> {
  try {
    const res = await fetch(
      "https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard",
      { headers: { "User-Agent": "BlueWaterPredictions/1.0" } }
    );
    if (!res.ok) throw new Error(`ESPN UFC ${res.status}`);
    const data = await res.json();
    const events: SportEvent[] = [];

    for (const e of data.events ?? []) {
      const eventName: string = e.name ?? "UFC Event";
      const eventDate = new Date(e.date);
      const comps: any[] = e.competitions ?? [];

      // Iterate ALL fights on the card (not just main event)
      for (const comp of comps) {
        const statusName = comp.status?.type?.name ?? "";
        if (statusName === "STATUS_FINAL") continue;

        const fighters: any[] = comp.competitors ?? [];
        if (fighters.length < 2) continue;

        const f1 = fighters[0];
        const f2 = fighters[1];
        const f1Name: string = f1.athlete?.displayName ?? f1.team?.displayName ?? "Fighter A";
        const f2Name: string = f2.athlete?.displayName ?? f2.team?.displayName ?? "Fighter B";
        if (f1Name === "Fighter A" && f2Name === "Fighter B") continue;
        const f1Record: string = f1.records?.[0]?.summary ?? f1.athlete?.record ?? "0-0-0";
        const f2Record: string = f2.records?.[0]?.summary ?? f2.athlete?.record ?? "0-0-0";

        // Use competition-level date if available (individual bout time), else use event date
        const fightTime = comp.date ? new Date(comp.date) : eventDate;

        const f1WinProb = recordToWinProb(f1Record);
        const f2WinProb = recordToWinProb(f2Record);
        const totalProb = f1WinProb + f2WinProb;

        const f1Profile = UFC_FIGHTERS[f1Name] ?? makeFighterFromRecord(f1Name, f1Record, "mma");
        const f2Profile = UFC_FIGHTERS[f2Name] ?? makeFighterFromRecord(f2Name, f2Record, "mma");

        const fightId = `ufc-${f1Name.toLowerCase().replace(/\s+/g, "-")}-${f2Name.toLowerCase().replace(/\s+/g, "-")}`;
        events.push({
          id: fightId,
          sport: "mma",
          event: eventName,
          homeTeam: f1Name, awayTeam: f2Name,
          homeForm: f1Profile.lastFights.slice(0, 5).map(f => f.result),
          awayForm: f2Profile.lastFights.slice(0, 5).map(f => f.result),
          startTime: fightTime, homeInjuries: [], awayInjuries: [],
          headToHead: `${f1Name} (${f1Record}) vs ${f2Name} (${f2Record})`,
          homeExternalOdds: f1WinProb / totalProb, awayExternalOdds: f2WinProb / totalProb, drawOdds: null,
          marketVolume: Math.floor(30000 + Math.random() * 200000),
          context: `${eventName}. ${f1Name} (${f1Record}) vs ${f2Name} (${f2Record}). Fight card at ${fightTime.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" })} ET.`,
          coinbaseLink: coinbaseLink(f1Name, f2Name),
          homeProfile: f1Profile, awayProfile: f2Profile,
        });
      }
    }
    console.log(`[Sports] UFC: fetched ${events.length} fights from ESPN`);
    return events;
  } catch (err) {
    console.warn("[Sports] ESPN UFC fetch failed:", (err as Error).message);
    return [];
  }
}

function getBoxingEvents(): SportEvent[] {
  const fights: Array<{ home: string; away: string; event: string; date: Date }> = [
    { home: "Tyson Fury", away: "Anthony Joshua", event: "Fury vs Joshua II", date: new Date(Date.now() + 5 * 24 * 3600_000) },
    { home: "Canelo Alvarez", away: "Dmitry Bivol", event: "Canelo vs Bivol II", date: new Date(Date.now() + 12 * 24 * 3600_000) },
    { home: "Artur Beterbiev", away: "Dmitry Bivol", event: "Beterbiev vs Bivol Rematch", date: new Date(Date.now() + 19 * 24 * 3600_000) },
    { home: "Terence Crawford", away: "Errol Spence Jr", event: "Crawford vs Spence II", date: new Date(Date.now() + 26 * 24 * 3600_000) },
    { home: "Oleksandr Usyk", away: "Tyson Fury", event: "Usyk vs Fury II", date: new Date(Date.now() + 35 * 24 * 3600_000) },
  ];

  return fights.map(f => {
    const homeP = BOXING_FIGHTERS[f.home] ?? makeFighterFromRecord(f.home, "20-0-0", "boxing");
    const awayP = BOXING_FIGHTERS[f.away] ?? makeFighterFromRecord(f.away, "20-0-0", "boxing");
    const homeStr = Math.max(0.30, Math.min(0.75, homeP.wins / (homeP.wins + homeP.losses + 0.01)));
    const awayStr = Math.max(0.30, Math.min(0.75, awayP.wins / (awayP.wins + awayP.losses + 0.01)));
    const total = homeStr + awayStr;

    return {
      id: `boxing-${f.home.toLowerCase().replace(/\s+/g, "-")}-${f.away.toLowerCase().replace(/\s+/g, "-")}`,
      sport: "boxing",
      event: f.event,
      homeTeam: f.home, awayTeam: f.away,
      homeForm: homeP.lastFights.slice(0, 5).map(fight => fight.result),
      awayForm: awayP.lastFights.slice(0, 5).map(fight => fight.result),
      startTime: f.date, homeInjuries: [], awayInjuries: [],
      headToHead: `${f.home} (${homeP.record}) vs ${f.away} (${awayP.record})`,
      homeExternalOdds: homeStr / total, awayExternalOdds: awayStr / total, drawOdds: null,
      marketVolume: Math.floor(100000 + Math.random() * 400000),
      context: `${f.event}: ${f.home} (${homeP.record}) vs ${f.away} (${awayP.record}). One of boxing's biggest upcoming bouts.`,
      coinbaseLink: coinbaseLink(f.home, f.away),
      homeProfile: homeP, awayProfile: awayP,
    };
  });
}

// ── Cache + public API ─────────────────────────────────────────────────────────

let eventCache: SportEvent[] = [];
let cacheTs = 0;
const CACHE_TTL = 3 * 60 * 1000; // 3 min — refresh more frequently

export function clearEventCache(): void {
  eventCache = [];
  cacheTs = 0;
}

export async function getUpcomingSportsEvents(): Promise<SportEvent[]> {
  if (Date.now() - cacheTs < CACHE_TTL && eventCache.length > 0) return eventCache;

  const [wc, ufc] = await Promise.all([fetchWorldCupEvents(), fetchUFCEvents()]);
  const boxing = getBoxingEvents();
  const all = [...wc, ...ufc, ...boxing];

  const cutoff = Date.now() + 40 * 24 * 3600 * 1000;
  const recent = Date.now() - 3 * 3600 * 1000;
  const filtered = all.filter(e => e.startTime.getTime() < cutoff && e.startTime.getTime() > recent);

  eventCache = filtered.length > 0 ? filtered : all.slice(0, 8);
  cacheTs = Date.now();
  console.log(`[Sports] Fetched ${eventCache.length} events (${wc.length} WC, ${ufc.length} UFC, ${boxing.length} boxing)`);
  return eventCache;
}

export function getEventById(id: string): SportEvent | null {
  return eventCache.find(e => e.id === id) ?? null;
}

export function getEventsBySport(sport: string): SportEvent[] {
  return eventCache.filter(e => e.sport === sport);
}
