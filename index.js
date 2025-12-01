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

//Checks to see if the user is logged in after each route
app.use((req, res, next) => {
  // Skip authentication check for public routes
  if (req.path === '/' || req.path === '/login' || req.path === '/logout') {
    return next(); // Skip to the next handler
  }

  // For all other routes, make sure the user is logged in
  if (req.session.isLoggedIn) {
    // User is authenticated — continue to the requested route
    next();
  } else {
    // User not logged in — show login page with error
    res.render("login", { error_message: "Please log in to access this page" });
  }
});

// Home page route
app.get("/", (req, res) => {
    res.render("index", { error_message: "" });
});

//Means the server is now waiting for client requests
app.listen(PORT, () => console.log("Website started"));