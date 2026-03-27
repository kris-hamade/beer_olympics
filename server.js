const path = require("path");
const express = require("express");
const session = require("express-session");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const dotenv = require("dotenv");
const {
  initDb,
  insertTeam,
  getTeams,
  getUsedCountryCodes,
  getTeamById,
  getTeamByCountryCode,
  updateTeam,
  deleteTeam
} = require("./db");
const countries = require("./countries");

dotenv.config();

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

app.listen(PORT, () => {
  console.log(`Beer Olympics server running on port ${PORT}`);
});
