// imports
const express = require("express");
const session = require("express-session");
const knex = require("knex")({
  client: "pg",
  connection: {
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "12345",
    database: process.env.DB_NAME || "ellarises",
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

// helper functions
function requireLogin(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect("/login?error=Please+log+in+first");
  }
  next();
}

function requireManager(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect("/login?error=Please+log+in+first");
  }

  if (req.session.user.level !== "M") {
    return res.status(403).render("login", {
      error_message: "Please log in to access this page"
    });
    // OR: res.redirect("/") if you prefer silent redirect
  }

  next();
}
// -------------------------

app.use((req, res, next) => {
  res.locals.lang = req.session.language || "en";
  res.locals.user = req.session.user || null;
  next();
});

app.get("/set-lang/:lang", (req, res) => {
  const lang = req.params.lang;
  req.session.language = lang;
  const backURL = req.header("Referer") || "/"; //Finds the page the button was clicked on
  res.redirect(backURL);  // go back to the previous page
});

app.get("/", (req, res) => {
  res.render("index", { title: "Ella Rises" });
});

// -------------------------
// AUTH ROUTES
// -------------------------
app.get("/login", (req, res) => {
  const context = req.query.context || "enroll";
  res.render("login", { error_message: "", context });
});

app.post("/login", async (req, res) => {
  try {
    const sName = req.body.username;
    const sPassword = req.body.password;

    // Step 1: Validate user login
    const users = await knex("logins")
      .select("userid", "username", "password", "level")
      .where("username", sName)
      .andWhere("password", sPassword);
    
    if (users.length === 0) {
      return res.render("login", { error_message: "Invalid login" });
    }

    const user = users[0];
    let fullName = "";

    // Step 2: Get full name based on level
    if (user.level === "M") {
      const mgr = await knex("managers")
        .select("managerfirstname", "managerlastname")
        .where("userid", user.userid)
        .first();

      if (mgr) {
        fullName = `${mgr.managerfirstname} ${mgr.managerlastname}`;
      }

    } else {
      const parent = await knex("parents")
        .select("parentfirstname", "parentlastname")
        .where("userid", user.userid)
        .first();

      if (parent) {
        fullName = `${parent.parentfirstname} ${parent.parentlastname}`;
      }
    }

    // Step 3: Save user in session
    req.session.isLoggedIn = true;
    req.session.user = {
      username: user.username,
      level: user.level,
      name: fullName
    };

    // Step 4: Redirect home
    res.redirect("/");

  } catch (err) {
    console.error("Login error:", err);
    res.render("login", { error_message: "Invalid login" });
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
app.get("/events/register",requireLogin, async (req, res) => {
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

app.get("/programs/register",requireLogin, async (req, res) => {
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

// Admin dashboard
app.get("/admin/dashboard",requireManager, async (req, res) => {
    const upcomingItems = await knex("eventoccurrences as eo")
    .join("events as e", "eo.eventid", "e.eventid")
    .select(
      "eo.eventoccurrenceid",
      "e.eventname",
      "e.eventtype",
      "eo.eventdatestart",
      "eo.eventtimestart",
      "eo.eventlocation"
    )
    .where("eo.eventdatestart", ">=", knex.fn.now())
    .orderBy("eo.eventdatestart");

    res.render("admin/dashboard", { upcomingItems, title: "Admin Dashboard" });
});

app.get("/admin/manageusers",requireManager, async (req, res) => {
  try {
    // Get all managers
    const managers = await knex("managers")
      .select("userid", "managerfirstname", "managerlastname")
      .orderBy("managerlastname");

    // Get all parents
    const parents = await knex("parents")
      .select(
        "userid",
        "parentid",
        "parentfirstname",
        "parentlastname",
        "parentemail",
        "preferredlanguage"
      )
      .orderBy("parentlastname");

    // Get participants and link by parentid
    const participants = await knex("participants")
      .select(
        "participantid",
        "participantfirstname",
        "participantlastname",
        "participantemail",
        "participantdob",
        "participantphone",
        "participantcity",
        "participantstate",
        "participantfieldofinterest",
        "parentid"
      );

    // Attach children to each parent
    parents.forEach(parent => {
      parent.children = participants.filter(p => p.parentid === parent.parentid);
    });

    res.render("admin/manageusers", {
      title: "Manage Users",
      managers,
      parents,
      error_message: ""
    });

  } catch (err) {
    console.error("Manage Users Error:", err);

    res.render("admin/manageusers", {
      title: "Manage Users",
      managers: [],
      parents: [],
      error_message: "Database error: " + err.message
    });
  }
});

app.get("/admin/add-event", requireManager, (req, res) => {
  res.render("admin/addEvent", { title: "Add Event", error_message: "" });
});

app.get("/pages/donations", (req, res) => {
  res.render("donations", { user: req.session.user });
});

app.post("/pages/donations", (req, res) => {
  const { name, email, amount, customAmount, message } = req.body;

  const finalAmount = customAmount && customAmount > 0 ? customAmount : amount;

  if (!finalAmount) {
    return res.render("donations", {
      error_message: "Please select or enter a donation amount.",
      user: req.session.user
    });
  }

  // TODO: send to Stripe, PayPal, email, insert into DB, etc.

  res.render("donations", {
    success_message: `Thank you for your donation of $${finalAmount}!`,
    user: req.session.user
  });
});

app.get("/admin/donations",requireManager, (req, res) => {
  res.render("admin/donations", { title: "View Donations" });
});

// Add event page
app.get("/admin/add-event",requireManager, (req, res) => {
    res.render("admin/addevent");
});

// -------------------------
// SERVER START
// -------------------------
app.listen(PORT, () => console.log("Website started"));