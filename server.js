const path = require("path");
const express = require("express");
const session = require("express-session");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const dotenv = require("dotenv");
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

initDb();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));

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
  req.session.flash = null;
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

function createSingleElimMatches(tournamentId, teams, settings, stage) {
  const seededTeams = seedTeams(teams, settings.seeding);
  const bracketSize = nextPowerOfTwo(seededTeams.length);
  const rounds = Math.log2(bracketSize);
  const slots = [...seededTeams, ...Array(bracketSize - seededTeams.length).fill(null)];
  const matchMap = [];
  const matches = [];
  const stageLabel = stage || "main";

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
    if (match.team_a_id && !match.team_b_id) {
      applyWinner(match, match.team_a_id);
    } else if (!match.team_a_id && match.team_b_id) {
      applyWinner(match, match.team_b_id);
    }
  });
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
    return res.redirect("/register");
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
  return res.redirect("/register");
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

  const perGameScoreboards = games.map((game) => {
    const stageWins = winsByGame[game.id] || new Map();
    const rows = teams.map((team) => ({
      team,
      wins: stageWins.get(team.id) || 0
    }))
      .filter((row) => row.wins > 0)
      .sort((a, b) => b.wins - a.wins);

    const maxRound = maxRoundByGame[game.id] || 0;
    const finalMatch = matches.find(
      (match) => match.stage === game.id && match.round === maxRound
    );
    const champion = finalMatch && finalMatch.winner_team_id ? teamById.get(finalMatch.winner_team_id) : null;

    return {
      id: game.id,
      name: game.name,
      rows,
      champion
    };
  });

  const totalScoreboard = teams.map((team) => ({
    team,
    wins: totalWinsMap.get(team.id) || 0
  }))
    .filter((row) => row.wins > 0)
    .sort((a, b) => b.wins - a.wins);

  res.render("admin_tournament", {
    title: "Tournament Control",
    tournament,
    settings,
    matches,
    tournaments,
    teams,
    games,
    perGameScoreboards,
    totalScoreboard
  });
});

app.post("/admin/tournament/create", requireAdmin, requireCsrf, (req, res) => {
  const name = (req.body.name || "").trim();
  const format = (req.body.format || "").trim();
  const seeding = (req.body.seeding || "registration").trim();
  const scoreMode = (req.body.score_mode || "numeric").trim();
  const groupCount = toInt(req.body.group_count, 2);
  const advanceCount = toInt(req.body.advance_count, 2);
  const swissRounds = toInt(req.body.swiss_rounds, 3);

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

app.post("/admin/tournament/games/generate", requireAdmin, requireCsrf, (req, res) => {
  const tournament = getActiveTournament();
  if (!tournament || tournament.format !== "multi_game") {
    setFlash(req, "error", "Multi-game tournaments are required to generate brackets.");
    return res.redirect("/admin/tournament");
  }

  const settings = parseSettings(tournament.settings_json);
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
    if (!existingStages.has(game.id)) {
      createSingleElimMatches(tournament.id, teams, settings, game.id);
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
