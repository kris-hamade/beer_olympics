const path = require("path");
const express = require("express");
const session = require("express-session");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const dotenv = require("dotenv");
const packageInfo = require("./package.json");
dotenv.config();

const {
  initDb,
  insertTeam,
  getTeams,
  getUsedCountryCodes,
  getTeamById,
  getTeamByCountryCode,
  updateTeam,
  deleteTeam,
  createTournament,
  getActiveTournament,
  getTournamentById,
  listTournaments,
  updateTournamentSettings,
  createMatch,
  listMatchesByTournament,
  deleteMatchesByTournament,
  deleteMatchesByStagePrefix,
  deleteMatchById,
  deleteTournamentById,
  updateMatchScore,
  updateMatchWinner,
  updateMatchTeams,
  updateMatchLinks
} = require("./db");
const countries = require("./countries");

const app = express();
const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || "beer";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-session-secret";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "beeradmin";
const ASSET_VERSION = process.env.ASSET_VERSION || packageInfo.version;

initDb();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: false }));
app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    }
  })
);

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax"
    }
  })
);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many login attempts. Try again later."
});

app.use((req, res, next) => {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  }

  res.locals.csrfToken = req.session.csrfToken;
  res.locals.isAuthed = Boolean(req.session.isAuthed);
  res.locals.flash = req.session.flash || null;
  res.locals.flagUrlFor = (code) => `https://flagcdn.com/32x24/${String(code).toLowerCase()}.png`;
  res.locals.assetVersion = ASSET_VERSION;
  req.session.flash = null;
  next();
});

app.use((req, res, next) => {
  if (req.method === "GET" && req.accepts("html")) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});

function setFlash(req, type, message) {
  req.session.flash = { type, message };
}

function requireAuth(req, res, next) {
  if (req.session.isAuthed) {
    return next();
  }
  return res.redirect("/");
}

function requireCsrf(req, res, next) {
  const token = req.body._csrf;
  if (!token || token !== req.session.csrfToken) {
    setFlash(req, "error", "Your form session expired. Please try again.");
    return res.redirect(req.headers.referer || "/");
  }
  return next();
}

function requireAdmin(req, res, next) {
  if (req.session.isAdmin) {
    return next();
  }
  return res.redirect("/admin");
}

function parseSettings(settingsJson) {
  if (!settingsJson) {
    return {};
  }
  try {
    return JSON.parse(settingsJson);
  } catch (error) {
    return {};
  }
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function shuffleList(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function seedTeams(teams, seeding) {
  if (seeding === "random") {
    return shuffleList(teams);
  }
  return teams;
}

function nextPowerOfTwo(value) {
  let size = 1;
  while (size < value) {
    size *= 2;
  }
  return size;
}

function roundRobinSchedule(teamIds) {
  const teams = [...teamIds];
  if (teams.length % 2 === 1) {
    teams.push(null);
  }
  const totalTeams = teams.length;
  const rounds = totalTeams - 1;
  const matchesPerRound = totalTeams / 2;
  const schedule = [];

  for (let round = 0; round < rounds; round += 1) {
    const roundPairs = [];
    for (let match = 0; match < matchesPerRound; match += 1) {
      const home = teams[match];
      const away = teams[totalTeams - 1 - match];
      if (home && away) {
        roundPairs.push([home, away]);
      }
    }
    schedule.push(roundPairs);

    const fixed = teams[0];
    const rest = teams.slice(1);
    rest.unshift(rest.pop());
    teams.splice(0, teams.length, fixed, ...rest);
  }

  return schedule;
}

function slugifyGameName(name) {
  const cleaned = String(name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "game";
}

function ensureUniqueStageId(baseId, existingIds) {
  let id = baseId;
  let suffix = 2;
  while (existingIds.has(id)) {
    id = `${baseId}_${suffix}`;
    suffix += 1;
  }
  return id;
}

function computeStandings(teamIds, matches) {
  const standings = new Map();
  teamIds.forEach((teamId) => {
    standings.set(teamId, {
      teamId,
      wins: 0,
      losses: 0,
      pointsFor: 0,
      pointsAgainst: 0
    });
  });

  matches.forEach((match) => {
    if (!match.team_a_id || !match.team_b_id) {
      return;
    }

    const recordA = standings.get(match.team_a_id);
    const recordB = standings.get(match.team_b_id);
    if (!recordA || !recordB) {
      return;
    }

    const scoreA = Number.isFinite(match.score_a) ? match.score_a : null;
    const scoreB = Number.isFinite(match.score_b) ? match.score_b : null;
    const winnerId = match.winner_team_id;

    if (scoreA !== null && scoreB !== null) {
      recordA.pointsFor += scoreA;
      recordA.pointsAgainst += scoreB;
      recordB.pointsFor += scoreB;
      recordB.pointsAgainst += scoreA;
    }

    if (winnerId) {
      if (winnerId === match.team_a_id) {
        recordA.wins += 1;
        recordB.losses += 1;
      } else if (winnerId === match.team_b_id) {
        recordB.wins += 1;
        recordA.losses += 1;
      }
    }
  });

  return Array.from(standings.values()).sort((a, b) => {
    if (b.wins !== a.wins) {
      return b.wins - a.wins;
    }
    const diffA = a.pointsFor - a.pointsAgainst;
    const diffB = b.pointsFor - b.pointsAgainst;
    return diffB - diffA;
  });
}

function createSingleElimMatches(tournamentId, teams, settings, stage, options) {
  const config = options || {};
  const seededTeams = config.seededTeams || seedTeams(teams, settings.seeding);
  const slots = config.slotsOverride || [...seededTeams, ...Array(nextPowerOfTwo(seededTeams.length) - seededTeams.length).fill(null)];
  const bracketSize = slots.length;
  const rounds = Math.log2(bracketSize);
  const reservedSlotIndex = Number.isFinite(config.reservedSlotIndex) ? config.reservedSlotIndex : null;
  const reservedMatchIndex = reservedSlotIndex !== null ? Math.floor(reservedSlotIndex / 2) : null;
  const reservedSlot = reservedSlotIndex !== null ? (reservedSlotIndex % 2 === 0 ? "A" : "B") : null;
  const matchMap = [];
  const matches = [];
  const stageLabel = stage || "main";
  const seededTeamIds = seededTeams.map((team) => team.id);

  for (let round = 1; round <= rounds; round += 1) {
    const matchesInRound = bracketSize / Math.pow(2, round);
    matchMap[round] = [];
    for (let matchIndex = 0; matchIndex < matchesInRound; matchIndex += 1) {
      const match = {
        tournament_id: tournamentId,
        stage: stageLabel,
        round,
        match_number: matchIndex + 1,
        group_name: null,
        team_a_id: null,
        team_b_id: null,
        status: "scheduled"
      };

      if (round === 1) {
        const teamA = slots[matchIndex * 2];
        const teamB = slots[matchIndex * 2 + 1];
        match.team_a_id = teamA ? teamA.id : null;
        match.team_b_id = teamB ? teamB.id : null;

        if (reservedMatchIndex === matchIndex) {
          if (reservedSlot === "A" && !teamA) {
            match.hold_for_play_in = true;
          }
          if (reservedSlot === "B" && !teamB) {
            match.hold_for_play_in = true;
          }
        }

        if (teamA && teamB) {
          match.seed_a = seededTeamIds.indexOf(teamA.id) + 1;
          match.seed_b = seededTeamIds.indexOf(teamB.id) + 1;
        } else if (teamA) {
          match.seed_a = seededTeamIds.indexOf(teamA.id) + 1;
        } else if (teamB) {
          match.seed_b = seededTeamIds.indexOf(teamB.id) + 1;
        }
      }

      matches.push(match);
    }
  }

  const matchIdMap = new Map();
  matches.forEach((match) => {
    const result = createMatch(match);
    match.id = result.lastInsertRowid;
    matchIdMap.set(match.id, match);
    matchMap[match.round].push(match);
  });

  for (let round = 1; round < rounds; round += 1) {
    const currentRoundMatches = matchMap[round];
    const nextRoundMatches = matchMap[round + 1];
    currentRoundMatches.forEach((match, index) => {
      const nextMatch = nextRoundMatches[Math.floor(index / 2)];
      const slot = index % 2 === 0 ? "A" : "B";
      updateMatchLinks(match.id, nextMatch.id, slot, null, null);
      match.next_match_id = nextMatch.id;
      match.next_match_slot = slot;
    });
  }

  const applyWinner = (match, winnerTeamId) => {
    if (!winnerTeamId) {
      return;
    }
    updateMatchWinner(match.id, winnerTeamId, "completed");
    match.winner_team_id = winnerTeamId;
    match.status = "completed";

    if (match.next_match_id) {
      const nextMatch = matchIdMap.get(match.next_match_id);
      if (!nextMatch) {
        return;
      }
      if (match.next_match_slot === "A") {
        nextMatch.team_a_id = winnerTeamId;
      } else {
        nextMatch.team_b_id = winnerTeamId;
      }
      updateMatchTeams(nextMatch.id, nextMatch.team_a_id, nextMatch.team_b_id);
    }
  };

  matchMap[1].forEach((match) => {
    if (match.hold_for_play_in) {
      return;
    }
    if (match.team_a_id && !match.team_b_id) {
      applyWinner(match, match.team_a_id);
    } else if (!match.team_a_id && match.team_b_id) {
      applyWinner(match, match.team_b_id);
    }
  });

  return matchMap;
}

function createSingleElimWithPlayIn(tournamentId, teams, settings, stage) {
  if (!settings.play_in_enabled || teams.length < 3 || teams.length % 2 === 0) {
    const matchMap = createSingleElimMatches(tournamentId, teams, settings, stage);
    return { matchMap, playInMatch: null, reservedMatchIndex: null };
  }

  const seededAllTeams = seedTeams(teams, settings.seeding);
  const playInPair = shuffleList([...teams]).slice(0, 2);
  const playInIds = new Set(playInPair.map((team) => team.id));
  const remainingTeams = seededAllTeams.filter((team) => !playInIds.has(team.id));

  const bracketSize = nextPowerOfTwo(remainingTeams.length + 1);
  const placeholderIndex = remainingTeams.length;
  const slots = [
    ...remainingTeams,
    null,
    ...Array(bracketSize - remainingTeams.length - 1).fill(null)
  ];

  const matchMap = createSingleElimMatches(tournamentId, teams, settings, stage, {
    seededTeams: remainingTeams,
    slotsOverride: slots,
    reservedSlotIndex: placeholderIndex
  });

  const playInMatch = createMatch({
    tournament_id: tournamentId,
    stage: stage || "main",
    round: 0,
    match_number: 1,
    group_name: null,
    team_a_id: playInPair[0].id,
    team_b_id: playInPair[1].id,
    seed_a: seededAllTeams.findIndex((team) => team.id === playInPair[0].id) + 1,
    seed_b: seededAllTeams.findIndex((team) => team.id === playInPair[1].id) + 1,
    status: "scheduled"
  });

  const targetMatchIndex = Math.floor(placeholderIndex / 2);
  const targetMatch = matchMap[1] ? matchMap[1][targetMatchIndex] : null;
  let playInNextMatchId = null;
  let playInNextSlot = null;
  if (targetMatch) {
    const slot = placeholderIndex % 2 === 0 ? "A" : "B";
    playInNextMatchId = targetMatch.id;
    playInNextSlot = slot;
    updateMatchLinks(playInMatch.lastInsertRowid, targetMatch.id, slot, null, null);
  }

  return {
    matchMap,
    playInMatch: playInMatch.lastInsertRowid,
    reservedMatchIndex: targetMatchIndex,
    playInNextMatchId,
    playInNextSlot
  };
}

function createDoubleElimMatches(tournamentId, teams, settings, gameId) {
  const winnersStage = `${gameId}_winners`;
  const losersStage = `${gameId}_losers`;
  const finalStage = `${gameId}_final`;

  let matchMap;
  let playInMatchId = null;
  let reservedMatchIndex = null;
  let playInNextMatchId = null;
  let playInNextSlot = null;

  if (settings.play_in_enabled && teams.length >= 3 && teams.length % 2 === 1) {
    const playInResult = createSingleElimWithPlayIn(tournamentId, teams, settings, winnersStage);
    matchMap = playInResult.matchMap;
    playInMatchId = playInResult.playInMatch;
    reservedMatchIndex = playInResult.reservedMatchIndex;
    playInNextMatchId = playInResult.playInNextMatchId;
    playInNextSlot = playInResult.playInNextSlot;
  } else {
    matchMap = createSingleElimMatches(tournamentId, teams, settings, winnersStage);
  }

  if (!matchMap || matchMap.length <= 1) {
    return;
  }

  const winnersRounds = matchMap.length - 1;
  const losersRounds = 2 * (winnersRounds - 1);
  const losersMap = {};

  for (let round = 1; round <= losersRounds; round += 1) {
    const matchesInRound = Math.pow(2, winnersRounds - 1 - Math.floor((round + 1) / 2));
    losersMap[round] = [];
    for (let matchIndex = 0; matchIndex < matchesInRound; matchIndex += 1) {
      const match = {
        tournament_id: tournamentId,
        stage: losersStage,
        round,
        match_number: matchIndex + 1,
        group_name: null,
        team_a_id: null,
        team_b_id: null,
        status: "scheduled"
      };
      const result = createMatch(match);
      match.id = result.lastInsertRowid;
      losersMap[round].push(match);
    }
  }

  for (let round = 1; round < losersRounds; round += 1) {
    const current = losersMap[round];
    const next = losersMap[round + 1];
    if (!current || !next) {
      continue;
    }
    const sameCount = current.length === next.length;
    current.forEach((match, index) => {
      const targetIndex = sameCount ? index : Math.floor(index / 2);
      const targetMatch = next[targetIndex];
      const slot = sameCount ? "A" : (index % 2 === 0 ? "A" : "B");
      updateMatchLinks(match.id, targetMatch.id, slot, null, null);
    });
  }

  for (let round = 1; round <= winnersRounds; round += 1) {
    const winnersRoundMatches = matchMap[round] || [];
    const targetRound = round === 1 ? 1 : 2 * round - 2;
    const losersRoundMatches = losersMap[targetRound] || [];
    if (losersRoundMatches.length === 0) {
      continue;
    }

    const sameCount = winnersRoundMatches.length === losersRoundMatches.length;
    winnersRoundMatches.forEach((match, index) => {
      const targetIndex = sameCount ? index : Math.floor(index / 2);
      const loserTarget = losersRoundMatches[targetIndex];
      if (!loserTarget) {
        return;
      }
      const slot = targetRound === 1 ? (index % 2 === 0 ? "A" : "B") : "B";
      updateMatchLinks(match.id, match.next_match_id, match.next_match_slot, loserTarget.id, slot);
    });
  }

  if (playInMatchId && losersMap[1]) {
    const targetIndex = Number.isFinite(reservedMatchIndex) ? Math.floor(reservedMatchIndex / 2) : 0;
    const loserTarget = losersMap[1][targetIndex];
    if (loserTarget) {
      const loserSlot = Number.isFinite(reservedMatchIndex) && reservedMatchIndex % 2 === 0 ? "A" : "B";
      updateMatchLinks(playInMatchId, playInNextMatchId, playInNextSlot, loserTarget.id, loserSlot);
    }
  }

  const winnersFinal = matchMap[winnersRounds] ? matchMap[winnersRounds][0] : null;
  const losersFinal = losersMap[losersRounds] ? losersMap[losersRounds][0] : null;
  if (winnersFinal && losersFinal) {
    const finalMatch = createMatch({
      tournament_id: tournamentId,
      stage: finalStage,
      round: 1,
      match_number: 1,
      group_name: null,
      team_a_id: null,
      team_b_id: null,
      status: "scheduled"
    });
    const finalId = finalMatch.lastInsertRowid;
    updateMatchLinks(winnersFinal.id, finalId, "A", winnersFinal.loser_next_match_id, winnersFinal.loser_next_match_slot);
    updateMatchLinks(losersFinal.id, finalId, "B", losersFinal.loser_next_match_id, losersFinal.loser_next_match_slot);
  }
}

function createRoundRobinMatches(tournamentId, teams, stage, groupName) {
  const schedule = roundRobinSchedule(teams.map((team) => team.id));
  schedule.forEach((roundPairs, roundIndex) => {
    roundPairs.forEach((pair, matchIndex) => {
      createMatch({
        tournament_id: tournamentId,
        stage,
        round: roundIndex + 1,
        match_number: matchIndex + 1,
        group_name: groupName || null,
        team_a_id: pair[0],
        team_b_id: pair[1],
        status: "scheduled"
      });
    });
  });
}

function createGroupStageMatches(tournamentId, teams, settings) {
  const seededTeams = seedTeams(teams, settings.seeding);
  const groupCount = Math.max(2, Math.min(toInt(settings.group_count, 2), seededTeams.length));
  const groupNames = Array.from({ length: groupCount }, (_, index) => String.fromCharCode(65 + index));
  const groups = {};
  groupNames.forEach((name) => {
    groups[name] = [];
  });

  seededTeams.forEach((team, index) => {
    const groupName = groupNames[index % groupCount];
    groups[groupName].push(team);
  });

  Object.entries(groups).forEach(([groupName, groupTeams]) => {
    if (groupTeams.length >= 2) {
      createRoundRobinMatches(tournamentId, groupTeams, "group", groupName);
    }
  });
}

function createSwissRoundMatches(tournamentId, teams, matches, settings) {
  const swissRounds = toInt(settings.swiss_rounds, 3);
  const currentRound = matches
    .filter((match) => match.stage === "swiss")
    .reduce((max, match) => Math.max(max, match.round), 0);
  if (currentRound >= swissRounds) {
    return { error: "Swiss rounds are complete." };
  }

  const standings = computeStandings(
    teams.map((team) => team.id),
    matches.filter((match) => match.stage === "swiss")
  );
  const pairingPool = standings.map((entry) => entry.teamId);
  const playedPairs = new Set();
  matches.forEach((match) => {
    if (match.team_a_id && match.team_b_id) {
      const key = [match.team_a_id, match.team_b_id].sort().join("-");
      playedPairs.add(key);
    }
  });

  const nextRound = currentRound + 1;
  let matchNumber = 1;
  while (pairingPool.length > 0) {
    const teamA = pairingPool.shift();
    let opponentIndex = pairingPool.findIndex((teamId) => {
      const key = [teamA, teamId].sort().join("-");
      return !playedPairs.has(key);
    });
    if (opponentIndex === -1) {
      opponentIndex = 0;
    }
    const teamB = pairingPool.splice(opponentIndex, 1)[0];

    if (!teamB) {
      createMatch({
        tournament_id: tournamentId,
        stage: "swiss",
        round: nextRound,
        match_number: matchNumber,
        group_name: null,
        team_a_id: teamA,
        team_b_id: null,
        status: "completed",
        winner_team_id: teamA
      });
      matchNumber += 1;
      continue;
    }

    createMatch({
      tournament_id: tournamentId,
      stage: "swiss",
      round: nextRound,
      match_number: matchNumber,
      group_name: null,
      team_a_id: teamA,
      team_b_id: teamB,
      status: "scheduled"
    });
    matchNumber += 1;
  }

  return { ok: true };
}

function buildScoreboards(teams, matches, games) {
  const teamById = new Map(teams.map((team) => [team.id, team]));
  const totalWinsMap = new Map();
  const winsByGame = {};
  const maxRoundByGame = {};

  matches.forEach((match) => {
    if (!match.stage || !match.winner_team_id) {
      return;
    }

    const stage = match.stage;
    if (!winsByGame[stage]) {
      winsByGame[stage] = new Map();
    }
    const stageWins = winsByGame[stage];
    stageWins.set(match.winner_team_id, (stageWins.get(match.winner_team_id) || 0) + 1);
    totalWinsMap.set(match.winner_team_id, (totalWinsMap.get(match.winner_team_id) || 0) + 1);

    const currentMaxRound = maxRoundByGame[stage] || 0;
    if (match.round > currentMaxRound) {
      maxRoundByGame[stage] = match.round;
    }
  });

  const perGameScoreboards = (games || []).map((game) => {
    const gameMatches = matches.filter(
      (match) => match.stage && match.stage.startsWith(game.id)
    );
    const gameWins = new Map();
    gameMatches.forEach((match) => {
      if (!match.winner_team_id) {
        return;
      }
      gameWins.set(match.winner_team_id, (gameWins.get(match.winner_team_id) || 0) + 1);
    });
    const rows = teams
      .map((team) => ({
        team,
        wins: gameWins.get(team.id) || 0
      }))
      .filter((row) => row.wins > 0)
      .sort((a, b) => b.wins - a.wins);

    const finalStageMatch = gameMatches.find((match) => match.stage === `${game.id}_final`);
    const maxRound = gameMatches.reduce((max, match) => Math.max(max, match.round), 0);
    const finalMatch = finalStageMatch || gameMatches.find((match) => match.round === maxRound);
    const champion = finalMatch && finalMatch.winner_team_id ? teamById.get(finalMatch.winner_team_id) : null;

    return {
      id: game.id,
      name: game.name,
      rows,
      champion
    };
  });

  const totalScoreboard = teams
    .map((team) => ({
      team,
      wins: totalWinsMap.get(team.id) || 0
    }))
    .filter((row) => row.wins > 0)
    .sort((a, b) => b.wins - a.wins);

  return { perGameScoreboards, totalScoreboard };
}

function buildBrackets(matches, games) {
  const buildRounds = (stageMatches) => {
    const roundsMap = new Map();
    stageMatches.forEach((match) => {
      if (!roundsMap.has(match.round)) {
        roundsMap.set(match.round, []);
      }
      roundsMap.get(match.round).push(match);
    });
    return Array.from(roundsMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([roundNumber, roundMatches]) => ({
        roundNumber,
        matches: roundMatches.sort((a, b) => a.match_number - b.match_number)
      }));
  };

  return (games || []).map((game) => {
    const winnersMatches = matches.filter((match) => match.stage === `${game.id}_winners`);
    const losersMatches = matches.filter((match) => match.stage === `${game.id}_losers`);
    const finalMatches = matches.filter((match) => match.stage === `${game.id}_final`);
    const singleMatches = matches.filter((match) => match.stage === game.id);

    const isDouble = winnersMatches.length > 0 || losersMatches.length > 0 || finalMatches.length > 0;
    if (!isDouble) {
      const rounds = buildRounds(singleMatches);
      return {
        id: game.id,
        name: game.name,
        rounds,
        champion: rounds.length ? rounds[rounds.length - 1].matches[0] : null,
        isDouble: false
      };
    }

    const winnersRounds = buildRounds(winnersMatches);
    const losersRounds = buildRounds(losersMatches);
    const finalMatch = finalMatches.length ? finalMatches[0] : null;

    return {
      id: game.id,
      name: game.name,
      winnersRounds,
      losersRounds,
      finalMatch,
      isDouble: true
    };
  });
}

function buildStageLabel(stage, gameId, round) {
  if (stage === `${gameId}_final`) {
    return "Grand Final";
  }
  if (stage === `${gameId}_winners`) {
    return `Winners Round ${round}`;
  }
  if (stage === `${gameId}_losers`) {
    return `Losers Round ${round}`;
  }
  if (stage === gameId) {
    return `Round ${round}`;
  }
  return `Round ${round}`;
}

function getNextMatchStatus(matches, game, teamId) {
  const gameMatches = matches.filter(
    (match) => match.stage && match.stage.startsWith(game.id)
  );
  const isTeamMatch = (match) => match.team_a_id === teamId || match.team_b_id === teamId;
  const byRound = (a, b) => (a.round - b.round) || (a.match_number - b.match_number);

  const scheduled = gameMatches
    .filter((match) => isTeamMatch(match) && match.status !== "completed")
    .sort(byRound)[0];

  if (scheduled) {
    const opponent = scheduled.team_a_id === teamId
      ? scheduled.team_b_name
      : scheduled.team_a_name;
    return {
      status: "scheduled",
      label: buildStageLabel(scheduled.stage, game.id, scheduled.round),
      opponent: opponent || "TBD"
    };
  }

  const byeMatch = gameMatches
    .filter((match) => isTeamMatch(match))
    .filter((match) => (!match.team_a_id || !match.team_b_id) && match.winner_team_id === teamId)
    .sort(byRound)
    .pop();

  if (byeMatch) {
    return {
      status: "bye",
      label: buildStageLabel(byeMatch.stage, game.id, byeMatch.round)
    };
  }

  const finalMatch = gameMatches.find((match) => match.stage === `${game.id}_final`);
  if (finalMatch && finalMatch.winner_team_id === teamId) {
    return { status: "champion", label: "Champion" };
  }

  if (gameMatches.length === 0) {
    return { status: "not_started", label: "Not started" };
  }

  return { status: "waiting", label: "Waiting for next round" };
}

function setWinnerAndAdvance(tournamentId, matchId, winnerTeamId) {
  if (!winnerTeamId) {
    return;
  }
  const matches = listMatchesByTournament(tournamentId);
  const match = matches.find((item) => item.id === matchId);
  if (!match) {
    return;
  }
  updateMatchWinner(matchId, winnerTeamId, "completed");

  if (match.loser_next_match_id) {
    const loserTeamId = winnerTeamId === match.team_a_id ? match.team_b_id : match.team_a_id;
    if (loserTeamId) {
      const loserNext = matches.find((item) => item.id === match.loser_next_match_id);
      if (loserNext) {
        if (match.loser_next_match_slot === "A") {
          updateMatchTeams(loserNext.id, loserTeamId, loserNext.team_b_id);
        } else {
          updateMatchTeams(loserNext.id, loserNext.team_a_id, loserTeamId);
        }
      }
    }
  }

  if (!match.next_match_id) {
    return;
  }
  const nextMatch = matches.find((item) => item.id === match.next_match_id);
  if (!nextMatch) {
    return;
  }

  if (match.next_match_slot === "A") {
    updateMatchTeams(nextMatch.id, winnerTeamId, nextMatch.team_b_id);
  } else {
    updateMatchTeams(nextMatch.id, nextMatch.team_a_id, winnerTeamId);
  }
}

function getAvailableCountries() {
  const used = new Set(getUsedCountryCodes());
  return countries.filter((country) => !used.has(country.code));
}

app.get("/", (req, res) => {
  if (req.session.isAuthed) {
    return res.redirect("/home");
  }
  return res.render("login", {
    title: "Beer Olympics Access",
    error: null
  });
});

app.post("/login", loginLimiter, requireCsrf, (req, res) => {
  const password = (req.body.password || "").trim();

  if (password !== APP_PASSWORD) {
    setFlash(req, "error", "Incorrect password. Please try again.");
    return res.redirect("/");
  }

  req.session.isAuthed = true;
  return res.redirect("/home");
});

app.post("/logout", requireAuth, requireCsrf, (req, res) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
});

app.get("/register", requireAuth, (req, res) => {
  const availableCountries = getAvailableCountries();
  const teams = getTeams();

  res.render("register", {
    title: "Beer Olympics Team Registration",
    countries: availableCountries,
    teams,
    errors: [],
    form: {
      player1_name: "",
      player2_name: "",
      country_code: ""
    },
    remainingCount: availableCountries.length
  });
});

app.get("/home", requireAuth, (req, res) => {
  const teams = getTeams();
  const remainingCount = getAvailableCountries().length;

  res.render("home", {
    title: "Beer Olympics Home",
    teams,
    remainingCount
  });
});

app.get("/team-status", requireAuth, (req, res) => {
  const teamId = Number(req.query.teamId);
  if (!Number.isFinite(teamId)) {
    return res.json({ error: "Team not found." });
  }

  const team = getTeamById(teamId);
  if (!team) {
    return res.json({ error: "Team not found." });
  }

  const tournament = getActiveTournament();
  if (!tournament) {
    return res.json({
      teamId,
      teamName: team.team_name,
      status: "no_tournament",
      games: []
    });
  }

  const settings = parseSettings(tournament.settings_json);
  const games = Array.isArray(settings.games) ? settings.games : [];
  const matches = listMatchesByTournament(tournament.id);

  const gameStatuses = games.map((game) => ({
    id: game.id,
    name: game.name,
    ...getNextMatchStatus(matches, game, teamId)
  }));

  return res.json({
    teamId,
    teamName: team.team_name,
    updatedAt: new Date().toISOString(),
    games: gameStatuses
  });
});

app.post("/register", requireAuth, requireCsrf, (req, res) => {
  const player1Name = (req.body.player1_name || "").trim();
  const player2Name = (req.body.player2_name || "").trim();
  const countryCode = (req.body.country_code || "").trim();

  const errors = [];
  const availableCountries = getAvailableCountries();
  const availableCodes = new Set(availableCountries.map((country) => country.code));

  if (!player1Name) {
    errors.push("Player 1 name is required.");
  }
  if (!player2Name) {
    errors.push("Player 2 name is required.");
  }
  if (!countryCode) {
    errors.push("Country selection is required.");
  }

  if (countryCode && !availableCodes.has(countryCode)) {
    errors.push("That country is no longer available. Please choose another.");
  }

  if (availableCountries.length === 0) {
    errors.push("All countries have been claimed. Registration is closed.");
  }

  if (errors.length > 0) {
    return res.render("register", {
      title: "Beer Olympics Team Registration",
      countries: availableCountries,
      teams: getTeams(),
      errors,
      form: {
        player1_name: player1Name,
        player2_name: player2Name,
        country_code: countryCode
      },
      remainingCount: availableCountries.length
    });
  }

  const selectedCountry = countries.find((country) => country.code === countryCode);

  try {
    const result = insertTeam({
      team_name: selectedCountry.name,
      player1_name: player1Name,
      player2_name: player2Name,
      country_code: selectedCountry.code,
      country_name: selectedCountry.name,
      country_flag: selectedCountry.flag
    });

    return res.redirect(`/success/${result.lastInsertRowid}`);
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      errors.push("That country is already registered. Please choose another.");
    } else {
      errors.push("Something went wrong. Please try again.");
    }

    return res.render("register", {
      title: "Beer Olympics Team Registration",
      countries: getAvailableCountries(),
      teams: getTeams(),
      errors,
      form: {
        player1_name: player1Name,
        player2_name: player2Name,
        country_code: countryCode
      },
      remainingCount: getAvailableCountries().length
    });
  }
});

app.get("/success/:id", requireAuth, (req, res) => {
  const team = getTeamById(req.params.id);

  if (!team) {
    return res.redirect("/register");
  }

  const remainingCount = getAvailableCountries().length;

  return res.render("success", {
    title: "Registration Complete",
    team,
    remainingCount
  });
});

app.get("/teams", requireAuth, (req, res) => {
  const teams = getTeams();
  const remainingCount = getAvailableCountries().length;

  res.render("teams", {
    title: "Registered Teams",
    teams,
    remainingCount
  });
});

app.get("/scoreboard", (req, res) => {
  const tournament = getActiveTournament();
  const settings = tournament ? parseSettings(tournament.settings_json) : {};
  const games = Array.isArray(settings.games) ? settings.games : [];
  const teams = getTeams();
  const matches = tournament ? listMatchesByTournament(tournament.id) : [];
  const { perGameScoreboards, totalScoreboard } = buildScoreboards(teams, matches, games);

  res.render("scoreboard", {
    title: "Scoreboard",
    tournament,
    games,
    perGameScoreboards,
    totalScoreboard
  });
});

app.get("/display", (req, res) => {
  res.redirect("/live-standings");
});

app.get("/live-standings", (req, res) => {
  res.render("display", {
    title: "Live Standings"
  });
});

app.get("/display/data", (req, res) => {
  res.redirect("/live-standings/data");
});

app.get("/live-standings/data", (req, res) => {
  const tournament = getActiveTournament();
  if (!tournament) {
    return res.json({
      tournament: null,
      games: [],
      brackets: [],
      perGameScoreboards: [],
      totalScoreboard: [],
      updatedAt: new Date().toISOString()
    });
  }

  const settings = parseSettings(tournament.settings_json);
  const games = Array.isArray(settings.games) ? settings.games : [];
  const teams = getTeams();
  const matches = listMatchesByTournament(tournament.id);
  const { perGameScoreboards, totalScoreboard } = buildScoreboards(teams, matches, games);
  const brackets = buildBrackets(matches, games);

  return res.json({
    tournament: {
      id: tournament.id,
      name: tournament.name,
      format: tournament.format
    },
    games,
    brackets,
    perGameScoreboards,
    totalScoreboard,
    updatedAt: new Date().toISOString()
  });
});

app.get("/admin", (req, res) => {
  if (req.session.isAdmin) {
    return res.redirect("/admin/teams");
  }

  return res.render("admin_login", {
    title: "Beer Olympics Admin",
    error: null
  });
});

app.post("/admin/login", loginLimiter, requireCsrf, (req, res) => {
  const password = (req.body.password || "").trim();

  if (password !== ADMIN_PASSWORD) {
    setFlash(req, "error", "Incorrect admin password.");
    return res.redirect("/admin");
  }

  req.session.isAdmin = true;
  return res.redirect("/admin/teams");
});

app.post("/admin/logout", requireAdmin, requireCsrf, (req, res) => {
  req.session.isAdmin = false;
  return res.redirect("/admin");
});

app.get("/admin/teams", requireAdmin, (req, res) => {
  const teams = getTeams();
  const used = new Set(getUsedCountryCodes());
  const countryOptionsByTeam = {};

  teams.forEach((team) => {
    countryOptionsByTeam[team.id] = countries.filter(
      (country) => country.code === team.country_code || !used.has(country.code)
    );
  });

  res.render("admin", {
    title: "Admin Portal",
    teams,
    countriesByTeam: countryOptionsByTeam
  });
});

app.post("/admin/teams/:id", requireAdmin, requireCsrf, (req, res) => {
  const teamId = Number(req.params.id);
  const player1Name = (req.body.player1_name || "").trim();
  const player2Name = (req.body.player2_name || "").trim();
  const countryCode = (req.body.country_code || "").trim();

  if (!player1Name || !player2Name || !countryCode) {
    setFlash(req, "error", "All fields are required.");
    return res.redirect("/admin/teams");
  }

  const selectedCountry = countries.find((country) => country.code === countryCode);
  if (!selectedCountry) {
    setFlash(req, "error", "Selected country is invalid.");
    return res.redirect("/admin/teams");
  }

  const existingCountry = getTeamByCountryCode(countryCode);
  if (existingCountry && existingCountry.id !== teamId) {
    setFlash(req, "error", "That country is already assigned to another team.");
    return res.redirect("/admin/teams");
  }

  updateTeam(teamId, {
    team_name: selectedCountry.name,
    player1_name: player1Name,
    player2_name: player2Name,
    country_code: selectedCountry.code,
    country_name: selectedCountry.name,
    country_flag: selectedCountry.flag
  });

  setFlash(req, "success", "Team updated.");
  return res.redirect("/admin/teams");
});

app.post("/admin/teams/:id/delete", requireAdmin, requireCsrf, (req, res) => {
  const teamId = Number(req.params.id);
  deleteTeam(teamId);
  setFlash(req, "success", "Team deleted.");
  return res.redirect("/admin/teams");
});

app.get("/admin/tournament", requireAdmin, (req, res) => {
  const tournament = getActiveTournament();
  const settings = tournament ? parseSettings(tournament.settings_json) : {};
  const matches = tournament ? listMatchesByTournament(tournament.id) : [];
  const tournaments = listTournaments();
  const teams = getTeams();
  const games = Array.isArray(settings.games) ? settings.games : [];
  const { perGameScoreboards, totalScoreboard } = buildScoreboards(teams, matches, games);
  const brackets = buildBrackets(matches, games);
  const activeBracketId = req.query.game ? String(req.query.game) : (brackets[0] ? brackets[0].id : "");

  res.render("admin_tournament", {
    title: "Tournament Control",
    tournament,
    settings,
    matches,
    tournaments,
    teams,
    games,
    perGameScoreboards,
    totalScoreboard,
    brackets,
    activeBracketId
  });
});

app.post("/admin/tournament/round/rearrange", requireAdmin, requireCsrf, (req, res) => {
  const tournament = getActiveTournament();
  if (!tournament) {
    setFlash(req, "error", "No active tournament to update.");
    return res.redirect("/admin/tournament");
  }

  const stage = (req.body.stage || "").trim();
  const roundNumber = toInt(req.body.round, null);
  const gameId = (req.body.game_id || "").trim();
  if (!stage || !roundNumber) {
    setFlash(req, "error", "Missing round details for rearranging.");
    return res.redirect(gameId ? `/admin/tournament?game=${encodeURIComponent(gameId)}` : "/admin/tournament");
  }

  const matches = listMatchesByTournament(tournament.id)
    .filter((match) => match.stage === stage && match.round === roundNumber);

  if (!matches.length) {
    setFlash(req, "error", "No matches found for that round.");
    return res.redirect(gameId ? `/admin/tournament?game=${encodeURIComponent(gameId)}` : "/admin/tournament");
  }

  const matchById = new Map(matches.map((match) => [match.id, match]));
  const allMatches = listMatchesByTournament(tournament.id);
  const allById = new Map(allMatches.map((match) => [match.id, match]));

  matches.forEach((match) => {
    const teamAId = toInt(req.body[`match_${match.id}_team_a`], null);
    const teamBId = toInt(req.body[`match_${match.id}_team_b`], null);

    updateMatchTeams(match.id, teamAId, teamBId);
    updateMatchWinner(match.id, null, "scheduled");
    updateMatchScore(match.id, null, null, "scheduled");

    if (match.next_match_id && match.next_match_slot) {
      const nextMatch = allById.get(match.next_match_id);
      if (nextMatch) {
        const nextTeamA = match.next_match_slot === "A" ? null : nextMatch.team_a_id;
        const nextTeamB = match.next_match_slot === "B" ? null : nextMatch.team_b_id;
        updateMatchTeams(nextMatch.id, nextTeamA, nextTeamB);
        updateMatchWinner(nextMatch.id, null, "scheduled");
        updateMatchScore(nextMatch.id, null, null, "scheduled");
      }
    }

    if (match.loser_next_match_id && match.loser_next_match_slot) {
      const loserMatch = allById.get(match.loser_next_match_id);
      if (loserMatch) {
        const loserTeamA = match.loser_next_match_slot === "A" ? null : loserMatch.team_a_id;
        const loserTeamB = match.loser_next_match_slot === "B" ? null : loserMatch.team_b_id;
        updateMatchTeams(loserMatch.id, loserTeamA, loserTeamB);
        updateMatchWinner(loserMatch.id, null, "scheduled");
        updateMatchScore(loserMatch.id, null, null, "scheduled");
      }
    }
  });

  setFlash(req, "success", "Round updated.");
  return res.redirect(gameId ? `/admin/tournament?game=${encodeURIComponent(gameId)}` : "/admin/tournament");
});

app.post("/admin/tournament/create", requireAdmin, requireCsrf, (req, res) => {
  const name = (req.body.name || "").trim();
  const format = (req.body.format || "").trim();
  const seeding = (req.body.seeding || "registration").trim();
  const scoreMode = (req.body.score_mode || "numeric").trim();
  const groupCount = toInt(req.body.group_count, 2);
  const advanceCount = toInt(req.body.advance_count, 2);
  const swissRounds = toInt(req.body.swiss_rounds, 3);
  const playInEnabled = req.body.play_in_enabled === "on";

  if (!name) {
    setFlash(req, "error", "Tournament name is required.");
    return res.redirect("/admin/tournament");
  }

  const allowedFormats = ["single_elim", "double_elim", "round_robin", "group_stage", "swiss", "multi_game"];
  if (!allowedFormats.includes(format)) {
    setFlash(req, "error", "Tournament format is invalid.");
    return res.redirect("/admin/tournament");
  }

  const settings = {
    seeding,
    score_mode: scoreMode,
    group_count: groupCount,
    advance_count: advanceCount,
    swiss_rounds: swissRounds,
    play_in_enabled: playInEnabled,
    games: []
  };

  createTournament(name, format, "setup", JSON.stringify(settings));
  setFlash(req, "success", "Tournament created.");
  return res.redirect("/admin/tournament");
});

app.post("/admin/tournament/reset", requireAdmin, requireCsrf, (req, res) => {
  const tournament = getActiveTournament();
  if (!tournament) {
    setFlash(req, "error", "No active tournament to reset.");
    return res.redirect("/admin/tournament");
  }
  deleteMatchesByTournament(tournament.id);
  setFlash(req, "success", "Matches reset.");
  return res.redirect("/admin/tournament");
});


app.post("/admin/tournament/games", requireAdmin, requireCsrf, (req, res) => {
  const tournament = getActiveTournament();
  if (!tournament || tournament.format !== "multi_game") {
    setFlash(req, "error", "Multi-game tournaments are required to add games.");
    return res.redirect("/admin/tournament");
  }

  const gameName = (req.body.game_name || "").trim();
  if (!gameName) {
    setFlash(req, "error", "Game name is required.");
    return res.redirect("/admin/tournament");
  }

  const settings = parseSettings(tournament.settings_json);
  const games = Array.isArray(settings.games) ? settings.games : [];
  const existingIds = new Set(games.map((game) => game.id));
  const baseId = slugifyGameName(gameName);
  const id = ensureUniqueStageId(baseId, existingIds);

  games.push({ id, name: gameName });
  settings.games = games;
  updateTournamentSettings(tournament.id, JSON.stringify(settings));

  setFlash(req, "success", "Game added.");
  return res.redirect("/admin/tournament");
});

app.post("/admin/tournament/games/bulk", requireAdmin, requireCsrf, (req, res) => {
  const tournament = getActiveTournament();
  if (!tournament || tournament.format !== "multi_game") {
    setFlash(req, "error", "Multi-game tournaments are required to add games.");
    return res.redirect("/admin/tournament");
  }

  const raw = (req.body.game_names || "").trim();
  if (!raw) {
    setFlash(req, "error", "Enter one or more game names.");
    return res.redirect("/admin/tournament");
  }

  const settings = parseSettings(tournament.settings_json);
  const games = Array.isArray(settings.games) ? settings.games : [];
  const existingIds = new Set(games.map((game) => game.id));
  const existingNames = new Set(games.map((game) => game.name.toLowerCase()));

  const names = raw
    .split(/\r?\n|,/)
    .map((name) => name.trim())
    .filter(Boolean);

  names.forEach((gameName) => {
    const lower = gameName.toLowerCase();
    if (existingNames.has(lower)) {
      return;
    }
    const baseId = slugifyGameName(gameName);
    const id = ensureUniqueStageId(baseId, existingIds);
    games.push({ id, name: gameName });
    existingIds.add(id);
    existingNames.add(lower);
  });

  settings.games = games;
  updateTournamentSettings(tournament.id, JSON.stringify(settings));

  setFlash(req, "success", "Games added.");
  return res.redirect("/admin/tournament");
});

app.post("/admin/tournament/games/:id/update", requireAdmin, requireCsrf, (req, res) => {
  const tournament = getActiveTournament();
  if (!tournament || tournament.format !== "multi_game") {
    setFlash(req, "error", "Multi-game tournaments are required to update games.");
    return res.redirect("/admin/tournament");
  }

  const gameId = String(req.params.id || "").trim();
  const gameName = (req.body.game_name || "").trim();
  if (!gameId || !gameName) {
    setFlash(req, "error", "Game name is required.");
    return res.redirect("/admin/tournament");
  }

  const settings = parseSettings(tournament.settings_json);
  const games = Array.isArray(settings.games) ? settings.games : [];
  const game = games.find((item) => item.id === gameId);
  if (!game) {
    setFlash(req, "error", "Game not found.");
    return res.redirect("/admin/tournament");
  }

  game.name = gameName;
  settings.games = games;
  updateTournamentSettings(tournament.id, JSON.stringify(settings));

  setFlash(req, "success", "Game updated.");
  return res.redirect("/admin/tournament");
});

app.post("/admin/tournament/games/:id/delete", requireAdmin, requireCsrf, (req, res) => {
  const tournament = getActiveTournament();
  if (!tournament || tournament.format !== "multi_game") {
    setFlash(req, "error", "Multi-game tournaments are required to delete games.");
    return res.redirect("/admin/tournament");
  }

  const gameId = String(req.params.id || "").trim();
  if (!gameId) {
    setFlash(req, "error", "Game selection is invalid.");
    return res.redirect("/admin/tournament");
  }

  const settings = parseSettings(tournament.settings_json);
  const games = Array.isArray(settings.games) ? settings.games : [];
  const nextGames = games.filter((game) => game.id !== gameId);
  if (nextGames.length === games.length) {
    setFlash(req, "error", "Game not found.");
    return res.redirect("/admin/tournament");
  }

  settings.games = nextGames;
  updateTournamentSettings(tournament.id, JSON.stringify(settings));
  deleteMatchesByStagePrefix(tournament.id, `${gameId}_`);
  deleteMatchesByStagePrefix(tournament.id, gameId);

  setFlash(req, "success", "Game deleted.");
  return res.redirect("/admin/tournament");
});

app.post("/admin/tournament/games/generate", requireAdmin, requireCsrf, (req, res) => {
  const tournament = getActiveTournament();
  if (!tournament || tournament.format !== "multi_game") {
    setFlash(req, "error", "Multi-game tournaments are required to generate brackets.");
    return res.redirect("/admin/tournament");
  }

  const settings = parseSettings(tournament.settings_json);
  const playInEnabled = req.body.play_in_enabled === "yes";
  const bracketType = (req.body.bracket_type || "single").trim();
  settings.play_in_enabled = playInEnabled;
  settings.bracket_type = bracketType;
  updateTournamentSettings(tournament.id, JSON.stringify(settings));
  const games = Array.isArray(settings.games) ? settings.games : [];
  if (games.length === 0) {
    setFlash(req, "error", "Add games before generating brackets.");
    return res.redirect("/admin/tournament");
  }

  const teams = getTeams();
  if (teams.length < 2) {
    setFlash(req, "error", "At least two teams are required.");
    return res.redirect("/admin/tournament");
  }

  const matches = listMatchesByTournament(tournament.id);
  const existingStages = new Set(matches.map((match) => match.stage));

  games.forEach((game) => {
    if (bracketType === "double") {
      if (!existingStages.has(`${game.id}_winners`)) {
        createDoubleElimMatches(tournament.id, teams, settings, game.id);
      }
    } else if (!existingStages.has(game.id)) {
      createSingleElimWithPlayIn(tournament.id, teams, settings, game.id);
    }
  });

  setFlash(req, "success", "Brackets generated.");
  return res.redirect("/admin/tournament");
});

app.post("/admin/tournament/:id/delete", requireAdmin, requireCsrf, (req, res) => {
  const tournamentId = Number(req.params.id);
  if (!Number.isFinite(tournamentId)) {
    setFlash(req, "error", "Invalid tournament selection.");
    return res.redirect("/admin/tournament");
  }

  const tournament = getTournamentById(tournamentId);
  if (!tournament) {
    setFlash(req, "error", "Tournament not found.");
    return res.redirect("/admin/tournament");
  }

  deleteTournamentById(tournamentId);
  setFlash(req, "success", "Tournament deleted.");
  return res.redirect("/admin/tournament");
});

app.post("/admin/tournament/generate", requireAdmin, requireCsrf, (req, res) => {
  const tournament = getActiveTournament();
  if (!tournament) {
    setFlash(req, "error", "Create a tournament first.");
    return res.redirect("/admin/tournament");
  }

  if (tournament.format === "multi_game") {
    setFlash(req, "error", "Use Generate game brackets for multi-game tournaments.");
    return res.redirect("/admin/tournament");
  }

  const matches = listMatchesByTournament(tournament.id);
  if (matches.length > 0) {
    setFlash(req, "error", "Matches already exist. Reset before generating again.");
    return res.redirect("/admin/tournament");
  }

  const teams = getTeams();
  if (teams.length < 2) {
    setFlash(req, "error", "At least two teams are required.");
    return res.redirect("/admin/tournament");
  }

  const settings = parseSettings(tournament.settings_json);

  if (tournament.format === "single_elim") {
    createSingleElimMatches(tournament.id, teams, settings, "main");
  } else if (tournament.format === "round_robin") {
    createRoundRobinMatches(tournament.id, teams, "main", null);
  } else if (tournament.format === "group_stage") {
    createGroupStageMatches(tournament.id, teams, settings);
  } else if (tournament.format === "swiss") {
    createSwissRoundMatches(tournament.id, teams, [], settings);
  } else if (tournament.format === "double_elim") {
    setFlash(req, "error", "Double elimination requires manual match creation for now.");
    return res.redirect("/admin/tournament");
  }

  setFlash(req, "success", "Matches generated.");
  return res.redirect("/admin/tournament");
});

app.post("/admin/tournament/next-round", requireAdmin, requireCsrf, (req, res) => {
  const tournament = getActiveTournament();
  if (!tournament || tournament.format !== "swiss") {
    setFlash(req, "error", "Swiss rounds are only available for Swiss tournaments.");
    return res.redirect("/admin/tournament");
  }

  const teams = getTeams();
  const matches = listMatchesByTournament(tournament.id);
  const settings = parseSettings(tournament.settings_json);
  const result = createSwissRoundMatches(tournament.id, teams, matches, settings);
  if (result.error) {
    setFlash(req, "error", result.error);
    return res.redirect("/admin/tournament");
  }

  setFlash(req, "success", "Swiss round generated.");
  return res.redirect("/admin/tournament");
});

app.post("/admin/tournament/advance", requireAdmin, requireCsrf, (req, res) => {
  const tournament = getActiveTournament();
  if (!tournament || tournament.format !== "group_stage") {
    setFlash(req, "error", "Group stage advancement is only for group tournaments.");
    return res.redirect("/admin/tournament");
  }

  const matches = listMatchesByTournament(tournament.id);
  const existingBracket = matches.some((match) => match.stage === "bracket");
  if (existingBracket) {
    setFlash(req, "error", "Bracket matches already exist.");
    return res.redirect("/admin/tournament");
  }

  const settings = parseSettings(tournament.settings_json);
  const advanceCount = Math.max(1, toInt(settings.advance_count, 2));
  const groups = {};

  matches
    .filter((match) => match.stage === "group" && match.group_name)
    .forEach((match) => {
      if (!groups[match.group_name]) {
        groups[match.group_name] = [];
      }
      groups[match.group_name].push(match);
    });

  const advancingTeams = [];
  Object.values(groups).forEach((groupMatches) => {
    const teamIds = new Set();
    groupMatches.forEach((match) => {
      if (match.team_a_id) {
        teamIds.add(match.team_a_id);
      }
      if (match.team_b_id) {
        teamIds.add(match.team_b_id);
      }
    });
    const standings = computeStandings(Array.from(teamIds), groupMatches);
    standings.slice(0, advanceCount).forEach((entry) => {
      advancingTeams.push(entry.teamId);
    });
  });

  if (advancingTeams.length < 2) {
    setFlash(req, "error", "Not enough teams to create a bracket.");
    return res.redirect("/admin/tournament");
  }

  const allTeams = getTeams();
  const bracketTeams = allTeams.filter((team) => advancingTeams.includes(team.id));
  createSingleElimMatches(tournament.id, bracketTeams, settings, "bracket");
  setFlash(req, "success", "Bracket created from group standings.");
  return res.redirect("/admin/tournament");
});

app.post("/admin/tournament/matches", requireAdmin, requireCsrf, (req, res) => {
  const tournament = getActiveTournament();
  if (!tournament) {
    setFlash(req, "error", "Create a tournament first.");
    return res.redirect("/admin/tournament");
  }

  const stage = (req.body.stage || "main").trim();
  const round = Math.max(1, toInt(req.body.round, 1));
  const matchNumber = Math.max(1, toInt(req.body.match_number, 1));
  const groupName = (req.body.group_name || "").trim() || null;
  const teamAId = req.body.team_a_id ? Number(req.body.team_a_id) : null;
  const teamBId = req.body.team_b_id ? Number(req.body.team_b_id) : null;

  createMatch({
    tournament_id: tournament.id,
    stage,
    round,
    match_number: matchNumber,
    group_name: groupName,
    team_a_id: teamAId,
    team_b_id: teamBId,
    status: "scheduled"
  });

  setFlash(req, "success", "Match added.");
  return res.redirect("/admin/tournament");
});

app.post("/admin/tournament/match/:id", requireAdmin, requireCsrf, (req, res) => {
  const tournament = getActiveTournament();
  if (!tournament) {
    setFlash(req, "error", "Create a tournament first.");
    return res.redirect("/admin/tournament");
  }

  const matchId = Number(req.params.id);
  const matches = listMatchesByTournament(tournament.id);
  const match = matches.find((item) => item.id === matchId);
  if (!match) {
    setFlash(req, "error", "Match not found.");
    return res.redirect("/admin/tournament");
  }

  const settings = parseSettings(tournament.settings_json);
  const scoreMode = settings.score_mode || "numeric";

  if (scoreMode === "winner_only") {
    const winnerTeamId = req.body.winner_team_id ? Number(req.body.winner_team_id) : null;
    updateMatchWinner(matchId, winnerTeamId, winnerTeamId ? "completed" : "scheduled");
    if (winnerTeamId) {
      setWinnerAndAdvance(tournament.id, matchId, winnerTeamId);
    }
    setFlash(req, "success", "Match updated.");
    return res.redirect("/admin/tournament");
  }

  const scoreA = req.body.score_a === "" ? null : toInt(req.body.score_a, null);
  const scoreB = req.body.score_b === "" ? null : toInt(req.body.score_b, null);
  const status = scoreA !== null && scoreB !== null ? "completed" : "scheduled";
  updateMatchScore(matchId, scoreA, scoreB, status);

  let winnerTeamId = null;
  if (scoreA !== null && scoreB !== null) {
    if (scoreA > scoreB) {
      winnerTeamId = match.team_a_id;
    } else if (scoreB > scoreA) {
      winnerTeamId = match.team_b_id;
    }
  }

  updateMatchWinner(matchId, winnerTeamId, status);
  if (winnerTeamId) {
    setWinnerAndAdvance(tournament.id, matchId, winnerTeamId);
  }

  setFlash(req, "success", "Match updated.");
  return res.redirect("/admin/tournament");
});

app.post("/admin/tournament/match/:id/winner", requireAdmin, requireCsrf, (req, res) => {
  const tournament = getActiveTournament();
  if (!tournament) {
    setFlash(req, "error", "Create a tournament first.");
    return res.redirect("/admin/tournament");
  }

  const gameId = (req.body.game_id || "").trim();
  const baseTarget = gameId ? `/admin/tournament?game=${encodeURIComponent(gameId)}` : "/admin/tournament";
  const redirectTarget = `${baseTarget}#bracket-control`;

  const matchId = Number(req.params.id);
  const matches = listMatchesByTournament(tournament.id);
  const match = matches.find((item) => item.id === matchId);
  if (!match) {
    setFlash(req, "error", "Match not found.");
    return res.redirect(redirectTarget);
  }

  const winnerRaw = (req.body.winner_team_id || "").trim();
  const winnerTeamId = winnerRaw ? Number(winnerRaw) : null;

  if (!winnerTeamId) {
    if (!match.winner_team_id) {
      setFlash(req, "error", "No winner to clear.");
      return res.redirect(redirectTarget);
    }

    const previousWinnerId = match.winner_team_id;
    const previousLoserId = previousWinnerId === match.team_a_id ? match.team_b_id : match.team_a_id;
    if (match.next_match_id) {
      const nextMatch = matches.find((item) => item.id === match.next_match_id);
      if (nextMatch && nextMatch.winner_team_id === previousWinnerId) {
        setFlash(req, "error", "Clear the next round winner first.");
        return res.redirect(redirectTarget);
      }

      if (nextMatch) {
        if (match.next_match_slot === "A" && nextMatch.team_a_id === previousWinnerId) {
          updateMatchTeams(nextMatch.id, null, nextMatch.team_b_id);
        } else if (match.next_match_slot === "B" && nextMatch.team_b_id === previousWinnerId) {
          updateMatchTeams(nextMatch.id, nextMatch.team_a_id, null);
        }
      }
    }

    if (match.loser_next_match_id && previousLoserId) {
      const loserNext = matches.find((item) => item.id === match.loser_next_match_id);
      if (loserNext && loserNext.winner_team_id === previousLoserId) {
        setFlash(req, "error", "Clear the next round loser winner first.");
        return res.redirect(redirectTarget);
      }
      if (loserNext) {
        if (match.loser_next_match_slot === "A" && loserNext.team_a_id === previousLoserId) {
          updateMatchTeams(loserNext.id, null, loserNext.team_b_id);
        } else if (match.loser_next_match_slot === "B" && loserNext.team_b_id === previousLoserId) {
          updateMatchTeams(loserNext.id, loserNext.team_a_id, null);
        }
      }
    }

    updateMatchWinner(matchId, null, "scheduled");
    setFlash(req, "success", "Winner cleared.");
    return res.redirect(redirectTarget);
  }

  if (winnerTeamId !== match.team_a_id && winnerTeamId !== match.team_b_id) {
    setFlash(req, "error", "Winner must be a team in this match.");
    return res.redirect(redirectTarget);
  }

  updateMatchWinner(matchId, winnerTeamId, "completed");
  setWinnerAndAdvance(tournament.id, matchId, winnerTeamId);
  setFlash(req, "success", "Winner set.");
  return res.redirect(redirectTarget);
});

app.post("/admin/tournament/match/:id/delete", requireAdmin, requireCsrf, (req, res) => {
  const tournament = getActiveTournament();
  if (!tournament) {
    setFlash(req, "error", "Create a tournament first.");
    return res.redirect("/admin/tournament");
  }

  const matchId = Number(req.params.id);
  const matches = listMatchesByTournament(tournament.id);
  const match = matches.find((item) => item.id === matchId);
  if (!match) {
    setFlash(req, "error", "Match not found.");
    return res.redirect("/admin/tournament");
  }

  deleteMatchById(matchId);
  setFlash(req, "success", "Match deleted.");
  return res.redirect("/admin/tournament");
});

app.listen(PORT, () => {
  console.log(`Beer Olympics server running on port ${PORT}`);
});
