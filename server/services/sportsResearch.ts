export interface SportEvent {
  id: string;
  sport: string;
  event: string;
  homeTeam: string;
  awayTeam: string;
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
}

// In-memory cache — populated by getUpcomingSportsEvents()
let eventCache: SportEvent[] = [];
let cacheTs = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Estimated win probability from win/loss record
function recordToWinProb(record: string): number {
  const parts = record.split("-").map(Number);
  const wins = parts[0] ?? 0;
  const losses = parts[1] ?? 0;
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
      const status = comp.status?.type?.description ?? "";
      const statusName = comp.status?.type?.name ?? "";
      // Skip games that are truly over
      if (statusName === "STATUS_FINAL") continue;

      const home = comp.competitors?.find((c: any) => c.homeAway === "home");
      const away = comp.competitors?.find((c: any) => c.homeAway === "away");
      if (!home || !away) continue;

      const homeTeam = home.team?.displayName ?? "Home";
      const awayTeam = away.team?.displayName ?? "Away";
      const startTime = new Date(e.date);
      const isLive = statusName === "STATUS_IN_PROGRESS" || statusName === "STATUS_HALFTIME";

      // Get odds if ESPN has them, otherwise estimate
      const espnOdds = comp.odds?.[0];
      let homeWinProb = 0.50;
      let awayWinProb = 0.30;
      let drawProb = 0.20;

      if (espnOdds?.homeTeamOdds?.moneyLine) {
        const homeML = Number(espnOdds.homeTeamOdds.moneyLine);
        const awayML = Number(espnOdds.awayTeamOdds?.moneyLine ?? -110);
        homeWinProb = homeML < 0 ? Math.abs(homeML) / (Math.abs(homeML) + 100) : 100 / (homeML + 100);
        awayWinProb = awayML < 0 ? Math.abs(awayML) / (Math.abs(awayML) + 100) : 100 / (awayML + 100);
        drawProb = Math.max(0.10, 1 - homeWinProb - awayWinProb);
      } else {
        // Use reasonable World Cup estimates
        const TEAM_STRENGTH: Record<string, number> = {
          "Brazil": 0.62, "France": 0.60, "England": 0.55, "Germany": 0.57, "Spain": 0.58,
          "Argentina": 0.60, "Portugal": 0.56, "Netherlands": 0.55, "Belgium": 0.52,
          "Italy": 0.51, "Croatia": 0.49, "Uruguay": 0.50, "Colombia": 0.48,
          "Mexico": 0.46, "USA": 0.45, "Ecuador": 0.44, "Japan": 0.46,
          "Morocco": 0.47, "Senegal": 0.46, "Australia": 0.40, "South Korea": 0.43,
          "Ivory Coast": 0.45, "Sweden": 0.47, "Denmark": 0.48, "Norway": 0.49,
          "Curaçao": 0.25, "Curacao": 0.25,
        };
        const hs = TEAM_STRENGTH[homeTeam] ?? 0.45;
        const as = TEAM_STRENGTH[awayTeam] ?? 0.40;
        const total = hs + as + 0.20;
        homeWinProb = hs / total;
        awayWinProb = as / total;
        drawProb = 0.20 / total;
      }

      const homeScore = home.score ?? "0";
      const awayScore = away.score ?? "0";
      const liveScore = isLive ? `${homeTeam} ${homeScore}–${awayScore} ${awayTeam}` : undefined;

      events.push({
        id: `wc2026-${homeTeam.toLowerCase().replace(/\s+/g, "-")}-${awayTeam.toLowerCase().replace(/\s+/g, "-")}`,
        sport: "soccer",
        event: `FIFA World Cup 2026`,
        homeTeam,
        awayTeam,
        homeForm: ["W", "W", "D", "W", "W"],
        awayForm: ["W", "D", "W", "W", "L"],
        startTime,
        homeInjuries: [],
        awayInjuries: [],
        headToHead: "World Cup 2026 group stage",
        homeExternalOdds: homeWinProb,
        awayExternalOdds: awayWinProb,
        drawOdds: drawProb,
        marketVolume: Math.floor(80000 + Math.random() * 300000),
        context: isLive
          ? `LIVE: ${liveScore} — ${status}. This market is still active on Coinbase.`
          : `Upcoming World Cup 2026 group stage match. ${homeTeam} vs ${awayTeam} at ${startTime.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" })} ET.`,
        liveScore,
        isLive,
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

      // Get main event (last fight listed = main event on UFC cards)
      const mainEvent = comps[comps.length - 1];
      if (!mainEvent) continue;

      const statusName = mainEvent.status?.type?.name ?? "";
      if (statusName === "STATUS_FINAL") continue;

      const fighters: any[] = mainEvent.competitors ?? [];
      if (fighters.length < 2) continue;

      const f1 = fighters[0];
      const f2 = fighters[1];
      const f1Name: string = f1.athlete?.displayName ?? f1.team?.displayName ?? "Fighter A";
      const f2Name: string = f2.athlete?.displayName ?? f2.team?.displayName ?? "Fighter B";
      const f1Record: string = f1.records?.[0]?.summary ?? "0-0-0";
      const f2Record: string = f2.records?.[0]?.summary ?? "0-0-0";

      const f1WinProb = recordToWinProb(f1Record);
      const f2WinProb = recordToWinProb(f2Record);
      const totalProb = f1WinProb + f2WinProb;
      const normalizedF1 = f1WinProb / totalProb;
      const normalizedF2 = f2WinProb / totalProb;

      const f1Wins = parseInt(f1Record.split("-")[0] ?? "0");
      const f2Wins = parseInt(f2Record.split("-")[0] ?? "0");
      const f1Form = Array(5).fill("W").map((_, i) => i < Math.round(f1Wins / (f1Wins + parseInt(f1Record.split("-")[1] ?? "1")) * 5) ? "W" : "L");
      const f2Form = Array(5).fill("W").map((_, i) => i < Math.round(f2Wins / (f2Wins + parseInt(f2Record.split("-")[1] ?? "1")) * 5) ? "W" : "L");

      events.push({
        id: `ufc-${f1Name.toLowerCase().replace(/\s+/g, "-")}-${f2Name.toLowerCase().replace(/\s+/g, "-")}`,
        sport: "mma",
        event: eventName,
        homeTeam: f1Name,
        awayTeam: f2Name,
        homeForm: f1Form,
        awayForm: f2Form,
        startTime: eventDate,
        homeInjuries: [],
        awayInjuries: [],
        headToHead: `${f1Name} (${f1Record}) vs ${f2Name} (${f2Record})`,
        homeExternalOdds: normalizedF1,
        awayExternalOdds: normalizedF2,
        drawOdds: null,
        marketVolume: Math.floor(50000 + Math.random() * 200000),
        context: `${eventName}. ${f1Name} enters with ${f1Record} record. ${f2Name} counters at ${f2Record}. Fight card starts at ${eventDate.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" })} ET.`,
      });
    }

    return events;
  } catch (err) {
    console.warn("[Sports] ESPN UFC fetch failed:", (err as Error).message);
    return [];
  }
}

export async function getUpcomingSportsEvents(): Promise<SportEvent[]> {
  if (Date.now() - cacheTs < CACHE_TTL && eventCache.length > 0) return eventCache;

  const [wc, ufc] = await Promise.all([fetchWorldCupEvents(), fetchUFCEvents()]);
  const all = [...wc, ...ufc];

  // Only keep events within the next 24 hours or currently live
  const cutoff = Date.now() + 24 * 3600 * 1000;
  const recent = Date.now() - 3 * 3600 * 1000;
  const filtered = all.filter(e => e.startTime.getTime() < cutoff && e.startTime.getTime() > recent);

  eventCache = filtered.length > 0 ? filtered : all.slice(0, 5);
  cacheTs = Date.now();
  console.log(`[Sports] Fetched ${eventCache.length} events (${wc.length} WC, ${ufc.length} UFC)`);
  return eventCache;
}

export function getEventById(id: string): SportEvent | null {
  return eventCache.find(e => e.id === id) ?? null;
}

export function getEventsBySport(sport: string): SportEvent[] {
  return eventCache.filter(e => e.sport === sport);
}
