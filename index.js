// imports
const express = require("express");
const session = require("express-session");
const knex = require("knex")({
  client: "pg",
  connection: {
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "12345",
    database: process.env.DB_NAME || "intex",
    port: process.env.DB_PORT || "5432"
  }
});

const app = express();
const PORT = process.env.PORT || 3000;

// middlewares
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));
app.set("view engine", "ejs");
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'fallback-secret-key',
    resave: false,
    saveUninitialized: false,
  })
);

app.get("/", (req, res) => {
  res.render("index");
});

// -------------------------
// AUTH ROUTES
// -------------------------
app.get("/login", (req, res) => {
  const context = req.query.context || "enroll";
  res.render("login", { error_message: "", context });
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const users = await knex("users")
      .select("username", "password", "level", "preferred_language")
      .where({ username, password });

    if (users.length === 0) {
      return res.render("login", { error_message: "Invalid login", context: "enroll" });
    }

    const user = users[0];
    req.session.isLoggedIn = true;
    req.session.user = {
      username: user.username,
      level: user.level,
      preferred_language: user.preferred_language
    };

    res.redirect("/");
  } catch (err) {
    console.error("Login error:", err);
    res.render("login", { error_message: "Invalid login", context: "enroll" });
  }
});

// logout
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
});

// -------------------------
// CREATE ACCOUNT
// -------------------------
app.get("/addUser", (req, res) => {
  const context = req.query.context || "enroll"; // enroll/volunteer
  res.render("createAccount", { context });
});

app.post("/addUser", async (req, res) => {
  try {
    const { username, password, preferred_language } = req.body;
    await knex("users").insert({ username, password, preferred_language });
    res.redirect("/login");
  } catch (err) {
    console.error(err);
    res.send("Error creating account.");
  }
});

// -------------------------
// EVENTS ROUTES
// -------------------------
app.get("/events/register", async (req, res) => {
  const user = req.session.user || null;

  // fetch all events
  const allEvents = await knex("events").select("*");

  let pastEvents = [];
  let upcomingRegistered = [];
  let availableEvents = [];

  const registrations = user ? await knex("event_registrations").where({ user_id: user.id }) : [];

  const today = new Date();

  allEvents.forEach(event => {
    const reg = registrations.find(r => r.event_id === event.id);
    const eventDate = new Date(event.date);

    if (eventDate < today && !reg?.survey_completed) pastEvents.push({ ...event, surveyCompleted: reg?.survey_completed || false });
    else if (reg) upcomingRegistered.push(event);
    else availableEvents.push(event);
  });

  res.render("events/register", {
    user,
    pastItems: pastEvents,
    upcomingRegistered,
    availableItems: availableEvents,
    type: "Events",
    type_es: "Eventos",
    title: "Register for Events",
    title_es: "Registro de Eventos"
  });
});

// -------------------------
// PROGRAMS ROUTES
// -------------------------
function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

app.get("/programs/register", async (req, res) => {
  const user = req.session.user || null;

  // fetch all programs
  const allPrograms = await knex("programs").select("*");
  let enrollments = user ? await knex("program_enrollments").where({ user_id: user.id }) : [];

  let pastPrograms = [];
  let currentPrograms = [];
  let availablePrograms = [];

  const today = new Date();

  enrollments.forEach(e => {
    const program = allPrograms.find(p => p.id === e.program_id);
    if (!program) return;
    const endDate = addMonths(new Date(e.start_date), program.duration_months);

    if (endDate < today && !e.survey_completed) pastPrograms.push({ ...e, program });
    else if (endDate >= today) currentPrograms.push({ ...e, program });
  });

  availablePrograms = allPrograms.filter(p => !enrollments.some(e => e.program_id === p.id));

  // sort carousel by user language
  const preferredLang = user?.preferred_language || "en";
  const sortedPrograms = preferredLang === "es"
    ? [...availablePrograms].sort((a, b) => a.es_priority - b.es_priority)
    : [...availablePrograms].sort((a, b) => a.en_priority - b.en_priority);

  res.render("programs/register", {
    user,
    pastPrograms,
    currentPrograms,
    sortedPrograms
  });
});

// -------------------------
// SERVER START
// -------------------------
app.listen(PORT, () => console.log("Website started"));