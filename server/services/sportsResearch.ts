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
}

function todayAt(hour: number, minute = 0): Date {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d;
}

export function getUpcomingSportsEvents(): SportEvent[] {
  const now = Date.now();
  return [
    // ── 10:00 AM ─────────────────────────────────────────────────────────────
    {
      id: "wc2026-bra-fra",
      sport: "soccer",
      event: "FIFA World Cup 2026 — Group A",
      homeTeam: "Brazil",
      awayTeam: "France",
      homeForm: ["W", "W", "D", "W", "W"],
      awayForm: ["W", "W", "W", "D", "L"],
      startTime: todayAt(10, 0),
      homeInjuries: [],
      awayInjuries: ["K. Mbappé (hamstring, 75% fit)"],
      headToHead: "Brazil leads 3-2-2 in last 7 meetings",
      homeExternalOdds: 0.48,
      awayExternalOdds: 0.33,
      drawOdds: 0.19,
      marketVolume: 248000,
      context: "Brazil's Vinicius Jr. in top form — 3 goals in group stage. France attack limited without Mbappé. Brazil dominant pressing system creates turnovers in the final third.",
    },
    // ── 12:00 PM ─────────────────────────────────────────────────────────────
    {
      id: "wc2026-eng-ger",
      sport: "soccer",
      event: "FIFA World Cup 2026 — Group D",
      homeTeam: "England",
      awayTeam: "Germany",
      homeForm: ["W", "W", "W", "D", "W"],
      awayForm: ["W", "D", "W", "W", "D"],
      startTime: todayAt(12, 0),
      homeInjuries: [],
      awayInjuries: ["T. Müller (minor knock, doubtful)"],
      headToHead: "England leads 5-4-3 in last 12 meetings including EURO 2020 win",
      homeExternalOdds: 0.42,
      awayExternalOdds: 0.38,
      drawOdds: 0.20,
      marketVolume: 192000,
      context: "England unbeaten in qualifying. Bellingham returned from injury and scored twice in group stage. Germany's high defensive line vulnerable to England's counter-attack.",
    },
    // ── 1:30 PM ──────────────────────────────────────────────────────────────
    {
      id: "wc2026-arg-esp",
      sport: "soccer",
      event: "FIFA World Cup 2026 — Group C",
      homeTeam: "Argentina",
      awayTeam: "Spain",
      homeForm: ["W", "D", "W", "W", "W"],
      awayForm: ["W", "W", "W", "W", "D"],
      startTime: todayAt(13, 30),
      homeInjuries: ["Ángel Di María (thigh, out)"],
      awayInjuries: [],
      headToHead: "Spain leads 3-2 in last 5 competitive fixtures",
      homeExternalOdds: 0.39,
      awayExternalOdds: 0.41,
      drawOdds: 0.20,
      marketVolume: 315000,
      context: "Lionel Messi's final World Cup campaign. Spain playing fluid tiki-taka with Pedri and Lamine Yamal in sensational form. Messi's set-piece delivery remains world-class.",
    },
    // ── 3:00 PM ──────────────────────────────────────────────────────────────
    {
      id: "wc2026-por-mor",
      sport: "soccer",
      event: "FIFA World Cup 2026 — Group B",
      homeTeam: "Portugal",
      awayTeam: "Morocco",
      homeForm: ["W", "W", "W", "W", "D"],
      awayForm: ["W", "D", "W", "L", "W"],
      startTime: todayAt(15, 0),
      homeInjuries: [],
      awayInjuries: ["A. Hakimi (ankle, 60% fit)"],
      headToHead: "Portugal beat Morocco 1-0 in 2022 QF",
      homeExternalOdds: 0.55,
      awayExternalOdds: 0.26,
      drawOdds: 0.19,
      marketVolume: 143000,
      context: "Ronaldo announced this as his final World Cup. Portugal heavy favorites. Morocco historically strong at World Cups, knocked Spain in 2022. Atlas Lions expect to surprise again.",
    },
    // ── 4:00 PM ──────────────────────────────────────────────────────────────
    {
      id: "wc2026-ned-usa",
      sport: "soccer",
      event: "FIFA World Cup 2026 — Group E",
      homeTeam: "Netherlands",
      awayTeam: "USA",
      homeForm: ["W", "W", "D", "W", "W"],
      awayForm: ["W", "W", "L", "W", "W"],
      startTime: todayAt(16, 0),
      homeInjuries: [],
      awayInjuries: ["C. Pulisic (knock, questionable)"],
      headToHead: "Netherlands leads 2-1 in competitive history",
      homeExternalOdds: 0.51,
      awayExternalOdds: 0.30,
      drawOdds: 0.19,
      marketVolume: 187000,
      context: "Home crowd advantage for USA (host nation). Dutch squad with De Jong and Gakpo creating overloads wide. USA has qualified young talent — Reyna, Weah, Dest — on home soil.",
    },
    // ── 5:30 PM ──────────────────────────────────────────────────────────────
    {
      id: "wc2026-fra-bel",
      sport: "soccer",
      event: "FIFA World Cup 2026 — Group F",
      homeTeam: "France",
      awayTeam: "Belgium",
      homeForm: ["W", "D", "W", "W", "W"],
      awayForm: ["W", "W", "D", "W", "L"],
      startTime: todayAt(17, 30),
      homeInjuries: [],
      awayInjuries: ["K. De Bruyne (calf, 70% fit)"],
      headToHead: "France leads 7-4-3 all-time, won 2018 WC QF 1-0",
      homeExternalOdds: 0.50,
      awayExternalOdds: 0.30,
      drawOdds: 0.20,
      marketVolume: 221000,
      context: "Classic battle of neighbouring nations. France's depth unmatched even without Mbappé at full fitness. De Bruyne's fitness the key story — Lukaku still lethal in the box.",
    },
    // ── 7:00 PM ──────────────────────────────────────────────────────────────
    {
      id: "ufc316-merab-omalley",
      sport: "mma",
      event: "UFC 316 — Bantamweight Championship",
      homeTeam: "Merab Dvalishvili",
      awayTeam: "Sean O'Malley",
      homeForm: ["W", "W", "W", "W", "W"],
      awayForm: ["L", "W", "W", "W", "L"],
      startTime: todayAt(19, 0),
      homeInjuries: [],
      awayInjuries: ["Reported rib discomfort during camp"],
      headToHead: "Merab won the last meeting by UD. Dvalishvili holds the belt.",
      homeExternalOdds: 0.62,
      awayExternalOdds: 0.38,
      drawOdds: null,
      marketVolume: 198000,
      context: "Merab on a 10-fight win streak. O'Malley seeking redemption after unanimous decision loss. Wrestling volume will be decisive — Merab averages 10+ takedown attempts per fight.",
    },
    // ── 8:00 PM ──────────────────────────────────────────────────────────────
    {
      id: "boxing-canelo-bivol2",
      sport: "boxing",
      event: "WBA/WBC/WBO Light Heavyweight Unification",
      homeTeam: "Saul 'Canelo' Alvarez",
      awayTeam: "Dmitry Bivol",
      homeForm: ["W", "W", "W", "W", "W"],
      awayForm: ["W", "W", "W", "L", "W"],
      startTime: todayAt(20, 0),
      homeInjuries: [],
      awayInjuries: [],
      headToHead: "Bivol won the first fight via unanimous decision in 2022. Canelo seeking revenge.",
      homeExternalOdds: 0.45,
      awayExternalOdds: 0.55,
      drawOdds: null,
      marketVolume: 412000,
      context: "Rematch of the year. Canelo trained extensively on anti-clinch tactics. Bivol's jab and distance management were key in Fight 1. Both fighters at 175 lb — Canelo moving up in weight.",
    },
    // ── 9:00 PM ──────────────────────────────────────────────────────────────
    {
      id: "ufc316-moreno-kkf",
      sport: "mma",
      event: "UFC 316 — Flyweight Co-Main Event",
      homeTeam: "Brandon Moreno",
      awayTeam: "Kai Kara-France",
      homeForm: ["W", "L", "W", "W", "W"],
      awayForm: ["W", "W", "L", "W", "W"],
      startTime: todayAt(21, 0),
      homeInjuries: [],
      awayInjuries: [],
      headToHead: "Series tied 1-1. Moreno won the trilogy. KKF scored knockdown in fight 2.",
      homeExternalOdds: 0.56,
      awayExternalOdds: 0.44,
      drawOdds: null,
      marketVolume: 87000,
      context: "Rubber match in the flyweight division. Moreno submission edge vs KKF striking power. Series tied makes this a true pick-em. Expect early pressure from KKF on the feet.",
    },
    // ── 9:30 PM ──────────────────────────────────────────────────────────────
    {
      id: "nfl-chiefs-eagles",
      sport: "football",
      event: "NFL Prediction Market — Super Bowl LXI Futures",
      homeTeam: "Kansas City Chiefs",
      awayTeam: "Philadelphia Eagles",
      homeForm: ["W", "W", "W", "L", "W"],
      awayForm: ["W", "W", "W", "W", "W"],
      startTime: todayAt(21, 30),
      homeInjuries: [],
      awayInjuries: [],
      headToHead: "Chiefs won Super Bowl LVII. Eagles seeking revenge in LXI.",
      homeExternalOdds: 0.44,
      awayExternalOdds: 0.56,
      drawOdds: null,
      marketVolume: 287000,
      context: "Eagles undefeated in preseason with dominant OL play. Mahomes vs Hurts storyline drives massive market volume. Eagles offensive line advantage expected to be decisive in trenches.",
    },
  ].filter(e => e.startTime.getTime() > now - 2 * 3600 * 1000);
}

export function getEventById(id: string): SportEvent | null {
  return getUpcomingSportsEvents().find(e => e.id === id) ?? null;
}

export function getEventsBySport(sport: string): SportEvent[] {
  return getUpcomingSportsEvents().filter(e => e.sport === sport);
}
