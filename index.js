// imports
const express = require("express");
const session = require("express-session");
const knex = require("knex")({
  client: "pg",
  connection: {
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "admin",
    database: process.env.DB_NAME || "ellarises",
    port: process.env.DB_PORT || "5432"
  }
});

const app = express();
const PORT = process.env.PORT || 3000;
const nodemailer = require("nodemailer");

// Configure your SMTP transporter (example with Gmail)
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

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
  }

  next();
}
// -------------------------

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

app.get("/", async (req, res) => {
  try {
    // Grab flash message if any
    const flashMessage = req.session.flashMessage || null;
    req.session.flashMessage = null; // Clear after displaying

    // Get today's date
    const today = new Date().toISOString().split("T")[0];

    // Query upcoming events
    const upcomingEvents = await knex("events as e")
      .join("eventoccurrences as eo", "e.eventid", "eo.eventid")
      .select(
        "e.eventid",
        "e.eventname",
        "e.eventdescription",
        "eo.eventdatestart",
        "eo.eventtimestart",
        "eo.eventdateend",
        "eo.eventtimeend",
        "eo.eventlocation",
        "eo.eventcapacity"
      )
      .where("eo.eventdateend", ">=", today)
      .orderBy("eo.eventdatestart", "asc")
      .limit(1); // Only get the next upcoming event

    res.render("index", {
      title: "Ella Rises",
      upcomingEvents,
      flashMessage,   // Pass flashMessage to EJS
    });
  } catch (err) {
    console.error("Error fetching upcoming events:", err);
    res.render("index", {
      title: "Ella Rises",
      upcomingEvents: [],
      flashMessage: null
    });
  }
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

    const users = await knex("logins")
      .select("userid", "username", "password", "level")
      .where("username", sName)
      .andWhere("password", sPassword);
    
    if (users.length === 0) {
      return res.render("login", { error_message: "Invalid login" });
    }

    const user = users[0];
    let fullName = "";

    if (user.level === "M") {
      const mgr = await knex("managers")
        .select("managerfirstname", "managerlastname")
        .where("userid", user.userid)
        .first();

      if (mgr) fullName = `${mgr.managerfirstname} ${mgr.managerlastname}`;
    } else {
      const parent = await knex("parents")
        .select("parentfirstname", "parentlastname")
        .where("userid", user.userid)
        .first();

      if (parent) fullName = `${parent.parentfirstname} ${parent.parentlastname}`;
    }

    req.session.isLoggedIn = true;
    req.session.user = {
      username: user.username,
      level: user.level,
      name: fullName,
      userid: user.userid
    };

    res.redirect("/");

  } catch (err) {
    console.error("Login error:", err);
    res.render("login", { error_message: "Invalid login" });
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
});

app.get("/account", requireLogin, async (req, res) => {
  try {
    const user = req.session.user;

    // Get parent info
    const parent = await knex("parents")
      .select("*")
      .where({ userid: user.userid })
      .first();

    if (!parent) {
      return res.status(404).send("Parent not found");
    }

    // Get participants
    const participants = await knex("participants")
      .select("*")
      .where({ parentid: parent.parentid });

    // Get milestones for each participant
    for (let p of participants) {
      const milestones = await knex("milestones")
        .select(
          "milestonetitle as title",
          "milestonedate as date",
          "milestonestatus"
        )
        .where({ participantemail: p.participantemail })
        .orderBy("milestonedate", "asc");
      p.milestones = milestones;

      // Map participant columns for EJS
      p.participantID = p.participantid;
      p.participantDOB = p.participantdob;
      p.participantgrade = p.participantgrade;
      p.participantfieldofinterest = p.participantfieldofinterest;
    }

    // Attach participants to parent
    parent.participants = participants;

    res.render("pages/account", { parent, user, lang: req.session.lang || "en" });

  } catch (err) {
    console.error("Error loading account page:", err);
    res.status(500).send("Error loading account page");
  }
});

// Add Participant
app.get("/account/participant/add", requireLogin, (req, res) => {
  res.render("pages/add-child", { user: req.session.user });
});

app.post("/account/participant/add", requireLogin, async (req, res) => {
  const parentUser = req.session.user;
  const { firstname, lastname, dob, grade, participantfieldofinterest, participantemail, participantcity } = req.body;

  try {
    await knex('participants').insert({
      parentid: parentUser.userid,
      participantfirstname: firstname,
      participantlastname: lastname,
      participantdob: dob || null,
      participantgrade: grade || null,
      participantfieldofinterest: participantfieldofinterest || null,
      participantemail: participantemail || null,
      participantcity: participantcity || null
    });

    res.redirect("/pages/account");
  } catch (err) {
    console.error("Error adding child:", err);
    res.status(500).send("Error adding child");
  }
});

// Register Participant for Event - GET
app.get("/pages/participant/:participantId/register-event", requireLogin, async (req, res) => {
  const participantId = req.params.participantId;

  try {
    const participant = await knex('participants').where({ participantid: participantId }).first();
    const participantEmail = participant.participantemail;

    // All event occurrences with event info
    const allOccurrences = await knex('eventoccurrences as eo')
      .join('events as e', 'eo.eventid', 'e.eventid')
      .select('eo.eventoccurrenceid', 'eo.eventdatestart', 'eo.eventtimestart', 'eo.eventlocation', 'e.eventname');

    // Registrations for this participant
    const registeredRows = await knex('registrations').where({ participantemail: participantEmail });
    const registeredIds = registeredRows.map(r => r.eventoccurrenceid);

    const availableOccurrences = allOccurrences.filter(eo => !registeredIds.includes(eo.eventoccurrenceid));

    res.render("pages/register-event", {
      participantId,
      availableOccurrences,
      user: req.session.user
    });
  } catch (err) {
    console.error("Error fetching event occurrences:", err);
    res.status(500).send("Error fetching events");
  }
});

// Register Participant for Event - POST
app.post("/pages/participant/:participantId/register-event", requireLogin, async (req, res) => {
  const participantId = req.params.participantId;
  const { eventoccurrenceid } = req.body;

  try {
    const participant = await knex('participants').where({ participantid: participantId }).first();
    const participantEmail = participant.participantemail;

    const exists = await knex('registrations')
      .where({ participantemail: participantEmail, eventoccurrenceid })
      .first();

    if (!exists) {
      await knex('registrations').insert({
        participantemail: participantEmail,
        eventoccurrenceid,
        createdat: knex.fn.now()
      });
    }

    res.redirect("/pages/account");
  } catch (err) {
    console.error("Error registering for event:", err);
    res.status(500).send("Error registering for event");
  }
});

// Delete Milestone
app.post("/account/milestone/:milestoneId/delete", requireLogin, async (req, res) => {
  const milestoneId = req.params.milestoneId;

  try {
    await knex('milestones').where({ milestoneid: milestoneId }).del();
    res.redirect("/pages/account");
  } catch (err) {
    console.error("Error deleting milestone:", err);
    res.status(500).send("Error deleting milestone");
  }
});

// Update Milestone
app.post("/account/milestone/:milestoneId/update", requireLogin, async (req, res) => {
  const milestoneId = req.params.milestoneId;
  const { milestonestatus } = req.body;

  try {
    await knex('milestones')
      .where({ milestoneid: milestoneId })
      .update({ milestonestatus });
    res.redirect("/pages/account");
  } catch (err) {
    console.error("Error updating milestone:", err);
    res.status(500).send("Error updating milestone");
  }
});

// Update Participant Status
app.post("/account/child/:childId/update", requireLogin, async (req, res) => {
  const childId = req.params.childId;
  const { fieldofinterest, graduationstatus } = req.body;

  try {
    await knex('participants')
      .where({ participantid: childId })
      .update({
        participantfieldofinterest: fieldofinterest,
        participantgraduationstatus: graduationstatus
      });

    res.redirect("/pages/account");
  } catch (err) {
    console.error("Error updating child progress:", err);
    res.status(500).send("Error updating progress");
  }
});

// -------------------------
// CREATE ACCOUNT
// -------------------------
app.get("/addUser", (req, res) => {
  const context = req.query.context || "enroll"; 
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
// DONATION ROUTES
// -------------------------
app.get("/pages/donations", (req, res) => {
  res.render("pages/donations", {
    title: "Donations",
    error_message: "",
    success_message: "",
    user: req.session.user
  }); 
});

app.post("/pages/donations", async (req, res) => {
  const { name, email, amount, customAmount, message } = req.body;

  let finalAmount;
  if (amount === "custom") finalAmount = Number(customAmount);
  else finalAmount = Number(amount);

  if (!finalAmount || finalAmount <= 0) {
    return res.render("pages/donations", {
      title: "Donations",
      error_message: "Please select or enter a valid donation amount.",
      success_message: "",
      user: req.session.user
    });
  }

  try {
    const today = new Date();
    const donationDate = today.toISOString().split('T')[0]; // "YYYY-MM-DD"

    await knex("donations").insert({
      donorname: name || null,
      donoremail: email,
      message: message || null,
      donationdate: donationDate,
      amount: finalAmount
    });

    return res.render("pages/donations", {
      title: "Donations",
      error_message: "",
      success_message: `Thank you for your donation of $${finalAmount}!`,
      user: req.session.user
    });

  } catch (err) {
    console.error(err);

    return res.render("pages/donations", {
      title: "Donations",
      error_message: "There was an error processing your donation.",
      success_message: "",
      user: req.session.user
    });
  }
});

// -------------------------
// EVENTS ROUTES
// -------------------------
app.get("/events/register",requireLogin, async (req, res) => {
  const user = req.session.user || null;
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

app.get("/pages/getinvolved", (req, res) => {
  res.render("pages/getinvolved", { title: "Get Involved", user: req.session.user });
});

// Dummy Press Route
app.get("/press", (req, res) => {
  res.status(418).render("pages/press", { title: "Press", message: "This page would be like the current page from ellarises.org." });
});

// Dummy Contact Route
app.get("/contact", (req, res) => {
  res.status(200).send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Contact Us</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          text-align: center;
          padding: 50px;
        }

        .flash-message {
          font-size: 48px;       /* large message */
          font-weight: bold;
          color: #d9534f;
          margin-bottom: 20px;
        }

        .countdown {
          font-size: 24px;
          color: #555;
        }
      </style>
    </head>
    <body>
      <div class="flash-message">Coming Soon</div>
      <div class="countdown">This will be similar to current ellarises.org contact us page. Redirecting in <span id="seconds">10</span> seconds...</div>

      <script>
        let seconds = 10;
        const countdownEl = document.getElementById('seconds');

        const interval = setInterval(() => {
          seconds--;
          countdownEl.textContent = seconds;
          if (seconds <= 0) {
            clearInterval(interval);
            window.location.href = '/';
          }
        }, 1000);
      </script>
    </body>
    </html>
  `);
});

// Dummy team Route
app.get("/team", (req, res) => {
  res.status(200).send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Team</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          text-align: center;
          padding: 50px;
        }

        .flash-message {
          font-size: 48px;       /* large message */
          font-weight: bold;
          color: #d9534f;
          margin-bottom: 20px;
        }

        .countdown {
          font-size: 24px;
          color: #555;
        }
      </style>
    </head>
    <body>
      <div class="flash-message">Coming Soon</div>
      <div class="countdown">This will be similar to current ellarises.org version of the page. Redirecting in <span id="seconds">10</span> seconds...</div>

      <script>
        let seconds = 10;
        const countdownEl = document.getElementById('seconds');

        const interval = setInterval(() => {
          seconds--;
          countdownEl.textContent = seconds;
          if (seconds <= 0) {
            clearInterval(interval);
            window.location.href = '/';
          }
        }, 1000);
      </script>
    </body>
    </html>
  `);
});

// Dummy Board Route
app.get("/board", (req, res) => {
  res.status(200).send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Board of Directors</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          text-align: center;
          padding: 50px;
        }

        .flash-message {
          font-size: 48px;       /* large message */
          font-weight: bold;
          color: #d9534f;
          margin-bottom: 20px;
        }

        .countdown {
          font-size: 24px;
          color: #555;
        }
      </style>
    </head>
    <body>
      <div class="flash-message">Coming Soon</div>
      <div class="countdown">This will be similar to current ellarises.org version of the page. Redirecting in <span id="seconds">10</span> seconds...</div>

      <script>
        let seconds = 10;
        const countdownEl = document.getElementById('seconds');

        const interval = setInterval(() => {
          seconds--;
          countdownEl.textContent = seconds;
          if (seconds <= 0) {
            clearInterval(interval);
            window.location.href = '/';
          }
        }, 1000);
      </script>
    </body>
    </html>
  `);
});

// Dummy <Mission> Route
app.get("/mission", (req, res) => {
  res.status(200).send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Mission</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          text-align: center;
          padding: 50px;
        }

        .flash-message {
          font-size: 48px;       /* large message */
          font-weight: bold;
          color: #d9534f;
          margin-bottom: 20px;
        }

        .countdown {
          font-size: 24px;
          color: #555;
        }
      </style>
    </head>
    <body>
      <div class="flash-message">Coming Soon</div>
      <div class="countdown">This will be similar to current ellarises.org version of the page. Redirecting in <span id="seconds">10</span> seconds...</div>

      <script>
        let seconds = 10;
        const countdownEl = document.getElementById('seconds');

        const interval = setInterval(() => {
          seconds--;
          countdownEl.textContent = seconds;
          if (seconds <= 0) {
            clearInterval(interval);
            window.location.href = '/';
          }
        }, 1000);
      </script>
    </body>
    </html>
  `);
});

// -------------------------
// ADMIN ROUTES
// -------------------------
app.get("/admin/dashboard", requireManager, async (req, res) => {
    const events = await knex("events as e")
        .leftJoin("eventoccurrences as eo", function () {
            this.on("eo.eventid", "=", "e.eventid")
                .andOn("eo.eventdatestart", ">=", knex.fn.now());
        })
        .select(
            "e.eventid",
            "e.eventname",
            "e.eventtype",
            knex.raw("MIN(eo.eventdatestart) as nextdate"),
            "eo.eventlocation"
        )
        .groupBy("e.eventid", "e.eventname", "e.eventtype", "eo.eventlocation")
        .orderBy("nextdate");

    res.render("admin/dashboard", { events, title: "Admin Dashboard" });
});

// Manage users
app.get("/admin/manageusers",requireManager, async (req, res) => {
  try {
    const managers = await knex("managers").select("userid", "managerfirstname", "managerlastname").orderBy("managerlastname");
    const parents = await knex("parents").select("userid","parentid","parentfirstname","parentlastname","parentemail","preferredlanguage").orderBy("parentlastname");
    const participants = await knex("participants").select("participantid","participantfirstname","participantlastname","participantemail","participantdob","participantphone","participantcity","participantstate","participantfieldofinterest","parentid");
    parents.forEach(parent => parent.children = participants.filter(p => p.parentid === parent.parentid));
    res.render("admin/manageusers", { title: "Manage Users", managers, parents, error_message: "" });
  } catch (err) {
    console.error("Manage Users Error:", err);
    res.render("admin/manageusers", { title: "Manage Users", managers: [], parents: [], error_message: "Database error: " + err.message });
  }
});

// Manage Surveys
app.post("/admin/surveys", requireManager, async (req, res) => {
  try {
    const { filterType, filterValue } = req.body; // e.g., filter by eventid or score threshold

    // Base query joining survey -> registration -> eventoccurrences -> events
    let query = knex("survey")
      .join("registration", "survey.registrationid", "registration.registrationid")
      .join("eventoccurrences", "registration.eventoccurrenceid", "eventoccurrences.eventoccurrenceid")
      .join("events", "eventoccurrences.eventid", "events.eventid")
      .select(
        "survey.surveyid as id",
        "registration.participantemail as user_label",
        "survey.satisfactionscore as SurveySatisfactionScore",
        "survey.usefulnessscore as SurveyUsefulnessScore",
        "survey.instructorscore as SurveyInstructorScore",
        "survey.recommendationscore as SurveyRecommendationScore",
        "survey.overallscore as SurveyOverallScore",
        "survey.comments as SurveyComments",
        "events.eventname",
        "events.eventtype",
        "events.eventdescription",
        "eventoccurrences.eventlocation",
        "survey.submissiondate as SurveySubmissionDate",
        "survey.submissiontime as SurveySubmissionTime"
      );

    // Apply filters if provided
    if (filterType && filterValue) {
      if (filterType === "event") {
        query = query.where("events.eventid", filterValue);
      } else if (filterType === "score") {
        query = query.where("survey.overallscore", ">=", filterValue);
      } else if (filterType === "participant") {
        query = query.where("registration.participantemail", filterValue);
      }
    }

    const responses = await query.orderBy("survey.submissiondate", "desc");

    // Compute average overall score for filtered set
    const avgOverall = responses.length
      ? (responses.reduce((sum, r) => sum + Number(r.SurveyOverallScore), 0) / responses.length).toFixed(2)
      : null;

    // Optional: populate filter options for dropdown in EJS
    const filterOptions = await knex("events").select("eventid as id", "eventname as label");

    res.render("admin/survey-responses", {
      user: req.session.user,
      responses,
      filterOptions,
      filterBy: filterType === "event" ? filterValue : null,
      avgOverall,
      lang: req.session.lang || "en"
    });

  } catch (err) {
    console.error("Error fetching survey responses:", err);
    res.status(500).send("Error fetching survey responses");
  }
});

app.get("/admin/surveys", requireManager, async (req, res) => {
  try {
    const { filterType, filterValue } = req.query; // e.g., /admin/surveys?filterType=event&filterValue=3

    // Base query joining survey -> registration -> eventoccurrences -> events
    let query = knex("survey")
      .join("registration", "survey.registrationid", "registration.registrationid")
      .join("eventoccurrences", "registration.eventoccurrenceid", "eventoccurrences.eventoccurrenceid")
      .join("events", "eventoccurrences.eventid", "events.eventid")
      .select(
        "survey.surveyid as id",
        "registration.participantemail as user_label",
        "survey.satisfactionscore as SurveySatisfactionScore",
        "survey.usefulnessscore as SurveyUsefulnessScore",
        "survey.instructorscore as SurveyInstructorScore",
        "survey.recommendationscore as SurveyRecommendationScore",
        "survey.overallscore as SurveyOverallScore",
        "survey.comments as SurveyComments",
        "events.eventname",
        "events.eventtype",
        "events.eventdescription",
        "eventoccurrences.eventlocation",
        "survey.submissiondate as SurveySubmissionDate",
        "survey.submissiontime as SurveySubmissionTime"
      );

    // Apply filters if provided
    if (filterType && filterValue) {
      if (filterType === "event") {
        query = query.where("events.eventid", filterValue);
      } else if (filterType === "score") {
        query = query.where("survey.overallscore", ">=", filterValue);
      } else if (filterType === "participant") {
        query = query.where("registration.participantemail", filterValue);
      }
    }

    const responses = await query.orderBy("survey.submissiondate", "desc");

    // Compute average overall score for filtered set
    const avgOverall = responses.length
      ? (responses.reduce((sum, r) => sum + Number(r.SurveyOverallScore), 0) / responses.length).toFixed(2)
      : null;

    // Populate filter options for dropdown in EJS
    const filterOptions = await knex("events").select("eventid as id", "eventname as label");

    res.render("admin/survey-responses", {
      user: req.session.user,
      responses,
      filterOptions,
      filterBy: filterType === "event" ? filterValue : null,
      avgOverall,
      lang: req.session.lang || "en"
    });

  } catch (err) {
    console.error("Error fetching survey responses:", err);
    res.status(500).send("Error fetching survey responses");
  }
});

// Milestones Management Route
app.post("/admin/user/:userid/participant/:participantid/milestones", requireLogin, async (req, res) => {
  try {
    const { userid, participantid } = req.params;

    // Get parent info
    const parent = await knex("parents")
      .select("*")
      .where({ userid })
      .first();
    if (!parent) return res.status(404).send("Parent not found");

    // Get the selected participant
    const participant = await knex("participants")
      .select("*")
      .where({ participantid, parentid: parent.parentid })
      .first();
    if (!participant) return res.status(404).send("Participant not found");

    // Get milestones for this participant
    const milestones = await knex("milestones")
      .select("milestonetitle as title", "milestonedate as date", "milestonestatus as status")
      .where({ participantemail: participant.participantemail })
      .orderBy("milestonedate", "asc");

    participant.milestones = milestones;

    // Map participant columns for EJS
    participant.participantDOB = participant.participantdob;
    participant.participantgrade = participant.participantgrade;
    participant.participantfirstname = participant.participantfirstname;
    participant.participantlastname = participant.participantlastname;

    res.render("admin/user-milestones", {
      parent,
      participant, // pass single participant
      user: req.session.user,
      lang: req.session.lang || "en",
    });

  } catch (err) {
    console.error("Error loading user milestones:", err);
    res.status(500).send("Error loading user milestones");
  }
});

// -------------------------
// MANAGE DONATIONS
// -------------------------
app.get("/admin/managedonations", requireManager, async (req, res) => {
  try {
    const { period, startDate, endDate, minAmount, maxAmount, success, error } = req.query;
    let query = knex("donations").select("*");

    if (period) {
      const today = new Date();
      let start;
      if (period === "week") start = new Date(today.setDate(today.getDate() - 7));
      else if (period === "month") start = new Date(today.setMonth(today.getMonth() - 1));
      else if (period === "year") start = new Date(today.setFullYear(today.getFullYear() - 1));
      if (start) query = query.where("donationdate", ">=", start.toISOString().split("T")[0]);
    }

    if (startDate) query = query.where("donationdate", ">=", startDate);
    if (endDate) query = query.where("donationdate", "<=", endDate);
    if (minAmount) query = query.where("amount", ">=", Number(minAmount));
    if (maxAmount) query = query.where("amount", "<=", Number(maxAmount));

    const donations = await query.orderBy("donationdate", "desc").orderBy("amount", "desc");
    const mapped = donations.map(d => ({
      donor_name: d.donorname,
      donor_email: d.donoremail,
      amount: d.amount,
      date: d.donationdate ? new Date(d.donationdate).toISOString().split("T")[0] : '—',
      notes: d.message ?? '—'
    }));

    const total = mapped.reduce((sum, d) => sum + Number(d.amount || 0), 0);

    res.render("admin/managedonations", {
      title: "View Donations",
      donations: mapped,
      total: total.toFixed(2),
      user: req.session.user,
      lang: req.session.lang || "en",
      filters: { period, startDate, endDate, minAmount, maxAmount },
      success_message: success || "",
      error_message: error || ""
    });

  } catch (err) {
    console.error("Error fetching donations:", err);
    res.status(500).send("Error loading donations");
  }
});

app.post("/admin/managedonations/send-thankyou", requireManager, async (req, res) => {
  const { donorEmail, donorName, amount } = req.body;

  if (!donorEmail) {
    return res.redirect("/admin/managedonations?error=Missing+donor+email");
  }

  try {
    await transporter.sendMail({
      from: `"Ella Rises" <${process.env.EMAIL_USER}>`,
      to: donorEmail,
      subject: "Thank you for your donation!",
      text: `Dear ${donorName || "Donor"},\n\nThank you for your generous donation of $${amount}.\n\nWe appreciate your support!\n\n— The Ella Rises Team`,
    });

    res.redirect("/admin/managedonations?success=Thank+you+email+sent+to+" + encodeURIComponent(donorEmail));
  } catch (err) {
    console.error("Error sending email:", err);
    res.redirect("/admin/managedonations?error=Failed+to+send+email+to+" + encodeURIComponent(donorEmail));
  }
});

app.get("/admin/donations", requireManager, (req, res) => {
  res.render("admin/donations", { title: "View Donations" });
});

// MANAGE EVENTS PAGE (Dashboard list)
app.get("/admin/manageevents", async (req, res) => {
  try {
    // Fetch all events + their next occurrence
    const events = await knex("events as e")
        .leftJoin("eventoccurrences as eo", function () {
            this.on("eo.eventid", "=", "e.eventid")
                .andOn("eo.eventdatestart", ">=", knex.fn.now());
        })
        .select(
            "e.eventid",
            "e.eventname",
            "e.eventtype",
            knex.raw("MIN(eo.eventdatestart) as nextdate"),
            "eo.eventlocation"
        )
        .groupBy("e.eventid", "e.eventname", "e.eventtype", "eo.eventlocation")
        .orderBy("nextdate");

    res.render("admin/events", { events, title: "Manage Events" });

  } catch (err) {
    console.error("❌ Error loading events:", err);
    res.status(500).send("Error loading events");
  }
});

// Add event page
app.get("/admin/add-event", requireManager, (req, res) => {
    res.render("admin/addevent", error_message="");
});

app.post("/admin/add-event", requireManager, async (req, res) => {
    const {
        eventname,
        eventtype,
        eventdescription,
        recurrencepattern,
        eventdefaultcapacity,

        // First occurrence schedule
        occurrencestartdate,
        occurrencestarttime,
        occurrenceenddate,
        occurrenceendtime,

        // Recurrence range
        repeatenddate,

        // Other info
        eventlocation,
        registrationdaysbefore
    } = req.body;

    try {
        // Insert main event
        const [eventID] = await knex("events")
            .insert({
                eventname,
                eventtype,
                eventdescription,
                recurrencepattern,
                eventdefaultcapacity
            })
            .returning("eventid");

        const EventID = eventID.eventid ?? eventID;

        // Convert to JS Dates
        let start = new Date(occurrencestartdate);
        let end   = new Date(occurrenceenddate);

        const final = new Date(repeatenddate);

        // Store occurrences here
        let occurrences = [];

        // Helper to add a single occurrence
        const addOccurrence = (startDate, endDate) => {
            // Dynamic registration deadline: X days prior
            const deadline = new Date(startDate);
            deadline.setDate(deadline.getDate() - Number(registrationdaysbefore));

            occurrences.push({
                eventid: EventID,

                eventdatestart: startDate.toISOString().split("T")[0],
                eventtimestart: occurrencestarttime,

                eventdateend: endDate.toISOString().split("T")[0],
                eventtimeend: occurrenceendtime,

                eventlocation,
                eventcapacity: eventdefaultcapacity,

                eventregistrationdeadlinedate: deadline.toISOString().split("T")[0],
                eventregistrationdeadlinetime: "23:59"
            });
        };

        // Add first occurrence
        addOccurrence(start, end);

        // Generate recurring events
        while (true) {
            let nextStart = new Date(start);
            let nextEnd   = new Date(end);

            if (recurrencepattern === "Daily") {
                nextStart.setDate(nextStart.getDate() + 1);
                nextEnd.setDate(nextEnd.getDate() + 1);
            }
            else if (recurrencepattern === "Weekly") {
                nextStart.setDate(nextStart.getDate() + 7);
                nextEnd.setDate(nextEnd.getDate() + 7);
            }
            else if (recurrencepattern === "Monthly") {
                nextStart.setMonth(nextStart.getMonth() + 1);
                nextEnd.setMonth(nextEnd.getMonth() + 1);
            }
            else {
                break; // No recurrence
            }

            if (nextStart > final) break;

            addOccurrence(nextStart, nextEnd);
            start = nextStart;
            end = nextEnd;
        }

        // Insert all occurrences
        await knex("eventoccurrences").insert(occurrences);

        res.redirect("/admin/dashboard");

    } catch (err) {
        console.error("Error adding event:", err.message);
        res.status(500).render("admin/addEvent", {
            error_message: "Unable to save event. Please try again."
        });
    }
});

app.get("/admin/event/:eventid/edit", requireManager, async (req, res) => {
    const eventID = req.params.eventid;

    // Get the event itself
    const event = await knex("events")
        .where({ eventid: eventID })
        .first();

    if (!event) {
        return res.status(404).send("Event not found.");
    }

    // Get its occurrences
    const occurrences = await knex("eventoccurrences")
        .where({ eventid: eventID })
        .orderBy("eventdatestart");

    // Render page with ONE event
    res.render("admin/manageevents", {
      event: { 
        ...event,
        occurrences
      },
      title: "Manage Event",
      success_message: ""
    });
});

app.post("/admin/event/:eventid/edit", requireManager, async (req, res) => {
    const { eventid } = req.params;

    const { 
      eventname,
      eventtype,
      eventdescription,
      recurrencepattern
    } = req.body;

    try {
        await knex("events")
            .where({ eventid })
            .update({
                eventname,
                eventtype,
                eventdescription,
                recurrencepattern
            });

        const event = await knex("events")
            .where({ eventid })
            .first();

        if (!event) {
            return res.status(404).send("Event not found.");
        }

        const occurrences = await knex("eventoccurrences")
            .where({ eventid })
            .orderBy("eventdatestart");

        res.render("admin/manageevents", {
            title: "Manage Event",
            event: {
                ...event,
                occurrences
            },
            success_message: "Event details saved successfully!"
        });

    } catch (err) {
        console.error("Error saving event:", err);
        res.status(500).send("Error saving event details.");
    }
});


app.post("/admin/event-occurrence/:occurrenceid/edit", requireManager, async (req, res) => {
    const { occurrenceid } = req.params;

    const {
        eventdatestart,
        eventtimestart,
        eventdateend,
        eventtimeend,
        eventlocation,
        eventcapacity,
        eventregistrationdeadlinedate,
        eventregistrationdeadlinetime
    } = req.body;

    try {
        const occ = await knex("eventoccurrences")
            .where({ eventoccurrenceid: occurrenceid })
            .first();

        if (!occ) {
            return res.status(404).send("Occurrence not found.");
        }

        await knex("eventoccurrences")
            .where({ eventoccurrenceid: occurrenceid })
            .update({
                eventdatestart,
                eventtimestart,
                eventdateend,
                eventtimeend,
                eventlocation,
                eventcapacity,
                eventregistrationdeadlinedate,
                eventregistrationdeadlinetime
            });

        const event = await knex("events")
            .where({ eventid: occ.eventid })
            .first();

        const occurrences = await knex("eventoccurrences")
            .where({ eventid: occ.eventid })
            .orderBy("eventdatestart");

        res.render("admin/manageevents", {
            event: {
                ...event,
                occurrences
            },
            title: "Manage Event",
            success_message: "Occurrence saved successfully!"
        });

    } catch (err) {
        console.error("Error updating occurrence:", err);
        res.status(500).send("Error saving occurrence.");
    }
});


app.get("/admin/event/:eventid/new-occurrence", requireManager, (req, res) => {
  const id = req.params.eventid;
  res.render("admin/addOccurrence", { eventid: id , title: "Add Occurrence" });
});

app.post("/admin/event/:eventid/new-occurrence", requireManager, async (req, res) => {
    const { eventid } = req.params;

    const {
        eventdatestart,
        eventtimestart,
        eventdateend,
        eventtimeend,
        eventlocation,
        eventcapacity,
        eventregistrationdeadlinedate,
        eventregistrationdeadlinetime
    } = req.body;

    // Build new occurrence
    const newOccurrence = {
        eventid,
        eventdatestart,
        eventtimestart,
        eventdateend,
        eventtimeend,
        eventlocation,
        eventcapacity,
        eventregistrationdeadlinedate,
        eventregistrationdeadlinetime
    };

    try {
        // Insert the new occurrence
        await knex("eventoccurrences").insert(newOccurrence);

        // Redirect back to the Event Edit page
        return res.redirect(`/admin/edit-event/${eventid}`);

    } catch (err) {
        console.error("Error inserting new occurrence:", err.message);

        return res.status(500).render("error", {
            error_message: "Unable to add new occurrence."
        });
    }
});

app.post("/admin/event/:eventid/delete", requireManager, async (req, res) => {
    const { eventid } = req.params;

    try {
        // Check if the event exists
        const event = await knex("events")
            .where({ eventid })
            .first();

        if (!event) {
            return res.status(404).send("Event not found.");
        }

        // Perform delete inside a transaction
        await knex.transaction(async trx => {

            // Delete occurrences first (foreign key safe)
            await trx("eventoccurrences")
                .where({ eventid })
                .del();

            // Delete the parent event
            await trx("events")
                .where({ eventid })
                .del();
        });

        // After deletion, reload the manage events page
        const events = await knex("events").select("*");

        res.render("admin/dashboard", {
            events,
            title: "Manage Events"
        });

    } catch (err) {
        console.error("Error deleting event:", err);
        res.status(500).send("Error deleting event.");
    }
});

app.post("/admin/event-occurrence/:occurrenceid/delete", requireManager, async (req, res) => {
    const { occurrenceid } = req.params;

    try {
        // Get the occurrence so we know which event to reload
        const occ = await knex("eventoccurrences")
            .where({ eventoccurrenceid: occurrenceid })
            .first();

        if (!occ) {
            return res.status(404).send("Occurrence not found.");
        }

        // Delete it
        await knex("eventoccurrences")
            .where({ eventoccurrenceid: occurrenceid })
            .del();

        // Fetch event again
        const event = await knex("events")
            .where({ eventid: occ.eventid })
            .first();

        // Fetch updated occurrences list
        const occurrences = await knex("eventoccurrences")
            .where({ eventid: occ.eventid })
            .orderBy("eventdatestart");

        // Render the manage events page with a success message
        res.render("admin/manageevents", {
            title: "Manage Event",
            event: {
                ...event,
                occurrences
            },
            success_message: "Occurrence deleted successfully!"
        });

    } catch (err) {
        console.error("Error deleting occurrence:", err);
        res.status(500).send("Error deleting occurrence.");
    }
});



// -------------------------
// START SERVER
// -------------------------
app.listen(PORT, () => console.log(`Website started on port ${PORT}`));