//Michael Jones - Section 1 - IS 403 Assignment 4

//Imports express library
let express = require("express");

//Imports express-session library
const session = require("express-session");

//Creates a new express application
const app = express();

//Allows the app to run ejs files
app.set("view engine", "ejs");

//Declares what port to run the website on
const PORT = process.env.PORT || 3000;

//Allows the app to use public files
app.use(express.static("public"));

//Handles data submitted from HTML forms and makes it available on the req.body object in route
app.use(express.urlencoded({ extended: true }));

//Configures express-session, which allows app to store data for each logged-in user
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'fallback-secret-key',
    resave: false,
    //Means "Don't create a session until something is put inside it"
    saveUninitialized: false,
  })
);

//Connects to the database
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

// Home page route
app.get("/", (req, res) => {
    res.render("index", { error_message: "" });
});

// Redirect to login page
app.get("/login", (req, res) => {
    res.render("login", { error_message: "" });
});

app.post("/login", (req, res) => {
  // Get data from the form (HTML input names: username, password)
  let sName = req.body.username;
  let sPassword = req.body.password;

  // Query the users table for a matching username & password
  knex
    .select("username", "password", "level")
    .from("users")
    .where("username", sName)
    .andWhere("password", sPassword)
    .then(users => {
      // If a user is found, log them in
      if (users.length > 0) {
        // Store login state and username in the session
        req.session.isLoggedIn = true;
        req.session.username = sName;
        req.session.level = users[0].level;
        // Redirect to home page
        res.redirect("/");
      } else {
        // Invalid credentials — show error
        res.render("login", { error_message: "Invalid login" });
      }
    })
    .catch(err => {
      // If something goes wrong with the database
      console.error("Login error:", err);
      res.render("login", { error_message: "Invalid login" });
    });
});

//Means the server is now waiting for client requests
app.listen(PORT, () => console.log("Website started"));