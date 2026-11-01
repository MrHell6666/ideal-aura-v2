# IDEAL AURA — Attendance OS · Volume 2
**Ideal Packages (Pvt) Ltd.**

Volume 2 is a separate product from Volume 1, the HR & Attendance ERP:

- It has its own Vercel project, its own sign-in cookies and its own data.
- Its data uses the Redis key prefix `aura:`. Volume 1 uses `ipk:`.
- Volume 2 can safely share the same Upstash database as Volume 1 without the two ever mixing.

It includes everything in Volume 1: employees, attendance, shifts, leave, PKR payroll, reports, roles, backup and the audit trail. On top of that, it adds the following.

| Feature | What it does |
|---|---|
| **AURA interface** | Cinematic animated design: aurora background, glass panels, spotlight cards, magnetic buttons, count-up numbers, command palette (Ctrl + K), dark and light themes. |
| **Pulse dashboard** | Live attendance orb, live presence strip, smart insights, leaderboard, department view, 20-week heatmap, "needs attention" list. |
| **Hold-to-punch** | Employees press and hold to check in or out. Optional **geo-fence**: block or flag punches outside a radius. Optional **selfie proof** from the front camera. |
| **Kiosk mode** | Turns a tablet or PC at the gate into a check-in terminal. Employees type their number and a 4–6 digit PIN. PINs are hashed and checked on the server, and an ID locks after 5 wrong tries. |
| **Live wall** | Full-screen presence board for a TV, with live tiles, a ticker and auto-refresh. |
| **Insights & streaks** | Aura score, on-time streaks, podium, achievements, arrival-time pattern, punctuality by department. |
| **Import from Volume 1** | During setup, choose "Restore a backup file" and upload a Volume 1 backup (.json). |

## Project structure

| Path | Purpose |
|---|---|
| `public/index.html` | The complete app (logo embedded). |
| `api/main.js` | Serverless backend: sign-in, data sync with permission checks, users, files, kiosk PINs, backup and restore. |
| `lib/` | Database access (Upstash REST), password hashing and sessions, permission rules. |
| `vercel.json` | Routing and security headers. Camera and location are allowed only for this site. |
| `dev-server.js` | Run locally with `node dev-server.js`. It uses an in-memory database; the setup token is `dev-setup-token`. |

There are no npm packages to install.

## Environment variables (Vercel → Settings → Environment Variables)

| Name | Value |
|---|---|
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Added automatically when an Upstash Redis database is connected to the project (Storage tab). |
| `SESSION_SECRET` | A random value of at least 32 characters. |
| `SETUP_TOKEN` | A one-time code, used on the first-time setup screen. |
| `DB_PREFIX` *(optional)* | Defaults to `aura`. Change it only if you run more than one copy on the same database. |

## Before using it for real

1. **Settings → Aura features:** set the geo-fence location and radius. You can tap **Use this device's current location** while standing at the factory. Decide whether selfies are required, and inform employees first.
2. **Kiosk Mode → Manage PINs:** generate PINs and print the slips.
3. **Settings → Payroll:** set your payroll rules. No tax rates or overtime rates are assumed.
4. **Users & Roles:** create logins. Everyone changes their password at first sign-in.
5. **Backup & Data:** download a backup every week.

## Notes and limits

- **Location and camera only work over HTTPS**, which Vercel provides, and only after the user allows them in the browser. GPS accuracy on phones is usually 5–30 m. The radius check allows for the reported accuracy, up to 150 m.
- **Selfies are 240×240 JPEG images** (about 15 KB each) stored in the database. They are visible to HR from the camera icon in the attendance register.
- **A kiosk stays signed in while it is open**, and the server session lasts 12 hours. Leaving the kiosk requires the password of the signed-in user.
- **Biometric devices** still connect through **Attendance → Import** (CSV or Excel). Email and SMS alerts are not included.
