const path = require("path");
const Database = require("better-sqlite3");

const dbPath = process.env.DB_PATH || path.join("/app/data", "beer_olympics.sqlite");
const db = new Database(dbPath);

let insertTeamStmt;
let getTeamsStmt;
let getUsedCountryCodesStmt;
let getTeamByIdStmt;
let getTeamByCountryCodeStmt;
let updateTeamStmt;
let deleteTeamStmt;
let createTournamentStmt;
let deactivateTournamentsStmt;
let getActiveTournamentStmt;
let getTournamentByIdStmt;
let listTournamentsStmt;
let updateTournamentSettingsStmt;
let createMatchStmt;
let listMatchesByTournamentStmt;
let deleteMatchesByTournamentStmt;
let deleteMatchByIdStmt;
let deleteTournamentByIdStmt;
let clearNextMatchLinksStmt;
let clearLoserMatchLinksStmt;
let updateMatchScoreStmt;
let updateMatchWinnerStmt;
let updateMatchTeamsStmt;
let updateMatchLinksStmt;

function initDb() {
  // Schema enforces unique team names and country assignments.
  db.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_name TEXT NOT NULL UNIQUE,
      player1_name TEXT NOT NULL,
      player2_name TEXT NOT NULL,
      country_code TEXT NOT NULL UNIQUE,
      country_name TEXT NOT NULL,
      country_flag TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS tournaments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      format TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'setup',
      settings_json TEXT NOT NULL DEFAULT '{}',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id INTEGER NOT NULL,
      stage TEXT NOT NULL DEFAULT 'main',
      round INTEGER NOT NULL,
      match_number INTEGER NOT NULL,
      group_name TEXT,
      team_a_id INTEGER,
      team_b_id INTEGER,
      score_a INTEGER,
      score_b INTEGER,
      winner_team_id INTEGER,
      status TEXT NOT NULL DEFAULT 'scheduled',
      next_match_id INTEGER,
      next_match_slot TEXT,
      loser_next_match_id INTEGER,
      loser_next_match_slot TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (tournament_id) REFERENCES tournaments(id)
    )
  `);

  if (!insertTeamStmt) {
    insertTeamStmt = db.prepare(
      "INSERT INTO teams (team_name, player1_name, player2_name, country_code, country_name, country_flag) VALUES (?, ?, ?, ?, ?, ?)"
    );
    getTeamsStmt = db.prepare(
      "SELECT id, team_name, player1_name, player2_name, country_code, country_name, country_flag, created_at FROM teams ORDER BY country_name ASC, team_name ASC"
    );
    getUsedCountryCodesStmt = db.prepare("SELECT country_code FROM teams");
    getTeamByIdStmt = db.prepare(
      "SELECT id, team_name, player1_name, player2_name, country_code, country_name, country_flag, created_at FROM teams WHERE id = ?"
    );
    getTeamByCountryCodeStmt = db.prepare(
      "SELECT id FROM teams WHERE country_code = ?"
    );
    updateTeamStmt = db.prepare(
      "UPDATE teams SET team_name = ?, player1_name = ?, player2_name = ?, country_code = ?, country_name = ?, country_flag = ? WHERE id = ?"
    );
    deleteTeamStmt = db.prepare("DELETE FROM teams WHERE id = ?");

    deactivateTournamentsStmt = db.prepare("UPDATE tournaments SET is_active = 0");
    createTournamentStmt = db.prepare(
      "INSERT INTO tournaments (name, format, status, settings_json, is_active) VALUES (?, ?, ?, ?, 1)"
    );
    getActiveTournamentStmt = db.prepare(
      "SELECT id, name, format, status, settings_json, is_active, created_at FROM tournaments WHERE is_active = 1 ORDER BY id DESC LIMIT 1"
    );
    getTournamentByIdStmt = db.prepare(
      "SELECT id, name, format, status, settings_json, is_active, created_at FROM tournaments WHERE id = ?"
    );
    listTournamentsStmt = db.prepare(
      "SELECT id, name, format, status, settings_json, is_active, created_at FROM tournaments ORDER BY id DESC"
    );
    updateTournamentSettingsStmt = db.prepare(
      "UPDATE tournaments SET settings_json = ? WHERE id = ?"
    );
    createMatchStmt = db.prepare(
      "INSERT INTO matches (tournament_id, stage, round, match_number, group_name, team_a_id, team_b_id, score_a, score_b, winner_team_id, status, next_match_id, next_match_slot, loser_next_match_id, loser_next_match_slot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    listMatchesByTournamentStmt = db.prepare(
      "SELECT m.id, m.tournament_id, m.stage, m.round, m.match_number, m.group_name, m.team_a_id, m.team_b_id, m.score_a, m.score_b, m.winner_team_id, m.status, m.next_match_id, m.next_match_slot, m.loser_next_match_id, m.loser_next_match_slot, m.created_at, " +
        "ta.team_name AS team_a_name, ta.country_name AS team_a_country, " +
        "tb.team_name AS team_b_name, tb.country_name AS team_b_country, " +
        "tw.team_name AS winner_name " +
      "FROM matches m " +
      "LEFT JOIN teams ta ON m.team_a_id = ta.id " +
      "LEFT JOIN teams tb ON m.team_b_id = tb.id " +
      "LEFT JOIN teams tw ON m.winner_team_id = tw.id " +
      "WHERE m.tournament_id = ? " +
      "ORDER BY m.stage ASC, m.group_name ASC, m.round ASC, m.match_number ASC"
    );
    deleteMatchesByTournamentStmt = db.prepare("DELETE FROM matches WHERE tournament_id = ?");
    deleteMatchByIdStmt = db.prepare("DELETE FROM matches WHERE id = ?");
    deleteTournamentByIdStmt = db.prepare("DELETE FROM tournaments WHERE id = ?");
    clearNextMatchLinksStmt = db.prepare(
      "UPDATE matches SET next_match_id = NULL, next_match_slot = NULL WHERE next_match_id = ?"
    );
    clearLoserMatchLinksStmt = db.prepare(
      "UPDATE matches SET loser_next_match_id = NULL, loser_next_match_slot = NULL WHERE loser_next_match_id = ?"
    );
    updateMatchScoreStmt = db.prepare(
      "UPDATE matches SET score_a = ?, score_b = ?, status = ? WHERE id = ?"
    );
    updateMatchWinnerStmt = db.prepare(
      "UPDATE matches SET winner_team_id = ?, status = ? WHERE id = ?"
    );
    updateMatchTeamsStmt = db.prepare(
      "UPDATE matches SET team_a_id = ?, team_b_id = ? WHERE id = ?"
    );
    updateMatchLinksStmt = db.prepare(
      "UPDATE matches SET next_match_id = ?, next_match_slot = ?, loser_next_match_id = ?, loser_next_match_slot = ? WHERE id = ?"
    );
  }
}

function insertTeam(team) {
  return insertTeamStmt.run(
    team.team_name,
    team.player1_name,
    team.player2_name,
    team.country_code,
    team.country_name,
    team.country_flag
  );
}

function getTeams() {
  return getTeamsStmt.all();
}

function getUsedCountryCodes() {
  return getUsedCountryCodesStmt.all().map((row) => row.country_code);
}

function getTeamById(id) {
  return getTeamByIdStmt.get(id);
}

function getTeamByCountryCode(countryCode) {
  return getTeamByCountryCodeStmt.get(countryCode);
}

function updateTeam(id, team) {
  return updateTeamStmt.run(
    team.team_name,
    team.player1_name,
    team.player2_name,
    team.country_code,
    team.country_name,
    team.country_flag,
    id
  );
}

function deleteTeam(id) {
  return deleteTeamStmt.run(id);
}

function createTournament(name, format, status, settingsJson) {
  const create = db.transaction(() => {
    deactivateTournamentsStmt.run();
    return createTournamentStmt.run(name, format, status, settingsJson);
  });

  return create();
}

function getActiveTournament() {
  return getActiveTournamentStmt.get();
}

function getTournamentById(id) {
  return getTournamentByIdStmt.get(id);
}

function listTournaments() {
  return listTournamentsStmt.all();
}

function updateTournamentSettings(tournamentId, settingsJson) {
  return updateTournamentSettingsStmt.run(settingsJson, tournamentId);
}

function createMatch(match) {
  return createMatchStmt.run(
    match.tournament_id,
    match.stage,
    match.round,
    match.match_number,
    match.group_name || null,
    match.team_a_id || null,
    match.team_b_id || null,
    match.score_a ?? null,
    match.score_b ?? null,
    match.winner_team_id || null,
    match.status || "scheduled",
    match.next_match_id || null,
    match.next_match_slot || null,
    match.loser_next_match_id || null,
    match.loser_next_match_slot || null
  );
}

function listMatchesByTournament(tournamentId) {
  return listMatchesByTournamentStmt.all(tournamentId);
}

function deleteMatchesByTournament(tournamentId) {
  return deleteMatchesByTournamentStmt.run(tournamentId);
}

function deleteMatchById(matchId) {
  const remove = db.transaction(() => {
    clearNextMatchLinksStmt.run(matchId);
    clearLoserMatchLinksStmt.run(matchId);
    return deleteMatchByIdStmt.run(matchId);
  });

  return remove();
}

function deleteTournamentById(tournamentId) {
  const remove = db.transaction(() => {
    deleteMatchesByTournamentStmt.run(tournamentId);
    return deleteTournamentByIdStmt.run(tournamentId);
  });

  return remove();
}

function updateMatchScore(matchId, scoreA, scoreB, status) {
  return updateMatchScoreStmt.run(scoreA, scoreB, status, matchId);
}

function updateMatchWinner(matchId, winnerTeamId, status) {
  return updateMatchWinnerStmt.run(winnerTeamId, status, matchId);
}

function updateMatchTeams(matchId, teamAId, teamBId) {
  return updateMatchTeamsStmt.run(teamAId || null, teamBId || null, matchId);
}

function updateMatchLinks(matchId, nextMatchId, nextMatchSlot, loserNextMatchId, loserNextMatchSlot) {
  return updateMatchLinksStmt.run(
    nextMatchId || null,
    nextMatchSlot || null,
    loserNextMatchId || null,
    loserNextMatchSlot || null,
    matchId
  );
}

module.exports = {
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
};
