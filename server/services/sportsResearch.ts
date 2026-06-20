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

function hoursFromNow(hours: number): Date {
  return new Date(Date.now() + hours * 3600 * 1000);
}

export function getUpcomingSportsEvents(): SportEvent[] {
  return [
    {
      id: "wc2026-bra-fra",
      sport: "soccer",
      event: "FIFA World Cup 2026 — Round of 32",
      homeTeam: "Brazil",
      awayTeam: "France",
      homeForm: ["W", "W", "D", "W", "W"],
      awayForm: ["W", "W", "W", "D", "L"],
      startTime: hoursFromNow(3.5),
      homeInjuries: [],
      awayInjuries: ["K. Mbappé (hamstring, 75% fit)"],
      headToHead: "Brazil leads 3-2-2 in last 7 meetings (all competitions)",
      homeExternalOdds: 0.48,
      awayExternalOdds: 0.33,
      drawOdds: 0.19,
      marketVolume: 248000,
      context: "Brazil's Vinicius Jr. is in top form with 3 goals in group stage. France's attack limited to Griezmann if Mbappé unavailable.",
    },
    {
      id: "wc2026-eng-ger",
      sport: "soccer",
      event: "FIFA World Cup 2026 — Round of 32",
      homeTeam: "England",
      awayTeam: "Germany",
      homeForm: ["W", "W", "W", "D", "W"],
      awayForm: ["W", "D", "W", "W", "D"],
      startTime: hoursFromNow(7.2),
      homeInjuries: [],
      awayInjuries: ["T. Müller (minor knock, doubtful)"],
      headToHead: "England leads 5-4-3 in last 12 meetings including EURO 2020 win",
      homeExternalOdds: 0.42,
      awayExternalOdds: 0.38,
      drawOdds: 0.20,
      marketVolume: 192000,
      context: "England unbeaten in qualifying. Bellingham returned from injury and scored twice in group stage.",
    },
    {
      id: "wc2026-arg-esp",
      sport: "soccer",
      event: "FIFA World Cup 2026 — Round of 32",
      homeTeam: "Argentina",
      awayTeam: "Spain",
      homeForm: ["W", "D", "W", "W", "W"],
      awayForm: ["W", "W", "W", "W", "D"],
      startTime: hoursFromNow(11.8),
      homeInjuries: ["Ángel Di María (thigh, out)"],
      awayInjuries: [],
      headToHead: "Spain leads 3-2 in last 5 competitive fixtures",
      homeExternalOdds: 0.39,
      awayExternalOdds: 0.41,
      drawOdds: 0.20,
      marketVolume: 315000,
      context: "Lionel Messi's final World Cup. Spain playing fluid tiki-taka with Pedri and Yamal in sensational form.",
    },
    {
      id: "wc2026-por-mor",
      sport: "soccer",
      event: "FIFA World Cup 2026 — Round of 32",
      homeTeam: "Portugal",
      awayTeam: "Morocco",
      homeForm: ["W", "W", "W", "W", "D"],
      awayForm: ["W", "D", "W", "L", "W"],
      startTime: hoursFromNow(19.4),
      homeInjuries: [],
      awayInjuries: ["A. Hakimi (ankle, 60% fit)"],
      headToHead: "Portugal beat Morocco 1-0 in 2022 QF. Morocco pushed hard.",
      homeExternalOdds: 0.55,
      awayExternalOdds: 0.26,
      drawOdds: 0.19,
      marketVolume: 143000,
      context: "Ronaldo announced this as his final World Cup. Portugal favorites but Morocco knocked Spain in 2022.",
    },
    {
      id: "ufc316-merab-omalley",
      sport: "mma",
      event: "UFC 316 — Bantamweight Championship",
      homeTeam: "Merab Dvalishvili",
      awayTeam: "Sean O'Malley",
      homeForm: ["W", "W", "W", "W", "W"],
      awayForm: ["L", "W", "W", "W", "L"],
      startTime: hoursFromNow(14.5),
      homeInjuries: [],
      awayInjuries: ["Reported rib discomfort during camp"],
      headToHead: "Merab won the last meeting by UD. Dvalishvili holds the belt.",
      homeExternalOdds: 0.62,
      awayExternalOdds: 0.38,
      drawOdds: null,
      marketVolume: 198000,
      context: "Merab on 10-fight win streak. O'Malley seeking redemption after unanimous decision loss. Wrestling will be decisive.",
    },
    {
      id: "ufc-moreno-kara",
      sport: "mma",
      event: "UFC Fight Night — Flyweight Championship",
      homeTeam: "Brandon Moreno",
      awayTeam: "Kai Kara-France",
      homeForm: ["W", "L", "W", "W", "W"],
      awayForm: ["W", "W", "L", "W", "W"],
      startTime: hoursFromNow(22.1),
      homeInjuries: [],
      awayInjuries: [],
      headToHead: "Series tied 1-1. Moreno won the trilogy. KKF scored knockdown in fight 2.",
      homeExternalOdds: 0.56,
      awayExternalOdds: 0.44,
      drawOdds: null,
      marketVolume: 87000,
      context: "Rubber match in the flyweight division. Both fighters peak form. Moreno has submission edge, KKF has striking power advantage.",
    },
    {
      id: "boxing-canelo-bivol2",
      sport: "boxing",
      event: "WBA/WBC/WBO Light Heavyweight Unification",
      homeTeam: "Saul 'Canelo' Alvarez",
      awayTeam: "Dmitry Bivol",
      homeForm: ["W", "W", "W", "W", "W"],
      awayForm: ["W", "W", "W", "L", "W"],
      startTime: hoursFromNow(31.5),
      homeInjuries: [],
      awayInjuries: [],
      headToHead: "Bivol won the first fight via unanimous decision. Canelo seeking revenge.",
      homeExternalOdds: 0.45,
      awayExternalOdds: 0.55,
      drawOdds: null,
      marketVolume: 412000,
      context: "Rematch of the year. Canelo trained extensively on anti-clinch tactics. Bivol's jab and distance management were key in Fight 1. 175 lb weight limit confirmed.",
    },
    {
      id: "boxing-fury-joshua",
      sport: "boxing",
      event: "WBC Heavyweight Championship",
      homeTeam: "Tyson Fury",
      awayTeam: "Anthony Joshua",
      homeForm: ["W", "W", "D", "W", "W"],
      awayForm: ["W", "W", "W", "W", "L"],
      startTime: hoursFromNow(55.0),
      homeInjuries: [],
      awayInjuries: [],
      headToHead: "No prior meeting. Fury vs Usyk happened, Joshua rebuilt.",
      homeExternalOdds: 0.52,
      awayExternalOdds: 0.48,
      drawOdds: null,
      marketVolume: 524000,
      context: "The biggest fight in UK boxing history. Fury's footwork vs Joshua's power. AJ has reached peak conditioning. Fury slight favorite at the venue in Riyadh.",
    },
    {
      id: "nfl-chiefs-eagles-sb",
      sport: "football",
      event: "Super Bowl LXI — AFC vs NFC Prediction",
      homeTeam: "Kansas City Chiefs",
      awayTeam: "Philadelphia Eagles",
      homeForm: ["W", "W", "W", "L", "W"],
      awayForm: ["W", "W", "W", "W", "W"],
      startTime: hoursFromNow(42.0),
      homeInjuries: [],
      awayInjuries: [],
      headToHead: "Chiefs won Super Bowl LVII. Eagles seeking revenge.",
      homeExternalOdds: 0.44,
      awayExternalOdds: 0.56,
      drawOdds: null,
      marketVolume: 287000,
      context: "Eagles undefeated in preseason with dominant OL play. Mahomes vs Hurts storyline drives massive market volume. Eagles offensive line advantage may be decisive.",
    },
  ];
}

export function getEventById(id: string): SportEvent | null {
  return getUpcomingSportsEvents().find(e => e.id === id) ?? null;
}

export function getEventsBySport(sport: string): SportEvent[] {
  return getUpcomingSportsEvents().filter(e => e.sport === sport);
}
