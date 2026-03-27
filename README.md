# Beer Olympics Team Signup

Private, session-gated Beer Olympics team registration site built with Node.js, Express, EJS, and SQLite.

## Features
- Password gate (session-based) with `express-session`
- 2-person team registration with country selection
- Countries removed from the dropdown after being claimed
- SQLite persistence with unique constraints on `team_name` and `country_code`
- Server-side and UI validation
- Clean, mobile-friendly UI with a fun Beer Olympics vibe
- Basic rate limiting on login and CSRF protection on forms

## Project Structure
- package.json
- server.js
- db.js
- countries.js
- /views
	- login.ejs
	- register.ejs
	- teams.ejs
	- success.ejs
- /public
	- styles.css

## Environment Variables
Create a `.env` file in the project root.

Example:
```
PORT=3000
SESSION_SECRET=your-super-secret
APP_PASSWORD=beer
ADMIN_PASSWORD=beeradmin
```

- `PORT`: optional, defaults to `3000`
- `SESSION_SECRET`: required for production
- `APP_PASSWORD`: defaults to `beer` if not set
- `ADMIN_PASSWORD`: defaults to `beeradmin` if not set

## Run Locally
1. Install dependencies
```
npm install
```

2. Start the server
```
npm start
```

3. Open the app
```
http://localhost:3000
```

## Admin Portal
- Visit `http://localhost:3000/admin`
- Use the admin password to update player names, swap countries, or delete teams

## Notes
- The SQLite database file is created at `beer_olympics.sqlite` in the project root.
- The country list is stored in `countries.js`.
