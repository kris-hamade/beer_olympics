const path = require("path");
const Database = require("better-sqlite3");

const dbPath = path.join(__dirname, "beer_olympics.sqlite");
const db = new Database(dbPath);

let insertTeamStmt;
let getTeamsStmt;
let getUsedCountryCodesStmt;
let getTeamByIdStmt;
let getTeamByCountryCodeStmt;
let updateTeamStmt;
let deleteTeamStmt;

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

module.exports = {
  initDb,
  insertTeam,
  getTeams,
  getUsedCountryCodes,
  getTeamById,
  getTeamByCountryCode,
  updateTeam,
  deleteTeam
};
