# ScrabbleBot — our bot

## Setup (once)
```bash
cd scrabble-bot
npm install
```
Needs Node 20+.

## First run (paste the token from https://scrabblebot.spacetimedb.com/team)
```bash
BOT_NAME=<yourbotname> BOT_TOKEN=<token> npm start
```
The token gets saved to `.token-<yourbotname>`, so after the first run you only need:
```bash
BOT_NAME=<yourbotname> ./run.sh
```
`run.sh` restarts the bot automatically if it disconnects.

## Tournament
**Automatic:** as soon as a tournament opens for registration, the bot registers itself
(log line: `*** registered for tournament N ***`). Once registered, it stops joining
lobby games, so it's free when the admin starts. During the tournament it plays its
matches on its own. Just keep `./run.sh` running and the computer awake
(macOS: run `caffeinate -dims` in a second terminal).

To register by hand instead: `BOT_NAME=SevenUp TOURNAMENT_ID=<id> ./run.sh`.
To turn off auto-registration: add `NO_AUTO_REGISTER=1`.
Don't stop the bot during the tournament. A bot that's offline still gets seated and loses every auction.

## Windows (PowerShell)
```powershell
$env:BOT_NAME="yourbotname"; $env:BOT_TOKEN="<token>"; npm start
```

## Logs
Each auction prints `letter mv=<marginal value> bid <n> bal <coins> bag <tiles left> (<ms>)`.
Each match ends with `ENDED: place X/Y`. Send me the log output so I can tune.
