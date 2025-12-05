// imports
const express = require("express");
const session = require("express-session");
// Determine environment
const isProd = process.env.NODE_ENV === "production";

// Knex setup
const knex = require("knex")({
  client: "pg",
  connection: {
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "12345",
    database: process.env.DB_NAME || "ellarises",
    port: process.env.DB_PORT || 5432,
    // SSL handling
    ssl: isProd
      ? { rejectUnauthorized: false } // production (RDS)
      : false,                        // local
  },
});

module.exports = knex;
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
    const { username, password } = req.body;

    // Authenticate user
    const user = await knex("logins")
      .where({ username, password })
      .first();

    if (!user) {
      return res.render("login", { error_message: "Invalid login" });
    }

    let fullName = "";
    let parentId = null;

    if (user.level === "M") {
      const mgr = await knex("managers")
        .where({ userid: user.userid })
        .first();

      if (mgr) {
        fullName = `${mgr.managerfirstname} ${mgr.managerlastname}`;
      }
    }

    if (user.level === "U") {
      const parent = await knex("parents")
        .where({ userid: user.userid })
        .first();

      if (parent) {
        fullName = `${parent.parentfirstname} ${parent.parentlastname}`;
        parentId = parent.parentid;   // <-- STORE parentid
      }
    }

    // Store session data (NOW parentid is included)
    req.session.isLoggedIn = true;
    req.session.user = {
      userid: user.userid,
      username: user.username,
      level: user.level,
      name: fullName,
      parentid: parentId             // <-- ALWAYS SET HERE
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


// -------------------------
// CREATE ACCOUNT
// -------------------------
app.get("/addUser", (req, res) => {
  const context = req.query.context || "enroll"; 
  res.render("createAccount", { context, title: "Create Account" });
});

app.post("/addUser", async (req, res) => {
  try {
    const {
      username,
      password,

      parentfirstname,
      parentlastname,
      parentphone,
      parentemail,
      parentcity,
      parentstate,
      parentzip,
      parentcollege,
      languagepreference,
      medicalconsent,
      photoconsent,
      tuitionagreement,
      agreementdate,
      scholarshipinterest,

      participantfirstname,
      participantlastname,
      participantemail,
      participantdob,
      participantgrade,
      participantschooloremployer,
      mariachiinstrumentinterest,
      instrumentexperience,
      programs
    } = req.body;

    // === VALIDATION OMITTED FOR BREVITY (same as yours) ===

    const programList = Array.isArray(programs) ? programs.join(", ") : "";

    // Create login
    const [loginRow] = await knex("logins")
      .insert({ username, password, level: "U" })
      .returning("userid");

    const newUserID = loginRow.userid || loginRow;

    const [parentRow] = await knex("parents")
      .insert({
        userid: newUserID,
        parentfirstname,
        parentlastname,
        parentphone,
        parentemail,
        parentcity,
        parentstate,
        parentzip,
        parentcollege,
        languagepreference,
        medicalconsent: medicalconsent === "true",
        photoconsent: photoconsent === "true",
        tuitionagreement: tuitionagreement === "true",
        scholarshipinterest: scholarshipinterest === "true",
        agreementdate
      })
      .returning("parentid");

    const newParentID = parentRow.parentid || parentRow;

    // Create participant
    const [participantRow] = await knex("participants")
      .insert({
        parentid: newParentID,
        participantfirstname,
        participantlastname,
        participantemail,
        participantdob,
        participantgrade,
        participantschooloremployer,
        participantfieldofinterest: programList,
        mariachiinstrumentinterest,
        instrumentexperience,
        graduationstatus: "enrolled"
      })
      .returning("participantemail");

    const newParticipantEmail = participantRow.participantemail;

    // ============================================================
    // AUTO-REGISTER FOR FUTURE EVENTS + AUTO-CREATE SURVEYS
    // ============================================================

    const today = new Date().toISOString().split("T")[0];

    const futureOccurrences = await knex("eventoccurrences")
      .where("eventregistrationdeadlinedate", ">=", today)
      .select("eventoccurrenceid");

    const registrationIds = [];

    for (const occ of futureOccurrences) {
      const [reg] = await knex("registration")
        .insert({
          participantemail: newParticipantEmail,
          eventoccurrenceid: occ.eventoccurrenceid,
          registrationstatus: "not attending",
          registrationattendedflag: false,
          createdatdate: today
        })
        .returning("registrationid");

      registrationIds.push(reg.registrationid || reg);
    }

    // Log in and redirect
    req.session.isLoggedIn = true;
    req.session.user = {
      userid: newUserID,
      parentid: newParentID,
      level: "U",
      username,
      name: `${parentfirstname} ${parentlastname}`
    };

    res.redirect(`/account/${newUserID}?success=User+Created`);

  } catch (err) {
    console.error("Error creating user:", err);
    res.render("createAccount", {
      error_message: "There was an error creating your account.",
      title: "Create Account"
    });
  }
});

app.get("/account/:userid", requireLogin, async (req, res) => {
  try {
    const { userid } = req.params;

    // Permission check
    if (req.session.user.level === "U" && req.session.user.userid != userid) {
      return res.status(403).send("Unauthorized");
    }

    // Load parent
    const parent = await knex("parents")
      .where({ userid })
      .first();

    if (!parent) return res.status(404).send("Parent not found");

    const parentId = parent.parentid;

    // Load children
    const participants = await knex("participants")
      .where({ parentid: parentId });

    // Load future occurrences (for event availability)
    const today = new Date().toISOString().split("T")[0];

    const futureOccurrences = await knex("eventoccurrences as eo")
      .join("events as e", "e.eventid", "eo.eventid")
      .where("eo.eventregistrationdeadlinedate", ">=", today)
      .select(
        "eo.eventoccurrenceid",
        "eo.eventdatestart",
        "eo.eventtimestart",
        "eo.eventregistrationdeadlinedate",
        "e.eventname"
      );

    // Build full participant data
    for (const child of participants) {
      const childEmail = child.participantemail;

      // Load registrations for this child
      const regs = await knex("registration")
        .where({ participantemail: childEmail });

      // Upcoming events
      const upcomingEvents = await knex("registration as r")
        .join("eventoccurrences as eo", "eo.eventoccurrenceid", "r.eventoccurrenceid")
        .join("events as e", "e.eventid", "eo.eventid")
        .where("r.participantemail", childEmail)
        .andWhere("eo.eventregistrationdeadlinedate", ">=", today)
        .select(
          "r.registrationid",
          "r.registrationstatus",
          "e.eventname",
          "eo.eventdatestart",
          "eo.eventtimestart"
        );

      child.upcomingEvents = upcomingEvents;

      // Past surveys missing
      const pastUnsurveyed = await knex("survey as s")
        .join("registration as r", "r.registrationid", "s.registrationid")
        .join("eventoccurrences as eo", "eo.eventoccurrenceid", "r.eventoccurrenceid")
        .join("events as e", "e.eventid", "eo.eventid")
        .where("r.participantemail", childEmail)
        .andWhere("eo.eventdatestart", "<", today)
        .whereNull("s.submissiondate")
        .select(
          "r.registrationid",
          "e.eventname",
          "eo.eventdatestart",
          "eo.eventtimestart"
        );

      child.pastUnsurveyed = pastUnsurveyed;

      // Load milestones
      const milestones = await knex("milestones").where({ participantid: child.participantid });
      child.milestones = milestones;
    }

    // Attach children list
    parent.participants = participants;

    res.render("pages/account", {
      user: req.session.user,
      parent,
      success_message: req.query.success || ""
    });

  } catch (err) {
    console.error("Account Load Error:", err);
    res.status(500).send("Server Error");
  }
});

app.post("/account/:userid/update", requireLogin, async (req, res) => {
  try {
    const userId = Number(req.params.userid);
    const logged = req.session.user;

    if (logged.level === "U" && logged.userid !== userId)
      return res.status(403).send("Unauthorized");

    await knex("parents")
      .where({ userid: userId })
      .update({
        parentfirstname: req.body.parentfirstname,
        parentlastname: req.body.parentlastname,
        parentemail: req.body.parentemail,
        parentphone: req.body.parentphone,
        parentcity: req.body.parentcity,
        parentstate: req.body.parentstate,
        parentzip: req.body.parentzip,
        parentcollege: req.body.parentcollege,
        languagepreference: req.body.languagepreference,
        scholarshipinterest: req.body.scholarshipinterest,
        tuitionagreement: req.body.tuitionagreement === "true",
        medicalconsent: req.body.medicalconsent === "true",
        photoconsent: req.body.photoconsent === "true",
        agreementdate: req.body.agreementdate || null
      });

    res.redirect(`/account/${userId}?success=Parent+Updated`);

  } catch (err) {
    console.error("Update parent error:", err);
    res.redirect(`/account/${req.params.userid}`);
  }
});

app.get("/account/:parentid/participant/add", requireLogin, async (req, res) => {
  const parentid = Number(req.params.parentid);
  const logged = req.session.user;

  const parent = await knex("parents").where({ parentid }).first();
  if (!parent) return res.status(404).send("Parent not found");

  if (logged.level === "U" && logged.userid !== parent.userid)
    return res.status(403).send("Unauthorized");

  res.render("pages/add-child", {
    title: "Add Child",
    parentid
  });
});

app.post("/account/:parentid/participant/add", requireLogin, async (req, res) => {
  try {
    const parentid = Number(req.params.parentid);
    const logged = req.session.user;

    const parent = await knex("parents").where({ parentid }).first();
    if (!parent) return res.status(404).send("Parent not found");
    if (logged.level === "U" && logged.userid !== parent.userid)
      return res.status(403).send("Unauthorized");

    const { programs } = req.body;
    const programList = Array.isArray(programs) ? programs.join(", ") : "";

    const [participantRow] = await knex("participants")
      .insert({
        parentid,
        participantfirstname: req.body.participantfirstname,
        participantlastname: req.body.participantlastname,
        participantemail: req.body.participantemail,
        participantdob: req.body.participantdob || null,
        participantgrade: req.body.participantgrade,
        participantschooloremployer: req.body.participantschooloremployer,
        participantfieldofinterest: programList,
        mariachiinstrumentinterest: req.body.mariachiinstrumentinterest,
        instrumentexperience: req.body.instrumentexperience,
        graduationstatus: req.body.graduationstatus || "not started"
      })
      .returning("participantemail");

    const newParticipantEmail = participantRow.participantemail;

    // ============================================================
    // AUTO-REGISTER FOR FUTURE EVENTS + CREATE SURVEYS
    // ============================================================

    const today = new Date().toISOString().split("T")[0];

    const futureOccurrences = await knex("eventoccurrences")
      .where("eventregistrationdeadlinedate", ">=", today)
      .select("eventoccurrenceid");

    const registrationIds = [];

    for (const occ of futureOccurrences) {
      const [reg] = await knex("registration")
        .insert({
          participantemail: newParticipantEmail,
          eventoccurrenceid: occ.eventoccurrenceid,
          registrationstatus: "not attending",
          registrationattendedflag: false,
          createdatdate: today
        })
        .returning("registrationid");

      registrationIds.push(reg.registrationid || reg);
    }

    res.redirect(`/account/${parent.userid}?success=Child+Added`);

  } catch (err) {
    console.error("Add child error:", err);
    res.status(500).send("Server Error");
  }
});

app.post("/account/participant/:participantid/update-full", requireLogin, async (req, res) => {
  try {
    const pid = Number(req.params.participantid);

    const child = await knex("participants").where({ participantid: pid }).first();
    if (!child) return res.status(404).send("Child not found");

    const parent = await knex("parents")
      .where({ parentid: child.parentid })
      .first();

    if (req.session.user.level === "U" &&
        req.session.user.userid !== parent.userid)
      return res.status(403).send("Unauthorized");

    await knex("participants")
      .where({ participantid: pid })
      .update({
        participantfirstname: req.body.participantfirstname,
        participantlastname: req.body.participantlastname,
        participantemail: req.body.participantemail,
        participantdob: req.body.participantdob || null,
        participantgrade: req.body.participantgrade,
        participantschooloremployer: req.body.participantschooloremployer,
        participantfieldofinterest: req.body.participantfieldofinterest,
        mariachiinstrumentinterest: req.body.mariachiinstrumentinterest,
        instrumentexperience: req.body.instrumentexperience,
        graduationstatus: req.body.graduationstatus
      });

    res.redirect(`/account/${parent.userid}?success=Child+Updated`);

  } catch (err) {
    console.error("Update child error:", err);
    res.status(500).send("Server Error");
  }
});

app.post("/account/participant/:participantid/delete", requireLogin, async (req, res) => {
    const trx = await knex.transaction();

    try {
        const participantid = Number(req.params.participantid);

        // Fetch participant
        const child = await trx("participants")
            .where({ participantid })
            .first();

        if (!child) {
            await trx.rollback();
            return res.status(404).send("Child not found");
        }

        // Fetch parent
        const parent = await trx("parents")
            .where({ parentid: child.parentid })
            .first();

        // Permission check
        if (req.session.user.level === "U" &&
            req.session.user.userid !== parent.userid) 
        {
            await trx.rollback();
            return res.status(403).send("Unauthorized");
        }

        const participantEmail = child.participantemail;
        const participantIdList = [participantid];

        // ---------------------------------------------------
        // 1. DELETE SURVEYS → Registration cleanup
        // ---------------------------------------------------
        const registrations = await trx("registration")
            .where({ participantemail: participantEmail })
            .select("registrationid");

        const regIds = registrations.map(r => r.registrationid);

        // Delete surveys
        if (regIds.length > 0) {
            await trx("survey")
                .whereIn("registrationid", regIds)
                .del();
        }

        // Delete registrations
        if (participantEmail) {
            await trx("registration")
                .where({ participantemail: participantEmail })
                .del();
        }

        // ---------------------------------------------------
        // 2. DELETE MILESTONES
        // ---------------------------------------------------
        await trx("milestones")
            .where({ participantid })
            .del();

        // ---------------------------------------------------
        // 3. DELETE PARTICIPANT
        // ---------------------------------------------------
        await trx("participants")
            .where({ participantid })
            .del();

        // Commit transaction
        await trx.commit();

        return res.redirect(`/account/${parent.userid}?success=Child+Deleted`);

    } catch (err) {
        console.error("Delete child error:", err);
        await trx.rollback();
        return res.status(500).send("Server Error");
    }
});

app.post("/account/milestone/:milestoneid/update-full", requireLogin, async (req, res) => {
  try {
    const mid = req.params.milestoneid;

    const milestone = await knex("milestones").where({ milestoneid: mid }).first();
    if (!milestone) return res.status(404).send("Milestone not found");

    const child = await knex("participants")
      .where({ participantid: milestone.participantid })
      .first();

    const parent = await knex("parents")
      .where({ parentid: child.parentid })
      .first();

    if (req.session.user.level === "U" &&
        req.session.user.userid !== parent.userid)
      return res.status(403).send("Unauthorized");

    await knex("milestones")
      .where({ milestoneid: mid })
      .update({
        milestonetitle: req.body.milestonetitle,
        milestonedate: req.body.milestonedate || null,
        milestonestatus: req.body.milestonestatus
      });

    res.redirect(`/account/${parent.userid}?success=Milestone+Updated`);

  } catch (err) {
    console.error("Update milestone error:", err);
    res.status(500).send("Server Error");
  }
});

app.post("/account/milestone/:milestoneid/delete", requireLogin, async (req, res) => {
  try {
    const mid = Number(req.params.milestoneid);

    const milestone = await knex("milestones").where({ milestoneid: mid }).first();
    if (!milestone) return res.status(404).send("Milestone not found");

    const child = await knex("participants")
      .where({ participantid: milestone.participantid })
      .first();

    const parent = await knex("parents")
      .where({ parentid: child.parentid })
      .first();

    if (req.session.user.level === "U" &&
        req.session.user.userid !== parent.userid)
      return res.status(403).send("Unauthorized");

    await knex("milestones").where({ milestoneid: mid }).del();

    res.redirect(`/account/${parent.userid}?success=Milestone+Deleted`);

  } catch (err) {
    console.error("Delete milestone error:", err);
    res.status(500).send("Server Error");
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
app.get("/events/register", requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    const parentId = user.parentid;
    const msg = req.query.msg || null;

    // 1. Load all children
    const children = await knex("participants")
      .where({ parentid: parentId })
      .select("*");

    // 2. Load all event occurrences (future + past)
    const occurrences = await knex("eventoccurrences")
      .join("events", "events.eventid", "eventoccurrences.eventid")
      .select(
        "eventoccurrences.eventoccurrenceid as id",
        "events.eventname as name",
        "eventoccurrences.eventdatestart",
        "eventoccurrences.eventtimestart"
      );

    // 3. Load all registrations for THIS parent's children
    const registrations = await knex("registration")
      .join("participants", "participants.participantemail", "registration.participantemail")
      .where("participants.parentid", parentId)
      .select("registration.*", "participants.participantemail");

    const today = new Date();
    let pastItems = [];
    let upcomingRegistered = [];
    let availableItems = [];

    occurrences.forEach(occ => {
      const eventDate = new Date(occ.eventdatestart);

      const registered = registrations.find(r => r.eventoccurrenceid === occ.id);

      const item = {
        id: occ.id,
        name: occ.name,
        date: eventDate
      };

      if (registered) {
        if (eventDate < today) pastItems.push(item);
        else upcomingRegistered.push(item);
      } else {
        if (eventDate >= today) availableItems.push(item);
      }
    });

    res.render("events/register", {
      title: "Register for Events",
      title_es: "Registro de Eventos",
      type: "Events",
      type_es: "Eventos",
      user,
      children,
      pastItems,
      upcomingRegistered,
      availableItems,
      lang: req.session.lang || "en",
      msg
    });

  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

app.post("/events/register/:eventOccurrenceId", requireLogin, async (req, res) => {
  try {
    const parentId = req.session.user.parentid;
    const eventOccurrenceId = Number(req.params.eventOccurrenceId);
    const childEmail = req.body.child_email;

    if (!childEmail) {
      return res.redirect("/events/register?msg=No+child+selected");
    }

    // Verify child belongs to parent
    const child = await knex("participants")
      .where({ participantemail: childEmail, parentid: parentId })
      .first();

    if (!child) {
      return res.redirect("/events/register?msg=Unauthorized");
    }

    // Prevent duplicate registration
    const existing = await knex("registration")
      .where({
        participantemail: childEmail,
        eventoccurrenceid: eventOccurrenceId
      })
      .first();

    if (existing) {
      return res.redirect("/events/register?msg=Already+Registered");
    }

    // Insert registration
    await knex("registration").insert({
      participantemail: childEmail,
      eventoccurrenceid: eventOccurrenceId,
      registrationstatus: "registered",
      registrationattendedflag: false,
      createdatdate: new Date()
    });

    return res.redirect("/events/register?msg=Success");

  } catch (err) {
    console.error("Event registration error:", err);
    res.status(500).send("Server error");
  }
});

// -------------------------
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
    try {
        const search = req.query.search ? req.query.search.trim().toLowerCase() : "";

        let events = await knex("events as e")
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

        // FILTER BY SEARCH
        if (search.length > 0) {
            events = events.filter(e => {
                const matchString = `${e.eventname} ${e.eventtype} ${e.eventlocation}`.toLowerCase();
                return matchString.includes(search);
            });
        }

        res.render("admin/dashboard", {
            title: "Admin Dashboard",
            events,
            search
        });

    } catch (err) {
        console.error("❌ Error loading dashboard:", err);
        res.status(500).send("Server Error");
    }
});

// Manage users
app.get("/admin/manageusers", requireLogin, async (req, res) => {
  try {
    if (req.session.user.level !== "M") {
      return res.status(403).send("Unauthorized");
    }

    const searchQuery = req.query.q ? req.query.q.trim().toLowerCase() : "";

    // Fetch parents + participants
    let parents = await knex("parents as p")
      .leftJoin("participants as c", "p.parentid", "c.parentid")
      .select(
        "p.*",
        "c.participantid",
        "c.participantfirstname",
        "c.participantlastname",
        "c.participantemail",
        "c.graduationstatus"
      );

    // Group children under parents
    const parentMap = {};

    parents.forEach(row => {
      if (!parentMap[row.parentid]) {
        parentMap[row.parentid] = {
          ...row,
          children: []
        };
      }
      if (row.participantid) {
        parentMap[row.parentid].children.push({
          participantid: row.participantid,
          participantfirstname: row.participantfirstname,
          participantlastname: row.participantlastname,
          participantemail: row.participantemail,
          graduationstatus: row.graduationstatus
        });
      }
    });

    let parentList = Object.values(parentMap);

    // ==========================
    // APPLY SEARCH FILTER
    // ==========================
    if (searchQuery.length > 0) {
      parentList = parentList.filter(p => {
        const parentString =
          `${p.parentfirstname} ${p.parentlastname} ${p.parentemail} ${p.parentcity}`
          .toLowerCase();

        const childString = p.children
          .map(c => `${c.participantfirstname} ${c.participantlastname}`.toLowerCase())
          .join(" ");

        return (
          parentString.includes(searchQuery) ||
          childString.includes(searchQuery)
        );
      });
    }

    res.render("admin/manageusers", {
      title: "Manage Users",
      parents: parentList,
      searchQuery
    });

  } catch (err) {
    console.error("Manage Users Error:", err);
    res.status(500).send("Server Error");
  }
});

app.post("/admin/user/:userid/delete", requireLogin, async (req, res) => {
    const trx = await knex.transaction();

    try {
        const { userid } = req.params;

        // Only managers can delete parents
        if (req.session.user.level !== "M") {
            await trx.rollback();
            return res.status(403).send("Unauthorized");
        }

        // Get parent row
        const parent = await trx("parents").where({ userid }).first();
        if (!parent) {
            await trx.rollback();
            return res.status(404).send("Parent not found");
        }

        const parentId = parent.parentid;

        // Get all participants belonging to this parent
        const participants = await trx("participants")
            .where({ parentid: parentId });

        const participantEmails = participants.map(p => p.participantemail);
        const participantIds = participants.map(p => p.participantid);

        //---------------------------------------------
        // STEP 1 — DELETE SURVEYS tied to registrations
        //---------------------------------------------
        if (participantEmails.length > 0) {
            const regs = await trx("registration")
                .whereIn("participantemail", participantEmails)
                .select("registrationid");

            const regIds = regs.map(r => r.registrationid);

            if (regIds.length > 0) {
                await trx("survey")
                    .whereIn("registrationid", regIds)
                    .del();
            }
        }

        //---------------------------------------------
        // STEP 2 — DELETE REGISTRATIONS
        //---------------------------------------------
        if (participantEmails.length > 0) {
            await trx("registration")
                .whereIn("participantemail", participantEmails)
                .del();
        }

        //---------------------------------------------
        // STEP 3 — DELETE MILESTONES
        //---------------------------------------------
        if (participantIds.length > 0) {
            await trx("milestones")
                .whereIn("participantid", participantIds)
                .del();
        }

        //---------------------------------------------
        // STEP 4 — DELETE PARTICIPANTS
        //---------------------------------------------
        await trx("participants")
            .where({ parentid: parentId })
            .del();

        //---------------------------------------------
        // STEP 5 — DELETE PARENT RECORD
        //---------------------------------------------
        await trx("parents")
            .where({ parentid: parentId })
            .del();

        //---------------------------------------------
        // STEP 6 — DELETE LOGIN ACCOUNT
        //---------------------------------------------
        await trx("logins")
            .where({ userid })
            .del();

        // Commit transaction
        await trx.commit();

        res.redirect("/admin/manageusers");

    } catch (err) {
        console.error("Error deleting parent:", err);
        await trx.rollback();
        res.status(500).send("Server Error");
    }
});

// Manage Surveys
// ---------------------------------------------
// ADMIN — SURVEY RESPONSES PAGE
// ---------------------------------------------
app.get("/admin/survey-responses", requireManager, async (req, res) => {
  try {
    const search = req.query.search ? req.query.search.trim().toLowerCase() : "";
    const filterBy = req.query.filterValue || "";
    const scoreOperator = req.query.scoreOperator || ">=";
    const scoreValue = req.query.scoreValue || "";

    // Base query
    let query = knex("survey as s")
      .join("registration as r", "s.registrationid", "r.registrationid")
      .join("participants as p", "p.participantemail", "r.participantemail")
      .join("eventoccurrences as eo", "eo.eventoccurrenceid", "r.eventoccurrenceid")
      .join("events as e", "e.eventid", "eo.eventid")
      .whereNotNull("s.submissiondate")
      .select(
        "s.surveyid as id",
        knex.raw("p.participantfirstname || ' ' || p.participantlastname as user_label"),
        "e.eventname",
        "e.eventtype",
        "e.eventdescription",
        "eo.eventlocation",

        "s.satisfactionscore as SurveySatisfactionScore",
        "s.usefulnessscore as SurveyUsefulnessScore",
        "s.instructorscore as SurveyInstructorScore",
        "s.recommendationscore as SurveyRecommendationScore",
        "s.overallscore as SurveyOverallScore",
        "s.comments as SurveyComments",
        "s.submissiondate as SurveySubmissionDate",
        "s.submissiontime as SurveySubmissionTime"
      );

    // ---------------------
    // SEARCH (participant or comment)
    // ---------------------
    if (search) {
      query = query.where(qb => {
        qb.whereRaw("LOWER(p.participantfirstname || ' ' || p.participantlastname) LIKE ?", `%${search}%`)
          .orWhereRaw("LOWER(s.comments) LIKE ?", `%${search}%`);
      });
    }

    // ---------------------
    // EVENT FILTER
    // ---------------------
    if (filterBy) {
      query = query.where("e.eventid", filterBy);
    }

    // ---------------------
    // SCORE FILTER
    // ---------------------
    if (scoreValue !== "") {
      query = query.where("s.overallscore", scoreOperator, Number(scoreValue));
    }

    // ---------------------
    // Execute final query
    // ---------------------
    const responses = await query.orderBy("s.submissiondate", "desc");

    // Event dropdown options
    const filterOptions = await knex("events")
      .select("eventid as id", "eventname as label_en", "eventname as label_es");

    res.render("admin/survey-responses", {
      user: req.session.user,
      responses,
      filterOptions,

      search,
      filterBy,
      scoreOperator,
      scoreValue,

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
app.get("/manageevents", async (req, res) => {
  try {
    const search = req.query.search ? req.query.search.trim().toLowerCase() : "";
    const today = new Date().toISOString().split("T")[0];

    let events = await knex("events as e")
      .leftJoin("eventoccurrences as eo", function () {
        this.on("eo.eventid", "e.eventid")
          .andOn(knex.raw("eo.eventdatestart >= ?", [today]));
      })
      .select(
        "e.*",
        // Find next event date
        knex.raw(`
          (
            SELECT eo2.eventdatestart
            FROM eventoccurrences eo2
            WHERE eo2.eventid = e.eventid
              AND eo2.eventdatestart >= ?
            ORDER BY eo2.eventdatestart ASC
            LIMIT 1
          ) AS nextdate
        `, [today]),
        // Find next event location
        knex.raw(`
          (
            SELECT eo3.eventlocation
            FROM eventoccurrences eo3
            WHERE eo3.eventid = e.eventid
              AND eo3.eventdatestart >= ?
            ORDER BY eo3.eventdatestart ASC
            LIMIT 1
          ) AS nextlocation
        `, [today])
      )
      .groupBy("e.eventid")
      .orderBy("e.eventname", "asc");

    // Apply search
    if (search.length > 0) {
      events = events.filter(e => {
        const combined = `${e.eventname} ${e.eventtype} ${e.eventdescription}`.toLowerCase();
        return combined.includes(search);
      });
    }

    res.render("pages/events", {
      title: "Manage Events",
      events,
      search
    });

  } catch (err) {
    console.error("Error loading events:", err);
    res.status(500).send("Server Error");
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

        occurrencestartdate,
        occurrencestarttime,
        occurrenceenddate,
        occurrenceendtime,

        repeatenddate,

        eventlocation,
        registrationdaysbefore
    } = req.body;

    try {
        // 1. Insert the event
        const [eventRow] = await knex("events")
            .insert({
                eventname,
                eventtype,
                eventdescription,
                recurrencepattern,
                eventdefaultcapacity
            })
            .returning("eventid");

        const eventID = eventRow.eventid || eventRow;

        // --- Build occurrences ---
        let start = new Date(occurrencestartdate);
        let end   = new Date(occurrenceenddate);
        const final = new Date(repeatenddate);

        let occurrences = [];

        const addOccurrence = (startDate, endDate) => {
            const deadline = new Date(startDate);
            deadline.setDate(deadline.getDate() - Number(registrationdaysbefore));

            occurrences.push({
                eventid: eventID,
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

        // Generate recurring dates
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
            else break;

            if (nextStart > final) break;

            addOccurrence(nextStart, nextEnd);
            start = nextStart;
            end = nextEnd;
        }

        // 2. Insert occurrences
        const inserted = await knex("eventoccurrences")
            .insert(occurrences)
            .returning("eventoccurrenceid");

        const occurrenceIds = inserted.map(o => o.eventoccurrenceid || o);

        // 3. Load all participants
        const participants = await knex("participants")
            .select("participantemail");

        // 4. Build registration rows
        let registrations = [];

        occurrenceIds.forEach(occId => {
            participants.forEach(p => {
                registrations.push({
                    participantemail: p.participantemail,
                    eventoccurrenceid: occId,
                    registrationstatus: "Not attending",
                    registrationattendedflag: false,
                    checkindate: null,
                    checkintime: null,
                    createdatdate: new Date()
                });
            });
        });

        // 5. Insert registrations and return IDs
        let registrationIds = [];

        if (registrations.length > 0) {
            const insertedRegs = await knex("registration")
                .insert(registrations)
                .returning("registrationid");

            registrationIds = insertedRegs.map(r => r.registrationid || r);
        }

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
        // 1. Insert occurrence
        const [occRow] = await knex("eventoccurrences")
            .insert(newOccurrence)
            .returning("eventoccurrenceid");

        const newOccurrenceId = occRow.eventoccurrenceid || occRow;

        // 2. Get all participants
        const allParticipants = await knex("participants").select("participantemail");

        // 3. Insert default registration rows
        const registrationRows = allParticipants.map(p => ({
            participantemail: p.participantemail,
            eventoccurrenceid: newOccurrenceId,
            registrationstatus: "Not attending",
            registrationattendedflag: false,
            checkindate: null,
            checkintime: null,
            createdatdate: new Date()
        }));

        // Insert & return registration IDs
        const insertedRegs = await knex("registration")
            .insert(registrationRows)
            .returning("registrationid");

        const registrationIds = insertedRegs.map(r => r.registrationid || r);

        // 5. Redirect
        return res.redirect(`/admin/event/${eventid}/edit`);

    } catch (err) {
        console.error("Error inserting new occurrence + auto registrations + surveys:", err);

        return res.status(500).render("error", {
            error_message: "Unable to add new occurrence."
        });
    }
});

app.post("/admin/event/:eventid/delete", requireManager, async (req, res) => {
    const { eventid } = req.params;

    try {
        await knex.transaction(async trx => {

            // ----------------------------------------------
            // 1. Get all occurrences belonging to this event
            // ----------------------------------------------
            const occurrences = await trx("eventoccurrences")
                .where({ eventid })
                .select("eventoccurrenceid");

            const occIds = occurrences.map(o => o.eventoccurrenceid);

            if (occIds.length > 0) {

                // ----------------------------------------------
                // 2. Get all registrations tied to these occurrences
                // ----------------------------------------------
                const regs = await trx("registration")
                    .whereIn("eventoccurrenceid", occIds)
                    .select("registrationid");

                const regIds = regs.map(r => r.registrationid);

                // ----------------------------------------------
                // 3. Delete all linked surveys
                // ----------------------------------------------
                if (regIds.length > 0) {
                    await trx("survey")
                        .whereIn("registrationid", regIds)
                        .del();
                }

                // ----------------------------------------------
                // 4. Delete registrations for these occurrences
                // ----------------------------------------------
                await trx("registration")
                    .whereIn("eventoccurrenceid", occIds)
                    .del();

                // ----------------------------------------------
                // 5. Delete the occurrences
                // ----------------------------------------------
                await trx("eventoccurrences")
                    .whereIn("eventoccurrenceid", occIds)
                    .del();
            }

            // ----------------------------------------------
            // 6. Delete the event itself
            // ----------------------------------------------
            await trx("events")
                .where({ eventid })
                .del();
        });

        // Reload event list
        const events = await knex("events").select("*");

        return res.render("admin/events", {
            title: "Manage Events",
            events,
            search: "",
            success_message: "Event deleted successfully!"
        });

    } catch (err) {
        console.error("Error deleting event:", err);
        return res.status(500).send("Error deleting event.");
    }
});

app.post("/admin/event-occurrence/:occurrenceid/delete", requireManager, async (req, res) => {
    const { occurrenceid } = req.params;

    try {
        // ----------------------------------------------
        // Load the occurrence to know which event to reload
        // ----------------------------------------------
        const occ = await knex("eventoccurrences")
            .where({ eventoccurrenceid: occurrenceid })
            .first();

        if (!occ) {
            return res.status(404).send("Occurrence not found.");
        }

        // ----------------------------------------------
        // Perform cascading deletion inside a transaction
        // ----------------------------------------------
        await knex.transaction(async trx => {

            // 1. Get registrations for this occurrence
            const regs = await trx("registration")
                .where({ eventoccurrenceid: occurrenceid })
                .select("registrationid");

            const regIds = regs.map(r => r.registrationid);

            // 2. Delete surveys tied to those registrations
            if (regIds.length > 0) {
                await trx("survey")
                    .whereIn("registrationid", regIds)
                    .del();
            }

            // 3. Delete registrations
            await trx("registration")
                .where({ eventoccurrenceid: occurrenceid })
                .del();

            // 4. Delete the occurrence
            await trx("eventoccurrences")
                .where({ eventoccurrenceid: occurrenceid })
                .del();
        });

        // ----------------------------------------------
        // Reload parent event + its updated occurrence list
        // ----------------------------------------------
        const event = await knex("events")
            .where({ eventid: occ.eventid })
            .first();

        const occurrences = await knex("eventoccurrences")
            .where({ eventid: occ.eventid })
            .orderBy("eventdatestart");

        // ----------------------------------------------
        // Render the updated manage event page
        // ----------------------------------------------
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

// =============================================
// ADMIN — VIEW CHECK-IN LIST
// =============================================
app.get("/admin/events/checkin/:eventOccurrenceId", requireManager, async (req, res) => {
    try {
        const eventOccurrenceId = Number(req.params.eventOccurrenceId);

        // Load event occurrence info
        const occurrence = await knex("eventoccurrences")
            .join("events", "events.eventid", "eventoccurrences.eventid")
            .where("eventoccurrences.eventoccurrenceid", eventOccurrenceId)
            .select(
                "eventoccurrences.*",
                "events.eventname"
            )
            .first();

        // Load all registration records for this occurrence
        const registrations = await knex("registration")
            .join("participants", "participants.participantemail", "registration.participantemail")
            .where("registration.eventoccurrenceid", eventOccurrenceId)
            .select(
                "registration.registrationid",
                "registration.registrationstatus",
                "registration.registrationattendedflag",
                "registration.checkindate",
                "registration.checkintime",
                "participants.participantfirstname",
                "participants.participantlastname",
                "participants.participantemail"
            )
            .orderBy("participants.participantlastname");

        res.render("admin/checkin", {
            occurrence,
            registrations
        });

    } catch (err) {
        console.error("Check-in page error:", err);
        res.status(500).send("Server error");
    }
});

// =============================================
// ADMIN — CHECK IN A PARTICIPANT
// =============================================
app.post("/admin/events/checkin/:registrationId", requireLogin, async (req, res) => {
  try {
    const registrationId = Number(req.params.registrationId);

    const now = new Date();
    const checkinDate = now.toISOString().split("T")[0];
    const checkinTime = now.toTimeString().split(" ")[0];

    // 1. Mark attendance
    await knex("registration")
      .where({ registrationid: registrationId })
      .update({
        registrationattendedflag: true,
        checkindate: checkinDate,
        checkintime: checkinTime
      });

    // 2. Create survey only if not already created
    const existingSurvey = await knex("survey")
      .where({ registrationid: registrationId })
      .first();

    if (!existingSurvey) {
      await knex("survey").insert({
        registrationid: registrationId,
        satisfactionscore: null,
        usefulnessscore: null,
        instructorscore: null,
        recommendationscore: null,
        overallscore: null,
        comments: null,
        submissiondate: null,
        submissiontime: null
      });
    }

    const reg = await knex("registration")
      .where({ registrationid: registrationId })
      .first();

    return res.redirect(`/admin/events/checkin/${reg.eventoccurrenceid}`);

  } catch (err) {
    console.error("Check-in error:", err);
    res.status(500).send("Server Error");
  }
});

// Update a child's event registration status for a specific occurrence
app.post("/account/participant/:participantid/event-status/:registrationid", requireLogin, async (req, res) => {
    try {
      const participantid = Number(req.params.participantid);
      const registrationid = Number(req.params.registrationid);
      const logged = req.session.user;
      const { registrationstatus } = req.body;  // expects "Not attending" or "Planning to attend"

      // Basic validation
      const allowed = ["Not attending", "Planning to attend"];
      const newStatus = allowed.includes(registrationstatus)
        ? registrationstatus
        : "Not attending";

      // 1. Find child
      const child = await knex("participants")
        .where({ participantid })
        .first();

      if (!child) {
        return res.status(404).send("Child not found");
      }

      // 2. Find parent owning this child
      const parent = await knex("parents")
        .where({ parentid: child.parentid })
        .first();

      if (!parent) {
        return res.status(404).send("Parent not found");
      }

      // 3. Permission check: parent can only edit their own child
      if (logged.level === "U" && logged.userid !== parent.userid) {
        return res.status(403).send("Unauthorized");
      }

      // 4. Make sure this registration belongs to this child
      const reg = await knex("registration")
        .where({
          registrationid,
          participantemail: child.participantemail
        })
        .first();

      if (!reg) {
        return res.status(404).send("Registration record not found");
      }

      // 5. Update registration status
      await knex("registration")
        .where({ registrationid })
        .update({
          registrationstatus: newStatus
        });

      res.redirect(`/account/${parent.userid}?success=Event+status+updated`);

    } catch (err) {
      console.error("Update event status error:", err);
      res.status(500).send("Server Error");
    }
  }
);

app.get("/survey/fill/:registrationid", requireLogin, async (req, res) => {
  try {
    const { registrationid } = req.params;

    const reg = await knex("registration")
      .where({ registrationid })
      .first();
    if (!reg) return res.status(404).send("Registration not found.");

    const participant = await knex("participants")
      .where({ participantemail: reg.participantemail })
      .first();
    if (!participant) return res.status(404).send("Participant not found.");

    const parent = await knex("parents")
      .where({ parentid: participant.parentid })
      .first();
    if (req.session.user.level === "U" &&
        req.session.user.userid !== parent.userid) {
      return res.status(403).send("Unauthorized.");
    }

    const occurrence = await knex("eventoccurrences as eo")
      .join("events as e", "e.eventid", "eo.eventid")
      .where("eo.eventoccurrenceid", reg.eventoccurrenceid)
      .select("eo.*", "e.eventname")
      .first();

    const survey = await knex("survey")
      .where({ registrationid })
      .first();

    res.render("pages/survey_fill", {
      registrationid,
      participant,
      parent,
      occurrence,
      survey
    });

  } catch (err) {
    console.error("Survey load error:", err);
    res.status(500).send("Error loading survey.");
  }
});

app.post("/survey/submit/:registrationid", requireLogin, async (req, res) => {
  try {
    const { registrationid } = req.params;

    const reg = await knex("registration")
      .where({ registrationid })
      .first();
    if (!reg) return res.status(404).send("Registration not found.");

    const participant = await knex("participants")
      .where({ participantemail: reg.participantemail })
      .first();

    const parent = await knex("parents")
      .where({ parentid: participant.parentid })
      .first();

    if (req.session.user.level === "U" &&
        req.session.user.userid !== parent.userid) {
      return res.status(403).send("Unauthorized.");
    }

    // Convert scores before averaging
    const scores = [
      Number(req.body.satisfactionscore),
      Number(req.body.usefulnessscore),
      Number(req.body.instructorscore),
      Number(req.body.recommendationscore)
    ];

    const overall = (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2);

    const surveyData = {
      registrationid,
      satisfactionscore: req.body.satisfactionscore,
      usefulnessscore: req.body.usefulnessscore,
      instructorscore: req.body.instructorscore,
      recommendationscore: req.body.recommendationscore,
      overallscore: overall,
      comments: req.body.comments || "",
      submissiondate: new Date(),
      submissiontime: new Date().toTimeString().split(" ")[0]
    };

    const existing = await knex("survey")
      .where({ registrationid })
      .first();

    if (existing) {
      await knex("survey")
        .where({ registrationid })
        .update(surveyData);
    } else {
      await knex("survey").insert(surveyData);
    }

    res.redirect(`/account/${parent.userid}?success=Survey+Submitted`);

  } catch (err) {
    console.error("Survey submission error:", err);
    res.status(500).send("Error submitting survey.");
  }
});

app.get("/admin/surveys", requireManager, async (req, res) => {
  try {
    const surveys = await knex("survey as s")
      .join("registration as r", "r.registrationid", "s.registrationid")
      .join("participants as p", "p.participantemail", "r.participantemail")
      .join("eventoccurrences as eo", "eo.eventoccurrenceid", "r.eventoccurrenceid")
      .join("events as e", "e.eventid", "eo.eventid")
      .select(
        "s.surveyid",
        "s.satisfactionscore",
        "s.usefulnessscore",
        "s.instructorscore",
        "s.recommendationscore",
        "s.overallscore",
        "s.comments",
        "s.submissiondate",
        "s.submissiontime",
        "p.participantfirstname",
        "p.participantlastname",
        "e.eventname",
        "eo.eventdatestart"
      )
      .orderBy("s.submissiondate", "desc");

    res.render("admin/surveys", {
      title: "Manage Surveys",
      surveys
    });

  } catch (err) {
    console.error("Admin survey list error:", err);
    res.status(500).send("Error loading surveys.");
  }
});

app.post("/admin/survey/delete/:surveyid", requireManager, async (req, res) => {
  try {
    const { surveyid } = req.params;

    // Delete the survey
    await knex("survey")
      .where({ surveyid })
      .del();

    return res.redirect("/admin/survey-responses?success=Survey+Deleted");

  } catch (err) {
    console.error("Error deleting survey response:", err);
    return res.redirect("/admin/survey-responses?error=Delete+Failed");
  }
});


// -------------------------
// START SERVER
// -------------------------
app.listen(PORT, () => console.log(`Website started on port ${PORT}`));