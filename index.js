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

function allowParentOrManager(req, ownerUserId) {
  const user = req.session.user;
  if (!user) return false;

  // Managers always allowed
  if (user.level === "M") return true;

  // Parents allowed only if editing their own user record
  return user.level === "U" && user.userid === ownerUserId;
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

app.get("/account/:userid", requireLogin, async (req, res) => {
  try {
    const requestedUserId = Number(req.params.userid);
    const loggedInUser = req.session.user;

    // 🔒 If parent tries to view someone else's account → block
    if (loggedInUser.level === "U" && loggedInUser.userid !== requestedUserId) {
      return res.status(403).send("You are not authorized to view this account.");
    }

    // Load parent account based on URL user ID
    const parent = await knex("parents")
      .where({ userid: requestedUserId })
      .first();

    if (!parent) {
      return res.status(404).send("Parent not found");
    }

    // Load children
    const participants = await knex("participants")
      .where({ parentid: parent.parentid });

    // Load milestones per participant
    for (let p of participants) {
      const milestones = await knex("milestones")
        .where({ participantid: p.participantid })
        .orderBy("milestonedate", "asc");

      p.milestones = milestones;
    }

    parent.participants = participants;

    res.render("pages/account", {
      parent,
      user: loggedInUser,
      lang: req.session.lang || "en"
    });

  } catch (err) {
    console.error("Account page error:", err);
    res.status(500).send("Error loading account page");
  }
});

app.post("/account/:userid/update", requireLogin, async (req, res) => {
  try {
    const userid = req.params.userid;

    if (req.session.user.userid !== Number(userid) && !req.session.user.ismanager) {
      return res.status(403).send("Unauthorized");
    }

    await knex("parents")
      .where({ userid })
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

    res.redirect(`/account/${userid}`);

  } catch (err) {
    console.error("Update parent error:", err);
    res.redirect(`/account/${req.params.userid}`);
  }
});

app.post("/account/:parentid/participant/add", requireLogin, async (req, res) => {
  try {
    const parent = await knex("parents")
      .where({ parentid: req.params.parentid })
      .first();

    await knex("participants").insert({
      parentid: req.params.parentid,
      participantfirstname: req.body.participantfirstname,
      participantlastname: req.body.participantlastname,
      participantemail: req.body.participantemail,
      participantdob: req.body.participantdob || null,
      participantgrade: req.body.participantgrade,
      participantschooloremployer: req.body.participantschooloremployer,
      participantfieldofinterest: req.body.participantfieldofinterest,
      mariachiinstrumentinterest: req.body.mariachiinstrumentinterest,
      instrumentexperience: req.body.instrumentexperience,
      graduationstatus: req.body.graduationstatus || "not started"
    });

    res.redirect(`/account/${parent.userid}`);

  } catch (err) {
    console.error("Add child error:", err);
    res.redirect("back");
  }
});

app.post("/account/participant/:participantid/delete", requireLogin, async (req, res) => {
  try {
    const participantid = req.params.participantid;

    // Find the participant
    const participant = await knex("participants")
      .where({ participantid })
      .first();

    if (!participant) {
      return res.status(404).send("Participant not found.");
    }

    // Load parent
    const parent = await knex("parents")
      .where({ parentid: participant.parentid })
      .first();

    if (!parent) {
      return res.status(404).send("Parent not found.");
    }

    // Authorization: only the parent OR a manager can delete
    if (req.session.user.userid !== parent.userid && !req.session.user.level === "U") {
      return res.status(403).send("Unauthorized");
    }

    // ========== OPTIONAL: Delete milestones first ==========
    await knex("milestones")
      .where({ participantid: participant.participantid })
      .del();

    // ========== Delete participant ==========
    await knex("participants")
      .where({ participantid })
      .del();

    // Redirect back to the parent's account page
    res.redirect(`/account/${parent.userid}`);

  } catch (err) {
    console.error("Delete child error:", err);
    res.redirect("back");
  }
});

app.post("/account/participant/:participantId/milestones/add", requireLogin, async (req, res) => {
  try {
    const { participantId } = req.params;
    const { milestonetitle, milestonedate, milestonestatus } = req.body;

    // Validate participant exists
    const participant = await knex("participants")
      .where({ participantid: participantId })
      .first();

    if (!participant) {
      return res.status(404).send("Participant not found.");
    }

    // Security: only the correct parent or a manager
    const isManager = req.session.user.level === "M";
    if (participant.parentid !== req.session.user.parentid && !isManager) {
      return res.status(403).send("Unauthorized");
    }

    // Insert milestone
    await knex("milestones").insert({
      participantid: participantId,
      milestonetitle: milestonetitle,
      milestonedate: milestonedate,
      milestonestatus: milestonestatus
    });

    // Get parent to redirect correctly
    const parent = await knex("parents")
      .where({ parentid: participant.parentid })
      .first();

    if (!parent) {
      return res.status(404).send("Parent not found.");
    }

    // Redirect using parent.userid
    res.redirect(`/account/${parent.userid}`);

  } catch (err) {
    console.error("Error adding milestone:", err);
    res.status(500).send("Server Error");
  }
});

app.post("/account/milestone/:milestoneid/update-full", requireLogin, async (req, res) => {
  try {
    const { milestoneid } = req.params;

    const milestone = await knex("milestones")
      .where({ milestoneid })
      .first();

    if (!milestone) {
      return res.status(404).send("Milestone not found.");
    }

    // Lookup participant
    const participant = await knex("participants")
      .where({ participantid: milestone.participantid })
      .first();

    if (!participant) {
      return res.status(404).send("Participant not found.");
    }

    // Lookup parent
    const parent = await knex("parents")
      .where({ parentid: participant.parentid })
      .first();

    if (!parent) {
      return res.status(404).send("Parent not found.");
    }

    // Authorization: parent or manager
    if (req.session.user.userid !== parent.userid && !req.session.user.level === "U") {
      return res.status(403).send("Unauthorized");
    }

    // Perform update
    await knex("milestones")
      .where({ milestoneid })
      .update({
        milestonetitle: req.body.milestonetitle,
        milestonedate: req.body.milestonedate || null,
        milestonestatus: req.body.milestonestatus
      });

    res.redirect(`/account/${parent.userid}`);

  } catch (err) {
    console.error("Error updating milestone:", err);
    res.redirect("back");
  }
});

app.post("/account/milestone/:milestoneid/delete", requireLogin, async (req, res) => {
  try {
    const { milestoneid } = req.params;

    const milestone = await knex("milestones")
      .where({ milestoneid })
      .first();

    if (!milestone) {
      return res.status(404).send("Milestone not found.");
    }

    // Lookup participant
    const participant = await knex("participants")
      .where({ participantid: milestone.participantid })
      .first();

    if (!participant) {
      return res.status(404).send("Participant not found.");
    }

    // Lookup parent
    const parent = await knex("parents")
      .where({ parentid: participant.parentid })
      .first();

    if (!parent) {
      return res.status(404).send("Parent not found.");
    }

    // Authorization: parent or manager
    if (req.session.user.userid !== parent.userid && !req.session.user.level === "U") {
      return res.status(403).send("Unauthorized");
    }

    // Delete milestone
    await knex("milestones")
      .where({ milestoneid })
      .del();

    res.redirect(`/account/${parent.userid}`);

  } catch (err) {
    console.error("Error deleting milestone:", err);
    res.redirect("back");
  }
});

app.post("/account/participant/:participantid/update-full", requireLogin, async (req, res) => {
  try {
    const child = await knex("participants")
      .where({ participantid: req.params.participantid })
      .first();

    const parent = await knex("parents")
      .where({ parentid: child.parentid })
      .first();

    await knex("participants")
      .where({ participantid: req.params.participantid })
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

    res.redirect(`/account/${parent.userid}`);

  } catch (err) {
    console.error("Update child error:", err);
    res.redirect("back");
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

// --- Add Child Routes ---
app.get("/account/:parentid/participant/add", requireLogin, async (req, res) => {
    const parentid = Number(req.params.parentid);
    const sessionUser = req.session.user;

    try {
        // Find the parent associated with this parentid
        const parent = await knex("parents")
            .where({ parentid })
            .first();

        if (!parent) {
            return res.status(404).send("Parent not found.");
        }

        // Permission rules:
        const isManager = sessionUser.level === "M";
        const isOwner = sessionUser.userid === parent.userid;

        if (!isManager && !isOwner) {
            return res.status(403).send("You are not authorized to add a participant for this account.");
        }

        // Render: ONLY pass what the page actually needs
        return res.render("pages/add-child", {
            title: "Add Child",
            parent,     // so EJS knows which parent the child belongs to
            parentid    // explicit id for the POST route
        });

    } catch (err) {
        console.error("Error loading Add Child page:", err);
        return res.status(500).send("Server error loading Add Child page.");
    }
});

app.post("/account/:parentid/participant/add", requireLogin, async (req, res) => {
    const parentid = Number(req.params.parentid);
    const sessionUser = req.session.user;

    const {
        participantfirstname,
        participantlastname,
        participantemail,
        participantdob,
        participantgrade,
        participantschooloremployer,
        participantfieldofinterest,
        mariachiinstrumentinterest,
        instrumentexperience
    } = req.body;

    try {
        // 1. Load the parent record to verify permissions + get parent.userid
        const parent = await knex("parents")
            .where({ parentid })
            .first();

        if (!parent) {
            return res.status(404).send("Parent not found.");
        }

        // 2. Permission check
        const isManager = sessionUser.level === "M";
        const isOwner = sessionUser.userid === parent.userid;

        if (!isManager && !isOwner) {
            return res.status(403).send("Not authorized to add participant for this parent.");
        }

        // 3. Insert the new participant
        await knex("participants").insert({
            parentid: parentid,
            participantfirstname,
            participantlastname,
            participantemail,
            participantdob: participantdob || null,
            participantgrade: participantgrade || null,
            participantschooloremployer: participantschooloremployer || null,
            participantfieldofinterest: participantfieldofinterest || null,
            mariachiinstrumentinterest: mariachiinstrumentinterest || null,
            instrumentexperience: instrumentexperience || null,
            graduationstatus: "enrolled"
        });

        // 4. Redirect back to the correct account page using the parent's *userid*
        return res.redirect(`/account/${parent.userid}`);

    } catch (err) {
        console.error("Error adding child:", err);
        return res.status(500).send("Error adding child");
    }
});

// --- Update Child Progress (editable fields on account.ejs) ---
app.post("/account/child/:childId/update", requireLogin, async (req, res) => {
  const childId = Number(req.params.childId);
  const user = req.session.user;

  const { fieldofinterest, graduationstatus } = req.body;

  try {
    // Load participant
    const participant = await knex("participants")
      .where({ participantid: childId })
      .first();

    if (!participant) return res.status(404).send("Child not found.");

    // Load parent to get ownerUserId
    const parent = await knex("parents")
      .where({ parentid: participant.parentid })
      .first();

    if (!parent) return res.status(404).send("Parent not found.");

    // 🔥 Check permissions
    if (!allowParentOrManager(req, parent.userid)) {
      return res.status(403).send("Not authorized to update this child.");
    }

    await knex("participants")
      .where({ participantid: childId })
      .update({
        participantfieldofinterest: fieldofinterest,
        graduationstatus
      });

    res.redirect(`/account/${parent.userid}`);

  } catch (err) {
    console.error("Error updating child progress:", err);
    res.status(500).send("Error updating progress");
  }
});

// --- Add Milestone for Child ---
app.get("/account/participant/:participantId/milestones/add", requireLogin, async (req, res) => {
  const participantId = req.params.participantId;
  res.render("pages/add-milestone", { title: "Add Milestone", participantId, user: req.session.user, lang: req.session.lang || "en" });
});

app.post("/account/participant/:participantId/milestones/add", requireLogin, async (req, res) => {
  const participantId = req.params.participantId;
  const { title, date, status } = req.body;

  try {
    await knex('milestones').insert({
      participantid: participantId,
      title,
      date: date || null,
      milestonestatus: status || 'Not Started'
    });
    res.redirect("/pages/account");
  } catch (err) {
    console.error("Error adding milestone:", err);
    res.status(500).send("Error adding milestone");
  }
});

// --- Update Milestone Status ---
app.post("/account/milestone/:milestoneId/update", requireLogin, async (req, res) => {
  const milestoneId = Number(req.params.milestoneId);
  const { milestonestatus } = req.body;

  try {
    const milestone = await knex("milestones").where({ milestoneid: milestoneId }).first();
    if (!milestone) return res.status(404).send("Milestone not found.");

    const participant = await knex("participants")
      .where({ participantemail: milestone.participantemail })
      .first();

    const parent = await knex("parents")
      .where({ parentid: participant.parentid })
      .first();

    // 🔥 Permission check
    if (!allowParentOrManager(req, parent.userid)) {
      return res.status(403).send("Not authorized to update milestone.");
    }

    await knex("milestones")
      .where({ milestoneid: milestoneId })
      .update({ milestonestatus });

    res.redirect(`/account/${parent.userid}`);

  } catch (err) {
    console.error("Error updating milestone:", err);
    res.status(500).send("Error updating milestone");
  }
});

// --- Delete Milestone ---
app.post("/account/milestone/:milestoneId/delete", requireLogin, async (req, res) => {
  const milestoneId = req.params.milestoneId;

  try {
    await knex('milestones')
      .where({ milestoneid: milestoneId })
      .del();

    res.redirect("/pages/account");
  } catch (err) {
    console.error("Error deleting milestone:", err);
    res.status(500).send("Error deleting milestone");
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

            // Parent fields
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

            // Participant fields
            participantfirstname,
            participantlastname,
            participantemail,
            participantdob,
            participantgrade,
            participantschooloremployer,
            mariachiinstrumentinterest,
            instrumentexperience,

            // NEW: programs from checkboxes
            programs
        } = req.body;

        if (!username || !password) {
            return res.render("createAccount", {
                error_message: "Username and Password are required.",
                title: "Create Account"
            });
        }

        if (!parentfirstname || !parentlastname || !parentemail) {
            return res.render("createAccount", {
                error_message: "Parent name and email are required.",
                title: "Create Account"
            });
        }

        if (!participantfirstname || !participantlastname || !participantemail) {
            return res.render("createAccount", {
                error_message: "Participant name and email are required.",
                title: "Create Account"
            });
        }

        const programList = Array.isArray(programs) ? programs.join(", ") : "";

        const [loginRow] = await knex("logins")
            .insert({
                username,
                password,
                level: "U"
            })
            .returning("userid");

        const newUserID = loginRow.userid || loginRow;

        const boolTuition = tuitionagreement === "true";
        const boolMedical = medicalconsent === "true";
        const boolPhoto = photoconsent === "true";
        const boolScholarship = scholarshipinterest === "true";

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
                medicalconsent: boolMedical,
                photoconsent: boolPhoto,
                tuitionagreement: boolTuition,
                scholarshipinterest: boolScholarship,
                agreementdate
            })
            .returning("parentid");

        const newParentID = parentRow.parentid || parentRow;

        await knex("participants")
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
            });

        req.session.isLoggedIn = true;
        req.session.user = {
            userid: newUserID,
            parentid: newParentID,
            level: "U",
            username: username,
            name: `${parentfirstname} ${parentlastname}`
        };


        res.redirect(`/account/${newUserID}`);

    } catch (err) {
        console.error("Error creating user:", err);

        return res.render("createAccount", {
            error_message: "There was an error creating your account. Please try again.",
            title: "Create Account"
        });
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
  try {
    const { userid } = req.params;

    // Only managers can delete parents
    if (req.session.user.level !== "M") {
      return res.status(403).send("Unauthorized");
    }

    // Fetch parent row
    const parent = await knex("parents").where({ userid }).first();
    if (!parent) return res.status(404).send("Parent not found");

    const parentId = parent.parentid;

    // Fetch participant rows
    const participants = await knex("participants")
      .where({ parentid: parentId });

    // =====================================================
    //   STEP 1 — DELETE SURVEYS for each participant
    // =====================================================
    for (const p of participants) {
      const regs = await knex("registration")
        .where({ participantemail: p.participantemail });

      for (const r of regs) {
        await knex("survey")
          .where({ registrationid: r.registrationid })
          .del();
      }
    }

    // =====================================================
    //   STEP 2 — DELETE REGISTRATIONS for each participant
    // =====================================================
    for (const p of participants) {
      await knex("registration")
        .where({ participantemail: p.participantemail })
        .del();
    }

    // =====================================================
    //   STEP 3 — DELETE MILESTONES (FK → participants)
    // =====================================================
    for (const p of participants) {
      await knex("milestones")
        .where({ participantid: p.participantid })
        .del();
    }

    // =====================================================
    //   STEP 4 — DELETE PARTICIPANTS
    // =====================================================
    await knex("participants")
      .where({ parentid: parentId })
      .del();

    // =====================================================
    //   STEP 5 — DELETE PARENT RECORD
    // =====================================================
    await knex("parents")
      .where({ parentid: parentId })
      .del();

    // =====================================================
    //   STEP 6 — DELETE LOGIN ACCOUNT
    // =====================================================
    await knex("logins")
      .where({ userid })
      .del();

    // Redirect back to admin user list
    res.redirect("/admin/manageusers");

  } catch (err) {
    console.error("Error deleting parent:", err);
    res.status(500).send("Server Error");
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

// GET – edit form
router.get('/surveyResponses/edit/:id', async (req, res) => {
  try {
    const response = await SurveyResponse.findByPk(req.params.id);
    if (!response) return res.status(404).send('Not found');

    res.render('admin/editSurveyResponse', {
      r: response,
      user: req.user,
      lang: req.session.lang || 'en'
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// POST – save changes
router.post('/surveyResponses/edit/:id', async (req, res) => {
  try {
    const response = await SurveyResponse.findByPk(req.params.id);
    if (!response) return res.status(404).send('Not found');

    await response.update(req.body);

    res.redirect('/admin/surveyResponses');
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// POST – delete
router.post('/surveyResponses/delete/:id', async (req, res) => {
  try {
    await SurveyResponse.destroy({
      where: { id: req.params.id }
    });

    res.redirect('/admin/surveyResponses');
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

module.exports = router;

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

app.get("/account/:userid/edit", requireLogin, async (req, res) => {
  const requestedUserId = Number(req.params.userid);
  const loggedInUser = req.session.user;

  try {
    let authorized = false;

    // ⭐ Managers can edit ANY parent
    if (loggedInUser.level === "M") {
      authorized = true;
    }

    // ⭐ Parents can only edit THEIR OWN account
    if (loggedInUser.level === "U" && loggedInUser.userid === requestedUserId) {
      authorized = true;
    }

    if (!authorized) {
      return res.status(403).send("Not authorized to edit this account.");
    }

    // Load parent record
    const parent = await knex("parents")
      .where({ userid: requestedUserId })
      .first();

    if (!parent) {
      return res.status(404).render("pages/editAccount", {
        parent: {},
        error_message: "Parent not found.",
        title: "Edit Account"
      });
    }

    res.render("pages/editAccount", {
      parent,
      error_message: "",
      title: "Edit Account"
    });

  } catch (err) {
    console.error("Error loading parent:", err.message);
    res.status(500).render("pages/editAccount", {
      parent: {},
      error_message: "Unable to load parent account.",
      title: "Edit Account Error"
    });
  }
});

app.post("/account/:userid/edit", requireLogin, async (req, res) => {
  const requestedUserId = Number(req.params.userid);
  const loggedInUser = req.session.user;

  const {
    parentemail,
    parentfirstname,
    parentlastname,
    parentphone,
    languagepreference,
    parentcollege,
    photoconsent
  } = req.body;

  try {
    let authorized = false;

    // ⭐ Managers can edit ANY parent
    if (loggedInUser.level === "M") {
      authorized = true;
    }

    // ⭐ Parents can edit ONLY their account
    if (loggedInUser.level === "U" && loggedInUser.userid === requestedUserId) {
      authorized = true;
    }

    if (!authorized) {
      return res.status(403).send("Not authorized to update this account.");
    }

    // Save update
    await knex("parents")
      .where({ userid: requestedUserId })
      .update({
        parentemail,
        parentfirstname,
        parentlastname,
        parentphone,
        languagepreference,
        parentcollege,
        photoconsent
      });

    // Redirect correctly
    res.redirect(`/account/${requestedUserId}`);

  } catch (err) {
    console.error("Error updating parent:", err.message);

    res.render("pages/editAccount", {
      parent: {
        userid: requestedUserId,
        parentemail,
        parentfirstname,
        parentlastname,
        parentphone,
        languagepreference,
        parentcollege,
        photoconsent
      },
      error_message: "Error saving changes. Please try again.",
      title: "Edit Account"
    });
  }
});

// -------------------------
// START SERVER
// -------------------------
app.listen(PORT, () => console.log(`Website started on port ${PORT}`));