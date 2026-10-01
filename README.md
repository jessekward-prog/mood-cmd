# mood-cmd

A mood and energy check-in that takes about ten seconds, dressed as a 16-bit game.

Each check-in is three bars and two short thoughts: mood, energy, and one bar that depends on the time of day (sleep in the morning, calm in the afternoon, connection at night), plus one good thing and one bad thing. A local LM Studio model reads your log and writes a report on what's lifting you, what's dragging you, and a few things to try. Nudges and the weekly report can be pushed to your phone through [ntfy](https://ntfy.sh).

<img src="public/icons/icon-192.png" width="96" alt="mood-cmd icon">

## What it does

- **Check-in:** two drag bars plus a time-of-day bar, two one-line thoughts. The screen colour follows the mood x energy quadrant.
- **Records:** 30-day chart, a colour per day, averages by time of day, and the full log.
- **Reports:** 7 or 30 days, written by your local model. The arithmetic (averages, morning against night, high sleep against low sleep) is done in code and handed to the model in words, so the numbers in the report are right.
- **Nudges:** up to four times a day. A nudge is skipped if you've already checked in that morning, afternoon or night. No streaks.
- **Weekly report:** written and pushed on the day and time you pick.
- **PIN:** set on first launch, stored hashed in Postgres, checked on every data route. Five wrong guesses lock PIN entry for five minutes.

If a check-in or the reports turn heavy, the report page shows Lifeline's number (Australia, 13 11 14). That check is done in code, not left to the model.

## Run it on Hostess

Deploy this repo's git URL from the Hostess dashboard. `app.yaml` asks for Postgres, and Hostess fills in `LM_STUDIO_URL`, `LM_STUDIO_API_KEY` and `LM_STUDIO_MODEL` from its library config. Open the app and set your PIN.

For push, set `NTFY_URL` (and `NTFY_TOKEN` if your ntfy server has auth on) in the app's env panel and redeploy.

## Run it anywhere else

Any Docker host with Postgres:

```bash
docker build -t mood-cmd .
docker run -p 3048:3048 -e DATABASE_URL='postgres://user:pass@db:5432/mood?sslmode=disable' mood-cmd
```

Local development: `npm install`, copy `.env.example` to `.env`, then `npm run dev`.

## Environment

| Variable | Needed | What it does |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string. `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD` work too. `sslmode=disable` is honoured. |
| `APP_PIN` | no | Preseed or reset the PIN (4 to 8 digits) instead of using the first-launch screen. |
| `LM_STUDIO_URL` | no | OpenAI-compatible model server, without `/v1`. Reports are off without it. |
| `LM_STUDIO_API_KEY` | no | Bearer key for that server. |
| `LM_STUDIO_MODEL` | no | Model id. Left empty, the request uses whatever model is loaded. An instruct model of 12B or so writes noticeably more accurate reports than a 7B. |
| `NTFY_URL` | no | ntfy server for nudges and reports. Push is off without it. |
| `NTFY_TOKEN` | no | Access token, for an ntfy server with auth on. |
| `NTFY_TOPIC` | no | Default topic (`mood-cmd`). Changeable in the app. |
| `APP_URL` | no | Public address, for push click-through links and the push icon. Without it, the app uses the https address it was last opened on. |

**On a public ntfy server, anyone who guesses the topic can read your reports.** Use your own server with auth on, or at least a long random topic.

## Notes

- Times (nudges, mornings, weekdays) follow the time zone of the browser you last opened the app in.
- Report requests go to the model one at a time. A model that isn't loaded yet can take a minute or two on the first report; the scheduled weekly report retries every ten minutes until it gets through.
