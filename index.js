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
      name: fullName
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

// -------------------------
// START SERVER
// -------------------------
app.listen(PORT, () => console.log(`Website started on port ${PORT}`));