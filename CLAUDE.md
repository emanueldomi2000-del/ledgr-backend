# LEDGR — Backend Project Context

## What is LEDGR
LEDGR is a verified sports tipster platform. Bettors post picks publicly, results are auto-graded, and performance is permanently tracked. No edits, no deleted losses. Think FACEIT meets Chess.com for sports betting.

## Stack
- **Backend**: Node.js + Express on Render (free tier)
- **Database**: PostgreSQL via Supabase (Prisma ORM)
- **Frontend**: Static HTML/CSS/JS on Vercel (separate repo: ledgr)
- **Backend URL**: https://ledgr-backend-7hmh.onrender.com

## File Structure
- `index.js` — main Express server, all API routes
- `autoVerify.js` — cron job every 10min, auto-grades Soccer + NBA picks
- `elo.js` — ELO rating calculations
- `prisma/schema.prisma` — database schema

## Database Models
### User
- id, email (unique), username (unique), password (hashed)
- role (default: "user")
- elo (default: 1000)
- createdAt

### Pick
- id, userId (FK), sport, event, fixtureId
- homeTeam, awayTeam, market, odds, stake
- stakeType (default: "units")
- result (default: "pending") — values: pending | win | loss | cashout
- pnl (profit/loss in units)
- confidence, reasoning
- eloChange, eloAfter
- createdAt

## API Endpoints
- GET / — health check
- GET /ping — keep-alive
- POST /auth/register — {email, username, password}
- POST /auth/login — {email, password}
- GET /picks — returns all picks with user.username
- POST /picks — create pick
- PUT /picks/:id — update result + pnl
- GET /fixtures — fetch live fixtures from odds API
- GET /players — fetch squad from football API
- POST /create-checkout — Stripe subscription

## Environment Variables (in Render)
- DATABASE_URL — Supabase pooled connection
- DIRECT_URL — Supabase direct connection
- JWT_SECRET — token signing
- ODDS_API_KEY — the-odds-api.com
- FOOTBALL_API_KEY — api-sports.io
- STRIPE_SECRET_KEY — Stripe

## Key Rules
1. NEVER delete picks — picks are immutable once posted
2. Picks lock when posted — no editing odds or stake
3. Auto-grading runs every 10min via cron
4. ELO calculated frontend-side from picks array (not stored in DB yet)
5. Keep-alive ping every 10min via cron-job.org to prevent Render spin-down
6. JWT tokens valid 90 days

## Frontend Repo
Separate repo: emanueldomi2000-del/ledgr on Vercel
Pages: /, /home, /dashboard, /leaderboard, /tipster, /compare, /simulator, /badges, /hall-of-fame, /login

## Current Issues / TODO
- ELO not yet stored in DB per pick (calculated frontend)
- No WebSocket/real-time yet
- Stripe not live yet (test mode)
- No comment system yet
- No notification system yet

## Design Philosophy
LEDGR must feel like a competitive ecosystem — NOT a gambling site.
Inspiration: FACEIT + Chess.com + Twitter/X mechanics.
Core value: trust through immutable verified records.
